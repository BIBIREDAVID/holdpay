const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

// Monnify signs webhook payloads with your secret key (HMAC SHA512), and the
// same secret key doubles as the password half of Basic auth for API calls.
// Store the real values with:
//   firebase functions:secrets:set MONNIFY_SECRET_KEY
//   firebase functions:secrets:set MONNIFY_API_KEY
// MONNIFY_CONTRACT_CODE and MONNIFY_SOURCE_ACCOUNT_NUMBER go in
// functions/.env instead (see the template) — they're identifiers, not credentials.
const MONNIFY_SECRET_KEY = defineSecret("MONNIFY_SECRET_KEY");
const MONNIFY_API_KEY = defineSecret("MONNIFY_API_KEY");
// Your merchant contract code and disbursement wallet account number are
// identifiers, not credentials — loaded as plain env vars from
// functions/.env (Functions v2 loads this automatically), not Secret
// Manager. Set the real values in functions/.env before deploying.
const MONNIFY_CONTRACT_CODE = process.env.MONNIFY_CONTRACT_CODE;
const MONNIFY_SOURCE_ACCOUNT_NUMBER = process.env.MONNIFY_SOURCE_ACCOUNT_NUMBER;
// firebase functions:secrets:set RESEND_API_KEY
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

// Sandbox for now — swap to https://api.monnify.com once you go fully live.
const MONNIFY_BASE_URL = "https://sandbox.monnify.com";

// Fallback only. Each escrow can now set its own `autoReleaseDays` at
// creation time (see CreateEscrow); this is what applies if that field is
// somehow missing (e.g. an escrow created before this feature existed).
const DEFAULT_AUTO_RELEASE_DAYS = 7;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function verifyMonnifySignature(rawBody, signatureHeader, secretKey) {
  const computedHash = crypto
    .createHmac("sha512", secretKey)
    .update(rawBody)
    .digest("hex");
  return (
    !!signatureHeader &&
    crypto.timingSafeEqual(
      Buffer.from(computedHash),
      Buffer.from(signatureHeader)
    )
  );
}

async function logTransaction(escrowId, type, payload) {
  await db.collection("transactions").add({
    escrowId,
    type,
    payload,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// Every browser-facing function needs this — the frontend (Vercel) and
// these functions (Firebase) are always different origins, in both local
// dev (Vite :5173 vs emulator :5001) and production. Safe to allow any
// origin here specifically because auth is a Bearer token in a header, not
// a cookie — there's no session to leak cross-site. monnifyWebhook is
// server-to-server and doesn't need this; it isn't wrapped.
function withCors(handler) {
  return async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    return handler(req, res);
  };
}

// Fire-and-forget-ish: logs and swallows failures rather than throwing, since
// a broken email send should never block a status update or payment flow —
// notifications are a nice-to-have, not something that can hold up money
// moving. Silently no-ops if `to` is empty (buyer email is optional).
async function sendEmail(apiKey, { to, subject, html }) {
  if (!to) return;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: "HoldPay <notifications@holdpay.app>", to, subject, html }),
    });
    if (!res.ok) {
      logger.warn(`sendEmail: Resend returned ${res.status}`, await res.text());
    }
  } catch (err) {
    logger.warn("sendEmail: failed", err);
  }
}

// Simple in-memory cache so a warm function instance reuses the same
// Monnify access token instead of re-authenticating on every call — the
// token is valid for about an hour per Monnify's docs. Resets naturally
// whenever the instance cold-starts, which is fine.
let cachedMonnifyToken = null;
let cachedMonnifyTokenExpiry = 0;

async function getMonnifyAccessToken(apiKey, secretKey) {
  if (cachedMonnifyToken && Date.now() < cachedMonnifyTokenExpiry) {
    return cachedMonnifyToken;
  }

  const basicAuth = Buffer.from(`${apiKey}:${secretKey}`).toString("base64");
  const res = await fetch(`${MONNIFY_BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth}` },
  });

  if (!res.ok) {
    throw new Error(`Monnify auth failed: ${res.status}`);
  }

  const body = await res.json();
  const token = body?.responseBody?.accessToken;
  const expiresIn = body?.responseBody?.expiresIn || 3600;

  if (!token) {
    throw new Error("Monnify auth response missing accessToken");
  }

  cachedMonnifyToken = token;
  cachedMonnifyTokenExpiry = Date.now() + (expiresIn - 60) * 1000;

  return token;
}

// ---------------------------------------------------------------------------
// createMonnifyInvoice
// Called right after an escrow doc is created (see onEscrowCreated below).
// Monnify support confirmed Reserved Accounts were the wrong feature for
// this use case — that product mandates BVN/NIN because it's designed for
// a persistent account tied to one real customer. Dynamic Invoices are
// built for exactly this instead: a fresh, single-use virtual account per
// transaction, no KYC step, with a built-in expiry. The invoiceReference
// reuses the ref already generated client-side, so payment webhooks can
// match straight back to the escrow via monnify.reservedAccountRef.
// Docs: https://developers.monnify.com/docs/collections/one-time-payments/invoice
// ---------------------------------------------------------------------------

async function createMonnifyInvoice(accessToken, contractCode, {
  invoiceReference,
  amountNaira,
  description,
  customerEmail,
  customerName,
  expiryDate, // "yyyy-MM-dd HH:mm:ss", required format per Monnify's docs
}) {
  const res = await fetch(`${MONNIFY_BASE_URL}/api/v1/invoice/create`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: amountNaira,
      invoiceReference,
      description: description || "HoldPay escrow payment",
      currencyCode: "NGN",
      contractCode,
      customerEmail: customerEmail || `buyer+${invoiceReference}@holdpay.app`,
      customerName: customerName || "HoldPay Buyer",
      expiryDate,
      paymentMethods: ["ACCOUNT_TRANSFER", "CARD"],
    }),
  });

  const body = await res.json();
  if (!res.ok || !body.requestSuccessful) {
    throw new Error(body.responseMessage || `Monnify invoice creation failed: ${res.status}`);
  }

  const invoice = body.responseBody;
  if (!invoice?.accountNumber) {
    throw new Error("Monnify invoice response missing account details");
  }

  return {
    accountNumber: invoice.accountNumber,
    bankName: invoice.bankName,
    bankCode: invoice.bankCode,
    checkoutUrl: invoice.checkoutUrl,
    invoiceReference: invoice.invoiceReference,
  };
}

// ---------------------------------------------------------------------------
// transferToSeller
// Real Monnify Single Transfer (disbursement) call — pays the seller's bank
// account from your Monnify wallet. Used by both releaseFunds (buyer-
// triggered) and autoReleaseCron (time-triggered).
// ---------------------------------------------------------------------------

async function transferToSeller(accessToken, sourceAccountNumber, {
  amountNaira,
  reference,
  narration,
  destinationAccountNumber,
  destinationBankCode,
}) {
  const res = await fetch(`${MONNIFY_BASE_URL}/api/v2/disbursements/single`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: amountNaira,
      reference,
      narration,
      destinationBankCode,
      destinationAccountNumber,
      currency: "NGN",
      sourceAccountNumber,
    }),
  });

  const body = await res.json();
  if (!res.ok || !body.requestSuccessful) {
    throw new Error(body.responseMessage || `Monnify transfer failed: ${res.status}`);
  }

  return {
    transactionReference: body.responseBody?.reference || reference,
    status: body.responseBody?.status || "UNKNOWN",
    monnifyResponse: body.responseBody,
  };
}

// ---------------------------------------------------------------------------
// 1. monnifyWebhook
//    Receives Monnify's payment notification, verifies signature,
//    and atomically moves the matching escrow pending_payment -> held.
//    Idempotent: safe if Monnify retries/fires the same event twice.
// ---------------------------------------------------------------------------

exports.monnifyWebhook = onRequest(
  { secrets: [MONNIFY_SECRET_KEY] },
  async (req, res) => {
    try {
      const signatureHeader = req.headers["monnify-signature"];
      const rawBody = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body);

      const isValid = verifyMonnifySignature(
        rawBody,
        signatureHeader,
        MONNIFY_SECRET_KEY.value()
      );

      if (!isValid) {
        logger.warn("monnifyWebhook: invalid signature, rejecting");
        return res.status(401).send("Invalid signature");
      }

      const event = req.body;

      if (event.eventType !== "SUCCESSFUL_TRANSACTION") {
        logger.info(`monnifyWebhook: ignoring event type ${event.eventType}`);
        return res.status(200).send("Ignored");
      }

      const eventData = event.eventData || {};
      const reservedAccountRef = eventData.product?.reference || eventData.paymentReference;
      const amountPaidNaira = eventData.amountPaid;

      if (!reservedAccountRef) {
        logger.error("monnifyWebhook: missing reservedAccountRef in payload");
        return res.status(400).send("Missing reference");
      }

      const escrowsRef = db.collection("escrows");
      const matchQuery = await escrowsRef
        .where("monnify.reservedAccountRef", "==", reservedAccountRef)
        .limit(1)
        .get();

      if (matchQuery.empty) {
        logger.error(`monnifyWebhook: no escrow found for ref ${reservedAccountRef}`);
        return res.status(404).send("Escrow not found");
      }

      const escrowDoc = matchQuery.docs[0];
      const escrowRef = escrowDoc.ref;

      const result = await db.runTransaction(async (tx) => {
        const freshDoc = await tx.get(escrowRef);
        const data = freshDoc.data();

        if (data.status !== "pending_payment") {
          return { alreadyProcessed: true };
        }

        const expectedAmountNaira = data.amount / 100;
        if (Math.abs(expectedAmountNaira - amountPaidNaira) > 1) {
          tx.update(escrowRef, {
            status: "disputed",
            disputedAt: admin.firestore.FieldValue.serverTimestamp(),
            disputeReason: `Amount mismatch: expected ₦${expectedAmountNaira}, received ₦${amountPaidNaira}`,
          });
          return { amountMismatch: true };
        }

        tx.update(escrowRef, {
          status: "held",
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return { success: true };
      });

      await logTransaction(escrowDoc.id, "payment_webhook", {
        rawEvent: event,
        result,
      });

      if (result.alreadyProcessed) {
        logger.info(`monnifyWebhook: escrow ${escrowDoc.id} already processed, no-op`);
      } else if (result.amountMismatch) {
        logger.warn(`monnifyWebhook: amount mismatch on escrow ${escrowDoc.id}`);
      } else {
        logger.info(`monnifyWebhook: escrow ${escrowDoc.id} moved to held`);
      }

      return res.status(200).send("OK");
    } catch (err) {
      logger.error("monnifyWebhook: unexpected error", err);
      return res.status(500).send("Internal error");
    }
  }
);

// ---------------------------------------------------------------------------
// 1a2. monnifyDisbursementWebhook
//     Separate from monnifyWebhook (payments) — configure this URL under
//     Monnify dashboard > Developers > Webhook URLs > Disbursement.
//     Monnify's synchronous transfer response only confirms a payout
//     REQUEST was accepted; this is what confirms money actually landed
//     (SUCCESSFUL_DISBURSEMENT) or definitively failed
//     (FAILED_DISBURSEMENT) — matched via payoutReference, which
//     releaseFunds/resolveDispute/autoReleaseCron all store on the escrow
//     doc when they initiate a transfer.
// ---------------------------------------------------------------------------

exports.monnifyDisbursementWebhook = onRequest(
  { secrets: [MONNIFY_SECRET_KEY] },
  async (req, res) => {
    try {
      const signatureHeader = req.headers["monnify-signature"];
      const rawBody = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body);

      if (!verifyMonnifySignature(rawBody, signatureHeader, MONNIFY_SECRET_KEY.value())) {
        logger.warn("monnifyDisbursementWebhook: invalid signature, rejecting");
        return res.status(401).send("Invalid signature");
      }

      const event = req.body;
      const eventData = event.eventData || {};
      const payoutReference = eventData.reference;

      if (!payoutReference) {
        logger.error("monnifyDisbursementWebhook: missing reference in payload");
        return res.status(400).send("Missing reference");
      }

      const match = await db
        .collection("escrows")
        .where("payoutReference", "==", payoutReference)
        .limit(1)
        .get();

      if (match.empty) {
        logger.error(`monnifyDisbursementWebhook: no escrow found for payoutReference ${payoutReference}`);
        return res.status(404).send("Escrow not found");
      }

      const escrowDoc = match.docs[0];

      if (event.eventType === "SUCCESSFUL_DISBURSEMENT") {
        await escrowDoc.ref.update({ payoutStatus: "success" });
        await logTransaction(escrowDoc.id, "payout_confirmed", { rawEvent: event });
        logger.info(`monnifyDisbursementWebhook: payout confirmed for escrow ${escrowDoc.id}`);
      } else if (event.eventType === "FAILED_DISBURSEMENT") {
        await escrowDoc.ref.update({ payoutStatus: "failed" });
        await logTransaction(escrowDoc.id, "payout_failed_confirmed", {
          reason: eventData.transactionDescription,
          rawEvent: event,
        });
        logger.error(
          `monnifyDisbursementWebhook: payout confirmed FAILED for escrow ${escrowDoc.id} — ` +
            `${eventData.transactionDescription}. Needs manual retry.`
        );
      } else {
        logger.info(`monnifyDisbursementWebhook: ignoring event type ${event.eventType}`);
      }

      return res.status(200).send("OK");
    } catch (err) {
      logger.error("monnifyDisbursementWebhook: unexpected error", err);
      return res.status(500).send("Internal error");
    }
  }
);

// ---------------------------------------------------------------------------
// 1b. getEscrowByToken
// ---------------------------------------------------------------------------

exports.getEscrowByToken = onRequest(withCors(async (req, res) => {
  try {
    const token = req.query.token || (req.body && req.body.token);
    if (!token) {
      return res.status(400).send("Missing token");
    }

    const match = await db
      .collection("escrows")
      .where("buyerConfirmToken", "==", token)
      .limit(1)
      .get();

    if (match.empty) {
      return res.status(404).send("Not found");
    }

    const doc = match.docs[0];
    const data = doc.data();

    let sellerStats = { completedCount: 0, disputedCount: 0 };
    if (data.sellerUid) {
      const statsDoc = await db.collection("sellerStats").doc(data.sellerUid).get();
      if (statsDoc.exists) {
        const s = statsDoc.data();
        sellerStats = {
          completedCount: s.completedCount || 0,
          disputedCount: s.disputedCount || 0,
        };
      }
    }

    return res.status(200).json({
      escrowId: doc.id,
      status: data.status,
      itemDesc: data.itemDesc,
      photoUrl: data.photoUrl || null,
      amount: data.amount,
      sellerStats,
      monnify: data.monnify
        ? {
            reservedAccountNumber: data.monnify.reservedAccountNumber,
            bankName: data.monnify.bankName,
            checkoutUrl: data.monnify.checkoutUrl || null,
          }
        : null,
      paidAt: data.paidAt || null,
      shippedAt: data.shippedAt || null,
      autoReleaseAt: data.autoReleaseAt ? data.autoReleaseAt.toMillis() : null,
      autoReleaseDays: Number.isFinite(data.autoReleaseDays)
        ? data.autoReleaseDays
        : DEFAULT_AUTO_RELEASE_DAYS,
      confirmedAt: data.confirmedAt || null,
      releasedAt: data.releasedAt || null,
      disputedAt: data.disputedAt || null,
    });
  } catch (err) {
    logger.error("getEscrowByToken: unexpected error", err);
    return res.status(500).send("Internal error");
  }
}));

// ---------------------------------------------------------------------------
// 1c. getBanks
//     Powers a real bank-name dropdown on the create form instead of a raw
//     code text input — pulls the live list from Monnify rather than a
//     hardcoded array, so codes can't drift out of sync with what Monnify
//     actually accepts. Cached in memory for an hour since this barely
//     changes and it's called on every visit to the create page.
// ---------------------------------------------------------------------------

let cachedBanks = null;
let cachedBanksExpiry = 0;

exports.getBanks = onRequest(
  { secrets: [MONNIFY_API_KEY, MONNIFY_SECRET_KEY] },
  withCors(async (req, res) => {
    try {
      if (cachedBanks && Date.now() < cachedBanksExpiry) {
        return res.status(200).json({ banks: cachedBanks });
      }

      const accessToken = await getMonnifyAccessToken(
        MONNIFY_API_KEY.value(),
        MONNIFY_SECRET_KEY.value()
      );

      const banksRes = await fetch(`${MONNIFY_BASE_URL}/api/v1/banks`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await banksRes.json();

      if (!banksRes.ok || !body.requestSuccessful) {
        logger.warn("getBanks: Monnify returned an error", body);
        return res.status(502).json({ error: "Couldn't load bank list" });
      }

      const banks = (body.responseBody || [])
        .map((b) => ({ code: b.code, name: b.name }))
        .sort((a, b) => a.name.localeCompare(b.name));

      cachedBanks = banks;
      cachedBanksExpiry = Date.now() + 60 * 60 * 1000;

      return res.status(200).json({ banks });
    } catch (err) {
      logger.error("getBanks: unexpected error", err);
      return res.status(500).json({ error: "Internal error" });
    }
  })
);

// ---------------------------------------------------------------------------
// 1d. resolveBankAccount
// ---------------------------------------------------------------------------

exports.resolveBankAccount = onRequest(
  { secrets: [MONNIFY_API_KEY, MONNIFY_SECRET_KEY] },
  withCors(async (req, res) => {
    try {
      if (req.method !== "POST") {
        return res.status(405).send("Method not allowed");
      }

      const idToken = (req.headers.authorization || "").replace("Bearer ", "");
      if (!idToken) {
        return res.status(401).send("Missing auth token");
      }
      try {
        await admin.auth().verifyIdToken(idToken);
      } catch (err) {
        return res.status(401).send("Invalid auth token");
      }

      const { accountNumber, bankCode } = req.body || {};
      if (!accountNumber || !bankCode) {
        return res.status(400).send("Missing accountNumber or bankCode");
      }

      const accessToken = await getMonnifyAccessToken(
        MONNIFY_API_KEY.value(),
        MONNIFY_SECRET_KEY.value()
      );

      const validateRes = await fetch(
        `${MONNIFY_BASE_URL}/api/v1/disbursements/account/validate?` +
          `accountNumber=${encodeURIComponent(accountNumber)}&bankCode=${encodeURIComponent(bankCode)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      const body = await validateRes.json();

      if (!validateRes.ok || !body.requestSuccessful) {
        logger.warn("resolveBankAccount: validation failed", body);
        return res.status(422).json({
          error: body.responseMessage || "Couldn't verify that account number. Double-check it and the bank.",
        });
      }

      return res.status(200).json({
        accountName: body.responseBody?.accountName || null,
        accountNumber: body.responseBody?.accountNumber || accountNumber,
        bankCode,
      });
    } catch (err) {
      logger.error("resolveBankAccount: unexpected error", err);
      return res.status(500).send("Internal error");
    }
  })
);

// ---------------------------------------------------------------------------
// Seller trust stats + reserved account creation — escrows/{escrowId} triggers
// ---------------------------------------------------------------------------

exports.onEscrowCreated = onDocumentCreated(
  {
    document: "escrows/{escrowId}",
    secrets: [RESEND_API_KEY, MONNIFY_API_KEY, MONNIFY_SECRET_KEY],
  },
  async (event) => {
    const escrowId = event.params.escrowId;
    const data = event.data?.data();
    if (!data?.sellerUid) return;

    await db
      .collection("sellerStats")
      .doc(data.sellerUid)
      .set({ totalCount: admin.firestore.FieldValue.increment(1) }, { merge: true });

    // --- Real Monnify Dynamic Invoice creation ---
    // Only runs if this escrow doesn't already have a real account number
    // (guards against double-creating if this trigger somehow re-runs).
    if (data.monnify?.reservedAccountNumber === "PENDING" || !data.monnify?.reservedAccountNumber) {
      try {
        const accessToken = await getMonnifyAccessToken(
          MONNIFY_API_KEY.value(),
          MONNIFY_SECRET_KEY.value()
        );

        // 3 days to pay before the invoice (and its virtual account) expires
        // — Monnify wants "yyyy-MM-dd HH:mm:ss", not ISO.
        const expiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
        const expiryDate = expiry.toISOString().slice(0, 19).replace("T", " ");

        const invoice = await createMonnifyInvoice(
          accessToken,
          MONNIFY_CONTRACT_CODE,
          {
            // Reuse the ref already generated client-side at creation time
            // (see CreateEscrow.jsx) — the webhook matches on this exact
            // field, so keeping it as the single source of truth here
            // means nothing downstream needs to change.
            invoiceReference: data.monnify.reservedAccountRef,
            amountNaira: data.amount / 100,
            description: data.itemDesc?.slice(0, 100),
            customerEmail: data.buyerContact?.email,
            customerName: data.buyerContact?.phone || "HoldPay Buyer",
            expiryDate,
          }
        );

        await event.data.ref.update({
          "monnify.reservedAccountNumber": invoice.accountNumber,
          "monnify.bankName": invoice.bankName,
          "monnify.bankCode": invoice.bankCode,
          "monnify.checkoutUrl": invoice.checkoutUrl,
        });

        await logTransaction(escrowId, "invoice_created", { invoice });
        logger.info(`onEscrowCreated: invoice created for escrow ${escrowId}`);
      } catch (err) {
        // Don't let a Monnify outage silently strand the escrow — flag it
        // so you notice in the dashboard/logs rather than a buyer hitting
        // a broken "PENDING" account number on their payment page.
        logger.error(`onEscrowCreated: invoice creation failed for ${escrowId}`, err);
        await logTransaction(escrowId, "invoice_creation_failed", {
          error: err.message,
        });
      }
    }

    if (data.buyerContact?.email) {
      const naira = `₦${(data.amount / 100).toLocaleString("en-NG")}`;
      await sendEmail(RESEND_API_KEY.value(), {
        to: data.buyerContact.email,
        subject: `An escrow was set up for "${data.itemDesc}"`,
        html: `<p>A seller has set up a HoldPay escrow for <strong>${data.itemDesc}</strong> (${naira}). Open the payment link they sent you to pay into a protected account — your money stays held until you confirm the item arrived.</p>`,
      });
    }
  }
);

exports.onEscrowStatusChange = onDocumentUpdated(
  { document: "escrows/{escrowId}", secrets: [RESEND_API_KEY] },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after || before.status === after.status) return;
    if (!after.sellerUid) return;

    const updates = {};
    if (after.status === "released") {
      updates.completedCount = admin.firestore.FieldValue.increment(1);
    }
    if (after.status === "disputed") {
      updates.disputedCount = admin.firestore.FieldValue.increment(1);
    }
    if (Object.keys(updates).length > 0) {
      await db.collection("sellerStats").doc(after.sellerUid).set(updates, { merge: true });
    }

    let sellerEmail = null;
    try {
      sellerEmail = (await admin.auth().getUser(after.sellerUid)).email;
    } catch (err) {
      logger.warn("onEscrowStatusChange: couldn't look up seller email", err);
    }

    const buyerEmail = after.buyerContact?.email;
    const apiKey = RESEND_API_KEY.value();
    const naira = `₦${(after.amount / 100).toLocaleString("en-NG")}`;
    const item = after.itemDesc;

    if (after.status === "held") {
      await sendEmail(apiKey, {
        to: sellerEmail,
        subject: `Payment received — "${item}"`,
        html: `<p>${naira} is now held for <strong>${item}</strong>. Ship the item, then mark it shipped on your HoldPay dashboard.</p>`,
      });
    } else if (after.status === "shipped") {
      await sendEmail(apiKey, {
        to: buyerEmail,
        subject: `Your item has shipped — "${item}"`,
        html: `<p>The seller marked <strong>${item}</strong> as shipped. Confirm receipt on your payment link once it arrives so the seller gets paid — or raise a dispute if something's wrong.</p>`,
      });
    } else if (after.status === "released") {
      await sendEmail(apiKey, {
        to: buyerEmail,
        subject: `Funds released — "${item}"`,
        html: `<p>Funds for <strong>${item}</strong> have been released to the seller. Thanks for using HoldPay.</p>`,
      });
      await sendEmail(apiKey, {
        to: sellerEmail,
        subject: `You've been paid — "${item}"`,
        html: `<p>${naira} for <strong>${item}</strong> has been released to your account.</p>`,
      });
    } else if (after.status === "disputed") {
      await sendEmail(apiKey, {
        to: sellerEmail,
        subject: `Dispute raised — "${item}"`,
        html: `<p>The buyer raised a dispute on <strong>${item}</strong>${
          after.disputeReason ? `: "${after.disputeReason}"` : ""
        }. This escrow is frozen until it's resolved.</p>`,
      });
    }
  }
);

// ---------------------------------------------------------------------------
// 2. releaseFunds
//    Called from the buyer's confirmation link. Validates the token,
//    transitions held/shipped -> released, and triggers a real Monnify
//    Single Transfer payout to the seller.
// ---------------------------------------------------------------------------

exports.releaseFunds = onRequest(
  { secrets: [MONNIFY_API_KEY, MONNIFY_SECRET_KEY] },
  withCors(async (req, res) => {
    try {
      if (req.method !== "POST") {
        return res.status(405).send("Method not allowed");
      }

      const { escrowId, token } = req.body || {};
      if (!escrowId || !token) {
        return res.status(400).send("Missing escrowId or token");
      }

      const escrowRef = db.collection("escrows").doc(escrowId);

      const result = await db.runTransaction(async (tx) => {
        const doc = await tx.get(escrowRef);
        if (!doc.exists) {
          return { error: "not_found" };
        }
        const data = doc.data();

        if (data.buyerConfirmToken !== token) {
          return { error: "invalid_token" };
        }

        if (!["held", "shipped"].includes(data.status)) {
          return { error: "invalid_state", currentStatus: data.status };
        }

        // Mark released now, inside the transaction, so a retry/double-click
        // can't trigger two transfers — the Monnify call happens after,
        // gated on this transaction having succeeded first.
        tx.update(escrowRef, {
          status: "released",
          confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
          releasedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return {
          success: true,
          sellerBankAccount: data.sellerBankAccount,
          amount: data.amount,
          itemDesc: data.itemDesc,
        };
      });

      if (result.error === "not_found") return res.status(404).send("Escrow not found");
      if (result.error === "invalid_token") return res.status(403).send("Invalid confirmation token");
      if (result.error === "invalid_state") {
        return res.status(409).send(`Cannot release from status: ${result.currentStatus}`);
      }

      try {
        const accessToken = await getMonnifyAccessToken(
          MONNIFY_API_KEY.value(),
          MONNIFY_SECRET_KEY.value()
        );

        const payoutReference = `HP-RELEASE-${escrowId}-${Date.now()}`;
        const transfer = await transferToSeller(
          accessToken,
          MONNIFY_SOURCE_ACCOUNT_NUMBER,
          {
            amountNaira: result.amount / 100,
            reference: payoutReference,
            narration: `HoldPay payout: ${result.itemDesc}`.slice(0, 100),
            destinationAccountNumber: result.sellerBankAccount.accountNumber,
            destinationBankCode: result.sellerBankAccount.bankCode,
          }
        );

        // Monnify's synchronous response only confirms the REQUEST was
        // accepted, not that money definitively landed — real transfers can
        // resolve async (insufficient balance, etc.), which only the
        // SUCCESSFUL_DISBURSEMENT/FAILED_DISBURSEMENT webhook confirms for
        // certain. If the sync response already says SUCCESS (typical when
        // 2FA isn't enabled on the account), trust it; otherwise wait on
        // the webhook rather than assuming.
        const definitiveNow = transfer.status === "SUCCESS";
        await escrowRef.update({
          payoutReference,
          payoutStatus: definitiveNow ? "success" : "pending",
        });

        await logTransaction(escrowId, "transfer_initiated", {
          amount: result.amount,
          sellerBankAccount: result.sellerBankAccount,
          transferResponse: transfer,
        });

        logger.info(`releaseFunds: escrow ${escrowId} released, transfer ${transfer.transactionReference}`);
        return res.status(200).json({ status: "released", transfer });
      } catch (transferErr) {
        // Status is already "released" in Firestore at this point — the
        // escrow itself succeeded from the buyer's perspective. A failed
        // transfer here needs manual follow-up (retry the payout), not a
        // rollback of the confirmation, since the buyer already confirmed
        // receipt of a real item. payoutStatus makes this visible to the
        // seller instead of the failure sitting only in logs.
        logger.error(`releaseFunds: transfer failed for escrow ${escrowId}`, transferErr);
        await escrowRef.update({ payoutStatus: "failed" });
        await logTransaction(escrowId, "transfer_failed", { error: transferErr.message });
        return res.status(200).json({
          status: "released",
          transfer: { status: "FAILED", note: "Payout failed — needs manual retry. Escrow status is still released." },
        });
      }
    } catch (err) {
      logger.error("releaseFunds: unexpected error", err);
      return res.status(500).send("Internal error");
    }
  })
);

// ---------------------------------------------------------------------------
// 2b. markShipped
// ---------------------------------------------------------------------------

exports.markShipped = onRequest(withCors(async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).send("Method not allowed");
    }

    const idToken = (req.headers.authorization || "").replace("Bearer ", "");
    if (!idToken) {
      return res.status(401).send("Missing auth token");
    }

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
      return res.status(401).send("Invalid auth token");
    }

    const { escrowId } = req.body || {};
    if (!escrowId) {
      return res.status(400).send("Missing escrowId");
    }

    const escrowRef = db.collection("escrows").doc(escrowId);

    const result = await db.runTransaction(async (tx) => {
      const doc = await tx.get(escrowRef);
      if (!doc.exists) return { error: "not_found" };
      const data = doc.data();

      if (data.sellerUid !== decoded.uid) return { error: "forbidden" };
      if (data.status !== "held") return { error: "invalid_state", currentStatus: data.status };

      const autoReleaseDays = Number.isFinite(data.autoReleaseDays)
        ? data.autoReleaseDays
        : DEFAULT_AUTO_RELEASE_DAYS;

      const autoReleaseAt = admin.firestore.Timestamp.fromDate(
        new Date(Date.now() + autoReleaseDays * 24 * 60 * 60 * 1000)
      );

      tx.update(escrowRef, {
        status: "shipped",
        shippedAt: admin.firestore.FieldValue.serverTimestamp(),
        autoReleaseAt,
      });

      return { success: true };
    });

    if (result.error === "not_found") return res.status(404).send("Escrow not found");
    if (result.error === "forbidden") return res.status(403).send("Not your escrow");
    if (result.error === "invalid_state") {
      return res.status(409).send(`Cannot ship from status: ${result.currentStatus}`);
    }

    await logTransaction(escrowId, "shipped", { by: decoded.uid });
    return res.status(200).json({ status: "shipped" });
  } catch (err) {
    logger.error("markShipped: unexpected error", err);
    return res.status(500).send("Internal error");
  }
}));

// ---------------------------------------------------------------------------
// 2c. raiseDispute
// ---------------------------------------------------------------------------

exports.raiseDispute = onRequest(withCors(async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).send("Method not allowed");
    }

    const { escrowId, token, reason } = req.body || {};
    if (!escrowId || !token) {
      return res.status(400).send("Missing escrowId or token");
    }

    const escrowRef = db.collection("escrows").doc(escrowId);

    const result = await db.runTransaction(async (tx) => {
      const doc = await tx.get(escrowRef);
      if (!doc.exists) return { error: "not_found" };
      const data = doc.data();

      if (data.buyerConfirmToken !== token) return { error: "invalid_token" };
      if (!["held", "shipped"].includes(data.status)) {
        return { error: "invalid_state", currentStatus: data.status };
      }

      tx.update(escrowRef, {
        status: "disputed",
        disputedAt: admin.firestore.FieldValue.serverTimestamp(),
        disputeReason: (reason || "No reason given").slice(0, 500),
      });
      return { success: true };
    });

    if (result.error === "not_found") return res.status(404).send("Escrow not found");
    if (result.error === "invalid_token") return res.status(403).send("Invalid confirmation token");
    if (result.error === "invalid_state") {
      return res.status(409).send(`Cannot dispute from status: ${result.currentStatus}`);
    }

    await logTransaction(escrowId, "disputed", { reason: reason || "No reason given" });
    return res.status(200).json({ status: "disputed" });
  } catch (err) {
    logger.error("raiseDispute: unexpected error", err);
    return res.status(500).send("Internal error");
  }
}));

// ---------------------------------------------------------------------------
// Admin gating
// Hardcoded allow-list rather than a Firestore role field — simplest thing
// that's actually safe for a hackathon timeline. Add your own email(s)
// here before deploying. Checked against the verified Firebase Auth token,
// not anything the client can spoof.
// ---------------------------------------------------------------------------

const ADMIN_EMAILS = [
  "davidbibiresanmi@gmail.com",
  // add teammates' emails here
];

async function requireAdmin(req) {
  const idToken = (req.headers.authorization || "").replace("Bearer ", "");
  if (!idToken) throw { status: 401, message: "Missing auth token" };

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    throw { status: 401, message: "Invalid auth token" };
  }

  if (!decoded.email || !ADMIN_EMAILS.includes(decoded.email)) {
    throw { status: 403, message: "Not authorized" };
  }

  return decoded;
}

// ---------------------------------------------------------------------------
// getEscrowTimeline
//     Surfaces the transactions/ audit log for one escrow, safe for either
//     the buyer (via their token) or the seller (via auth) to view. Never
//     returns raw payloads (webhook bodies, bank details) — only a short,
//     human-readable label per event, generated server-side so nothing
//     sensitive leaks through regardless of what's stored internally.
// ---------------------------------------------------------------------------

function describeTransactionEvent(type) {
  const labels = {
    created: "Escrow created",
    reserved_account_created: "Payment account ready",
    reserved_account_creation_failed: "Payment account setup delayed",
    payment_webhook: "Payment received",
    shipped: "Item marked as shipped",
    disputed: "Dispute raised",
    dispute_resolved: "Dispute resolved",
    transfer_initiated: "Payout sent to seller",
    transfer_failed: "Payout attempt failed — retrying",
    auto_released: "Funds auto-released (no confirmation in time)",
    bank_account_updated: "Seller updated payout details",
  };
  return labels[type] || type;
}

exports.getEscrowTimeline = onRequest(withCors(async (req, res) => {
  try {
    const { escrowId, token } = req.query;
    if (!escrowId) return res.status(400).send("Missing escrowId");

    const escrowRef = db.collection("escrows").doc(escrowId);
    const escrowDoc = await escrowRef.get();
    if (!escrowDoc.exists) return res.status(404).send("Escrow not found");
    const data = escrowDoc.data();

    // Access check: either the buyer's token matches, or the caller is the
    // authenticated seller who owns this escrow.
    let authorized = token && data.buyerConfirmToken === token;
    if (!authorized) {
      const idToken = (req.headers.authorization || "").replace("Bearer ", "");
      if (idToken) {
        try {
          const decoded = await admin.auth().verifyIdToken(idToken);
          authorized = decoded.uid === data.sellerUid || ADMIN_EMAILS.includes(decoded.email);
        } catch (err) {
          // falls through to authorized = false
        }
      }
    }
    if (!authorized) return res.status(403).send("Not authorized to view this timeline");

    const snap = await db
      .collection("transactions")
      .where("escrowId", "==", escrowId)
      .orderBy("createdAt", "asc")
      .get();

    const events = snap.docs.map((d) => {
      const t = d.data();
      return {
        type: t.type,
        label: describeTransactionEvent(t.type),
        createdAt: t.createdAt ? t.createdAt.toMillis() : null,
      };
    });

    return res.status(200).json({ events });
  } catch (err) {
    logger.error("getEscrowTimeline: unexpected error", err);
    return res.status(500).send("Internal error");
  }
}));

// ---------------------------------------------------------------------------
// resolveDispute
//     Admin action closing out a disputed escrow — either releases funds to
//     the seller (real Monnify transfer, same path as releaseFunds) or
//     marks it refunded. Refund is recorded but NOT auto-transferred to the
//     buyer — Monnify's reserved account flow doesn't collect the buyer's
//     bank details anywhere, so an automated buyer payout isn't safely
//     possible yet. Refunds need manual bank transfer outside the app for
//     now; this just closes the escrow's state honestly instead of
//     pretending it's automated.
// ---------------------------------------------------------------------------

exports.resolveDispute = onRequest(
  { secrets: [MONNIFY_API_KEY, MONNIFY_SECRET_KEY] },
  withCors(async (req, res) => {
    try {
      if (req.method !== "POST") {
        return res.status(405).send("Method not allowed");
      }

      let admin_;
      try {
        admin_ = await requireAdmin(req);
      } catch (err) {
        return res.status(err.status || 500).send(err.message || "Error");
      }

      const { escrowId, action, note } = req.body || {};
      if (!escrowId || !["release", "refund"].includes(action)) {
        return res.status(400).send("Missing escrowId or invalid action (release|refund)");
      }

      const escrowRef = db.collection("escrows").doc(escrowId);
      const doc = await escrowRef.get();
      if (!doc.exists) return res.status(404).send("Escrow not found");
      const data = doc.data();

      if (data.status !== "disputed") {
        return res.status(409).send(`Cannot resolve from status: ${data.status}`);
      }

      if (action === "refund") {
        await escrowRef.update({
          status: "refunded",
          releasedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        await logTransaction(escrowId, "dispute_resolved", {
          action: "refund",
          by: admin_.email,
          note: note || null,
        });
        return res.status(200).json({ status: "refunded" });
      }

      // action === "release"
      await escrowRef.update({
        status: "released",
        releasedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      try {
        const accessToken = await getMonnifyAccessToken(
          MONNIFY_API_KEY.value(),
          MONNIFY_SECRET_KEY.value()
        );
        const payoutReference = `HP-DISPUTE-RELEASE-${escrowId}-${Date.now()}`;
        const transfer = await transferToSeller(
          accessToken,
          MONNIFY_SOURCE_ACCOUNT_NUMBER,
          {
            amountNaira: data.amount / 100,
            reference: payoutReference,
            narration: `HoldPay dispute payout: ${data.itemDesc}`.slice(0, 100),
            destinationAccountNumber: data.sellerBankAccount.accountNumber,
            destinationBankCode: data.sellerBankAccount.bankCode,
          }
        );
        await escrowRef.update({
          payoutReference,
          payoutStatus: transfer.status === "SUCCESS" ? "success" : "pending",
        });
        await logTransaction(escrowId, "dispute_resolved", {
          action: "release",
          by: admin_.email,
          note: note || null,
          transferResponse: transfer,
        });
        return res.status(200).json({ status: "released", transfer });
      } catch (transferErr) {
        logger.error(`resolveDispute: transfer failed for ${escrowId}`, transferErr);
        await escrowRef.update({ payoutStatus: "failed" });
        await logTransaction(escrowId, "transfer_failed", { error: transferErr.message });
        return res.status(200).json({
          status: "released",
          transfer: { status: "FAILED", note: "Payout failed — needs manual retry." },
        });
      }
    } catch (err) {
      logger.error("resolveDispute: unexpected error", err);
      return res.status(500).send("Internal error");
    }
  })
);

// ---------------------------------------------------------------------------
// adminListEscrows
//     Powers the general admin dashboard — every escrow across every
//     seller, since Firestore rules correctly block cross-seller reads
//     client-side. Optional status filter via query param.
// ---------------------------------------------------------------------------

exports.adminListEscrows = onRequest(withCors(async (req, res) => {
  try {
    try {
      await requireAdmin(req);
    } catch (err) {
      return res.status(err.status || 500).send(err.message || "Error");
    }

    const statusFilter = req.query.status;
    let query = db.collection("escrows").orderBy("createdAt", "desc").limit(200);
    if (statusFilter) {
      query = db
        .collection("escrows")
        .where("status", "==", statusFilter)
        .orderBy("createdAt", "desc")
        .limit(200);
    }

    const snap = await query.get();
    const escrows = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        status: data.status,
        itemDesc: data.itemDesc,
        amount: data.amount,
        sellerUid: data.sellerUid,
        disputeReason: data.disputeReason || null,
        createdAt: data.createdAt ? data.createdAt.toMillis() : null,
        disputedAt: data.disputedAt ? data.disputedAt.toMillis() : null,
      };
    });

    return res.status(200).json({ escrows });
  } catch (err) {
    logger.error("adminListEscrows: unexpected error", err);
    return res.status(500).send("Internal error");
  }
}));

// ---------------------------------------------------------------------------
// 3. autoReleaseCron
//    Runs every 6 hours. Sends a 24h-ahead reminder, then auto-releases
//    (with a real Monnify transfer) anything past its per-escrow deadline.
// ---------------------------------------------------------------------------

exports.autoReleaseCron = onSchedule(
  {
    schedule: "every 6 hours",
    secrets: [RESEND_API_KEY, MONNIFY_API_KEY, MONNIFY_SECRET_KEY],
  },
  async () => {
    const now = admin.firestore.Timestamp.now();
    const apiKey = RESEND_API_KEY.value();

    // --- Reminder pass -----------------------------------------------------
    const reminderCutoff = admin.firestore.Timestamp.fromDate(
      new Date(Date.now() + 24 * 60 * 60 * 1000)
    );
    const dueForReminder = await db
      .collection("escrows")
      .where("status", "==", "shipped")
      .where("autoReleaseAt", "<=", reminderCutoff)
      .where("reminderSentAt", "==", null)
      .get();

    for (const doc of dueForReminder.docs) {
      const data = doc.data();
      try {
        if (data.buyerContact?.email) {
          await sendEmail(apiKey, {
            to: data.buyerContact.email,
            subject: `Reminder: confirm receipt of "${data.itemDesc}"`,
            html: `<p>Funds for <strong>${data.itemDesc}</strong> auto-release to the seller soon unless you confirm receipt or raise a dispute first.</p>`,
          });
        }
        await doc.ref.update({ reminderSentAt: admin.firestore.FieldValue.serverTimestamp() });
      } catch (err) {
        logger.error(`autoReleaseCron: reminder failed for escrow ${doc.id}`, err);
      }
    }

    // --- Release pass --------------------------------------------------
    const staleShipped = await db
      .collection("escrows")
      .where("status", "==", "shipped")
      .where("autoReleaseAt", "<=", now)
      .get();

    if (staleShipped.empty) {
      logger.info("autoReleaseCron: nothing to release");
      return;
    }

    logger.info(`autoReleaseCron: found ${staleShipped.size} escrow(s) to auto-release`);

    for (const doc of staleShipped.docs) {
      const escrowRef = doc.ref;
      const data = doc.data();
      try {
        const released = await db.runTransaction(async (tx) => {
          const fresh = await tx.get(escrowRef);
          const freshData = fresh.data();
          if (freshData.status !== "shipped") return false; // race with buyer confirm

          tx.update(escrowRef, {
            status: "released",
            releasedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          return true;
        });

        if (!released) continue;

        await logTransaction(doc.id, "auto_released", {
          reason: "No confirmation within the auto-release window",
        });

        try {
          const accessToken = await getMonnifyAccessToken(
            MONNIFY_API_KEY.value(),
            MONNIFY_SECRET_KEY.value()
          );
          const payoutReference = `HP-AUTORELEASE-${doc.id}-${Date.now()}`;
          const transfer = await transferToSeller(
            accessToken,
            MONNIFY_SOURCE_ACCOUNT_NUMBER,
            {
              amountNaira: data.amount / 100,
              reference: payoutReference,
              narration: `HoldPay payout: ${data.itemDesc}`.slice(0, 100),
              destinationAccountNumber: data.sellerBankAccount.accountNumber,
              destinationBankCode: data.sellerBankAccount.bankCode,
            }
          );
          await doc.ref.update({
            payoutReference,
            payoutStatus: transfer.status === "SUCCESS" ? "success" : "pending",
          });
          await logTransaction(doc.id, "transfer_initiated", { transferResponse: transfer });
          logger.info(`autoReleaseCron: auto-released and paid out escrow ${doc.id}`);
        } catch (transferErr) {
          logger.error(`autoReleaseCron: transfer failed for ${doc.id}`, transferErr);
          await doc.ref.update({ payoutStatus: "failed" });
          await logTransaction(doc.id, "transfer_failed", { error: transferErr.message });
        }

        // Emails for the status transition itself are handled by onEscrowStatusChange.
      } catch (err) {
        logger.error(`autoReleaseCron: failed for escrow ${doc.id}`, err);
      }
    }
  }
);
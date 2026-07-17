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
const MONNIFY_SECRET_KEY = defineSecret("MONNIFY_SECRET_KEY");
const MONNIFY_API_KEY = defineSecret("MONNIFY_API_KEY");
// firebase functions:secrets:set RESEND_API_KEY
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

// Sandbox for now — swap to https://api.monnify.com once you go live.
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
      // "from" needs a domain verified in your Resend dashboard — swap this
      // for whatever you already set up for NACOS.
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
  // Refresh a little early so we never hand out a token that's about to expire.
  cachedMonnifyTokenExpiry = Date.now() + (expiresIn - 60) * 1000;

  return token;
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

      // Only care about successful reserved-account payment events.
      // Monnify's actual event name may differ slightly by product config —
      // confirm against your sandbox dashboard's webhook payload sample.
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

      // Transaction guarantees idempotency: if this fires twice (Monnify
      // retries on any non-200), the second run sees status != pending_payment
      // and no-ops instead of double-crediting.
      const result = await db.runTransaction(async (tx) => {
        const freshDoc = await tx.get(escrowRef);
        const data = freshDoc.data();

        if (data.status !== "pending_payment") {
          return { alreadyProcessed: true };
        }

        const expectedAmountNaira = data.amount / 100;
        if (Math.abs(expectedAmountNaira - amountPaidNaira) > 1) {
          // Amount mismatch — flag instead of silently accepting a short/over payment.
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

      // Always 200 once we've validly processed (or safely ignored) the event —
      // Monnify will keep retrying on non-2xx responses.
      return res.status(200).send("OK");
    } catch (err) {
      logger.error("monnifyWebhook: unexpected error", err);
      return res.status(500).send("Internal error");
    }
  }
);

// ---------------------------------------------------------------------------
// 1b. getEscrowByToken
//     Lets the unauthenticated buyer page look up escrow status/details
//     using only the token from their confirm link — never exposes other
//     escrows since Firestore rules block direct client reads.
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

    // Trust stats are a separate lookup, not embedded on the escrow doc —
    // sellerStats/{uid} is a running counter kept in sync by the
    // onEscrowStatusChange trigger below, so this stays a single cheap
    // doc read rather than counting the seller's whole escrow history
    // on every buyer page load.
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

    // Only return fields the buyer actually needs — never leak seller bank
    // details or the token itself back out.
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
          }
        : null,
      paidAt: data.paidAt || null,
      shippedAt: data.shippedAt || null,
      // Sent as epoch millis, not the raw Firestore Timestamp — plain JSON
      // has no Timestamp type, so the client would otherwise receive an
      // opaque {seconds, nanoseconds} object with no .toDate().
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
// 1b. getBanks
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
// 1c. resolveBankAccount
//     Called from the seller's form (debounced, on blur of the account
//     fields) to confirm the account name tied to an account number + bank
//     code BEFORE it's saved as the payout destination. Uses Monnify's
//     free Name Enquiry API (available on sandbox and live). Requires the
//     seller to be authenticated — this is a paid-adjacent lookup, not a
//     public endpoint.
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
// 1d. updateSellerBankAccount
//     Lets a seller fix their own payout destination any time before an
//     escrow has released — this only changes WHERE money goes, never
//     what the buyer agreed to, so it's safe to allow post-creation
//     (unlike item/price, which are locked once payment is in motion).
//     Re-validates the new account through Monnify and writes an audit
//     entry, since this field controls where real money lands.
// ---------------------------------------------------------------------------

exports.updateSellerBankAccount = onRequest(
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
      let decoded;
      try {
        decoded = await admin.auth().verifyIdToken(idToken);
      } catch (err) {
        return res.status(401).send("Invalid auth token");
      }

      const { escrowId, accountNumber, bankCode } = req.body || {};
      if (!escrowId || !accountNumber || !bankCode) {
        return res.status(400).send("Missing escrowId, accountNumber, or bankCode");
      }

      const escrowRef = db.collection("escrows").doc(escrowId);
      const doc = await escrowRef.get();
      if (!doc.exists) return res.status(404).send("Escrow not found");

      const data = doc.data();
      if (data.sellerUid !== decoded.uid) return res.status(403).send("Not your escrow");
      if (data.status === "released") {
        return res.status(409).send("Can't change payout details after funds have released");
      }

      // Re-validate against Monnify before saving — same check as at
      // creation time. Non-fatal if it fails: we still let the seller
      // update the field, just without the confirmed account name.
      let accountName = "";
      try {
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
        if (validateRes.ok && body.requestSuccessful) {
          accountName = body.responseBody?.accountName || "";
        }
      } catch (err) {
        logger.warn("updateSellerBankAccount: Monnify validation failed, saving unverified", err);
      }

      const oldAccount = data.sellerBankAccount || {};

      await escrowRef.update({
        sellerBankAccount: { accountNumber, bankCode, accountName },
      });

      // Worth its own audit entry, separate from the general transaction
      // log noise — this is the one field edit that changes where money
      // actually goes.
      await logTransaction(escrowId, "bank_account_updated", {
        by: decoded.uid,
        from: { accountNumber: oldAccount.accountNumber, bankCode: oldAccount.bankCode },
        to: { accountNumber, bankCode, accountName },
      });

      return res.status(200).json({ accountName });
    } catch (err) {
      logger.error("updateSellerBankAccount: unexpected error", err);
      return res.status(500).send("Internal error");
    }
  })
);

// ---------------------------------------------------------------------------
// Seller trust stats — sellerStats/{sellerUid}
// Kept in sync by Firestore triggers rather than manual increments inside
// every function that can change an escrow's status, so a new code path
// (or a bug in one) can't silently skip updating the counter.
// ---------------------------------------------------------------------------

exports.onEscrowCreated = onDocumentCreated(
  { document: "escrows/{escrowId}", secrets: [RESEND_API_KEY] },
  async (event) => {
    const data = event.data?.data();
    if (!data?.sellerUid) return;

    await db
      .collection("sellerStats")
      .doc(data.sellerUid)
      .set({ totalCount: admin.firestore.FieldValue.increment(1) }, { merge: true });

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

    // Best-effort — a lookup failure here shouldn't stop the stats update above.
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
//    transitions held/shipped -> released, and (mock) triggers a Monnify
//    Single Transfer payout to the seller.
// ---------------------------------------------------------------------------

exports.releaseFunds = onRequest(withCors(async (req, res) => {
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

      tx.update(escrowRef, {
        status: "released",
        confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
        releasedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return { success: true, sellerBankAccount: data.sellerBankAccount, amount: data.amount };
    });

    if (result.error === "not_found") return res.status(404).send("Escrow not found");
    if (result.error === "invalid_token") return res.status(403).send("Invalid confirmation token");
    if (result.error === "invalid_state") {
      return res.status(409).send(`Cannot release from status: ${result.currentStatus}`);
    }

    // --- Monnify Single Transfer call goes here ---
    // Mocked until you have sandbox disbursement credentials wired up.
    // Real call: POST https://sandbox.monnify.com/api/v2/disbursements/single
    // with sellerBankAccount + amount, using an OAuth bearer token.
    const mockTransferResponse = {
      transactionReference: `MOCK-${crypto.randomUUID()}`,
      status: "SUCCESS",
      note: "Mocked — replace with real Monnify Single Transfer call once sandbox disbursement access is granted",
    };

    await logTransaction(escrowId, "transfer_initiated", {
      amount: result.amount,
      sellerBankAccount: result.sellerBankAccount,
      transferResponse: mockTransferResponse,
    });

    logger.info(`releaseFunds: escrow ${escrowId} released (mock transfer)`);
    return res.status(200).json({ status: "released", transfer: mockTransferResponse });
  } catch (err) {
    logger.error("releaseFunds: unexpected error", err);
    return res.status(500).send("Internal error");
  }
}));

// ---------------------------------------------------------------------------
// 2b. markShipped
//     Called by the authenticated seller from their dashboard. Verifies
//     they own the escrow, then transitions held -> shipped and sets the
//     auto-release deadline.
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

      // Each escrow can set its own window at creation time; fall back to
      // the default for older escrows that predate the field.
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
//     Called by the buyer from their payment page when something's wrong.
//     Freezes the escrow so autoReleaseCron won't sweep it while a human
//     resolves the dispute.
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
// 3. autoReleaseCron
//    Runs daily. Sweeps 'shipped' escrows whose per-escrow autoReleaseAt
//    deadline has passed with no dispute, and auto-releases them.
// ---------------------------------------------------------------------------

exports.autoReleaseCron = onSchedule(
  { schedule: "every 6 hours", secrets: [RESEND_API_KEY] },
  async () => {
    const now = admin.firestore.Timestamp.now();
    const apiKey = RESEND_API_KEY.value();

    // --- Reminder pass -----------------------------------------------------
    // Nudge buyers whose auto-release is within 24h and who haven't already
    // been reminded. reminderSentAt gates this so a 6-hourly cron doesn't
    // re-send the same reminder 4 times before release actually happens.
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
    // autoReleaseAt is computed per-escrow in markShipped, respecting each
    // seller's chosen window — so this just finds anything whose deadline
    // has already passed, rather than applying one global cutoff.
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
      try {
        await db.runTransaction(async (tx) => {
          const fresh = await tx.get(escrowRef);
          const data = fresh.data();
          if (data.status !== "shipped") return; // guard against race with buyer confirm

          tx.update(escrowRef, {
            status: "released",
            releasedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        });

        await logTransaction(doc.id, "auto_released", {
          reason: "No confirmation within the auto-release window",
        });

        // Real Monnify Single Transfer call would go here too, same as releaseFunds.
        // Emails for this transition are handled by onEscrowStatusChange.
        logger.info(`autoReleaseCron: auto-released escrow ${doc.id}`);
      } catch (err) {
        logger.error(`autoReleaseCron: failed for escrow ${doc.id}`, err);
      }
    }
  }
);
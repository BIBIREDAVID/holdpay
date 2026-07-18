// Run with: npm run test:webhook
// (which passes --env-file=.env so these come from your local .env,
// never hardcoded or committed — see .env.example for what's needed)

const crypto = require("crypto");

const MONNIFY_SECRET = process.env.MONNIFY_SECRET_KEY;
const paymentReference = process.env.TEST_PAYMENT_REFERENCE;

if (!MONNIFY_SECRET || !paymentReference) {
  console.error(
    "Missing MONNIFY_SECRET_KEY or TEST_PAYMENT_REFERENCE in .env — copy .env.example to .env and fill both in."
  );
  process.exit(1);
}

// The payload exactly as Monnify sends it
const payload = {
  eventType: "SUCCESSFUL_TRANSACTION",
  eventData: {
    paymentReference,
    amountPaid: "450000.00",
    transactionReference: "MNFY_TEST_" + Date.now(),
  },
};

const payloadString = JSON.stringify(payload);

// Signature our webhook expects
const signature = crypto
  .createHmac("sha512", MONNIFY_SECRET)
  .update(payloadString)
  .digest("hex");

// Fire the request at the local emulator
fetch("http://127.0.0.1:5001/holdpay-f920a/us-central1/monnifyWebhook", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "monnify-signature": signature,
  },
  body: payloadString,
})
  .then(async (res) => {
    console.log(`Status Code: ${res.status}`);
    console.log(`Response: ${await res.text()}`);
  })
  .catch((err) => console.error("Request failed:", err));
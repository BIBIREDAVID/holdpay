const crypto = require("crypto");

// 1. The payload exactly as Monnify sends it
const payload = {
    eventType: "SUCCESSFUL_TRANSACTION",
    eventData: {
        // REPLACE THIS WITH THE ID YOU COPIED FROM FIRESTORE
        paymentReference: "9bG4ECyuwQWDcdl3yuYB", 
        amountPaid: "450000.00",
        transactionReference: "MNFY_TEST_" + Date.now()
    }
};

const payloadString = JSON.stringify(payload);
const MONNIFY_SECRET = "your_monnify_secret_key_here";

// 2. Generate the signature that our webhook expects
const signature = crypto
    .createHmac("sha512", MONNIFY_SECRET)
    .update(payloadString)
    .digest("hex");

// 3. Fire the request at your local emulator
// (Using native fetch available in Node 18+)
fetch("http://127.0.0.1:5001/holdpay-f920a/us-central1/monnifyWebhook", {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "monnify-signature": signature
    },
    body: payloadString
})
.then(async (res) => {
    console.log(`Status Code: ${res.status}`);
    console.log(`Response: ${await res.text()}`);
})
.catch(err => console.error("Request failed:", err));
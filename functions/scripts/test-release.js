// Run with: npm run test:release
// (which passes --env-file=.env — see .env.example for what's needed)

const escrowId = process.env.TEST_ESCROW_ID;
const token = process.env.TEST_BUYER_TOKEN;

if (!escrowId || !token) {
  console.error(
    "Missing TEST_ESCROW_ID or TEST_BUYER_TOKEN in .env — copy a 'held' or 'shipped' " +
      "escrow's ID and buyerConfirmToken from the Firestore emulator UI into your .env."
  );
  process.exit(1);
}

fetch("http://127.0.0.1:5001/holdpay-f920a/us-central1/releaseFunds", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ escrowId, token }),
})
  .then((res) => res.json())
  .then((data) => console.log(data))
  .catch((err) => console.error(err));
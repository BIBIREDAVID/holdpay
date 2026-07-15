const path = require("path");
const crypto = require("crypto");

const isLive = process.argv.includes("--live");

if (!isLive) {
  // Point the Admin SDK at the local Firestore emulator instead of prod.
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
  process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
}

const admin = require("firebase-admin");

if (isLive) {
  const serviceAccount = require(path.join(__dirname, "serviceAccount.json"));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
} else {
  admin.initializeApp({ projectId: "holdpay-f920a" });
}

const db = admin.firestore();

function daysAgo(n) {
  return admin.firestore.Timestamp.fromDate(
    new Date(Date.now() - n * 24 * 60 * 60 * 1000)
  );
}

function daysFromNow(n) {
  return admin.firestore.Timestamp.fromDate(
    new Date(Date.now() + n * 24 * 60 * 60 * 1000)
  );
}

function makeEscrow(overrides) {
  const base = {
    status: "pending_payment",
    amount: 1500000, // kobo -> ₦15,000
    itemDesc: "Sample item",
    sellerUid: "seed-seller-uid",
    sellerBankAccount: {
      accountNumber: "0123456789",
      bankCode: "058",
      accountName: "Demo Seller",
    },
    buyerContact: {
      email: "buyer@example.com",
      phone: "+2348000000000",
    },
    buyerConfirmToken: crypto.randomUUID(),
    monnify: {
      reservedAccountNumber: "1000" + Math.floor(Math.random() * 1000000),
      reservedAccountRef: "HP-" + crypto.randomUUID().slice(0, 8),
      bankName: "Moniepoint MFB",
    },
    createdAt: daysAgo(4),
    paidAt: null,
    shippedAt: null,
    autoReleaseAt: null,
    confirmedAt: null,
    releasedAt: null,
    disputedAt: null,
    disputeReason: null,
  };
  return { ...base, ...overrides };
}

const sampleEscrows = [
  makeEscrow({
    itemDesc: "iPhone 13 Pro Max, 256GB (used, UK)",
    amount: 45000000,
    status: "pending_payment",
  }),
  makeEscrow({
    itemDesc: "Custom Ankara jacket, size M",
    amount: 2500000,
    status: "held",
    paidAt: daysAgo(2),
  }),
  makeEscrow({
    itemDesc: "PS5 console + 2 controllers",
    amount: 38000000,
    status: "shipped",
    paidAt: daysAgo(3),
    shippedAt: daysAgo(1),
    autoReleaseAt: daysFromNow(2),
  }),
  makeEscrow({
    itemDesc: "Handmade beaded necklace set",
    amount: 1200000,
    status: "confirmed",
    paidAt: daysAgo(5),
    shippedAt: daysAgo(4),
    confirmedAt: daysAgo(1),
  }),
  makeEscrow({
    itemDesc: "MacBook Air M1 charger (original)",
    amount: 800000,
    status: "released",
    paidAt: daysAgo(6),
    shippedAt: daysAgo(5),
    confirmedAt: daysAgo(3),
    releasedAt: daysAgo(3),
  }),
  makeEscrow({
    itemDesc: "Wig - 20 inch bone straight",
    amount: 6000000,
    status: "disputed",
    paidAt: daysAgo(4),
    shippedAt: daysAgo(3),
    disputedAt: daysAgo(1),
    disputeReason: "Item received does not match description",
  }),
  makeEscrow({
    itemDesc: "Fairly used gaming laptop",
    amount: 32000000,
    status: "refunded",
    paidAt: daysAgo(10),
    disputedAt: daysAgo(8),
  }),
];

async function seed() {
  console.log(
    `Seeding ${sampleEscrows.length} escrows into ${
      isLive ? "LIVE Firebase project" : "local emulator"
    }...`
  );

  const batch = db.batch();
  const transactionsToLog = [];

  sampleEscrows.forEach((escrow) => {
    const ref = db.collection("escrows").doc();
    batch.set(ref, escrow);
    transactionsToLog.push({
      escrowId: ref.id,
      type: "created",
      payload: { seeded: true, status: escrow.status },
      createdAt: escrow.createdAt,
    });
  });

  await batch.commit();

  const txBatch = db.batch();
  transactionsToLog.forEach((tx) => {
    const ref = db.collection("transactions").doc();
    txBatch.set(ref, tx);
  });
  await txBatch.commit();

  console.log("Done. Seeded escrows:");
  sampleEscrows.forEach((e) =>
    console.log(`  [${e.status}] ${e.itemDesc} — ₦${e.amount / 100}`)
  );
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
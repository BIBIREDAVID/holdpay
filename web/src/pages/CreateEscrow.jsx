import { useState } from "react";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../lib/firebase";
import { useAuth } from "../lib/AuthContext";
import SellerNav from "../components/SellerNav";
import AppSidebar from "../components/AppSidebar";

function generateRef() {
  return "HP-" + crypto.randomUUID().slice(0, 8).toUpperCase();
}

function formatNairaPreview(amountNaira) {
  const n = parseFloat(amountNaira);
  if (!n || Number.isNaN(n)) return "₦0";
  return `₦${n.toLocaleString("en-NG")}`;
}

export default function CreateEscrow() {
  const { user } = useAuth();
  const [itemDesc, setItemDesc] = useState("");
  const [amountNaira, setAmountNaira] = useState("");
  const [buyerPhone, setBuyerPhone] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [bankCode, setBankCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    if (!itemDesc.trim() || !amountNaira || !buyerPhone.trim()) {
      setError("Fill in the item, price, and buyer's phone number.");
      return;
    }

    setSubmitting(true);
    try {
      const confirmToken = crypto.randomUUID();
      const reservedAccountRef = generateRef();

      const docRef = await addDoc(collection(db, "escrows"), {
        status: "pending_payment",
        amount: Math.round(parseFloat(amountNaira) * 100),
        itemDesc: itemDesc.trim(),
        sellerUid: user.uid,
        sellerBankAccount: {
          accountNumber: accountNumber.trim(),
          bankCode: bankCode.trim(),
          accountName: "",
        },
        buyerContact: {
          email: "",
          phone: buyerPhone.trim(),
        },
        buyerConfirmToken: confirmToken,
        monnify: {
          reservedAccountNumber: "PENDING",
          reservedAccountRef,
          bankName: "",
        },
        createdAt: serverTimestamp(),
        paidAt: null,
        shippedAt: null,
        autoReleaseAt: null,
        confirmedAt: null,
        releasedAt: null,
        disputedAt: null,
        disputeReason: null,
      });

      const buyerLink = `${window.location.origin}/pay/${confirmToken}`;
      setCreated({ escrowId: docRef.id, buyerLink });
    } catch (err) {
      console.error(err);
      setError("Couldn't create the escrow. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    return (
      <div className="app-shell">
        <AppSidebar active="new" />
        <div className="page">
          <SellerNav active="new" />
          <div className="card">
            <h2>Escrow created</h2>
            <p className="muted">
              Send this link to your buyer on WhatsApp or Instagram. They'll pay
              into a dedicated account, and you'll both see the funds held until
              confirmed.
            </p>
            <div className="field">
              <label>Buyer's payment link</label>
              <input readOnly value={created.buyerLink} onFocus={(e) => e.target.select()} />
            </div>
            <button
              className="btn btn-primary"
              onClick={() => navigator.clipboard.writeText(created.buyerLink)}
            >
              Copy link
            </button>
          </div>
          <button className="btn btn-ghost" onClick={() => setCreated(null)}>
            Create another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <AppSidebar active="new" />
      <div className="page">
        <SellerNav active="new" />
        <h1>New escrow</h1>
        <p className="muted" style={{ marginBottom: 20 }}>
          Set up a protected transaction. Your buyer pays into a dedicated
          account — you only get paid once they confirm the item arrived.
        </p>

        {error && <div className="error-banner">{error}</div>}

        <div className="create-shell">
          <form onSubmit={handleSubmit}>
            <div className="card">
              <div className="field">
                <label>What are you selling?</label>
                <textarea
                  value={itemDesc}
                  onChange={(e) => setItemDesc(e.target.value)}
                  placeholder="e.g. iPhone 13 Pro Max, 256GB, UK used"
                />
              </div>
              <div className="field">
                <label>Price (₦)</label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={amountNaira}
                  onChange={(e) => setAmountNaira(e.target.value)}
                  placeholder="45000"
                />
              </div>
              <div className="field">
                <label>Buyer's phone number</label>
                <input
                  type="tel"
                  value={buyerPhone}
                  onChange={(e) => setBuyerPhone(e.target.value)}
                  placeholder="0801 234 5678"
                />
                <div className="hint">Used to send the buyer their payment link.</div>
              </div>
            </div>

            <div className="card">
              <h3 style={{ fontSize: 15 }}>Where should we send your money?</h3>
              <div className="field">
                <label>Account number</label>
                <input
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  placeholder="0123456789"
                />
              </div>
              <div className="field">
                <label>Bank code</label>
                <input
                  value={bankCode}
                  onChange={(e) => setBankCode(e.target.value)}
                  placeholder="058 (GTBank)"
                />
                <div className="hint">Swap this for a bank-name dropdown before demo day.</div>
              </div>
            </div>

            <button className="btn btn-primary" type="submit" disabled={submitting}>
              {submitting ? "Creating…" : "Create escrow & get payment link"}
            </button>
          </form>

          {/* Desktop-only — hidden below 960px. Shows the buyer what they'll
              see, updating live as the seller fills the form in. */}
          <div className="create-preview">
            <div className="card">
              <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
                What your buyer will see
              </div>
              <span className="seal seal-pending">
                <span className="dot" />
                Awaiting payment
              </span>
              <h3 style={{ marginTop: 14, marginBottom: 4, fontSize: 16 }}>
                {itemDesc.trim() || "Item description"}
              </h3>
              <div className="amount-display" style={{ fontSize: 22 }}>
                {formatNairaPreview(amountNaira)}
              </div>
              <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
                This is the receipt your buyer opens from their payment link —
                before they've paid anything.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
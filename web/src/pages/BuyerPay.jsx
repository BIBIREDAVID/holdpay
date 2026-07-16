import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import SealBadge from "../components/SealBadge";
import BrandPanel from "../components/BrandPanel";
import { FUNCTIONS_BASE_URL } from "../lib/firebase";

function formatNaira(kobo) {
  return `₦${(kobo / 100).toLocaleString("en-NG")}`;
}

// escrow.autoReleaseAt arrives as epoch millis over JSON (see the
// getEscrowByToken function — plain JSON has no Timestamp type).
function formatCountdown(autoReleaseAtMillis, now) {
  if (!autoReleaseAtMillis) return null;
  const msLeft = autoReleaseAtMillis - now.getTime();
  if (msLeft <= 0) return "Releasing shortly";

  const days = Math.floor(msLeft / (24 * 60 * 60 * 1000));
  const hours = Math.floor((msLeft % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));

  if (days >= 1) return `Auto-releases in ${days}d ${hours}h`;
  const mins = Math.floor((msLeft % (60 * 60 * 1000)) / (60 * 1000));
  return `Auto-releases in ${hours}h ${mins}m`;
}

export default function BuyerPay() {
  const { token } = useParams();
  const [escrow, setEscrow] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [disputing, setDisputing] = useState(false);
  const [showDisputeForm, setShowDisputeForm] = useState(false);
  const [disputeReason, setDisputeReason] = useState("");
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(interval);
  }, []);

  async function fetchEscrow() {
    try {
      const res = await fetch(
        `${FUNCTIONS_BASE_URL}/getEscrowByToken?token=${encodeURIComponent(token)}`
      );
      if (!res.ok) {
        setError(res.status === 404 ? "We can't find this escrow — check your link." : "Something went wrong loading this escrow.");
        return;
      }
      const data = await res.json();
      setEscrow(data);
      setError(null);
    } catch (err) {
      console.error(err);
      setError("Couldn't reach HoldPay. Check your connection.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchEscrow();
    const interval = setInterval(fetchEscrow, 8000);
    return () => clearInterval(interval);
  }, [token]);

  async function handleConfirm() {
    if (!escrow) return;
    setConfirming(true);
    setError(null);
    try {
      const res = await fetch(`${FUNCTIONS_BASE_URL}/releaseFunds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ escrowId: escrow.escrowId, token }),
      });
      if (!res.ok) {
        const text = await res.text();
        setError(text || "Couldn't confirm receipt. Try again.");
        return;
      }
      await fetchEscrow();
    } catch (err) {
      console.error(err);
      setError("Couldn't reach HoldPay. Check your connection.");
    } finally {
      setConfirming(false);
    }
  }

  async function handleDispute() {
    if (!escrow) return;
    setDisputing(true);
    setError(null);
    try {
      const res = await fetch(`${FUNCTIONS_BASE_URL}/raiseDispute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ escrowId: escrow.escrowId, token, reason: disputeReason }),
      });
      if (!res.ok) {
        const text = await res.text();
        setError(text || "Couldn't raise a dispute. Try again.");
        return;
      }
      setShowDisputeForm(false);
      await fetchEscrow();
    } catch (err) {
      console.error(err);
      setError("Couldn't reach HoldPay. Check your connection.");
    } finally {
      setDisputing(false);
    }
  }

  if (loading) {
    return (
      <div className="auth-shell">
        <BrandPanel variant="buyer" />
        <div className="page">
          <Topbar />
          <p className="muted">Loading your escrow…</p>
        </div>
      </div>
    );
  }

  if (error && !escrow) {
    return (
      <div className="auth-shell">
        <BrandPanel variant="buyer" />
        <div className="page">
          <Topbar />
          <div className="error-banner">{error}</div>
        </div>
      </div>
    );
  }

  const canAct = escrow.status === "held" || escrow.status === "shipped";

  return (
    <div className="auth-shell">
      <BrandPanel variant="buyer" />
      <div className="page">
        <Topbar />

        <div style={{ marginBottom: 14 }}>
          <SealBadge status={escrow.status} />
        </div>

        <h1 style={{ fontSize: 22 }}>{escrow.itemDesc}</h1>
        <div className="amount-display" style={{ marginBottom: 20 }}>
          {formatNaira(escrow.amount)}
        </div>

        {escrow.status === "pending_payment" && (
          <div className="reserved-account">
            <div className="bank">Pay into this account — {escrow.monnify?.bankName || "bank details loading"}</div>
            <div className="number">{escrow.monnify?.reservedAccountNumber}</div>
          </div>
        )}

        {escrow.status === "shipped" && escrow.autoReleaseAt && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>
              {formatCountdown(escrow.autoReleaseAt, now)}
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Unless you raise a dispute before then, the seller is paid automatically —
              you don't need to do anything if the item's as expected.
            </p>
          </div>
        )}

        {error && <div className="error-banner">{error}</div>}

        <div className="card">
          <h3 style={{ fontSize: 15 }}>How this works</h3>
          <ul className="timeline">
            <li>
              <span className="step-label">1. Pay</span>
              <span className="muted">Your money is held by HoldPay, not the seller.</span>
            </li>
            <li>
              <span className="step-label">2. Ship</span>
              <span className="muted">Seller sends your item.</span>
            </li>
            <li>
              <span className="step-label">3. Confirm</span>
              <span className="muted">
                You confirm it arrived — seller gets paid. If you don't, it releases
                automatically {escrow.autoReleaseDays || 7} days after shipping.
              </span>
            </li>
          </ul>
        </div>

        {canAct && !showDisputeForm && (
          <>
            <button className="btn btn-confirm" onClick={handleConfirm} disabled={confirming}>
              {confirming ? "Confirming…" : "I've received my item — release funds"}
            </button>
            <button
              className="btn btn-ghost"
              style={{ marginTop: 10 }}
              onClick={() => setShowDisputeForm(true)}
            >
              Something's wrong — raise a dispute
            </button>
          </>
        )}

        {canAct && showDisputeForm && (
          <div className="card">
            <h3 style={{ fontSize: 15 }}>What happened?</h3>
            <div className="field">
              <textarea
                value={disputeReason}
                onChange={(e) => setDisputeReason(e.target.value)}
                placeholder="e.g. item never arrived, wrong item, damaged on arrival"
              />
            </div>
            <button className="btn btn-primary" onClick={handleDispute} disabled={disputing || !disputeReason.trim()}>
              {disputing ? "Submitting…" : "Submit dispute"}
            </button>
            <button
              className="btn btn-ghost"
              style={{ marginTop: 10 }}
              onClick={() => setShowDisputeForm(false)}
            >
              Cancel
            </button>
          </div>
        )}

        {escrow.status === "released" && (
          <p className="muted">Funds released to the seller. Thanks for using HoldPay.</p>
        )}

        {escrow.status === "disputed" && (
          <p className="muted">
            This escrow is under dispute. HoldPay will follow up with both parties.
          </p>
        )}
      </div>
    </div>
  );
}

function Topbar() {
  return (
    <div className="topbar">
      <div className="mark">H</div>
      <div className="name">HoldPay</div>
    </div>
  );
}
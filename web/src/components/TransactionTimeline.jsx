import { useEffect, useState } from "react";
import { FUNCTIONS_BASE_URL } from "../lib/firebase";

/**
 * TransactionTimeline
 *
 * Chronological event list for one escrow, pulled from getEscrowTimeline.
 * Works for both the buyer page (pass token) and the seller dashboard
 * (pass idToken instead) — exactly one of the two should be provided.
 *
 * Usage — buyer page:
 *   <TransactionTimeline escrowId={escrow.escrowId} token={token} />
 *
 * Usage — seller dashboard (inside an async context where you can await
 * auth.currentUser.getIdToken()):
 *   <TransactionTimeline escrowId={escrow.id} idToken={idToken} />
 */

function formatTime(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleString("en-NG", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function TransactionTimeline({ escrowId, token, idToken }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const params = new URLSearchParams({ escrowId });
        if (token) params.set("token", token);

        const res = await fetch(`${FUNCTIONS_BASE_URL}/getEscrowTimeline?${params}`, {
          headers: idToken ? { Authorization: `Bearer ${idToken}` } : {},
        });

        if (!res.ok) {
          if (!cancelled) setError("Couldn't load transaction history.");
          return;
        }
        const data = await res.json();
        if (!cancelled) setEvents(data.events || []);
      } catch (err) {
        console.error(err);
        if (!cancelled) setError("Couldn't reach HoldPay.");
      }
    }

    if (escrowId && (token || idToken)) load();
    return () => {
      cancelled = true;
    };
  }, [escrowId, token, idToken]);

  if (error) return <p className="muted" style={{ fontSize: 12.5 }}>{error}</p>;
  if (!events) return <p className="muted" style={{ fontSize: 12.5 }}>Loading history…</p>;
  if (events.length === 0) return null;

  return (
    <div className="card">
      <h3 style={{ fontSize: 15, marginBottom: 4 }}>Transaction history</h3>
      <ul className="timeline">
        {events.map((e, i) => (
          <li key={i}>
            <span className="step-label" style={{ minWidth: 130 }}>{e.label}</span>
            <span className="muted mono" style={{ fontSize: 12 }}>{formatTime(e.createdAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
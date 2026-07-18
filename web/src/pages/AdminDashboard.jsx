import { useEffect, useState } from "react";
import { useAuth } from "../lib/AuthContext";
import { FUNCTIONS_BASE_URL } from "../lib/firebase";
import SellerNav from "../components/SellerNav";
import SealBadge from "../components/SealBadge";

/**
 * AdminDashboard
 *
 * Combines the two admin surfaces in one page: a disputes queue (the
 * primary job — resolve frozen escrows) and a full escrow list across
 * every seller (the general view). Gated server-side by requireAdmin() in
 * adminListEscrows/resolveDispute — this page itself doesn't enforce
 * access, the API does, so there's no client-side bypass risk.
 *
 * Route this at /admin in App.jsx, wrapped in ProtectedRoute like your
 * other seller pages. Being logged in isn't being an admin — the backend
 * still checks the email allow-list on every call, so a non-admin seller
 * hitting this URL just gets 403s and an empty/error state, nothing leaks.
 */

function formatNaira(kobo) {
  return `₦${(kobo / 100).toLocaleString("en-NG")}`;
}

export default function AdminDashboard() {
  const { user } = useAuth();
  const [escrows, setEscrows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("disputed"); // "disputed" | "all"
  const [resolvingId, setResolvingId] = useState(null);
  const [noteDrafts, setNoteDrafts] = useState({});

  async function fetchEscrows(statusFilter) {
    setLoading(true);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const qs = statusFilter ? `?status=${statusFilter}` : "";
      const res = await fetch(`${FUNCTIONS_BASE_URL}/adminListEscrows${qs}`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!res.ok) {
        const text = await res.text();
        setError(res.status === 403 ? "You don't have admin access." : text || "Couldn't load escrows.");
        setEscrows([]);
        return;
      }
      const data = await res.json();
      setEscrows(data.escrows || []);
    } catch (err) {
      console.error(err);
      setError("Couldn't reach HoldPay. Check your connection.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!user) return;
    fetchEscrows(tab === "disputed" ? "disputed" : null);
  }, [user, tab]);

  async function handleResolve(escrowId, action) {
    setResolvingId(escrowId);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`${FUNCTIONS_BASE_URL}/resolveDispute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          escrowId,
          action,
          note: noteDrafts[escrowId] || "",
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        alert(text || "Couldn't resolve this dispute.");
        return;
      }
      await fetchEscrows(tab === "disputed" ? "disputed" : null);
    } catch (err) {
      console.error(err);
      alert("Couldn't reach HoldPay. Check your connection.");
    } finally {
      setResolvingId(null);
    }
  }

  return (
    <div className="page">
      <SellerNav active="admin" />
      <h1>Admin</h1>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button
          onClick={() => setTab("disputed")}
          className="btn-ghost"
          style={{
            padding: "6px 14px",
            borderRadius: 999,
            fontSize: 12.5,
            fontWeight: 600,
            background: tab === "disputed" ? "var(--adire-deep)" : "transparent",
            color: tab === "disputed" ? "white" : "var(--adire)",
            border: tab === "disputed" ? "none" : "1.5px solid var(--line)",
          }}
        >
          Disputes
        </button>
        <button
          onClick={() => setTab("all")}
          className="btn-ghost"
          style={{
            padding: "6px 14px",
            borderRadius: 999,
            fontSize: 12.5,
            fontWeight: 600,
            background: tab === "all" ? "var(--adire-deep)" : "transparent",
            color: tab === "all" ? "white" : "var(--adire)",
            border: tab === "all" ? "none" : "1.5px solid var(--line)",
          }}
        >
          All escrows
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && !error && escrows.length === 0 && (
        <p className="muted">
          {tab === "disputed" ? "No disputes right now — nothing to resolve." : "No escrows found."}
        </p>
      )}

      {!loading &&
        escrows.map((e) => (
          <div className="card" key={e.id}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{e.itemDesc}</div>
                <div className="mono muted">{formatNaira(e.amount)}</div>
              </div>
              <SealBadge status={e.status} />
            </div>

            {e.disputeReason && (
              <p className="muted" style={{ marginBottom: 10 }}>Reason: {e.disputeReason}</p>
            )}

            {e.status === "disputed" && (
              <>
                <div className="field">
                  <label>Resolution note (optional)</label>
                  <input
                    value={noteDrafts[e.id] || ""}
                    onChange={(ev) =>
                      setNoteDrafts((prev) => ({ ...prev, [e.id]: ev.target.value }))
                    }
                    placeholder="e.g. Confirmed with both parties via WhatsApp"
                  />
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    className="btn btn-confirm"
                    onClick={() => handleResolve(e.id, "release")}
                    disabled={resolvingId === e.id}
                    style={{ flex: 1 }}
                  >
                    {resolvingId === e.id ? "Working…" : "Release to seller"}
                  </button>
                  <button
                    className="btn"
                    onClick={() => handleResolve(e.id, "refund")}
                    disabled={resolvingId === e.id}
                    style={{ flex: 1, background: "var(--danger)", color: "white" }}
                  >
                    {resolvingId === e.id ? "Working…" : "Refund buyer"}
                  </button>
                </div>
                <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  Refund closes the escrow but doesn't auto-transfer — send the buyer's
                  refund manually, we don't collect their bank details.
                </p>
              </>
            )}
          </div>
        ))}
    </div>
  );
}
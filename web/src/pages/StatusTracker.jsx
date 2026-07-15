import { useEffect, useState } from "react";
import { collection, query, where, onSnapshot, orderBy } from "firebase/firestore";
import { db, FUNCTIONS_BASE_URL } from "../lib/firebase";
import { useAuth } from "../lib/AuthContext";
import SellerNav from "../components/SellerNav";
import SealBadge from "../components/SealBadge";

function formatNaira(kobo) {
  return `₦${(kobo / 100).toLocaleString("en-NG")}`;
}

export default function StatusTracker() {
  const { user } = useAuth();
  const [escrows, setEscrows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [shippingId, setShippingId] = useState(null);
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, "escrows"),
      where("sellerUid", "==", user.uid),
      orderBy("createdAt", "desc")
    );
    const unsub = onSnapshot(q, (snap) => {
      setEscrows(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });
    return () => unsub();
  }, [user]);

  async function handleMarkShipped(escrowId) {
    setShippingId(escrowId);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`${FUNCTIONS_BASE_URL}/markShipped`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ escrowId }),
      });
      if (!res.ok) {
        const text = await res.text();
        alert(text || "Couldn't mark as shipped.");
      }
    } catch (err) {
      console.error(err);
      alert("Couldn't reach HoldPay. Check your connection.");
    } finally {
      setShippingId(null);
    }
  }

  if (loading) {
    return (
      <div className="page">
        <SellerNav active="dashboard" />
        <p className="muted">Loading your escrows…</p>
      </div>
    );
  }

  const heldTotal = escrows
    .filter((e) => ["held", "shipped"].includes(e.status))
    .reduce((sum, e) => sum + e.amount, 0);
  const releasedTotal = escrows
    .filter((e) => e.status === "released")
    .reduce((sum, e) => sum + e.amount, 0);
  const disputedCount = escrows.filter((e) => e.status === "disputed").length;

  const filtered = filter === "all" ? escrows : escrows.filter((e) => e.status === filter);

  return (
    <div className="page">
      <SellerNav active="dashboard" />
      <h1>Your escrows</h1>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Currently held</div>
          <div className="mono" style={{ fontSize: 19, fontWeight: 600 }}>{formatNaira(heldTotal)}</div>
        </div>
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Released to you</div>
          <div className="mono" style={{ fontSize: 19, fontWeight: 600, color: "var(--ok)" }}>{formatNaira(releasedTotal)}</div>
        </div>
      </div>

      {disputedCount > 0 && (
        <div className="error-banner">
          {disputedCount} escrow{disputedCount > 1 ? "s" : ""} under dispute — needs your attention.
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {["all", "held", "shipped", "disputed", "released"].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className="btn-ghost"
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              fontSize: 12.5,
              fontWeight: 600,
              textTransform: "capitalize",
              background: filter === f ? "var(--adire-deep)" : "transparent",
              color: filter === f ? "white" : "var(--adire)",
              border: filter === f ? "none" : "1.5px solid var(--line)",
            }}
          >
            {f === "all" ? "All" : f}
          </button>
        ))}
      </div>

      {filtered.length === 0 && (
        <p className="muted">Nothing here yet.</p>
      )}

      {filtered.map((e) => (
        <div className="card" key={e.id}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{e.itemDesc}</div>
              <div className="mono muted">{formatNaira(e.amount)}</div>
            </div>
            <SealBadge status={e.status} />
          </div>

          {e.status === "disputed" && e.disputeReason && (
            <p className="muted" style={{ marginBottom: 10 }}>Reason: {e.disputeReason}</p>
          )}

          {e.status === "held" && (
            <button
              className="btn btn-primary"
              onClick={() => handleMarkShipped(e.id)}
              disabled={shippingId === e.id}
            >
              {shippingId === e.id ? "Marking…" : "Mark as shipped"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
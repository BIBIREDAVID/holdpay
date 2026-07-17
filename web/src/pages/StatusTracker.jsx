import { useEffect, useState } from "react";
import { collection, query, where, onSnapshot, orderBy, doc } from "firebase/firestore";
import { db, FUNCTIONS_BASE_URL } from "../lib/firebase";
import { useAuth } from "../lib/AuthContext";
import SellerNav from "../components/SellerNav";
import AppSidebar from "../components/AppSidebar";
import SealBadge from "../components/SealBadge";

function formatNaira(kobo) {
  return `₦${(kobo / 100).toLocaleString("en-NG")}`;
}

// autoReleaseAt can be a Firestore Timestamp (has .toDate) or, briefly,
// null right after ship before the write round-trips back down.
function formatCountdown(autoReleaseAt, now) {
  if (!autoReleaseAt) return null;
  const target = autoReleaseAt.toDate ? autoReleaseAt.toDate() : new Date(autoReleaseAt);
  const msLeft = target.getTime() - now.getTime();
  if (msLeft <= 0) return "Releasing shortly";

  const days = Math.floor(msLeft / (24 * 60 * 60 * 1000));
  const hours = Math.floor((msLeft % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));

  if (days >= 1) return `Auto-releases in ${days}d ${hours}h`;
  const mins = Math.floor((msLeft % (60 * 60 * 1000)) / (60 * 1000));
  return `Auto-releases in ${hours}h ${mins}m`;
}

function downloadCSV(escrows) {
  const headers = ["Item", "Amount (NGN)", "Status", "Created", "Shipped", "Released"];
  const rows = escrows.map((e) => [
    e.itemDesc || "",
    (e.amount / 100).toFixed(2),
    e.status || "",
    e.createdAt?.toDate ? e.createdAt.toDate().toISOString() : "",
    e.shippedAt?.toDate ? e.shippedAt.toDate().toISOString() : "",
    e.releasedAt?.toDate ? e.releasedAt.toDate().toISOString() : "",
  ]);

  // Quote every field and escape embedded quotes — item descriptions are
  // free text and can contain commas.
  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `holdpay-escrows-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function StatusTracker() {
  const { user } = useAuth();
  const [escrows, setEscrows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [shippingId, setShippingId] = useState(null);
  const [filter, setFilter] = useState("all");
  const [now, setNow] = useState(new Date());
  const [stats, setStats] = useState(null);

  // Bank-detail edit — one escrow's edit form open at a time, kept simple
  // since this is a rare action, not something sellers do repeatedly.
  const [editingId, setEditingId] = useState(null);
  const [editAccountNumber, setEditAccountNumber] = useState("");
  const [editBankCode, setEditBankCode] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState(null);

  useEffect(() => {
    if (!user) return;
    const unsub = onSnapshot(doc(db, "sellerStats", user.uid), (snap) => {
      setStats(snap.exists() ? snap.data() : { totalCount: 0, completedCount: 0, disputedCount: 0 });
    });
    return () => unsub();
  }, [user]);

  function startEdit(e) {
    setEditingId(e.id);
    setEditAccountNumber(e.sellerBankAccount?.accountNumber || "");
    setEditBankCode(e.sellerBankAccount?.bankCode || "");
    setEditError(null);
  }

  async function saveEdit(escrowId) {
    setSavingEdit(true);
    setEditError(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`${FUNCTIONS_BASE_URL}/updateSellerBankAccount`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          escrowId,
          accountNumber: editAccountNumber.trim(),
          bankCode: editBankCode.trim(),
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        setEditError(text || "Couldn't update payout details.");
        return;
      }
      setEditingId(null);
    } catch (err) {
      console.error(err);
      setEditError("Couldn't reach HoldPay. Check your connection.");
    } finally {
      setSavingEdit(false);
    }
  }

  // Ticks once a minute so countdown text stays roughly accurate without
  // re-rendering on every second.
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(interval);
  }, []);

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
      <div className="app-shell">
        <AppSidebar active="dashboard" />
        <div className="page">
          <SellerNav active="dashboard" />
          <p className="muted">Loading your escrows…</p>
        </div>
      </div>
    );
  }

  const heldTotal = escrows
    .filter((e) => ["held", "shipped"].includes(e.status))
    .reduce((sum, e) => sum + e.amount, 0);
  const releasedTotal = escrows
    .filter((e) => e.status === "released")
    .reduce((sum, e) => sum + e.amount, 0);
  const activeCount = escrows.filter(
    (e) => e.status !== "released" && e.status !== "refunded"
  ).length;
  const disputedCount = escrows.filter((e) => e.status === "disputed").length;

  const filtered = filter === "all" ? escrows : escrows.filter((e) => e.status === filter);

  return (
    <div className="app-shell">
      <AppSidebar active="dashboard" />
      <div className="page">
        <SellerNav active="dashboard" />
        <h1>Your escrows</h1>
        {stats && (
          <p className="muted" style={{ marginTop: -12, marginBottom: 20 }}>
            {stats.completedCount || 0} completed
            {stats.disputedCount > 0 ? ` · ${stats.disputedCount} disputed` : ""} — this is what
            buyers see on your payment links.
          </p>
        )}

        <div className="stat-grid">
          <div className="card">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Active escrows</div>
            <div className="mono" style={{ fontSize: 19, fontWeight: 600 }}>{activeCount}</div>
          </div>
          <div className="card">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Currently held</div>
            <div className="mono" style={{ fontSize: 19, fontWeight: 600 }}>{formatNaira(heldTotal)}</div>
          </div>
          <div className="card">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Released to you</div>
            <div className="mono" style={{ fontSize: 19, fontWeight: 600, color: "var(--ok)" }}>{formatNaira(releasedTotal)}</div>
          </div>
        </div>

        {disputedCount > 0 && (
          <div className="error-banner">
            {disputedCount} escrow{disputedCount > 1 ? "s" : ""} under dispute — needs your attention.
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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

          {escrows.length > 0 && (
            <button
              onClick={() => downloadCSV(escrows)}
              className="btn-ghost"
              style={{
                padding: "6px 12px",
                borderRadius: 999,
                fontSize: 12.5,
                fontWeight: 600,
                background: "transparent",
                color: "var(--adire)",
                border: "1.5px solid var(--line)",
              }}
            >
              Export CSV
            </button>
          )}
        </div>

        {filtered.length === 0 && (
          <p className="muted">Nothing here yet.</p>
        )}

        <div className="escrow-grid">
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

              {e.status === "shipped" && e.autoReleaseAt && (
                <p className="muted" style={{ marginBottom: 10 }}>
                  {formatCountdown(e.autoReleaseAt, now)} unless a dispute is raised.
                </p>
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

              {e.status !== "released" && e.status !== "refunded" && (
                <>
                  {editingId !== e.id ? (
                    <button
                      className="nav-logout"
                      style={{ marginTop: 10, fontSize: 12.5 }}
                      onClick={() => startEdit(e)}
                    >
                      Edit payout details
                    </button>
                  ) : (
                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
                      {editError && <div className="error-banner">{editError}</div>}
                      <div className="field">
                        <label>Account number</label>
                        <input
                          value={editAccountNumber}
                          onChange={(ev) => setEditAccountNumber(ev.target.value)}
                        />
                      </div>
                      <div className="field" style={{ marginBottom: 10 }}>
                        <label>Bank code</label>
                        <input
                          value={editBankCode}
                          onChange={(ev) => setEditBankCode(ev.target.value)}
                        />
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          className="btn btn-primary"
                          style={{ flex: 1 }}
                          onClick={() => saveEdit(e.id)}
                          disabled={savingEdit}
                        >
                          {savingEdit ? "Saving…" : "Save"}
                        </button>
                        <button
                          className="btn btn-ghost"
                          style={{ flex: 1 }}
                          onClick={() => setEditingId(null)}
                          disabled={savingEdit}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
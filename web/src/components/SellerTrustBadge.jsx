/**
 * SellerTrustBadge
 *
 * Surfaces the sellerStats already computed server-side (onEscrowCreated /
 * onEscrowStatusChange triggers keep sellerStats/{uid} in sync) on the
 * buyer's payment page — the actual trust signal a stranger paying
 * upfront needs before sending money.
 *
 * Usage, from your getEscrowByToken response:
 *   <SellerTrustBadge stats={escrow.sellerStats} />
 */

function ShieldCheckIcon({ color }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2.5 4.5 5.5v6c0 5 3.2 8.6 7.5 10 4.3-1.4 7.5-5 7.5-10v-6L12 2.5Z"
        fill={color}
      />
      <path
        d="m8.5 12.3 2.4 2.4 4.6-4.9"
        stroke="white"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function SellerTrustBadge({ stats }) {
  const completed = stats?.completedCount || 0;
  const disputed = stats?.disputedCount || 0;

  if (completed === 0 && disputed === 0) {
    return (
      <div className="card" style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
        <ShieldCheckIcon color="#8a8ea8" />
        <div>
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>New seller on HoldPay</div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            Your payment is still protected — held until you confirm receipt.
          </div>
        </div>
      </div>
    );
  }

  const disputeRate = completed + disputed > 0 ? disputed / (completed + disputed) : 0;
  const isTrusted = disputeRate < 0.1;

  return (
    <div className="card" style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
      <ShieldCheckIcon color={isTrusted ? "#3c8c5d" : "#c1443c"} />
      <div>
        <div style={{ fontWeight: 600, fontSize: 13.5 }}>
          {completed} completed escrow{completed !== 1 ? "s" : ""}
          {disputed > 0 && <span className="muted" style={{ fontWeight: 500 }}> · {disputed} disputed</span>}
        </div>
        <div className="muted" style={{ fontSize: 12.5 }}>
          {isTrusted
            ? "This seller has a strong track record on HoldPay."
            : "This seller has had some disputed transactions."}
        </div>
      </div>
    </div>
  );
}
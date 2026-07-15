const STATUS_CONFIG = {
  pending_payment: { label: "Awaiting payment", cls: "seal-pending" },
  held: { label: "Funds held", cls: "seal-held" },
  shipped: { label: "Shipped", cls: "seal-shipped" },
  confirmed: { label: "Confirmed", cls: "seal-released" },
  released: { label: "Released", cls: "seal-released" },
  disputed: { label: "Disputed", cls: "seal-disputed" },
  refunded: { label: "Refunded", cls: "seal-disputed" },
};

export default function SealBadge({ status }) {
  const config = STATUS_CONFIG[status] || { label: status, cls: "seal-pending" };
  return (
    <span className={`seal ${config.cls}`}>
      <span className="dot" />
      {config.label}
    </span>
  );
}
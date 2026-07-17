import { useEffect, useState } from "react";

/**
 * AutoReleaseCountdown
 *
 * Shows a live "funds auto-release in Xd Yh Zm" countdown, driven by the
 * escrow's `autoReleaseAt` field (set by markShipped, 7 days out by default).
 * Ticks down once a minute — no need for per-second precision on a
 * multi-day window, and it keeps re-renders cheap.
 *
 * Usage — works whether autoReleaseAt comes from Firestore directly
 * (a Timestamp with .toDate()) or from your getEscrowByToken API response
 * (a plain object like { _seconds, _nanoseconds } or an ISO string):
 *
 *   <AutoReleaseCountdown autoReleaseAt={escrow.autoReleaseAt} />
 *
 * Renders nothing if autoReleaseAt is missing or already in the past
 * (falls back silently so it's safe to drop in unconditionally).
 */

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate(); // Firestore Timestamp
  if (typeof value._seconds === "number") return new Date(value._seconds * 1000); // serialized Timestamp
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function formatRemaining(ms) {
  if (ms <= 0) return null;
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

export default function AutoReleaseCountdown({ autoReleaseAt, compact = false }) {
  const target = toDate(autoReleaseAt);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!target) return;
    const interval = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => clearInterval(interval);
  }, [target]);

  if (!target) return null;

  const remainingMs = target.getTime() - now;
  const label = formatRemaining(remainingMs);

  if (!label) {
    // Past due — autoReleaseCron should sweep this shortly. Say so rather
    // than showing a confusing negative countdown.
    return (
      <div className={compact ? "muted" : "card"} style={compact ? {} : { padding: "12px 16px" }}>
        <span className="mono" style={{ fontSize: compact ? 12.5 : 13, color: "var(--seal-gold)" }}>
          Auto-release pending — processing shortly
        </span>
      </div>
    );
  }

  if (compact) {
    return (
      <span className="mono muted" style={{ fontSize: 12.5 }}>
        Auto-releases in {label}
      </span>
    );
  }

  return (
    <div className="card" style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ fontSize: 18 }}>⏳</span>
      <div>
        <div style={{ fontWeight: 600, fontSize: 14 }}>Funds auto-release in {label}</div>
        <div className="muted" style={{ fontSize: 12.5 }}>
          If nothing's confirmed by then, the seller is paid automatically.
        </div>
      </div>
    </div>
  );
}
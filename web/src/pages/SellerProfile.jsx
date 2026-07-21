import React, { useEffect, useState } from "react";
import { doc, getDoc, collection, query, where, orderBy, limit, getDocs } from "firebase/firestore";
import { db } from "../lib/firebase";
import { useAuth } from "../lib/AuthContext";
import AppSidebar from "../components/AppSidebar";
import SellerNav from "../components/SellerNav";
import SellerTrustBadge from "../components/SellerTrustBadge";
import SealBadge from "../components/SealBadge";

// Seller's own profile — what a buyer sees represented back to them, plus
// their recent escrow activity. Reads sellers/{uid} and sellerStats/{uid}
// directly (firestore.rules allow a seller to read both of their own docs),
// and queries escrows where sellerUid == uid, which is the same shape
// CreateEscrow.jsx writes.
//
// Two bugs this fixes versus my last draft, now that I've seen
// CreateEscrow.jsx:
//   - the item-description field is `itemDesc`, not `itemDescription`.
//   - `amount` is stored in kobo (Math.round(naira * 100)), not naira — I
//     was about to print the raw integer as if it were already ₦.
//
// Real images, not gradient placeholders: escrow docs can carry a
// `photoUrl` from Storage (sellers optionally attach one photo when
// creating an escrow). Shown when present; falls back to a plain swatch
// for the — probably common — case where no photo was attached.
//
// Layout follows CreateEscrow.jsx's actual shell (<div className="app-shell">
// + AppSidebar + <div className="page"> + SellerNav + stacked <div
// className="card">), rather than the standalone card-on-a-background
// design from my earlier drafts, which doesn't match how the rest of the
// app is actually built.
//
// Still unverified, since I don't have sellers/{uid}'s schema or the full
// set of AppSidebar/SellerNav `active` keys: I'm reading displayName /
// handle / location / bio off the seller doc, and using active="profile".
// Both are one-line fixes if the real names differ.

function TrustRing({ pct, initials }) {
  const r = 29;
  const c = 2 * Math.PI * r;
  return (
    <div style={{ position: "relative", height: 64, width: 64, flexShrink: 0 }}>
      <svg viewBox="0 0 64 64" style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}>
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--line)" strokeWidth="4" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke="#E5A128"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 6,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#181E36",
          color: "#F3B33D",
          fontWeight: 700,
          fontSize: 17,
        }}
      >
        {initials}
      </div>
    </div>
  );
}

export default function SellerProfile() {
  const { user } = useAuth();
  const [seller, setSeller] = useState(null);
  const [stats, setStats] = useState(null);
  const [recentEscrows, setRecentEscrows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.uid) return;
    (async () => {
      const escrowsQuery = query(
        collection(db, "escrows"),
        where("sellerUid", "==", user.uid),
        orderBy("createdAt", "desc"),
        limit(5)
      );

      const [sellerSnap, statsSnap, escrowsSnap] = await Promise.all([
        getDoc(doc(db, "sellers", user.uid)),
        getDoc(doc(db, "sellerStats", user.uid)),
        getDocs(escrowsQuery),
      ]);

      setSeller(sellerSnap.exists() ? sellerSnap.data() : null);
      setStats(statsSnap.exists() ? statsSnap.data() : { completedCount: 0, disputedCount: 0 });
      setRecentEscrows(
        escrowsSnap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            item: data.itemDesc || "",
            amountNaira: typeof data.amount === "number" ? data.amount / 100 : null,
            photoUrl: data.photoUrl || null,
            status: data.status,
          };
        })
      );
      setLoading(false);
    })();
  }, [user]);

  if (loading) {
    return (
      <div className="app-shell">
        <AppSidebar active="profile" />
        <div className="page">
          <SellerNav active="profile" />
          <p className="muted">Loading profile…</p>
        </div>
      </div>
    );
  }

  const initials = (seller?.displayName || user?.email || "?")
    .split(" ")
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const completed = stats?.completedCount || 0;
  const disputed = stats?.disputedCount || 0;
  const total = completed + disputed;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="app-shell">
      <AppSidebar active="profile" />
      <div className="page">
        <SellerNav active="profile" />
        <h1>Your profile</h1>
        <p className="muted" style={{ marginBottom: 20 }}>
          What buyers see represented back to them on their payment page.
        </p>

        <div className="card" style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <TrustRing pct={pct} initials={initials} />
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 17, margin: 0 }}>{seller?.displayName || "Unnamed seller"}</h2>
            {seller?.handle && (
              <div className="muted mono" style={{ fontSize: 13, marginTop: 2 }}>
                {seller.handle}
              </div>
            )}
            {seller?.location && (
              <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                {seller.location}
              </div>
            )}
          </div>
        </div>

        {seller?.bio && (
          <div className="card">
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5 }}>{seller.bio}</p>
          </div>
        )}

        <div className="card">
          <SellerTrustBadge stats={stats} />
        </div>

        {recentEscrows.length > 0 && (
          <div className="card">
            <h3 style={{ fontSize: 15, marginBottom: 12 }}>Recent escrows</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {recentEscrows.map((e) => (
                <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  {e.photoUrl ? (
                    <img
                      src={e.photoUrl}
                      alt=""
                      style={{
                        height: 48,
                        width: 48,
                        borderRadius: "var(--radius-sm)",
                        objectFit: "cover",
                        background: "var(--paper)",
                        flexShrink: 0,
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        height: 48,
                        width: 48,
                        borderRadius: "var(--radius-sm)",
                        background: "linear-gradient(135deg, #F3B33D, #E5A128)",
                        flexShrink: 0,
                      }}
                      aria-hidden="true"
                    />
                  )}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontSize: 13.5,
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {e.item}
                    </div>
                    <div className="muted mono" style={{ fontSize: 11.5, marginTop: 2 }}>
                      {e.amountNaira != null ? `₦${e.amountNaira.toLocaleString("en-NG")}` : ""}
                    </div>
                  </div>
                  <SealBadge status={e.status} />
                </div>
              ))}
            </div>
          </div>
        )}

        <button
          className="btn btn-ghost"
          onClick={() => navigator.clipboard?.writeText(window.location.href)}
        >
          Copy profile link
        </button>
      </div>
    </div>
  );
}
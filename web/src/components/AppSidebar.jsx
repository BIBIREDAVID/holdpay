import { useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";

const NAV_ITEMS = [
  { key: "new", to: "/", label: "New escrow" },
  { key: "dashboard", to: "/dashboard", label: "Dashboard" },
  { key: "profile", to: "/profile", label: "Profile" },
];

// Desktop-only counterpart to SellerNav. Hidden below 960px by CSS
// (.app-sidebar { display: none }), so it never conflicts with the
// mobile topbar — the two are just alternate views of the same nav.
export default function AppSidebar({ active }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const [signingOut, setSigningOut] = useState(false);
  const [sealStyle, setSealStyle] = useState({ opacity: 0 });
  const [stamping, setStamping] = useState(false);
  const linkRefs = useRef({});
  const navRef = useRef(null);

  useLayoutEffect(() => {
    const el = linkRefs.current[active];
    const container = navRef.current;
    if (!el || !container) return;

    const elRect = el.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    setSealStyle({
      top: elRect.top - containerRect.top - 4,
      height: elRect.height + 8,
      opacity: 1,
    });

    setStamping(true);
    const t = setTimeout(() => setStamping(false), 320);
    return () => clearTimeout(t);
  }, [active]);

  async function handleSignOut() {
    setSigningOut(true);
    await signOut();
    navigate("/login");
  }

  if (!user) return null;

  return (
    <aside className="app-sidebar">
      <div className="sidebar-brand">
        <div className="mark">H</div>
        <div className="name">HoldPay</div>
      </div>

      <nav ref={navRef} className="sidebar-nav">
        <span
          className={`sidebar-seal ${stamping ? "nav-seal-stamp" : ""}`}
          style={sealStyle}
          aria-hidden="true"
        />
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.key}
            ref={(el) => (linkRefs.current[item.key] = el)}
            to={item.to}
            className={`sidebar-link ${active === item.key ? "sidebar-link-active" : ""}`}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="sidebar-foot">
        <button onClick={handleSignOut} disabled={signingOut} className="nav-logout">
          {signingOut ? "Signing out…" : "Log out"}
        </button>
      </div>
    </aside>
  );
}
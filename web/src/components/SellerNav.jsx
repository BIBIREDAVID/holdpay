import { useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";


const NAV_ITEMS = [
  { key: "new", to: "/", label: "New escrow" },
  { key: "dashboard", to: "/dashboard", label: "Transaction" },
  { key: "profile", to: "/profile", label: "Profile" },
];


export default function SellerNav({ active }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();


  const [signingOut, setSigningOut] = useState(false);
  const [sealStyle, setSealStyle] = useState({ opacity: 0 });
  const [stamping, setStamping] = useState(false);
  const linkRefs = useRef({});
  const navRef = useRef(null);


  // Slide the seal indicator to sit under whichever link is active,
  // and re-trigger the little stamp animation each time it moves.
  useLayoutEffect(() => {
    const el = linkRefs.current[active];
    const container = navRef.current;
    if (!el || !container) return;


    const elRect = el.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();


    setSealStyle({
      left: elRect.left - containerRect.left - 8,
      width: elRect.width + 16,
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


  return (
    <div className="topbar" style={{ justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div className="mark">H</div>
        <div className="name">HoldPay</div>
      </div>


      {user && (
        <nav
          ref={navRef}
          style={{
            position: "relative",
            display: "flex",
            gap: 14,
            alignItems: "center",
            fontSize: 13.5,
          }}
        >
          <span
            className={`nav-seal ${stamping ? "nav-seal-stamp" : ""}`}
            style={sealStyle}
            aria-hidden="true"
          />


          {NAV_ITEMS.map((item) => (
            <Link
              key={item.key}
              ref={(el) => (linkRefs.current[item.key] = el)}
              to={item.to}
              className={`nav-link ${active === item.key ? "nav-link-active" : ""}`}
            >
              {item.label}
            </Link>
          ))}


          <button
            onClick={handleSignOut}
            disabled={signingOut}
            className="nav-logout"
          >
            {signingOut ? "Signing out…" : "Log out"}
          </button>
        </nav>
      )}
    </div>
  );
}




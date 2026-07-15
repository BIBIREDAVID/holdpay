import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";

export default function SellerNav({ active }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  async function handleSignOut() {
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
        <nav style={{ display: "flex", gap: 14, alignItems: "center", fontSize: 13.5 }}>
          <Link to="/" style={{ fontWeight: active === "new" ? 700 : 500, color: active === "new" ? "var(--adire-deep)" : "var(--adire)" }}>
            New escrow
          </Link>
          <Link to="/dashboard" style={{ fontWeight: active === "dashboard" ? 700 : 500, color: active === "dashboard" ? "var(--adire-deep)" : "var(--adire)" }}>
            Dashboard
          </Link>
          <button
            onClick={handleSignOut}
            style={{ background: "none", border: "none", color: "#6b6f8a", fontSize: 13.5, padding: 0 }}
          >
            Log out
          </button>
        </nav>
      )}
    </div>
  );
}
import { Navigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";
import ProfileSetupModal from "./ProfileSetupModal";

export default function ProtectedRoute({ children, showProfileSetup = true }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="page">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <>
      {showProfileSetup && <ProfileSetupModal />}
      {children}
    </>
  );
}
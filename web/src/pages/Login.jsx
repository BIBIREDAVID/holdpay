import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
} from "firebase/auth";
import { auth } from "../lib/firebase";
import BrandPanel from "../components/BrandPanel";

export default function Login({ mode = "login" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const isSignup = mode === "signup";

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (isSignup) {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
      navigate("/dashboard");
    } catch (err) {
      setError(friendlyAuthError(err.code));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      <BrandPanel variant="seller" />
      <div className="page">
        <Topbar />
        <h1>{isSignup ? "Create your seller account" : "Log in"}</h1>
        <p className="muted" style={{ marginBottom: 20 }}>
          {isSignup
            ? "Set up escrows and get paid safely from your Instagram or WhatsApp sales."
            : "Welcome back — access your escrows and payouts."}
        </p>

        {error && <div className="error-banner">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="card">
            {isSignup && (
              <div className="field">
                <label>Business or shop name</label>
                <input
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  placeholder="e.g. Ada's Closet"
                />
              </div>
            )}
            <div className="field">
              <label>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>
            <div className="field">
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                autoComplete={isSignup ? "new-password" : "current-password"}
              />
            </div>
          </div>

          <button className="btn btn-primary" type="submit" disabled={submitting}>
            {submitting ? "Please wait…" : isSignup ? "Create account" : "Log in"}
          </button>
        </form>

        <p className="muted" style={{ marginTop: 16, textAlign: "center" }}>
          {isSignup ? (
            <>Already have an account? <Link to="/login">Log in</Link></>
          ) : (
            <>New to HoldPay? <Link to="/signup">Create an account</Link></>
          )}
        </p>
      </div>
    </div>
  );
}

function friendlyAuthError(code) {
  switch (code) {
    case "auth/email-already-in-use":
      return "That email's already registered — try logging in instead.";
    case "auth/invalid-email":
      return "That email address doesn't look right.";
    case "auth/weak-password":
      return "Password needs to be at least 6 characters.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Email or password is incorrect.";
    default:
      return "Something went wrong. Try again.";
  }
}

function Topbar() {
  return (
    <div className="topbar">
      <div className="mark">H</div>
      <div className="name">HoldPay</div>
    </div>
  );
}
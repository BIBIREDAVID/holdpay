import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  updateProfile,
} from "firebase/auth";
import { auth } from "../lib/firebase";
import BrandPanel from "../components/BrandPanel";

const googleProvider = new GoogleAuthProvider();

export default function Login({ mode = "login" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const navigate = useNavigate();
  const isSignup = mode === "signup";

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (isSignup) {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        // Wasn't being saved anywhere before — displayName is the cheapest
        // place for it, no extra Firestore doc/rules needed.
        if (businessName.trim()) {
          await updateProfile(cred.user, { displayName: businessName.trim() });
        }
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

  async function handleGoogleSignIn() {
    setError(null);
    setGoogleSubmitting(true);
    try {
      // Google already provides a name (their Google account name) as
      // displayName automatically — nothing extra to save here.
      await signInWithPopup(auth, googleProvider);
      navigate("/dashboard");
    } catch (err) {
      if (err.code !== "auth/popup-closed-by-user") {
        setError(friendlyAuthError(err.code));
      }
    } finally {
      setGoogleSubmitting(false);
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

        <button
          type="button"
          className="btn btn-ghost"
          onClick={handleGoogleSignIn}
          disabled={googleSubmitting}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 16 }}
        >
          <GoogleIcon />
          {googleSubmitting ? "Please wait…" : "Continue with Google"}
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
          <span className="muted" style={{ fontSize: 12.5 }}>or</span>
          <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
        </div>

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
    case "auth/unauthorized-domain":
      return "This domain isn't authorized for Google sign-in yet — check Firebase console settings.";
    default:
      return "Something went wrong. Try again.";
  }
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.9c1.7-1.56 2.7-3.87 2.7-6.62z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 009 18z"/>
      <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 013.68 9c0-.59.1-1.17.27-1.7V4.97H.96A9 9 0 000 9c0 1.45.35 2.83.96 4.03l2.99-2.33z"/>
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 00.96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58z"/>
    </svg>
  );
}

function Topbar() {
  return (
    <div className="topbar">
      <div className="mark">H</div>
      <div className="name">HoldPay</div>
    </div>
  );
}
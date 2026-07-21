import { useEffect, useState } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "../lib/firebase";
import { useAuth } from "../lib/AuthContext";

// Shows once for a seller whose sellers/{uid} doc has no displayName yet —
// i.e. right after signup, before they've ever set one. Writes are allowed
// by firestore.rules (`allow write: if request.auth.uid == sellerId`), so
// this is a direct client write, same pattern as everything else here.
//
// Mount this once, high up — inside ProtectedRoute is the natural spot,
// since that's the one place every authenticated seller route already
// passes through. I don't have that file yet, so for now this is wired
// nowhere; see the note in chat for the two ways to place it.

const EMPTY = { displayName: "", handle: "", location: "", bio: "" };

export default function ProfileSetupModal() {
  const { user } = useAuth();
  const [checked, setChecked] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!user?.uid) return;
    (async () => {
      const snap = await getDoc(doc(db, "sellers", user.uid));
      const data = snap.exists() ? snap.data() : null;
      if (!data?.displayName) {
        setNeedsSetup(true);
        setForm({ ...EMPTY, ...data });
      }
      setChecked(true);
    })();
  }, [user]);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    if (!form.displayName.trim()) {
      setError("Add at least your name — buyers see this before they pay.");
      return;
    }

    setSaving(true);
    try {
      await setDoc(
        doc(db, "sellers", user.uid),
        {
          displayName: form.displayName.trim(),
          handle: form.handle.trim(),
          location: form.location.trim(),
          bio: form.bio.trim(),
        },
        { merge: true }
      );
      setNeedsSetup(false);
    } catch (err) {
      console.error("ProfileSetupModal: setDoc failed", err);
      setError(`Couldn't save: ${err.message || "unknown error"}. Try again.`);
    } finally {
      setSaving(false);
    }
  }

  if (!checked || !needsSetup) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(24, 30, 54, 0.55)",
      }}
    >
      <div className="card" style={{ width: "100%", maxWidth: 420 }}>
        <h2 style={{ fontSize: 18, marginTop: 0 }}>Set up your seller profile</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
          This is what a buyer sees before they send you money — takes under a minute.
        </p>

        {error && <div className="error-banner">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="field">
            <label>Your name</label>
            <input
              value={form.displayName}
              onChange={(e) => update("displayName", e.target.value)}
              placeholder="Chidinma Okafor"
              autoFocus
            />
          </div>
          <div className="field">
            <label>Handle (optional)</label>
            <input
              value={form.handle}
              onChange={(e) => update("handle", e.target.value)}
              placeholder="@chidinmabeads"
            />
          </div>
          <div className="field">
            <label>Location (optional)</label>
            <input
              value={form.location}
              onChange={(e) => update("location", e.target.value)}
              placeholder="Lagos, NG"
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Short bio (optional)</label>
            <textarea
              value={form.bio}
              onChange={(e) => update("bio", e.target.value)}
              placeholder="What you sell, how you ship, anything that builds trust."
            />
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button className="btn btn-primary" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save and continue"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={saving}
              onClick={() => setNeedsSetup(false)}
            >
              Skip for now
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
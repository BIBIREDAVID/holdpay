import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { collection, doc, setDoc, serverTimestamp } from "firebase/firestore";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage, FUNCTIONS_BASE_URL } from "../lib/firebase";
import { useAuth } from "../lib/AuthContext";
import SellerNav from "../components/SellerNav";
import AppSidebar from "../components/AppSidebar";
// npm install qrcode.react
import { QRCodeSVG } from "qrcode.react";

// Resizes/recompresses client-side before upload — phone-camera photos are
// often 3-8MB, which is a real cost/speed problem on the mobile data most
// buyers and sellers here are on. 1200px is plenty for a trust photo.
async function compressImage(file, maxWidth = 1200, quality = 0.8) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

function generateRef() {
  return "HP-" + crypto.randomUUID().slice(0, 8).toUpperCase();
}

function formatNairaPreview(amountNaira) {
  const n = parseFloat(amountNaira);
  if (!n || Number.isNaN(n)) return "₦0";
  return `₦${n.toLocaleString("en-NG")}`;
}

const MIN_RELEASE_DAYS = 1;
const MAX_RELEASE_DAYS = 30;
const DEFAULT_RELEASE_DAYS = 7;

export default function CreateEscrow() {
  const { user } = useAuth();
  const [itemDesc, setItemDesc] = useState("");
  const [amountNaira, setAmountNaira] = useState("");
  const [buyerPhone, setBuyerPhone] = useState("");
  const [buyerEmail, setBuyerEmail] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [bankCode, setBankCode] = useState("");
  const [banks, setBanks] = useState([]);
  const [banksLoading, setBanksLoading] = useState(true);
  const [banksError, setBanksError] = useState(null);
  const [autoReleaseDays, setAutoReleaseDays] = useState(String(DEFAULT_RELEASE_DAYS));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  function handlePhotoChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoFile(file);
    setPhotoPreviewUrl(URL.createObjectURL(file));
  }

  // Bank account resolve — debounced so it fires ~500ms after the seller
  // stops typing in either field, not on every keystroke.
  const [resolving, setResolving] = useState(false);
  const [resolvedName, setResolvedName] = useState(null);
  const [payoutConfirmed, setPayoutConfirmed] = useState(false);
  const [resolveError, setResolveError] = useState(null);
  const resolveTimer = useRef(null);
  const resolveRequestId = useRef(0);

  // Real bank list from Monnify, not a hardcoded array — codes have to
  // match exactly what Monnify's own system recognizes, and a stale
  // hand-typed list would silently drift out of sync over time.
  useEffect(() => {
    let cancelled = false;
    async function loadBanks() {
      try {
        const res = await fetch(`${FUNCTIONS_BASE_URL}/getBanks`);
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok || !body.banks) {
          setBanksError("Couldn't load the bank list — you can still type a code directly.");
          return;
        }
        setBanks(body.banks);
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          setBanksError("Couldn't reach HoldPay for the bank list — you can still type a code directly.");
        }
      } finally {
        if (!cancelled) setBanksLoading(false);
      }
    }
    loadBanks();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setResolvedName(null);
    setResolveError(null);
    setPayoutConfirmed(false);

    if (resolveTimer.current) clearTimeout(resolveTimer.current);

    const accNum = accountNumber.trim();
    const code = bankCode.trim();
    if (accNum.length < 10 || !code) return;

    resolveTimer.current = setTimeout(async () => {
      const thisRequest = ++resolveRequestId.current;
      setResolving(true);
      try {
        const idToken = await user.getIdToken();
        const res = await fetch(`${FUNCTIONS_BASE_URL}/resolveBankAccount`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({ accountNumber: accNum, bankCode: code }),
        });
        const body = await res.json().catch(() => ({}));

        // Ignore stale responses if the seller kept typing after this fired.
        if (thisRequest !== resolveRequestId.current) return;

        if (!res.ok) {
          setResolveError(body.error || "Couldn't verify that account. You can still continue.");
          return;
        }
        setResolvedName(body.accountName);
      } catch (err) {
        if (thisRequest !== resolveRequestId.current) return;
        console.error(err);
        setResolveError("Couldn't reach the bank lookup. You can still continue.");
      } finally {
        if (thisRequest === resolveRequestId.current) setResolving(false);
      }
    }, 500);

    return () => {
      if (resolveTimer.current) clearTimeout(resolveTimer.current);
    };
  }, [accountNumber, bankCode, user]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    if (!itemDesc.trim() || !amountNaira || !buyerPhone.trim() || !buyerEmail.trim()) {
      setError("Fill in the item, price, buyer's phone number, and buyer's email.");
      return;
    }

    // Bank details can't be edited after creation (see StatusTracker) — this
    // is the one point where a typo can still be caught, so if we managed
    // to resolve a name, require the seller to actually look at it.
    if (resolvedName && !payoutConfirmed) {
      setError(`Please confirm the payout account name (${resolvedName}) below before continuing.`);
      return;
    }

    const releaseDaysNum = parseInt(autoReleaseDays, 10);
    if (
      !Number.isFinite(releaseDaysNum) ||
      releaseDaysNum < MIN_RELEASE_DAYS ||
      releaseDaysNum > MAX_RELEASE_DAYS
    ) {
      setError(`Release window needs to be between ${MIN_RELEASE_DAYS} and ${MAX_RELEASE_DAYS} days.`);
      return;
    }

    setSubmitting(true);
    try {
      const confirmToken = crypto.randomUUID();
      const reservedAccountRef = generateRef();

      // Pre-generate the doc reference so we know the escrow ID before
      // writing — needed because the photo path is keyed on escrowId, and
      // escrows can't be updated after creation (create-then-locked, per
      // your Firestore rules), so the photo URL has to be known upfront.
      const escrowRef = doc(collection(db, "escrows"));

      let photoUrl = null;
      if (photoFile) {
        setUploadingPhoto(true);
        try {
          const compressed = await compressImage(photoFile);
          const path = `sellers/${user.uid}/escrows/${escrowRef.id}/photo.jpg`;
          await uploadBytes(storageRef(storage, path), compressed, {
            contentType: "image/jpeg",
          });
          photoUrl = await getDownloadURL(storageRef(storage, path));
        } catch (err) {
          console.error(err);
          // Non-fatal — the escrow still gets created without a photo
          // rather than blocking the seller over an upload hiccup.
        } finally {
          setUploadingPhoto(false);
        }
      }

      await setDoc(escrowRef, {
        status: "pending_payment",
        amount: Math.round(parseFloat(amountNaira) * 100),
        itemDesc: itemDesc.trim(),
        photoUrl,
        sellerUid: user.uid,
        sellerBankAccount: {
          accountNumber: accountNumber.trim(),
          bankCode: bankCode.trim(),
          // Filled in automatically if the resolve lookup succeeded — the
          // seller isn't blocked from continuing if it didn't.
          accountName: resolvedName || "",
        },
        buyerContact: {
          email: buyerEmail.trim(),
          phone: buyerPhone.trim(),
        },
        buyerConfirmToken: confirmToken,
        autoReleaseDays: releaseDaysNum,
        monnify: {
          reservedAccountNumber: "PENDING",
          reservedAccountRef,
          bankName: "",
        },
        createdAt: serverTimestamp(),
        paidAt: null,
        shippedAt: null,
        autoReleaseAt: null,
        reminderSentAt: null,
        confirmedAt: null,
        releasedAt: null,
        disputedAt: null,
        disputeReason: null,
      });

      const buyerLink = `${window.location.origin}/pay/${confirmToken}`;
      setCreated({ escrowId: escrowRef.id, buyerLink });
    } catch (err) {
      console.error("CreateEscrow: setDoc failed", err);
      // Surfacing err.message (not just a generic string) so a real cause —
      // permission-denied, offline, quota, etc. — is visible in the UI
      // itself without needing to open DevTools to diagnose it.
      setError(`Couldn't create the escrow: ${err.message || "unknown error"}. Check your connection and try again.`);
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    return (
      <div className="app-shell">
        <AppSidebar active="new" />
        <div className="page">
          <SellerNav active="new" />
          <div className="card">
            <h2>Escrow created</h2>
            <p className="muted">
              Send this link to your buyer on WhatsApp or Instagram. They'll pay
              into a dedicated account, and you'll both see the funds held until
              confirmed.
            </p>
            <div className="field">
              <label>Buyer's payment link</label>
              <input readOnly value={created.buyerLink} onFocus={(e) => e.target.select()} />
            </div>
            <button
              className="btn btn-primary"
              onClick={() => navigator.clipboard.writeText(created.buyerLink)}
            >
              Copy link
            </button>
            <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
              <div style={{ background: "white", padding: 16, borderRadius: "var(--radius-sm)", border: "1px solid var(--line)" }}>
                <QRCodeSVG value={created.buyerLink} size={180} fgColor="#1b1f3b" level="M" />
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setCreated(null)}>
              Create another
            </button>
            <Link to="/dashboard" className="btn btn-primary" style={{ flex: 1, textDecoration: "none", textAlign: "center" }}>
              Go to dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <AppSidebar active="new" />
      <div className="page">
        <SellerNav active="new" />
        <h1>New escrow</h1>
        <p className="muted" style={{ marginBottom: 20 }}>
          Set up a protected transaction. Your buyer pays into a dedicated
          account — you only get paid once they confirm the item arrived.
        </p>

        {error && <div className="error-banner">{error}</div>}

        <div className="create-shell">
          <form onSubmit={handleSubmit}>
            <div className="card">
              <div className="field">
                <label>What are you selling?</label>
                <textarea
                  value={itemDesc}
                  onChange={(e) => setItemDesc(e.target.value)}
                  placeholder="e.g. iPhone 13 Pro Max, 256GB, UK used"
                />
              </div>
              <div className="field">
                <label>Price (₦)</label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={amountNaira}
                  onChange={(e) => setAmountNaira(e.target.value)}
                  placeholder="45000"
                />
              </div>
              <div className="field">
                <label>Buyer's phone number</label>
                <input
                  type="tel"
                  value={buyerPhone}
                  onChange={(e) => setBuyerPhone(e.target.value)}
                  placeholder="0801 234 5678"
                />
                <div className="hint">Used to send the buyer their payment link.</div>
              </div>
              <div className="field">
                <label>Buyer's email</label>
                <input
                  type="email"
                  required
                  value={buyerEmail}
                  onChange={(e) => setBuyerEmail(e.target.value)}
                  placeholder="buyer@example.com"
                />
                <div className="hint">
                  Required — they'll get email updates at every step: payment received,
                  shipped, released, and any disputes.
                </div>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Photo (optional)</label>
                <input type="file" accept="image/*" onChange={handlePhotoChange} />
                {photoFile && (
                  <div className="hint" style={{ color: "var(--ok)", fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                    {photoFile.name}
                    <button
                      type="button"
                      className="nav-logout"
                      style={{ fontSize: 12, fontWeight: 600, padding: 0 }}
                      onClick={() => {
                        setPhotoFile(null);
                        setPhotoPreviewUrl(null);
                      }}
                    >
                      Remove
                    </button>
                  </div>
                )}
                <div className="hint">
                  One photo of the item — meaningfully raises trust for a buyer paying a
                  stranger upfront. Resized automatically before upload.
                </div>
              </div>
            </div>

            <div className="card">
              <h3 style={{ fontSize: 15 }}>Where should we send your money?</h3>
              <div className="field">
                <label>Account number</label>
                <input
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  placeholder="0123456789"
                />
              </div>
              <div className="field">
                <label>Bank</label>
                {banksLoading ? (
                  <input value="" placeholder="Loading banks…" disabled />
                ) : banks.length > 0 ? (
                  <select value={bankCode} onChange={(e) => setBankCode(e.target.value)}>
                    <option value="">Select a bank</option>
                    {banks.map((b) => (
                      <option key={b.code} value={b.code}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={bankCode}
                    onChange={(e) => setBankCode(e.target.value)}
                    placeholder="058 (GTBank)"
                  />
                )}
                {banksError && <div className="hint" style={{ color: "var(--danger)" }}>{banksError}</div>}
              </div>

              {resolving && <div className="hint">Checking account…</div>}
              {!resolving && resolvedName && (
                <label
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    marginTop: 8,
                    padding: 10,
                    background: "var(--ok-tint)",
                    border: "1px solid #3c8c5d40",
                    borderRadius: "var(--radius-sm)",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={payoutConfirmed}
                    onChange={(ev) => setPayoutConfirmed(ev.target.checked)}
                    style={{ width: "auto", marginTop: 3 }}
                  />
                  <span style={{ fontSize: 13, color: "var(--ok)", fontWeight: 600 }}>
                    Yes, pay out to <strong>{resolvedName}</strong> — this can't be changed
                    once the escrow is created.
                  </span>
                </label>
              )}
              {!resolving && resolveError && (
                <div className="hint" style={{ color: "var(--danger)" }}>{resolveError}</div>
              )}
            </div>

            <div className="card">
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Auto-release window</label>
                <input
                  type="number"
                  min={MIN_RELEASE_DAYS}
                  max={MAX_RELEASE_DAYS}
                  value={autoReleaseDays}
                  onChange={(e) => setAutoReleaseDays(e.target.value)}
                />
                <div className="hint">
                  Days after you mark an item shipped before funds release automatically if
                  the buyer hasn't confirmed or disputed. Default 7, max 30.
                </div>
              </div>
            </div>

            <button className="btn btn-primary" type="submit" disabled={submitting}>
              {uploadingPhoto ? "Uploading photo…" : submitting ? "Creating…" : "Create escrow & get payment link"}
            </button>
          </form>

          {/* Desktop-only — hidden below 960px. Shows the buyer what they'll
              see, updating live as the seller fills the form in. */}
          <div className="create-preview">
            <div className="card">
              <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
                What your buyer will see
              </div>
              {photoPreviewUrl && (
                <img
                  src={photoPreviewUrl}
                  alt="Item preview"
                  style={{
                    width: "100%",
                    aspectRatio: "4 / 3",
                    objectFit: "contain",
                    background: "var(--paper)",
                    borderRadius: "var(--radius-sm)",
                    marginBottom: 12,
                  }}
                />
              )}
              <span className="seal seal-pending">
                <span className="dot" />
                Awaiting payment
              </span>
              <h3 style={{ marginTop: 14, marginBottom: 4, fontSize: 16 }}>
                {itemDesc.trim() || "Item description"}
              </h3>
              <div className="amount-display" style={{ fontSize: 22 }}>
                {formatNairaPreview(amountNaira)}
              </div>
              <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
                This is the receipt your buyer opens from their payment link —
                before they've paid anything.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
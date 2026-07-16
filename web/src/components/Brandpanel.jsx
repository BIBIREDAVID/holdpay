const COPY = {
  seller: {
    title: "Get paid for your IG and WhatsApp sales — without the trust issues.",
    body: "Buyers pay into a dedicated account. You ship. Funds release once they confirm. No more chargebacks, no more \u201csent the alert\u201d screenshots.",
  },
  buyer: {
    title: "Your money is safe until your item shows up.",
    body: "HoldPay keeps buyer funds in a dedicated account and only releases them to the seller once you confirm the item arrived.",
  },
};

// Shown only above 960px (.auth-brand { display: none } by default).
// Fills the empty space on Login/Signup and the buyer payment page with
// the pitch, instead of leaving a lone form floating in blank paper.
export default function BrandPanel({ variant = "seller" }) {
  const copy = COPY[variant] || COPY.seller;

  return (
    <aside className="auth-brand">
      <div className="auth-brand-seal" aria-hidden="true" />

      <div className="auth-brand-mark">
        <div className="mark">H</div>
        <div className="name">HoldPay</div>
      </div>

      <h2 className="auth-brand-title">{copy.title}</h2>
      <p className="auth-brand-body">{copy.body}</p>

      <div className="auth-brand-steps">
        <span className="seal seal-held">
          <span className="dot" />
          Held
        </span>
        <span className="seal seal-shipped">
          <span className="dot" />
          Shipped
        </span>
        <span className="seal seal-released">
          <span className="dot" />
          Released
        </span>
      </div>
    </aside>
  );
}
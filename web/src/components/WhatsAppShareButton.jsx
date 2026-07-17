/**
 * WhatsAppShareButton
 *
 * Opens WhatsApp (app on mobile, web.whatsapp.com on desktop) with a
 * pre-filled message containing the item, price, and buyer payment link —
 * so the seller can send it straight into their existing chat with the buyer.
 *
 * Usage (on the "escrow created" screen, after you have itemDesc/amount/buyerLink):
 *
 *   <WhatsAppShareButton
 *     itemDesc={itemDesc}
 *     amountNaira={amountNaira}
 *     buyerLink={created.buyerLink}
 *   />
 *
 * If you already collect the buyer's phone number at creation time, pass it
 * as buyerPhone (E.164 or local Nigerian format, e.g. "08012345678") to open
 * WhatsApp directly in that contact's chat instead of the generic share sheet.
 */

function formatNaira(amount) {
  const n = typeof amount === "number" ? amount : parseFloat(amount);
  return `₦${n.toLocaleString("en-NG")}`;
}

function toWhatsAppPhone(phone) {
  if (!phone) return null;
  // Strip everything but digits, then normalise Nigerian local numbers
  // (0801...) to international format (234801...) which wa.me requires.
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("0")) return "234" + digits.slice(1);
  if (digits.startsWith("234")) return digits;
  return digits;
}

export default function WhatsAppShareButton({ itemDesc, amountNaira, buyerLink, buyerPhone }) {
  const message =
    `Hi! Here's your secure payment link for *${itemDesc}* (${formatNaira(amountNaira)}).\n\n` +
    `Your money is held safely by HoldPay until you confirm you've received the item:\n${buyerLink}`;

  const phone = toWhatsAppPhone(buyerPhone);
  const url = phone
    ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}`
    : `https://wa.me/?text=${encodeURIComponent(message)}`;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="btn"
      style={{
        background: "#25D366",
        color: "white",
        textDecoration: "none",
      }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.87 9.87 0 0 0 4.74 1.21h.01c5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2Zm0 18.03h-.01a8.2 8.2 0 0 1-4.18-1.14l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.36c0-4.54 3.7-8.24 8.25-8.24 2.2 0 4.27.86 5.83 2.42a8.19 8.19 0 0 1 2.41 5.83c0 4.55-3.7 8.2-8.25 8.2Zm4.52-6.16c-.25-.12-1.47-.72-1.7-.81-.23-.08-.39-.12-.56.13-.17.25-.64.81-.78.97-.14.17-.29.19-.54.06-.25-.12-1.04-.38-1.98-1.22-.73-.65-1.23-1.46-1.37-1.7-.14-.25-.02-.38.11-.51.11-.11.25-.29.37-.43.12-.15.16-.25.25-.42.08-.17.04-.31-.02-.44-.06-.12-.56-1.35-.77-1.85-.2-.48-.41-.42-.56-.43h-.48c-.17 0-.44.06-.67.31-.23.25-.87.85-.87 2.08s.89 2.41 1.02 2.58c.12.17 1.75 2.67 4.25 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.67-1.18.21-.58.21-1.08.14-1.18-.06-.1-.23-.16-.48-.28Z" />
      </svg>
      Send via WhatsApp
    </a>
  );
}
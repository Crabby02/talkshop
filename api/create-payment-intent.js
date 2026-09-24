// Creates a Stripe PaymentIntent for a TalkShop checkout order.
//
// v1 money flow: the platform's Stripe account receives the card funds for
// the order. Each merchant is then paid out manually by the platform using
// the payout details the merchant entered in the storefront builder (UPI ID
// or bank account). The platform retains PLATFORM_FEE_PCT of each card
// payment. Automated per-merchant payouts (Stripe Connect) can replace this
// manual step later without changing the checkout page.
//
// No npm dependencies: Stripe is called over plain REST with fetch.
"use strict";

const PLATFORM_FEE_PCT = 3;

const CURRENCY_ALLOWLIST = new Set([
  "USD","EUR","GBP","INR","AED","SAR","QAR","KWD","BHD","OMR",
  "SGD","MYR","IDR","PHP","THB","VND","JPY","KRW","HKD","TWD",
  "AUD","NZD","CAD","CHF","SEK","NOK","DKK","ZAR","NGN","KES",
  "GHS","EGP","BRL","MXN","ARS","CLP","COP","PEN","TRY","ILS",
  "PKR","BDT","LKR","NPR","CNY","PLN","CZK","HUF","RON"
]);

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === "object") { resolve(req.body); return; }
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch (e) { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const secret = process.env.STRIPE_SECRET_KEY || "";
  if (!secret) {
    // Demo mode: no keys configured, the client simulates payment locally.
    res.status(200).json({ demo: true });
    return;
  }

  const body = await readBody(req);
  const amount = Number(body.amount);
  const currency = String(body.currency || "").toUpperCase();

  if (!Number.isInteger(amount) || amount <= 0 || amount >= 10000000) {
    res.status(400).json({ error: "bad_amount" });
    return;
  }
  if (!CURRENCY_ALLOWLIST.has(currency)) {
    res.status(400).json({ error: "bad_currency" });
    return;
  }

  const orderId = String(body.orderId || "").slice(0, 32);
  const shop = String(body.shop || "").slice(0, 80);

  const params = new URLSearchParams();
  params.set("amount", String(amount));
  params.set("currency", currency.toLowerCase());
  params.set("automatic_payment_methods[enabled]", "true");
  if (orderId) params.set("description", "TalkShop order " + orderId + (shop ? " for " + shop : ""));
  params.set("metadata[order_id]", orderId || "unknown");
  params.set("metadata[shop]", shop || "unknown");
  params.set("metadata[platform_fee_pct]", String(PLATFORM_FEE_PCT));

  let r;
  try {
    r = await fetch("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + secret,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });
  } catch (e) {
    res.status(502).json({ error: "stripe_unreachable" });
    return;
  }

  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok || !j || !j.client_secret) {
    res.status(r.status || 500).json({ error: "stripe_error" });
    return;
  }
  res.status(200).json({ clientSecret: j.client_secret });
};

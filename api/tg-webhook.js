// TalkShop Telegram shop bot webhook (v1) — @TalkShopBot.
//
//   POST /api/tg-webhook   <- Telegram update webhook
//
// Flow: /start -> customer sends an 8-char shop ID -> product list as inline
// buttons -> tap product -> variants (if any) -> add to cart -> /cart ->
// checkout (name, phone, pickup/delivery, address) -> order summary with a
// TS-XXXXXX order code. Shopkeeper notification v1 is customer-driven: if the
// shop payload has a WhatsApp number we hand the customer a wa.me deep link
// with the order prefilled; otherwise we give them the order code to share.
//
// v1 limitations (noted, not done here):
// - Sessions live in an in-memory Map. Serverless instances are ephemeral, so
//   a cart can vanish on a cold start or if traffic hits another instance.
//   Follow-up: persist sessions (same store as /api/shops).
// - No in-Telegram payment. That needs a payment provider token (e.g. Stripe)
//   wired to Telegram Payments via sendInvoice. Do NOT fake a payment UI.
// - No automated shopkeeper push notification. Follow-up: notify the merchant
//   (Telegram/WhatsApp/email) when an order lands, with merchant opt-in.
//
// Security notes:
// - The bot token is read ONLY from process.env.TELEGRAM_BOT_TOKEN and is
//   never logged, never echoed into messages, never persisted.
// - Update shapes are validated; shop IDs must match ID_RE; user text is
//   length-capped; no parse_mode is used so user content cannot inject
//   Telegram markup.
"use strict";

const https = require("https");
const crypto = require("crypto");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ID_RE = /^[2-9A-HJ-NP-Z]{8}$/;
const ORDER_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const MAX_TEXT = 4000;      // stay under Telegram's 4096 message cap
const MAX_PRODUCTS = 40;    // buttons per shop listing

// Country code -> ISO currency, mirrors the storefront's COUNTRY table.
const CUR={IN:'INR',CN:'CNY',US:'USD',GB:'GBP',CA:'CAD',AU:'AUD',SG:'SGD',AE:'AED',BR:'BRL',PT:'EUR',ES:'EUR',MX:'MXN',AR:'ARS',CL:'CLP',CO:'COP',PE:'PEN',FR:'EUR',DE:'EUR',IT:'EUR',NL:'EUR',JP:'JPY',KR:'KRW',ID:'IDR',MY:'MYR',PH:'PHP',TH:'THB',VN:'VND',BD:'BDT',PK:'PKR',LK:'LKR',NP:'NPR',ZA:'ZAR',NG:'NGN',KE:'KES',EG:'EGP',SA:'SAR',IL:'ILS',TR:'TRY',RU:'RUB',SE:'SEK',NO:'NOK',CH:'CHF',NZ:'NZD'};

// --- per-chat sessions (see v1 limitation note above) ---
const sessions = new Map(); // chatId -> {step, shopId, shop, cart, co}
function sess(chatId) {
  let s = sessions.get(chatId);
  if (!s) { s = { step: "await_id", shopId: null, shop: null, cart: [], co: {} }; sessions.set(chatId, s); }
  return s;
}
function resetSession(chatId, keepShop) {
  const old = sessions.get(chatId);
  const s = { step: "await_id", shopId: null, shop: null, cart: [], co: {} };
  if (keepShop && old && old.shop) { s.step = "browse"; s.shopId = old.shopId; s.shop = old.shop; }
  sessions.set(chatId, s);
  return s;
}

// --- Telegram API ---
function tg(method, body) {
  return new Promise((resolve) => {
    if (!TOKEN) { resolve(null); return; }
    let data;
    try { data = JSON.stringify(body); } catch (e) { resolve(null); return; }
    const req = https.request(
      { hostname: "api.telegram.org", path: "/bot" + TOKEN + "/" + method, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => { try { resolve(JSON.parse(raw)); } catch (e) { resolve(null); } });
      }
    );
    req.on("error", () => resolve(null));
    req.setTimeout(15000, () => { try { req.destroy(); } catch (e) {} resolve(null); });
    req.write(data);
    req.end();
  });
}
function sendMsg(chatId, text, extra) {
  const body = Object.assign({ chat_id: chatId, text: clip(text) }, extra || {});
  return tg("sendMessage", body);
}
function answerCb(cbId, text) {
  return tg("answerCallbackQuery", { callback_query_id: cbId, text: text || "" });
}
function editMsg(chatId, msgId, text, extra) {
  const body = Object.assign({ chat_id: chatId, message_id: msgId, text: clip(text) }, extra || {});
  return tg("editMessageText", body);
}

// --- helpers ---
function clip(s) {
  s = String(s == null ? "" : s);
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "..." : s;
}
// Numeric value out of a merchant price string, mirroring the storefront.
function normPrice(s) {
  s = String(s == null ? "" : s).trim();
  if (!s) return 0;
  if (s.indexOf(",") >= 0 && s.indexOf(".") < 0) s = s.replace(",", ".");
  s = s.replace(/,/g, "");
  const m = s.match(/[\d]+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}
function shopCurrency(shop) {
  const cc = shop && shop.loc && shop.loc.cc;
  return (cc && CUR[cc]) || "USD";
}
function fmt(amount, cur) {
  const n = Number(amount) || 0;
  try { return new Intl.NumberFormat("en", { style: "currency", currency: cur }).format(n); }
  catch (e) { return cur + " " + n.toFixed(2); }
}
function productPrice(p) {
  // {label, min} — base price, or "from X" when variants carry prices.
  const base = normPrice(p.price);
  const vps = (p.variants || []).map((v) => normPrice(v.p)).filter((n) => n > 0);
  if (!vps.length) return { label: base > 0 ? null : "Price on request", min: base };
  const m = Math.min.apply(null, vps);
  return { label: "from", min: m };
}
function priceText(p, cur) {
  const pp = productPrice(p);
  if (pp.label === "Price on request") return "Price on request";
  return (pp.label ? pp.label + " " : "") + fmt(pp.min, cur);
}
function lineLabel(p, vi) {
  const v = vi >= 0 && p.variants && p.variants[vi] ? p.variants[vi] : null;
  return v ? p.name + " (" + v.n + ")" : String(p.name || "Item");
}
function linePrice(p, vi) {
  const v = vi >= 0 && p.variants && p.variants[vi] ? p.variants[vi] : null;
  const raw = v && v.p ? v.p : p.price;
  return normPrice(raw);
}
function cartTotal(s) {
  return s.cart.reduce((t, l) => t + l.price * l.qty, 0);
}
function newOrderId() {
  const b = crypto.randomBytes(6);
  let id = "TS-";
  for (let i = 0; i < 6; i++) id += ORDER_ALPHABET[b[i] % 32];
  return id;
}
function cleanDigits(s) {
  return String(s || "").replace(/\D/g, "");
}
function shopHost(req) {
  const h = req.headers["x-forwarded-host"] || req.headers.host || process.env.VERCEL_URL || "";
  return String(h).split(",")[0].trim();
}
function fetchShop(req, id) {
  return new Promise((resolve) => {
    const host = shopHost(req);
    if (!host) { resolve(null); return; }
    const req2 = https.request(
      { hostname: host, path: "/api/shops?id=" + encodeURIComponent(id), method: "GET",
        headers: { "Accept": "application/json" } },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          if (res.statusCode !== 200) { resolve(null); return; }
          try {
            const o = JSON.parse(raw);
            resolve(o && o.payload ? o.payload : null);
          } catch (e) { resolve(null); }
        });
      }
    );
    req2.on("error", () => resolve(null));
    req2.setTimeout(12000, () => { try { req2.destroy(); } catch (e) {} resolve(null); });
    req2.end();
  });
}

// --- views ---
function productKeyboard(s) {
  const prods = (s.shop.products || []).slice(0, MAX_PRODUCTS);
  const rows = prods.map((p, i) => [{ text: clip(String(p.name || "Item")).slice(0, 60), callback_data: "p:" + i }]);
  rows.push([{ text: "View cart", callback_data: "cart" }]);
  return { inline_keyboard: rows };
}
async function showShop(chatId, s) {
  const d = s.shop;
  const cur = shopCurrency(d);
  const n = (d.products || []).length;
  let text = d.name + "\n";
  if (d.tagline) text += d.tagline + "\n";
  text += n + (n === 1 ? " item" : " items") + " (prices in " + cur + ")\n\nTap an item to add it to your cart:";
  await sendMsg(chatId, text, { reply_markup: productKeyboard(s) });
}
async function showProduct(chatId, s, pi) {
  const p = (s.shop.products || [])[pi];
  if (!p) return;
  const cur = shopCurrency(s.shop);
  let text = (p.name || "Item") + "\n" + priceText(p, cur);
  const vars = p.variants || [];
  if (vars.length) {
    text += "\n\nChoose an option:";
    const rows = vars.map((v, vi) => [{
      text: (String(v.n || "Option") + (v.p ? " - " + fmt(normPrice(v.p), cur) : "")).slice(0, 60),
      callback_data: "v:" + pi + ":" + vi,
    }]);
    rows.push([{ text: "Back to items", callback_data: "shop" }]);
    await sendMsg(chatId, text, { reply_markup: { inline_keyboard: rows } });
  } else {
    const rows = [[
      { text: "Add to cart", callback_data: "v:" + pi + ":-1" },
      { text: "Back to items", callback_data: "shop" },
    ]];
    await sendMsg(chatId, text, { reply_markup: { inline_keyboard: rows } });
  }
}
function cartText(s) {
  const cur = shopCurrency(s.shop);
  if (!s.cart.length) return { text: "Your cart is empty.", total: 0, cur };
  const lines = s.cart.map((l, i) => (i + 1) + ". " + l.qty + "x " + l.label + " - " + fmt(l.price * l.qty, cur));
  const total = cartTotal(s);
  return { text: "Your cart:\n\n" + lines.join("\n") + "\n\nTotal: " + fmt(total, cur), total, cur };
}
async function showCart(chatId, s, msgId) {
  const c = cartText(s);
  const rows = s.cart.map((l, i) => [{ text: "Remove: " + clip(l.label).slice(0, 40), callback_data: "rm:" + i }]);
  if (s.cart.length) rows.push([{ text: "Checkout", callback_data: "co" }]);
  rows.push([{ text: "Back to items", callback_data: "shop" }]);
  const kb = { reply_markup: { inline_keyboard: rows } };
  if (msgId) await editMsg(chatId, msgId, c.text, kb);
  else await sendMsg(chatId, c.text, kb);
}
async function addLine(chatId, cbId, s, pi, vi, msgId) {
  const p = (s.shop.products || [])[pi];
  if (!p) { await answerCb(cbId); return; }
  const key = pi + ":" + vi;
  const cur = shopCurrency(s.shop);
  const price = linePrice(p, vi);
  const label = lineLabel(p, vi);
  const ex = s.cart.find((l) => l.key === key);
  if (ex) ex.qty += 1;
  else s.cart.push({ key, pi, vi, label, price, qty: 1 });
  await answerCb(cbId, "Added: " + clip(label).slice(0, 50));
  if (msgId) {
    // Refresh the cart message in place when the tap came from the cart.
    await showCart(chatId, s, msgId);
  }
}
function startCheckout(chatId, s) {
  s.step = "co_name";
  s.co = {};
  return sendMsg(chatId, "Great, let's check out.\n\nWhat's your name?");
}
function orderSummaryText(s, orderId) {
  const d = s.shop;
  const cur = shopCurrency(d);
  const lines = s.cart.map((l) => l.qty + "x " + l.label + " - " + fmt(l.price * l.qty, cur));
  let t = "New TalkShop order " + orderId + "\n";
  t += "Shop: " + d.name + "\n\n";
  t += lines.join("\n") + "\n";
  t += "Total: " + fmt(cartTotal(s), cur) + "\n\n";
  t += "Name: " + s.co.name + "\n";
  t += "Phone: " + s.co.phone + "\n";
  t += (s.co.mode === "delivery" ? "Delivery" : "Pickup");
  if (s.co.mode === "delivery" && s.co.addr) t += "\nAddress: " + s.co.addr;
  return t;
}
async function submitOrder(chatId, s) {
  const orderId = newOrderId();
  const summary = orderSummaryText(s, orderId);
  const waNum = cleanDigits(s.shop.whatsapp || "");
  if (waNum) {
    const url = "https://wa.me/" + waNum + "?text=" + encodeURIComponent(summary);
    await sendMsg(chatId,
      "Order " + orderId + " is ready.\n\n" + cartText(s).text +
      "\n\nTap below to send it to the shop on WhatsApp:",
      { reply_markup: { inline_keyboard: [[{ text: "Send order on WhatsApp", url }]] } });
  } else {
    await sendMsg(chatId,
      "Order " + orderId + " is ready.\n\n" + cartText(s).text +
      "\n\nShare this order code with the shop to confirm: " + orderId);
  }
  s.cart = [];
  s.co = {};
  s.step = "browse";
  await sendMsg(chatId, "Want to order more? Tap an item below:", { reply_markup: productKeyboard(s) });
}

// --- message handling ---
async function handleMessage(req, chatId, msg) {
  const s = sess(chatId);
  const text = ((msg.text || "") + "").trim();

  if (text === "/start") {
    resetSession(chatId, false);
    await sendMsg(chatId,
      "Hi! I'm the TalkShop ordering bot.\n\nSend me a shop ID (the 8-character code the shopkeeper shared, e.g. K7M2QX9P) and I'll show you what they're selling.");
    return;
  }
  if (text === "/cart") {
    if (!s.shop) { await sendMsg(chatId, "Send me a shop ID first."); return; }
    await showCart(chatId, s, 0);
    return;
  }
  if (text === "/cancel") {
    resetSession(chatId, true);
    await sendMsg(chatId, s.shop ? "Checkout cancelled." : "OK, starting over. Send me a shop ID.");
    if (s.shop) await showShop(chatId, s);
    return;
  }
  if (!text) return;

  // Checkout conversation steps.
  if (s.step === "co_name") {
    const name = text.slice(0, 80);
    if (name.length < 2) { await sendMsg(chatId, "Please tell me your name."); return; }
    s.co.name = name;
    s.step = "co_phone";
    await sendMsg(chatId, "Thanks " + name + ". What's your phone number?");
    return;
  }
  if (s.step === "co_phone") {
    const phone = text.slice(0, 30);
    if (cleanDigits(phone).length < 6) { await sendMsg(chatId, "That doesn't look like a phone number. Try again?"); return; }
    s.co.phone = phone;
    s.step = "co_mode";
    await sendMsg(chatId, "Pickup or delivery?", {
      reply_markup: { inline_keyboard: [[
        { text: "Pickup", callback_data: "mode:pickup" },
        { text: "Delivery", callback_data: "mode:delivery" },
      ]] },
    });
    return;
  }
  if (s.step === "co_addr") {
    const addr = text.slice(0, 200);
    if (addr.length < 4) { await sendMsg(chatId, "Please share your delivery address."); return; }
    s.co.addr = addr;
    await submitOrder(chatId, s);
    return;
  }

  // Shop ID entry (also works mid-browse: switches shops, clears cart).
  const cand = text.toUpperCase().replace(/\s+/g, "");
  if (ID_RE.test(cand)) {
    const shop = await fetchShop(req, cand);
    if (!shop || !shop.name) {
      await sendMsg(chatId, "I couldn't find a shop with that ID. Check the code and try again, or /start to begin over.");
      return;
    }
    s.shopId = cand;
    s.shop = shop;
    s.cart = [];
    s.co = {};
    s.step = "browse";
    await showShop(chatId, s);
    return;
  }

  if (s.step === "await_id") {
    await sendMsg(chatId, "Send me a shop ID (8 characters, e.g. K7M2QX9P) to browse a shop.");
    return;
  }
  await sendMsg(chatId, "Send a shop ID to switch shops, /cart to see your cart, or /start to begin over.");
}

// --- callback handling ---
async function handleCallback(req, chatId, cb) {
  const cbId = cb.id;
  const msgId = cb.message && cb.message.message_id;
  const data = String(cb.data || "");
  const s = sess(chatId);

  const parts = data.split(":");
  const kind = parts[0];

  if (!s.shop && kind !== "shop") { await answerCb(cbId); return; }

  if (kind === "p") {
    const pi = parseInt(parts[1], 10);
    await answerCb(cbId);
    if (Number.isInteger(pi)) await showProduct(chatId, s, pi);
    return;
  }
  if (kind === "v") {
    const pi = parseInt(parts[1], 10);
    const vi = parseInt(parts[2], 10);
    if (Number.isInteger(pi) && Number.isInteger(vi)) await addLine(chatId, cbId, s, pi, vi, 0);
    else await answerCb(cbId);
    return;
  }
  if (kind === "cart") {
    await answerCb(cbId);
    await showCart(chatId, s, 0);
    return;
  }
  if (kind === "shop") {
    await answerCb(cbId);
    await showShop(chatId, s);
    return;
  }
  if (kind === "rm") {
    const i = parseInt(parts[1], 10);
    if (Number.isInteger(i) && s.cart[i]) s.cart.splice(i, 1);
    await answerCb(cbId, "Removed");
    await showCart(chatId, s, msgId);
    return;
  }
  if (kind === "co") {
    await answerCb(cbId);
    if (!s.cart.length) { await sendMsg(chatId, "Your cart is empty."); return; }
    await startCheckout(chatId, s);
    return;
  }
  if (kind === "mode") {
    const mode = parts[1] === "delivery" ? "delivery" : "pickup";
    s.co.mode = mode;
    await answerCb(cbId);
    if (mode === "delivery") {
      s.step = "co_addr";
      await sendMsg(chatId, "What's your delivery address?");
    } else {
      await submitOrder(chatId, s);
    }
    return;
  }
  await answerCb(cbId);
}

// --- entry point ---
module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "method_not_allowed" }); return; }
  // Always 200 fast so Telegram doesn't retry storms; work happens above.
  try {
    let update = req.body;
    if (!update || typeof update !== "object") {
      let raw = "";
      await new Promise((resolve) => {
        req.on("data", (c) => { raw += c; if (raw.length > 200 * 1024) { try { req.destroy(); } catch (e) {} } });
        req.on("end", resolve);
        req.on("error", resolve);
      });
      try { update = JSON.parse(raw || "null"); } catch (e) { update = null; }
    }
    if (update && typeof update === "object") {
      if (update.message && update.message.chat && Number.isInteger(update.message.chat.id)) {
        await handleMessage(req, update.message.chat.id, update.message);
      } else if (update.callback_query && update.callback_query.message &&
                 update.callback_query.message.chat && Number.isInteger(update.callback_query.message.chat.id)) {
        await handleCallback(req, update.callback_query.message.chat.id, update.callback_query);
      }
    }
  } catch (e) {
    // Never leak internals or the token; Telegram just needs the 200.
  }
  res.status(200).json({ ok: true });
};

// TalkShop orders API.
//
//   POST  /api/orders  {shopId, items, customer, fulfillment, ...} -> {orderId, code}
//   GET   /api/orders?shopId=<id>&key=<merchantKey>               -> {orders: [...]} (newest first)
//   PATCH /api/orders  {shopId, orderId, key, status}             -> {orderId, status}
//
// Every checkout POSTs here first so the merchant gets an Orders inbox in
// their dashboard; the WhatsApp handoff continues to work regardless.
//
// Trust model: the client sends what it charged, and the server recomputes
// every money figure from the stored shop payload (product/variant prices,
// coupon rules, delivery rules) and rejects on mismatch beyond rounding.
// The merchantKey (issued by POST /api/shops) gates all reads and status
// writes. Customer PII is stored (needed for fulfillment) but never logged.
//
// Storage: orders/<shopId>/<orderId>.json per order plus a per-shop
// orders/<shopId>/index.json (newest first, capped) so GET is one fetch.
"use strict";

const store = require("./_lib/blob-store");
const util = require("./_lib/api-util");

const MAX_BODY = 256 * 1024;
const SHOP_ID_RE = /^[2-9A-HJ-NP-Z]{8}$/;
const ORDER_ID_RE = /^[2-9A-HJ-NP-Z]{12}$/;
const STATUSES = ["new", "preparing", "ready", "completed", "cancelled"];
const INDEX_CAP = 200;

function orderPath(shopId, orderId) { return "orders/" + shopId + "/" + orderId + ".json"; }
function indexPath(shopId) { return "orders/" + shopId + "/index.json"; }

function s(v, max) {
  if (v == null) return "";
  const t = String(v).slice(0, max);
  return t;
}

// Mirror of the storefront's priceNum(): variant price if present, else base
// price; explicit USD value takes precedence over parsed local price text.
// fxRate is supplied by the client (1 when no conversion happened).
function unitPriceOf(p, vi, fxRate) {
  const v = (p.variants && vi != null) ? p.variants[vi] : null;
  const usd = v ? v.usd : p.usd;
  if (usd != null && isFinite(Number(usd))) return Number(usd) * fxRate;
  let t = String(v ? v.p : (p.price || ""));
  if (t.indexOf(",") >= 0 && t.indexOf(".") < 0) t = t.replace(",", ".");
  t = t.replace(/,/g, "");
  const m = t.match(/[\d]+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}

function closeEnough(a, b, tol) {
  return Math.abs(Number(a) - Number(b)) <= tol;
}

async function loadShop(shopId) {
  const raw = await store.load(shopId);
  if (!raw) return null;
  try {
    const env = JSON.parse(raw);
    if (!env || !env.payload || typeof env.payload !== "object") return null;
    return env;
  } catch (e) { return null; }
}

function checkKey(env, key) {
  return !!(env && env.merchantKey && util.secretsEqual(key, env.merchantKey));
}

async function handlePost(req, res) {
  if (!util.rateOk(util.clientIp(req), 30, 60 * 1000)) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }
  const read = await util.readBody(req, MAX_BODY);
  if (!read.ok) {
    res.status(read.reason === "too_large" ? 413 : 400).json({ error: read.reason });
    return;
  }
  const b = read.body || {};
  const shopId = s(b.shopId, 16);
  if (!SHOP_ID_RE.test(shopId)) { res.status(400).json({ error: "bad_shop" }); return; }

  let env = null;
  try { env = await loadShop(shopId); }
  catch (e) { res.status(502).json({ error: "store_unreachable" }); return; }
  if (!env) { res.status(404).json({ error: "shop_not_found" }); return; }
  const d = env.payload;

  // --- field validation (no PII in error responses beyond what the client sent) ---
  const items = Array.isArray(b.items) ? b.items : null;
  if (!items || !items.length || items.length > 100) { res.status(400).json({ error: "bad_items" }); return; }
  const cust = b.customer || {};
  const name = s(cust.name, 100).trim(), phone = s(cust.phone, 40).trim(), address = s(cust.address, 500).trim();
  if (!name || !phone) { res.status(400).json({ error: "bad_customer" }); return; }
  const fulfillment = b.fulfillment === "delivery" ? "delivery" : (b.fulfillment === "pickup" ? "pickup" : null);
  if (!fulfillment) { res.status(400).json({ error: "bad_fulfillment" }); return; }
  const slot = s(b.slot, 120);
  const paymentMethod = s(b.paymentMethod, 40);
  const note = s(b.note, 1000);
  let currency = s(b.currency, 8).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) currency = "USD";
  let fxRate = Number(b.fxRate);
  if (!isFinite(fxRate) || fxRate <= 0 || fxRate > 100000) fxRate = 1;
  const couponCode = b.coupon && b.coupon.code ? s(b.coupon.code, 40).trim().toUpperCase() : null;
  const tIn = b.totals || {};

  // --- recompute every money figure from the stored payload ---
  const usdShop = (d.products || []).some(p => p.usd != null);
  let sub = 0;
  const lines = [];
  for (const it of items) {
    const pi = it.pi, vi = it.vi == null ? null : it.vi;
    const qty = it.qty;
    if (!Number.isInteger(pi) || pi < 0 || !d.products || !d.products[pi]) { res.status(400).json({ error: "bad_item" }); return; }
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) { res.status(400).json({ error: "bad_qty" }); return; }
    const p = d.products[pi];
    if (vi !== null && (!Number.isInteger(vi) || vi < 0 || !(p.variants && p.variants[vi]))) {
      res.status(400).json({ error: "bad_variant" }); return;
    }
    const unit = unitPriceOf(p, vi, fxRate);
    const sent = Number(it.unitPrice);
    if (!isFinite(sent) || sent < 0 || !closeEnough(unit, sent, 0.015 + 0.002 * Math.abs(unit))) {
      res.status(400).json({ error: "price_mismatch" });
      return;
    }
    sub += unit * qty;
    lines.push({
      name: s(it.name, 200), variant: it.variant == null ? null : s(it.variant, 200),
      qty: qty, unitPrice: Math.round(unit * 100) / 100
    });
  }

  let disc = 0, couponOut = null;
  if (couponCode) {
    const c = (d.coupons || []).find(x => String(x.code || "").trim().toUpperCase() === couponCode);
    if (!c) { res.status(400).json({ error: "bad_coupon" }); return; }
    if (c.type === "pct") disc = sub * Number(c.val || 0) / 100;
    else disc = Math.min(sub, usdShop ? Number(c.val || 0) * fxRate : Number(c.val || 0));
    couponOut = couponCode;
  }

  let fee = 0;
  if (fulfillment === "delivery" && d.dlv) {
    const fv = usdShop ? Number(d.dlv.fee || 0) * fxRate : Number(d.dlv.fee || 0);
    if (d.dlv.freeAbove != null) {
      const fa = usdShop ? Number(d.dlv.freeAbove) * fxRate : Number(d.dlv.freeAbove);
      fee = (sub - disc) >= fa ? 0 : fv;
    } else fee = fv;
  }
  const total = Math.max(0, sub - disc + fee);

  const tol = t => 0.05 + 0.002 * Math.abs(t);
  if (!closeEnough(sub, tIn.sub, tol(sub)) || !closeEnough(disc, tIn.disc, tol(disc)) ||
      !closeEnough(fee, tIn.fee, tol(fee)) || !closeEnough(total, tIn.total, tol(total))) {
    res.status(400).json({ error: "total_mismatch" });
    return;
  }

  // --- persist ---
  const now = new Date().toISOString();
  let idx = [];
  try {
    const rawIdx = await store.loadPath(indexPath(shopId));
    if (rawIdx) { const p = JSON.parse(rawIdx); if (Array.isArray(p)) idx = p; }
  } catch (e) { /* corrupted index: rebuild from scratch below */ idx = []; }

  let orderId = null, code = null;
  for (let i = 0; i < 8; i++) {
    const c = util.newOrderCode();
    if (!idx.some(o => o.code === c)) { code = c; break; }
  }
  if (!code) { res.status(503).json({ error: "code_collision" }); return; }
  for (let i = 0; i < 8; i++) {
    const cand = util.newOrderId();
    if (!idx.some(o => o.orderId === cand)) { orderId = cand; break; }
  }
  if (!orderId) { res.status(503).json({ error: "id_collision" }); return; }

  const order = {
    v: 1, orderId, code, shopId, createdAt: now, status: "new",
    items: lines,
    customer: { name, phone, address },
    fulfillment, slot, paymentMethod, couponCode,
    subtotal: Math.round(sub * 100) / 100,
    discount: Math.round(disc * 100) / 100,
    fee: Math.round(fee * 100) / 100,
    total: Math.round(total * 100) / 100,
    currency, note
  };
  idx.unshift(order);
  if (idx.length > INDEX_CAP) idx = idx.slice(0, INDEX_CAP);

  try {
    await store.savePath(orderPath(shopId, orderId), JSON.stringify(order));
    await store.savePath(indexPath(shopId), JSON.stringify(idx));
  } catch (e) {
    res.status(502).json({ error: "store_unreachable" });
    return;
  }
  res.status(200).json({ orderId, code });
}

async function handleGet(req, res) {
  if (!util.rateOk(util.clientIp(req), 120, 60 * 1000)) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }
  const shopId = s(req.query && req.query.shopId, 16);
  const key = s(req.query && req.query.key, 64);
  if (!SHOP_ID_RE.test(shopId)) { res.status(404).json({ error: "not_found" }); return; }
  let env = null;
  try { env = await loadShop(shopId); }
  catch (e) { res.status(502).json({ error: "store_unreachable" }); return; }
  if (!env || !checkKey(env, key)) { res.status(403).json({ error: "forbidden" }); return; }
  let idx = [];
  try {
    const raw = await store.loadPath(indexPath(shopId));
    if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) idx = p; }
  } catch (e) { res.status(502).json({ error: "store_corrupt" }); return; }
  res.status(200).json({ orders: idx });
}

async function handlePatch(req, res) {
  if (!util.rateOk(util.clientIp(req), 30, 60 * 1000)) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }
  const read = await util.readBody(req, 16 * 1024);
  if (!read.ok) { res.status(400).json({ error: read.reason }); return; }
  const b = read.body || {};
  const shopId = s(b.shopId, 16), orderId = s(b.orderId, 16), key = s(b.key, 64);
  const status = s(b.status, 16);
  if (!SHOP_ID_RE.test(shopId) || !ORDER_ID_RE.test(orderId) || STATUSES.indexOf(status) < 0) {
    res.status(400).json({ error: "bad_request" });
    return;
  }
  let env = null;
  try { env = await loadShop(shopId); }
  catch (e) { res.status(502).json({ error: "store_unreachable" }); return; }
  if (!env || !checkKey(env, key)) { res.status(403).json({ error: "forbidden" }); return; }

  let raw = null;
  try { raw = await store.loadPath(orderPath(shopId, orderId)); }
  catch (e) { res.status(502).json({ error: "store_unreachable" }); return; }
  if (!raw) { res.status(404).json({ error: "order_not_found" }); return; }
  let order = null;
  try { order = JSON.parse(raw); } catch (e) { res.status(502).json({ error: "store_corrupt" }); return; }

  order.status = status;
  order.updatedAt = new Date().toISOString();
  let idx = [];
  try {
    const rawIdx = await store.loadPath(indexPath(shopId));
    if (rawIdx) { const p = JSON.parse(rawIdx); if (Array.isArray(p)) idx = p; }
  } catch (e) { idx = []; }
  const ix = idx.findIndex(o => o.orderId === orderId);
  if (ix >= 0) { idx[ix] = order; } else { idx.unshift(order); }
  try {
    await store.savePath(orderPath(shopId, orderId), JSON.stringify(order));
    await store.savePath(indexPath(shopId), JSON.stringify(idx));
  } catch (e) { res.status(502).json({ error: "store_unreachable" }); return; }
  res.status(200).json({ orderId, status });
}

module.exports = async (req, res) => {
  if (req.method === "POST") { await handlePost(req, res); return; }
  if (req.method === "GET") { await handleGet(req, res); return; }
  if (req.method === "PATCH") { await handlePatch(req, res); return; }
  res.status(405).json({ error: "method_not_allowed" });
};

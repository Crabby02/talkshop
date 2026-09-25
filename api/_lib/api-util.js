// TalkShop shared API utilities (serverless).
//
// Small helpers used by api/shops.js and api/orders.js: per-instance rate
// limiting, client IP extraction, capped JSON body reading, timing-safe
// secret comparison, and unguessable ID/key generation.
"use strict";

const crypto = require("crypto");

// Unambiguous alphabet: no 0/O, 1/I/L. 32 symbols, 256 % 32 == 0, so no
// modulo bias when mapping random bytes.
const ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

const buckets = new Map();
function rateOk(ip, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start > windowMs) { b = { start: now, n: 0 }; buckets.set(ip, b); }
  b.n += 1;
  if (buckets.size > 5000) buckets.clear();
  return b.n <= limit;
}

function clientIp(req) {
  const f = req.headers["x-forwarded-for"];
  const first = typeof f === "string" ? f.split(",")[0].trim() : "";
  return first || "unknown";
}

function readBody(req, cap) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === "object") { resolve({ ok: true, body: req.body }); return; }
    let raw = "";
    let tooBig = false;
    req.on("data", (c) => {
      raw += c;
      if (raw.length > cap + 1024) { tooBig = true; if (typeof req.destroy === "function") req.destroy(); }
    });
    req.on("end", () => {
      if (tooBig) { resolve({ ok: false, reason: "too_large" }); return; }
      try { resolve({ ok: true, body: JSON.parse(raw || "null") }); }
      catch (e) { resolve({ ok: false, reason: "bad_json" }); }
    });
    req.on("error", () => resolve({ ok: false, reason: "read_error" }));
  });
}

// Constant-time string comparison for secrets (merchant keys).
function secretsEqual(a, b) {
  const sa = String(a || ""), sb = String(b || "");
  const ba = Buffer.from(sa, "utf8"), bb = Buffer.from(sb, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function randomFromAlphabet(len) {
  const bytes = crypto.randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += ID_ALPHABET[bytes[i] % 32];
  return s;
}

function newShopId() { return randomFromAlphabet(8); }
function newMerchantKey() { return randomFromAlphabet(32); }
function newOrderId() { return randomFromAlphabet(12); }
function newOrderCode() { return "TS-" + randomFromAlphabet(6); }

module.exports = {
  ID_ALPHABET,
  rateOk, clientIp, readBody, secretsEqual,
  newShopId, newMerchantKey, newOrderId, newOrderCode
};

// TalkShop shop storage API (phase 2).
//
//   POST /api/shops  {payload}                 -> {id, merchantKey}  (new shop)
//   POST /api/shops  {payload, shopId}         -> {id, merchantKey?} (republish in place)
//   GET  /api/shops?id=<id>                   -> {id, payload} or 404
//
// Every shop record carries a merchantKey (32 unambiguous chars) stored in
// the server envelope {v, savedAt, updatedAt, merchantKey, payload}. The key
// is returned to the publishing merchant only: on creation, and on republish
// of a legacy record that has no key yet (one-time migration). It is never
// returned by GET, and never logged.
//
// Republish semantics: POST with a valid shopId updates that record's payload
// in place, so the merchant's shared link stays stable across edits.
//   - record has a key: the request must present it as {key}; 403 otherwise.
//   - record has no key (pre-key shops): allowed without a key, a key is
//     generated, stored, and returned.
//   - unknown shopId: 404. Malformed shopId: 400.
//
// Storage lives in api/_lib/blob-store.js (Vercel Blob).
"use strict";

const store = require("./_lib/blob-store");
const util = require("./_lib/api-util");

const MAX_BODY = 256 * 1024; // hard cap on stored payloads
const ID_RE = /^[2-9A-HJ-NP-Z]{8}$/;

function readEnvelope(raw) {
  if (!raw) return null;
  try {
    const env = JSON.parse(raw);
    if (!env || typeof env !== "object" || !env.payload || typeof env.payload !== "object") return null;
    return env;
  } catch (e) { return null; }
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
  const body = read.body || {};
  const payload = body.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    res.status(400).json({ error: "bad_payload" });
    return;
  }
  if (JSON.stringify(payload).length > MAX_BODY) {
    res.status(413).json({ error: "too_large" });
    return;
  }

  const shopId = body.shopId != null ? String(body.shopId) : "";

  // --- republish an existing shop in place ---
  if (shopId) {
    if (!ID_RE.test(shopId)) { res.status(400).json({ error: "bad_shop_id" }); return; }
    let raw = null;
    try { raw = await store.load(shopId); }
    catch (e) { res.status(502).json({ error: "store_unreachable" }); return; }
    const env = readEnvelope(raw);
    if (!env) { res.status(404).json({ error: "not_found" }); return; }

    let merchantKey = env.merchantKey || null;
    let returnKey = false;
    if (merchantKey) {
      // Keyed record: the merchant must prove ownership to overwrite.
      if (!util.secretsEqual(body.key, merchantKey)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
    } else {
      // Legacy record without a key: one-time migration, issue and return it.
      merchantKey = util.newMerchantKey();
      returnKey = true;
    }

    const next = {
      v: 1,
      savedAt: env.savedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      merchantKey: merchantKey,
      payload: payload
    };
    try { await store.save(shopId, JSON.stringify(next)); }
    catch (e) { res.status(502).json({ error: "store_unreachable" }); return; }
    const out = { id: shopId };
    if (returnKey) out.merchantKey = merchantKey;
    res.status(200).json(out);
    return;
  }

  // --- brand-new shop ---
  let id = null;
  for (let i = 0; i < 5; i++) {
    const cand = util.newShopId();
    let taken = false;
    try { taken = await store.exists(cand); }
    catch (e) { res.status(502).json({ error: "store_unreachable" }); return; }
    if (!taken) { id = cand; break; }
  }
  if (!id) { res.status(503).json({ error: "id_collision" }); return; }

  const merchantKey = util.newMerchantKey();
  const envelope = JSON.stringify({ v: 1, savedAt: new Date().toISOString(), merchantKey: merchantKey, payload });
  try {
    await store.save(id, envelope);
  } catch (e) {
    res.status(502).json({ error: "store_unreachable" });
    return;
  }
  res.status(200).json({ id, merchantKey });
}

async function handleGet(req, res) {
  if (!util.rateOk(util.clientIp(req), 120, 60 * 1000)) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  const id = String((req.query && req.query.id) || "");
  // Malformed IDs get the same 404 as missing ones (no existence oracle).
  if (!ID_RE.test(id)) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  let raw = null;
  try { raw = await store.load(id); }
  catch (e) { res.status(502).json({ error: "store_unreachable" }); return; }
  const env = readEnvelope(raw);
  if (!env) { res.status(404).json({ error: "not_found" }); return; }
  // Note: the merchantKey is deliberately never returned here.
  res.status(200).json({ id, payload: env.payload });
}

module.exports = async (req, res) => {
  if (req.method === "POST") { await handlePost(req, res); return; }
  if (req.method === "GET") { await handleGet(req, res); return; }
  res.status(405).json({ error: "method_not_allowed" });
};

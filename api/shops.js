// TalkShop shop storage API (phase 1).
//
//   POST /api/shops        {payload: {...}} -> {id}              (8-char shop ID)
//   GET  /api/shops?id=<id>                -> {id, payload} or 404
//
// The payload is the existing client-side shop object; it is stored as-is
// inside a small server envelope {v, savedAt, payload}. Nothing sensitive
// should be stored in phase 1: there is no auth yet, IDs are unguessable
// (8 chars x 5 bits = 40 bits) and are the only capability needed to read.
//
// Follow-ups (noted, not done here): merchant auth + shop ownership, an
// update endpoint for re-publishing, a delete endpoint, and abuse controls
// beyond the per-instance rate limiter below.
//
// Storage lives in api/_lib/blob-store.js (Vercel Blob). Swap that module to
// change backends without touching this file.
"use strict";

const crypto = require("crypto");
const store = require("./_lib/blob-store");

const MAX_BODY = 256 * 1024; // hard cap on stored payloads
const ID_LEN = 8;
// Unambiguous alphabet: no 0/O, 1/I/L. 32 symbols, 256 % 32 == 0, so no
// modulo bias when mapping random bytes.
const ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ID_RE = /^[2-9A-HJ-NP-Z]{8}$/;

// --- tiny per-instance rate limiter (best-effort friction, not a boundary) ---
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

function newId() {
  const bytes = crypto.randomBytes(ID_LEN);
  let id = "";
  for (let i = 0; i < ID_LEN; i++) id += ID_ALPHABET[bytes[i] % 32];
  return id;
}

async function handlePost(req, res) {
  if (!rateOk(clientIp(req), 30, 60 * 1000)) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  const read = await readBody(req, MAX_BODY);
  if (!read.ok) {
    res.status(read.reason === "too_large" ? 413 : 400).json({ error: read.reason });
    return;
  }
  const payload = read.body && read.body.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    res.status(400).json({ error: "bad_payload" });
    return;
  }
  if (JSON.stringify(payload).length > MAX_BODY) {
    res.status(413).json({ error: "too_large" });
    return;
  }

  // Fresh unguessable ID; retry on the near-impossible collision.
  let id = null;
  for (let i = 0; i < 5; i++) {
    const cand = newId();
    let taken = false;
    try { taken = await store.exists(cand); }
    catch (e) { res.status(502).json({ error: "store_unreachable" }); return; }
    if (!taken) { id = cand; break; }
  }
  if (!id) { res.status(503).json({ error: "id_collision" }); return; }

  const envelope = JSON.stringify({ v: 1, savedAt: new Date().toISOString(), payload });
  try {
    await store.save(id, envelope);
  } catch (e) {
    res.status(502).json({ error: "store_unreachable" });
    return;
  }
  res.status(200).json({ id });
}

async function handleGet(req, res) {
  if (!rateOk(clientIp(req), 120, 60 * 1000)) {
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
  if (!raw) { res.status(404).json({ error: "not_found" }); return; }

  let env = null;
  try { env = JSON.parse(raw); }
  catch (e) { res.status(502).json({ error: "store_corrupt" }); return; }
  res.status(200).json({ id, payload: env.payload });
}

module.exports = async (req, res) => {
  if (req.method === "POST") { await handlePost(req, res); return; }
  if (req.method === "GET") { await handleGet(req, res); return; }
  res.status(405).json({ error: "method_not_allowed" });
};

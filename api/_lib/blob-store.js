// TalkShop shop storage adapter (phase 1).
//
// Backend: Vercel Blob store "talkshop-shop-data", provisioned and linked to
// this project entirely from the Vercel CLI (zero dashboard clicks).
// Uses the Blob REST API over plain fetch, no npm dependencies.
//
// Env (set on the Vercel project):
//   BLOB_READ_WRITE_TOKEN  auto-created when the store was linked to the project
//   BLOB_STORE_BASE_URL    e.g. https://<storeid>.private.blob.vercel-storage.com
//
// Upgrade path: to move to KV/Postgres later, keep this module's four
// functions (exists/save/load/remove) and swap the internals; api/shops.js
// stays untouched.
//
// Security follow-ups (noted, not done in phase 1): per-merchant auth so only
// the owning merchant can overwrite or delete a shop; presigned URLs instead
// of a shared token if the token ever needs to leave the server.
"use strict";

const API = "https://blob.vercel-storage.com";
const API_VERSION = "10";

function cfg() {
  const token = process.env.BLOB_READ_WRITE_TOKEN || "";
  const base = (process.env.BLOB_STORE_BASE_URL || "").replace(/\/+$/, "");
  if (!token || !base) throw new Error("blob_not_configured");
  return { token, base };
}

function pathname(id) {
  // id is validated against ID_RE in api/shops.js before it reaches here,
  // so it can only contain unambiguous alphanumerics (no path traversal).
  return "shops/" + id + ".json";
}

// Generic path access for other record types (orders, indexes). Callers must
// validate every path segment themselves; the fixed "shops/"/"orders/"
// prefixes are lowercase, IDs are unambiguous alphanumerics. Directory
// traversal is rejected explicitly.
const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9\-\/]*\.json$/;
function checkPath(p) {
  if (typeof p !== "string" || !PATH_RE.test(p) || p.indexOf("..") >= 0) {
    throw new Error("bad_path");
  }
  return p;
}

async function apiFetch(url, opts, token) {
  return fetch(url, {
    ...opts,
    headers: {
      "Authorization": "Bearer " + token,
      "x-api-version": API_VERSION,
      ...((opts && opts.headers) || {})
    }
  });
}

// HEAD the file URL: 200 = exists, 404 = missing.
async function existsPath(path) {
  const { token, base } = cfg();
  const r = await apiFetch(base + "/" + checkPath(path), { method: "HEAD" }, token);
  return r.status === 200;
}

async function savePath(path, jsonString) {
  const { token } = cfg();
  const url = API + "/?pathname=" + encodeURIComponent(checkPath(path));
  const r = await apiFetch(url, {
    method: "PUT",
    headers: {
      "x-vercel-blob-access": "private",
      "x-add-random-suffix": "0",
      // Updates rewrite the same pathname (order status, shop republish),
      // so overwrites must be allowed.
      "x-allow-overwrite": "1",
      "x-content-type": "application/json",
      "content-type": "application/json"
    },
    body: jsonString
  }, token);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error("blob_save_failed:" + r.status + ":" + t.slice(0, 120));
  }
}

async function loadPath(path) {
  const { token, base } = cfg();
  const r = await apiFetch(base + "/" + checkPath(path), { method: "GET" }, token);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("blob_load_failed:" + r.status);
  return await r.text();
}

async function exists(id) {
  return existsPath(pathname(id));
}

async function save(id, jsonString) {
  return savePath(pathname(id), jsonString);
}

async function load(id) {
  return loadPath(pathname(id));
}

async function remove(id) {
  const { token, base } = cfg();
  const r = await apiFetch(API + "/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ urls: [base + "/" + pathname(id)] })
  }, token);
  if (!r.ok) throw new Error("blob_delete_failed:" + r.status);
}

module.exports = { exists, save, load, remove, existsPath, savePath, loadPath };

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";

const require = createRequire(import.meta.url);
const P = require("../tests/play-client-runtime.cjs");
const WORKER = process.env.WORKER_ORIGIN || "https://google-play-downloader.basil-as.workers.dev";
const runtimeSource = fs.readFileSync(new URL("../js/runtime-fixes.js", import.meta.url), "utf8");
const DFE_TARGETS = runtimeSource.match(/const DFE_TARGETS = "([^"]+)";/)?.[1] || "";
const DFE_PHENOTYPE = runtimeSource.match(/const DFE_PHENOTYPE = "([^"]+)";/)?.[1] || "";
assert.ok(DFE_TARGETS.length > 500, "current X-DFE-Encoded-Targets missing");
assert.match(DFE_PHENOTYPE, /^H4sI/, "current X-DFE-Phenotype missing");

globalThis.crypto ||= webcrypto;

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function fields(raw) { return new P.ProtoDecoder(raw).readAll(); }
function firstBytes(rows, n) { return rows.find(([f, w, v]) => f === n && w === 2 && v instanceof Uint8Array)?.[2] || null; }
function firstInt(rows, n) { const row = rows.find(([f, w]) => f === n && w === 0); return row ? Number(row[2]) : 0; }
function navigate(raw, ...path) {
  let bytes = raw;
  for (const n of path) {
    const sub = firstBytes(fields(bytes), n);
    if (!sub) return [];
    bytes = sub;
  }
  return fields(bytes);
}
function offerType(raw) {
  const doc = navigate(raw, 1, 2, 4);
  if (!doc.length) return 1;
  const offer = firstBytes(doc, 8);
  if (offer) {
    const value = firstInt(fields(offer), 8);
    if (value) return value;
  }
  const availability = firstBytes(doc, 9);
  if (availability) {
    const value = firstInt(fields(availability), 6);
    if (value) return value;
  }
  return 1;
}
function pv(value) {
  let n = BigInt(value), out = [];
  while (n > 0x7fn) { out.push(Number((n & 0x7fn) | 0x80n)); n >>= 7n; }
  out.push(Number(n));
  return Uint8Array.from(out);
}
function join(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
function pvi(field, value) { return join(pv(field << 3), pv(value)); }
function pbytes(field, bytes) { return join(pv((field << 3) | 2), pv(bytes.length), bytes); }
function pstr(field, value) { return pbytes(field, new TextEncoder().encode(String(value))); }
function nonce() {
  const bytes = webcrypto.getRandomValues(new Uint8Array(256));
  return `nonce=${Buffer.from(bytes).toString("base64url")}`;
}
function acquireBody(packageName, versionCode, ot) {
  const payload = join(pstr(1, packageName), pvi(2, 1), pvi(3, 3));
  const pkg = join(pbytes(1, payload), pvi(2, 1));
  const version = join(pvi(1, versionCode), pvi(3, 0));
  const m30 = join(pvi(1, 2), pvi(2, 0));
  return join(pbytes(1, pkg), pbytes(12, version), pvi(13, ot), pvi(15, 0), pstr(22, nonce()), pvi(25, 2), pbytes(30, m30));
}
function currentHeaders(auth) {
  return { ...P.buildHeaders(auth), "X-DFE-Encoded-Targets": DFE_TARGETS, "X-DFE-Phenotype": DFE_PHENOTYPE };
}
async function anonymousAuth() {
  const response = await fetch(`${WORKER}/api/auth?mode=anonymous`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(P.profileFor("arm64"))
  });
  const text = await response.text();
  assert.equal(response.status, 200, `anonymous auth HTTP ${response.status}: ${text.slice(0, 200)}`);
  const auth = JSON.parse(text);
  assert.ok(auth.authToken && auth.gsfId, "anonymous auth bundle missing authToken/gsfId");
  return auth;
}
async function fdfe(auth, path, { method = "GET", body, contentType } = {}) {
  const forwarded = currentHeaders(auth);
  if (contentType) forwarded["Content-Type"] = contentType;
  const headers = { "X-Play-Headers": b64urlJson(forwarded) };
  if (contentType) headers["Content-Type"] = contentType;
  const response = await fetch(`${WORKER}/api/fdfe${path}`, { method, headers, body });
  return { response, raw: new Uint8Array(await response.arrayBuffer()) };
}
function deliveryPath(packageName, vc, ot, token = "") {
  const q = new URLSearchParams({ doc: packageName, ot: String(ot), vc: String(vc) });
  if (token) q.set("dtok", token);
  return `/delivery?${q}`;
}
function printable(raw) {
  return Buffer.from(raw).toString("utf8").replace(/[^\x20-\x7e\u0400-\u04ff]+/g, " ").trim().slice(0, 240);
}
async function resolve(packageName, auth) {
  const details = await fdfe(auth, `/details?doc=${encodeURIComponent(packageName)}`);
  assert.equal(details.response.status, 200, `${packageName}: details HTTP ${details.response.status}`);
  const app = P.parseDetails(details.raw);
  assert.equal(app?.package, packageName, `${packageName}: details parser mismatch`);
  assert.ok(app.versionCode > 0, `${packageName}: versionCode missing`);
  const ot = offerType(details.raw);

  let response = await fdfe(auth, deliveryPath(packageName, app.versionCode, ot));
  if (response.response.ok) {
    const delivery = P.parseDelivery(response.raw);
    if (delivery?.base?.url) return { app, delivery, path: "direct-delivery" };
  }

  await fdfe(auth, "/acquire", { method: "POST", body: acquireBody(packageName, app.versionCode, ot), contentType: "application/x-protobuf" });
  const purchaseQ = new URLSearchParams({ doc: packageName, ot: String(ot), vc: String(app.versionCode) });
  const purchase = await fdfe(auth, `/purchase?${purchaseQ}`, { method: "POST" });
  if (!purchase.response.ok) throw new Error(`${packageName}: purchase HTTP ${purchase.response.status}: ${printable(purchase.raw)}`);

  const direct = P.parseDelivery(purchase.raw);
  if (direct?.base?.url) return { app, delivery: direct, path: "purchase-delivery" };
  const token = P.parsePurchase(purchase.raw);
  assert.ok(token, `${packageName}: purchase returned neither delivery nor token`);

  response = await fdfe(auth, deliveryPath(packageName, app.versionCode, ot, token));
  assert.equal(response.response.status, 200, `${packageName}: token delivery HTTP ${response.response.status}: ${printable(response.raw)}`);
  const delivery = P.parseDelivery(response.raw);
  assert.ok(delivery?.base?.url, `${packageName}: delivery URL missing`);
  return { app, delivery, path: "purchase-token-delivery" };
}

const auth = await anonymousAuth();
for (const packageName of ["com.google.android.apps.photos", "com.arslan.vkdatingapp1"]) {
  const result = await resolve(packageName, auth);
  console.log(JSON.stringify({ package: packageName, versionCode: result.app.versionCode, path: result.path, urlHost: new URL(result.delivery.base.url).hostname }));
}

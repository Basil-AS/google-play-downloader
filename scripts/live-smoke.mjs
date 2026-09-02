import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";

const require = createRequire(import.meta.url);
const P = require("../tests/play-client-runtime.cjs");
const WORKER = process.env.WORKER_ORIGIN || "https://google-play-downloader.basil-as.workers.dev";
const TARGET = "com.arslan.vkdatingapp1";
const runtimeSource = fs.readFileSync(new URL("../js/runtime-fixes.js", import.meta.url), "utf8");
const DFE_TARGETS = runtimeSource.match(/const DFE_TARGETS = "([^"]+)";/)?.[1] || "";
const DFE_PHENOTYPE = runtimeSource.match(/const DFE_PHENOTYPE = "([^"]+)";/)?.[1] || "";
const COUNTRY_MCC = Object.freeze({
  PK: "41001", US: "31038", DE: "26201", GB: "23430",
  IN: "40420", SE: "24001", RU: "25001"
});
assert.ok(DFE_TARGETS.length > 500, "current X-DFE-Encoded-Targets missing");
assert.match(DFE_PHENOTYPE, /^H4sI/, "current X-DFE-Phenotype missing");
globalThis.crypto ||= webcrypto;

function b64urlJson(value) { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function fields(raw) { return new P.ProtoDecoder(raw).readAll(); }
function firstBytes(rows, n) { return rows.find(([f, w, v]) => f === n && w === 2 && v instanceof Uint8Array)?.[2] || null; }
function firstInt(rows, n) { const row = rows.find(([f, w]) => f === n && w === 0); return row ? Number(row[2]) : 0; }
function firstString(rows, n) { const value = firstBytes(rows, n); return value ? new TextDecoder().decode(value) : ""; }
function navigate(raw, ...path) {
  let bytes = raw;
  for (const n of path) { const sub = firstBytes(fields(bytes), n); if (!sub) return []; bytes = sub; }
  return fields(bytes);
}
function metadata(raw) {
  const doc = navigate(raw, 1, 2, 4);
  const offerBytes = firstBytes(doc, 8);
  const availabilityBytes = firstBytes(doc, 9);
  const offer = offerBytes ? fields(offerBytes) : [];
  const availability = availabilityBytes ? fields(availabilityBytes) : [];
  return {
    offerType: firstInt(offer, 8) || firstInt(availability, 6) || 1,
    currency: firstString(offer, 2),
    restriction: firstInt(availability, 5)
  };
}
function pv(value) {
  let n = BigInt(value), out = [];
  while (n > 0x7fn) { out.push(Number((n & 0x7fn) | 0x80n)); n >>= 7n; }
  out.push(Number(n));
  return Uint8Array.from(out);
}
function join(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
function pvi(field, value) { return join(pv(field << 3), pv(value)); }
function pbytes(field, bytes) { return join(pv((field << 3) | 2), pv(bytes.length), bytes); }
function pstr(field, value) { return pbytes(field, new TextEncoder().encode(String(value))); }
function nonce() { return `nonce=${Buffer.from(webcrypto.getRandomValues(new Uint8Array(256))).toString("base64url")}`; }
function acquireBody(packageName, versionCode, ot) {
  const payload = join(pstr(1, packageName), pvi(2, 1), pvi(3, 3));
  const pkg = join(pbytes(1, payload), pvi(2, 1));
  const version = join(pvi(1, versionCode), pvi(3, 0));
  const m30 = join(pvi(1, 2), pvi(2, 0));
  return join(pbytes(1, pkg), pbytes(12, version), pvi(13, ot), pvi(15, 0), pstr(22, nonce()), pvi(25, 2), pbytes(30, m30));
}
function profile(country = "") {
  const value = { ...P.profileFor("arm64") };
  if (country && COUNTRY_MCC[country]) {
    value.CellOperator = COUNTRY_MCC[country];
    value.SimOperator = COUNTRY_MCC[country];
  }
  if (country === "RU") value.Locales = "ru-RU,en-US";
  else value.Locales = "en-US,ru-RU";
  return value;
}
function currentHeaders(auth, country = "") {
  const result = { ...P.buildHeaders(auth, country), "X-DFE-Encoded-Targets": DFE_TARGETS, "X-DFE-Phenotype": DFE_PHENOTYPE };
  if (country && COUNTRY_MCC[country]) result["X-DFE-MCCMNC"] = COUNTRY_MCC[country];
  return result;
}
async function auth(mode, country = "") {
  const suffix = mode === "anonymous" ? "?mode=anonymous" : "";
  const headers = { "Content-Type": "application/json" };
  if (country) headers["X-Play-Country"] = country;
  const response = await fetch(`${WORKER}/api/auth${suffix}`, { method: "POST", headers, body: JSON.stringify(profile(country)) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${mode}/${country || "AUTO"} auth HTTP ${response.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  assert.ok(data.authToken && data.gsfId, `${mode} auth bundle missing authToken/gsfId`);
  return data;
}
function withCountry(path, country = "") {
  if (!country) return path;
  const u = new URL(`https://dummy${path}`);
  if (!u.searchParams.has("gl")) u.searchParams.set("gl", country);
  return `${u.pathname}${u.search}`;
}
async function fdfe(authData, path, { method = "GET", body, contentType, country = "" } = {}) {
  const forwarded = currentHeaders(authData, country);
  if (contentType) forwarded["Content-Type"] = contentType;
  const headers = { "X-Play-Headers": b64urlJson(forwarded) };
  if (contentType) headers["Content-Type"] = contentType;
  const response = await fetch(`${WORKER}/api/fdfe${withCountry(path, country)}`, { method, headers, body });
  return { response, raw: new Uint8Array(await response.arrayBuffer()) };
}
function deliveryPath(packageName, vc, ot, token = "") {
  const q = new URLSearchParams({ doc: packageName, ot: String(ot), vc: String(vc) });
  if (token) q.set("dtok", token);
  return `/delivery?${q}`;
}
function printable(raw) { return Buffer.from(raw).toString("utf8").replace(/[^\x20-\x7e\u0400-\u04ff]+/g, " ").trim().slice(0, 240); }
async function details(packageName, authData, country = "") {
  const response = await fdfe(authData, `/details?doc=${encodeURIComponent(packageName)}`, { country });
  if (!response.response.ok) throw new Error(`${packageName}/${country || "AUTO"}: details HTTP ${response.response.status}: ${printable(response.raw)}`);
  const app = P.parseDetails(response.raw);
  assert.equal(app?.package, packageName, `${packageName}: details parser mismatch`);
  return { app, meta: metadata(response.raw), raw: response.raw };
}
async function directDelivery(packageName, app, meta, authData, country = "") {
  const response = await fdfe(authData, deliveryPath(packageName, app.versionCode, meta.offerType), { country });
  if (!response.response.ok) return null;
  const delivery = P.parseDelivery(response.raw);
  return delivery?.base?.url ? delivery : null;
}
async function acquireAndPurchase(packageName, app, meta, authData, country = "") {
  await fdfe(authData, "/acquire", { method: "POST", body: acquireBody(packageName, app.versionCode, meta.offerType), contentType: "application/x-protobuf", country });
  const q = new URLSearchParams({ doc: packageName, ot: String(meta.offerType), vc: String(app.versionCode) });
  const purchase = await fdfe(authData, `/purchase?${q}`, { method: "POST", country });
  if (!purchase.response.ok) return { ok: false, error: `HTTP ${purchase.response.status}: ${printable(purchase.raw)}` };
  let delivery = P.parseDelivery(purchase.raw);
  if (delivery?.base?.url) return { ok: true, delivery, path: "purchase-delivery" };
  const token = P.parsePurchase(purchase.raw);
  if (!token) return { ok: false, error: "purchase returned neither delivery nor token" };
  const redeemed = await fdfe(authData, deliveryPath(packageName, app.versionCode, meta.offerType, token), { country });
  if (!redeemed.response.ok) return { ok: false, error: `delivery HTTP ${redeemed.response.status}: ${printable(redeemed.raw)}` };
  delivery = P.parseDelivery(redeemed.raw);
  if (!delivery?.base?.url) return { ok: false, error: "delivery URL missing" };
  return { ok: true, delivery, path: "purchase-token-delivery" };
}

// Control: prove the deployed transport can resolve a real Google CDN URL.
const controlAuth = await auth("anonymous", "");
const controlDetails = await details("com.google.android.apps.photos", controlAuth, "");
const controlDelivery = await directDelivery("com.google.android.apps.photos", controlDetails.app, controlDetails.meta, controlAuth, "");
assert.ok(controlDelivery?.base?.url, "Google Photos control did not return direct delivery");
console.log(JSON.stringify({ type: "control", package: "com.google.android.apps.photos", versionCode: controlDetails.app.versionCode, restriction: controlDetails.meta.restriction, currency: controlDetails.meta.currency, path: "direct-delivery", urlHost: new URL(controlDelivery.base.url).hostname }));

// Probe the suspicious target without hammering purchase. If details itself says
// restriction=2 (GEO_RESTRICTED), only test direct delivery in case the pooled
// account already owns it. Purchase is attempted only on an unrestricted storefront.
const matrix = [];
let success = null;
for (const country of ["", "PK", "US", "DE", "GB", "IN", "SE", "RU"]) {
  try {
    const account = await auth("anonymous", country);
    const info = await details(TARGET, account, country);
    const direct = await directDelivery(TARGET, info.app, info.meta, account, country);
    const row = {
      country: country || "AUTO",
      versionCode: info.app.versionCode,
      restriction: info.meta.restriction,
      currency: info.meta.currency,
      accountMccMnc: account?.deviceInfoProvider?.mccMnc || "",
      directDelivery: Boolean(direct?.base?.url)
    };
    if (direct?.base?.url) {
      row.path = "direct-delivery";
      row.urlHost = new URL(direct.base.url).hostname;
      success = { country, account, info, delivery: direct, path: row.path };
    } else if (info.meta.restriction !== 2) {
      const acquired = await acquireAndPurchase(TARGET, info.app, info.meta, account, country);
      row.purchase = acquired.ok ? "ok" : acquired.error;
      if (acquired.ok) {
        row.path = acquired.path;
        row.urlHost = new URL(acquired.delivery.base.url).hostname;
        success = { country, account, info, delivery: acquired.delivery, path: acquired.path };
      }
    } else {
      row.purchase = "skipped: GEO_RESTRICTED";
    }
    matrix.push(row);
    console.log(JSON.stringify({ type: "target-storefront", ...row }));
    if (success) break;
  } catch (error) {
    const row = { country: country || "AUTO", error: error?.message || String(error) };
    matrix.push(row);
    console.log(JSON.stringify({ type: "target-storefront", ...row }));
  }
}

if (!success) {
  const summary = matrix.map(row => `${row.country}: restriction=${row.restriction ?? "?"}, currency=${row.currency || "?"}, direct=${row.directDelivery ?? false}, purchase=${row.purchase || row.error || "n/a"}`).join(" | ");
  throw new Error(`${TARGET}: no downloadable storefront found. ${summary}`);
}
console.log(JSON.stringify({ type: "target-success", package: TARGET, country: success.country || "AUTO", path: success.path, urlHost: new URL(success.delivery.base.url).hostname }));

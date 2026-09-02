const B = window.GooglePlayClient;
const F = window.fetch.bind(window);
const icons = new Map();
const searchIcons = new Map();
const anonymousAuthCache = new Map();
const dec = new TextDecoder();
const enc = new TextEncoder();
const V = "20260902-6";

// Synced with pyplay/Aurora GPlayApi 3.6.4 (2026). Google can answer
// DF-DFERH-01 when these capability blobs are stale or absent.
const DFE_TARGETS = "CAESN/qigQYC2AMBFfUbyA7SM5Ij/CvfBoIDgxHqGP8R3xzIBvoQtBKFDZ4HAY4FrwSVMasHBO0O2Q8akgYRAQECAQO7AQEpKZ0CnwECAwRrAQYBr9PPAoK7sQMBAQMCBAkIDAgBAwEDBAICBAUZEgMEBAMLAQEBBQEBAcYBARYED+cBfS8CHQEKkAEMMxcBIQoUDwYHIjd3DQ4MFk0JWGYZEREYAQOLAYEBFDMIEYMBAgICAgICOxkCD18LGQKEAcgDBIQBAgGLARkYCy8oBTJlBCUocxQn0QUBDkkGxgNZQq0BZSbeAmIDgAEBOgGtAaMCDAOQAZ4BBIEBKUtQUYYBQscDDxPSARA1oAEHAWmnAsMB2wFyywGLAxol+wImlwOOA80CtwN26A0WjwJVbQEJPAH+BRDeAfkHK/ABASEBCSAaHQemAzkaRiu2Ad8BdXeiAwEBGBUBBN4LEIABK4gB2AFLfwECAdoENq0CkQGMBsIBiQEtiwGgA1zyAUQ4uwS8AwhsvgPyAcEDF27vApsBHaICGhl3GSKxAR8MC6cBAgItmQYG9QIeywLvAeYBDArLAh8HASI4ELICDVmVBgsY/gHWARtcAsMBpALiAdsBA7QBpAJmIArpByn0AyAKBwHTARIHAX8D+AMBcRIBBbEDmwUBMacCHAciNp0BAQF0OgQLJDuSAh54kwFSP0eeAQQ4M5EBQgMEmwFXywFo0gFyWwMcapQBBugBPUW2AVgBKmy3AR6PAbMBGQxrUJECvQR+8gFoWDsYgQNwRSczBRXQAgtRswEW0ALMAREYAUEBIG6yATYCRE8OxgER8gMBvQEDRkwLc8MBTwHZAUOnAXiiBakDIbYBNNcCIUmuArIBSakBrgFHKs0EgwV/G3AD0wE6LgECtQJ4xQFwFbUCjQPkBS6vAQqEAUZF3QIM9wEhCoYCQhXsBCyZArQDugIziALWAdIBlQHwBdUErQE6qQaSA4EEIvYBHir9AQVLmgMCApsCKAwHuwgrENsBAjNYswEVmgIt7QJnN4wDEnta+wGfAcUBxgEtEFXQAQWdAUAeBcwBAQM7rAEJATJ0LENrdh73A6UBhAE+qwEeASxLZUMhDREuH0CGARbd7K0GlQo";
const DFE_PHENOTYPE = "H4sIAAAAAAAAAB3OO3KjMAAA0KRNuWXukBkBQkAJ2MhgAZb5u2GCwQZbCH_EJ77QHmgvtDtbv-Z9_H63zXXU0NVPB1odlyGy7751Q3CitlPDvFd8lxhz3tpNmz7P92CFw73zdHU2Ie0Ad2kmR8lxhiErTFLt3RPGfJQHSDy7Clw10bg8kqf2owLokN4SecJTLoSwBnzQSd652_MOf2d1vKBNVedzg4ciPoLz2mQ8efGAgYeLou-l-PXn_7Sna1MfhHuySxt-4esulEDp8Sbq54CPPKjpANW-lkU2IZ0F92LBI-ukCKSptqeq1eXU96LD9nZfhKHdtjSWwJqUm_2r6pMHOxk01saVanmNopjX3YxQafC4iC6T55aRbC8nTI98AF_kItIQAJb5EQxnKTO7TZDWnr01HVPxelb9A2OWX6poidMWl16K54kcu_jhXw-JSBQkVcD_fPsLSZu6joIBAAA";
const COUNTRY_MCC = Object.freeze({ US: ["310", "38"], IN: ["404", "20"], GB: ["234", "30"], DE: ["262", "01"], RU: ["250", "01"] });

function vi(d, s) {
  let sh = 0n, v = 0n;
  for (let i = 0; i < 10; i++) {
    if (s.p >= d.length) throw Error("EOF");
    const b = BigInt(d[s.p++]);
    v |= (b & 127n) << sh;
    if (!(b & 128n)) return Number(v);
    sh += 7n;
  }
  throw Error("varint");
}
function sg(d, s, g) {
  while (s.p < d.length) {
    const k = vi(d, s), f = k >>> 3, w = k & 7;
    if (w === 4) { if (f !== g) throw Error("group"); return; }
    if (w === 0) vi(d, s); else if (w === 1) s.p += 8; else if (w === 2) s.p += vi(d, s); else if (w === 3) sg(d, s, f); else if (w === 5) s.p += 4; else throw Error("wire");
    if (s.p > d.length) throw Error("EOF");
  }
  throw Error("group EOF");
}
function fs(x) {
  const d = x instanceof Uint8Array ? x : new Uint8Array(x || []), s = { p: 0 }, o = [];
  while (s.p < d.length) {
    const k = vi(d, s), f = k >>> 3, w = k & 7;
    let v;
    if (w === 0) v = vi(d, s);
    else if (w === 1) { v = d.slice(s.p, s.p + 8); s.p += 8; }
    else if (w === 2) { const n = vi(d, s); v = d.slice(s.p, s.p + n); s.p += n; }
    else if (w === 3) { sg(d, s, f); continue; }
    else if (w === 4) break;
    else if (w === 5) { v = d.slice(s.p, s.p + 4); s.p += 4; }
    else throw Error("wire");
    o.push([f, w, v]);
  }
  return o;
}
const fb = (a, n) => a.find(([f, w, v]) => f === n && w === 2 && v instanceof Uint8Array)?.[2] || null;
const ab = (a, n) => a.filter(([f, w, v]) => f === n && w === 2 && v instanceof Uint8Array).map(x => x[2]);
const st = (a, n) => { const v = fb(a, n); try { return v ? dec.decode(v) : ""; } catch { return ""; } };
const ii = (a, n) => { const r = a.find(([f, w]) => f === n && w === 0); return r ? Number(r[2]) : 0; };
function nav(x, ...p) {
  let d = x instanceof Uint8Array ? x : new Uint8Array(x || []);
  for (const n of p) { let a; try { a = fs(d); } catch { return []; } d = fb(a, n); if (!d) return []; }
  try { return fs(d); } catch { return []; }
}
function img(u) { try { const x = new URL(u); return x.protocol === "https:" && x.hostname.endsWith(".googleusercontent.com") ? x.href : ""; } catch { return ""; } }
function detailIcon(raw) {
  const d = nav(raw, 1, 2, 4);
  for (const x of ab(d, 10)) { try { const a = fs(x); if (ii(a, 1) === 4) { const u = img(st(a, 5)); if (u) return u; } } catch {} }
  return "";
}
function detailMeta(raw) {
  const doc = nav(raw, 1, 2, 4); let offer = [], availability = [];
  try { const ob = fb(doc, 8), av = fb(doc, 9); if (ob) offer = fs(ob); if (av) availability = fs(av); } catch {}
  return { offerType: ii(offer, 8) || ii(availability, 6) || 1, currency: st(offer, 2), formattedAmount: st(offer, 3), availabilityRestriction: ii(availability, 5) };
}
function parseSearch(raw) {
  let r; try { r = fs(raw); } catch { return new Map(); }
  const m = new Map();
  for (const x of ab(r, 11)) { const p = st(nav(x, 2, 1), 1), u = img(st(nav(x, 2, 2, 2, 1, 6), 1)); if (p && u) m.set(p, u); }
  return m;
}
function readableStrings(raw, depth = 0, out = []) {
  if (depth > 8) return out;
  let rows; try { rows = fs(raw); } catch { return out; }
  for (const [, w, v] of rows) {
    if (w !== 2 || !(v instanceof Uint8Array)) continue;
    try { const s = dec.decode(v); if (s && /[\p{L}\p{N}]/u.test(s) && s.length >= 4) out.push(s); } catch {}
    if (v.length > 3) readableStrings(v, depth + 1, out);
  }
  return out;
}
function playMessage(raw) {
  const list = readableStrings(raw).filter(s => /DF-|Google Play|Ошибка|Error|country|стране|purchase/i.test(s));
  return list.sort((a, b) => b.length - a.length)[0] || "";
}
function target(i) {
  try { const u = new URL(typeof i === "string" || i instanceof URL ? i : i.url); if (u.hostname === "corsproxy.io") { const t = u.searchParams.get("url"); return t ? new URL(t) : u; } return u; } catch { return null; }
}
function currentHeaders(auth, country = "") {
  const headers = B.buildHeaders(auth, country);
  headers["X-DFE-Encoded-Targets"] = DFE_TARGETS;
  headers["X-DFE-Phenotype"] = DFE_PHENOTYPE;
  return headers;
}
function pv(n) { let x = BigInt(n), out = []; while (x > 0x7fn) { out.push(Number((x & 0x7fn) | 0x80n)); x >>= 7n; } out.push(Number(x)); return new Uint8Array(out); }
function join(...parts) { const size = parts.reduce((n, p) => n + p.length, 0), out = new Uint8Array(size); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
const pvi = (field, value) => join(pv(field << 3), pv(value));
const pbytes = (field, value) => { const b = value instanceof Uint8Array ? value : new Uint8Array(value || []); return join(pv((field << 3) | 2), pv(b.length), b); };
const pstr = (field, value) => pbytes(field, enc.encode(String(value)));
function acquireNonce() {
  const bytes = new Uint8Array(256); if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes); else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return `nonce=${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "")}`;
}
function acquireRequest(packageName, versionCode, offerType = 1) {
  const payload = join(pstr(1, packageName), pvi(2, 1), pvi(3, 3));
  const pkg = join(pbytes(1, payload), pvi(2, 1));
  const version = join(pvi(1, versionCode), pvi(3, 0));
  const m30 = join(pvi(1, 2), pvi(2, 0));
  return join(pbytes(1, pkg), pbytes(12, version), pvi(13, offerType), pvi(15, 0), pstr(22, acquireNonce()), pvi(25, 2), pbytes(30, m30));
}
async function relayPlay(url, auth, options = {}, init = {}) {
  const headers = currentHeaders(auth, options.country);
  if (init.contentType) headers["Content-Type"] = init.contentType;
  const response = await F(B.relayUrl(url, headers), { method: init.method || "GET", headers: init.contentType ? { "Content-Type": init.contentType } : {}, body: init.body, cache: "no-store", referrerPolicy: "no-referrer", signal: options.signal });
  const raw = new Uint8Array(await response.arrayBuffer());
  return { response, raw };
}
async function acquireApp(packageName, versionCode, offerType, auth, options = {}) {
  return relayPlay("https://android.clients.google.com/fdfe/acquire", auth, options, { method: "POST", contentType: "application/x-protobuf", body: acquireRequest(packageName, versionCode, offerType) });
}
function deliveryUrl(packageName, versionCode, offerType, token = "") {
  const u = new URL("https://android.clients.google.com/fdfe/delivery");
  u.searchParams.set("doc", packageName); u.searchParams.set("ot", String(offerType)); u.searchParams.set("vc", String(versionCode)); if (token) u.searchParams.set("dtok", token); return u.toString();
}
async function tryDelivery(packageName, versionCode, offerType, auth, options = {}, token = "") {
  const { response, raw } = await relayPlay(deliveryUrl(packageName, versionCode, offerType, token), auth, options);
  if (!response.ok) return { delivery: null, response, raw };
  const delivery = B.parseDelivery(raw);
  return { delivery: delivery?.base?.url ? delivery : null, response, raw };
}
async function purchase(packageName, versionCode, offerType, auth, options = {}) {
  const u = new URL("https://android.clients.google.com/fdfe/purchase");
  u.searchParams.set("doc", packageName); u.searchParams.set("ot", String(offerType)); u.searchParams.set("vc", String(versionCode));
  const result = await relayPlay(u.toString(), auth, options, { method: "POST" });
  const token = result.response.ok ? B.parsePurchase(result.raw) : "";
  return { ...result, token };
}
function profileForAnonymous(arch, options = {}) {
  const p = { ...B.profileFor(arch) };
  const locale = String(options.locale || "ru-RU");
  p.Locales = `${locale},${locale.toLowerCase().startsWith("ru") ? "en-US" : "ru-RU"}`;
  if (options.density) p["Screen.Density"] = String(options.density);
  const cc = String(options.country || "").toUpperCase(), op = COUNTRY_MCC[cc];
  if (op) { p.CellOperator = `${op[0]}${op[1]}`; p.SimOperator = `${op[0]}${op[1]}`; }
  return p;
}
async function anonymousAuth(arch, options = {}) {
  const country = String(options.country || "").toUpperCase();
  const key = `${arch}|${country}|${options.locale || ""}|${options.density || ""}`;
  const cached = anonymousAuthCache.get(key); if (cached?.expiresAt > Date.now()) return cached.data;
  const origin = window.PlayTransport?.getApiOrigin?.(); if (!origin) throw new Error("anonymous auth backend недоступен");
  const headers = { "Content-Type": "application/json" }; if (country) headers["X-Play-Country"] = country;
  const response = await F(`${origin}/api/auth?mode=anonymous`, { method: "POST", headers, body: JSON.stringify(profileForAnonymous(arch, options)), cache: "no-store", referrerPolicy: "no-referrer", signal: options.signal });
  const text = await response.text();
  if (!response.ok) throw new Error(`anonymous auth HTTP ${response.status}${text ? `: ${text.slice(0, 160)}` : ""}`);
  const data = JSON.parse(text); if (!data?.authToken || !data?.gsfId) throw new Error("anonymous dispenser не вернул authToken/gsfId");
  anonymousAuthCache.set(key, { expiresAt: Date.now() + 20 * 60 * 1000, data }); return data;
}
function finalize(packageName, arch, app, delivery) {
  delivery.versionCode ||= app.versionCode;
  delivery.base.name = `${packageName}-${delivery.versionCode}.apk`;
  delivery.splits.forEach(s => { s.name = `${packageName}-${delivery.versionCode}-${s.name}.apk`; });
  return { arch, app, delivery };
}
async function resolveWithAuth(packageName, arch, options, auth) {
  const pre = await B.details(packageName, arch, { ...options, auth });
  const meta = detailMeta(pre.raw), offerType = meta.offerType || 1, vc = pre.app.versionCode;

  // Current playfetch first asks delivery directly. Already-acquired free apps can
  // succeed here without touching the purchase endpoint at all.
  const direct = await tryDelivery(packageName, vc, offerType, auth, options);
  if (direct.delivery) return finalize(packageName, arch, { ...pre.app, ...meta, icon: detailIcon(pre.raw) || "" }, direct.delivery);

  // Modern Aurora performs acquire best-effort: its error is informative but
  // must not prevent the normal purchase/delivery path.
  const acquired = await acquireApp(packageName, vc, offerType, auth, options).catch(() => null);
  const purchaseResult = await purchase(packageName, vc, offerType, auth, options);
  if (!purchaseResult.response.ok) {
    const pmsg = playMessage(purchaseResult.raw);
    const amsg = acquired ? playMessage(acquired.raw) : "";
    const message = pmsg || amsg || `Google Play purchase HTTP ${purchaseResult.response.status}`;
    const error = new Error(message); error.playStatus = purchaseResult.response.status; error.playMessage = message; throw error;
  }

  // Some free-app purchase responses carry delivery data directly. The core
  // parser may find a URL in that response; otherwise redeem encodedDeliveryToken.
  const purchaseDelivery = B.parseDelivery(purchaseResult.raw);
  if (purchaseDelivery?.base?.url) return finalize(packageName, arch, { ...pre.app, ...meta, icon: detailIcon(pre.raw) || "" }, purchaseDelivery);
  const delivered = await tryDelivery(packageName, vc, offerType, auth, options, purchaseResult.token);
  if (!delivered.delivery) {
    const msg = playMessage(delivered.raw) || "Google Play не вернул download URL для этого профиля/версии";
    throw new Error(msg);
  }
  return finalize(packageName, arch, { ...pre.app, ...meta, icon: detailIcon(pre.raw) || "" }, delivered.delivery);
}

window.fetch = async (i, n = {}) => {
  const t = target(i), r = await F(i, n);
  if (t?.hostname === "android.clients.google.com" && t.pathname === "/fdfe/search" && r.ok) {
    try { searchIcons.set(t.searchParams.get("q") || "", parseSearch(new Uint8Array(await r.clone().arrayBuffer()))); } catch {}
  }
  return r;
};

window.GooglePlayClient = Object.freeze({
  ...B,
  buildHeaders: currentHeaders,
  async details(...a) {
    const r = await B.details(...a), u = detailIcon(r.raw), meta = detailMeta(r.raw); if (u) icons.set(r.app.package, u);
    return { ...r, app: { ...r.app, ...meta, icon: u || r.app.icon || "" } };
  },
  async search(q, ...a) {
    const r = await B.search(q, ...a), m = searchIcons.get(String(q || "")) || new Map();
    for (const x of r) { const u = m.get(x.package) || x.icon || ""; if (u) icons.set(x.package, u); }
    return r.map(x => ({ ...x, icon: icons.get(x.package) || x.icon || "" }));
  },
  async resolve(packageName, arch = "arm64", options = {}) {
    let primaryError;
    try {
      const primary = await B.details(packageName, arch, options);
      return await resolveWithAuth(packageName, arch, options, primary.auth);
    } catch (error) { primaryError = error; }

    // A billing/storefront-bound account can return the localized
    // "purchases are not supported in your country" even for a free app.
    // Retry with an Aurora anonymous account; file delivery still comes only
    // from Google's FDFE/CDN and no APK mirror is involved.
    const retryable = /DF-DFERH-01|purchase|country|стране|покуп/i.test(String(primaryError?.message || ""));
    if (retryable) {
      try { return await resolveWithAuth(packageName, arch, options, await anonymousAuth(arch, options)); }
      catch (anonymousError) {
        throw new Error(`${primaryError?.message || "Google Play purchase failed"}; anonymous fallback: ${anonymousError?.message || anonymousError}`);
      }
    }
    throw primaryError;
  }
});

function paint(root = document) {
  root.querySelectorAll?.(".app-card[data-package]").forEach(c => {
    const u = icons.get(c.dataset.package), h = c.querySelector(".app-icon-placeholder"); if (!u || !h || h.dataset.realIcon) return;
    const i = document.createElement("img"); i.className = "app-icon"; i.src = u; i.alt = ""; i.loading = "lazy"; i.referrerPolicy = "no-referrer"; i.dataset.realIcon = "1"; i.addEventListener("error", () => i.replaceWith(h)); h.replaceWith(i);
  });
}
new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) paint(n); }))).observe(document.documentElement, { childList: true, subtree: true });
try {
  if (sessionStorage.getItem("gpd:runtime-fix") !== V) {
    for (const k of Object.keys(sessionStorage)) if (k.startsWith("gpd:search:")) sessionStorage.removeItem(k);
    sessionStorage.setItem("gpd:runtime-fix", V);
  }
} catch {}

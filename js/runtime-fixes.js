const B = window.GooglePlayClient;
const F = window.fetch.bind(window);
const icons = new Map();
const searchIcons = new Map();
const dec = new TextDecoder();
const enc = new TextEncoder();
const V = "20260902-3";

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
    if (w === 4) {
      if (f !== g) throw Error("group");
      return;
    }
    if (w === 0) vi(d, s);
    else if (w === 1) s.p += 8;
    else if (w === 2) s.p += vi(d, s);
    else if (w === 3) sg(d, s, f);
    else if (w === 5) s.p += 4;
    else throw Error("wire");
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
const st = (a, n) => {
  const v = fb(a, n);
  try { return v ? dec.decode(v) : ""; } catch { return ""; }
};
const ii = (a, n) => {
  const r = a.find(([f, w]) => f === n && w === 0);
  return r ? Number(r[2]) : 0;
};

function nav(x, ...p) {
  let d = x instanceof Uint8Array ? x : new Uint8Array(x || []);
  for (const n of p) {
    let a;
    try { a = fs(d); } catch { return []; }
    d = fb(a, n);
    if (!d) return [];
  }
  try { return fs(d); } catch { return []; }
}

function img(u) {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && x.hostname.endsWith(".googleusercontent.com") ? x.href : "";
  } catch { return ""; }
}

function detailIcon(raw) {
  const d = nav(raw, 1, 2, 4);
  for (const x of ab(d, 10)) {
    try {
      const a = fs(x);
      if (ii(a, 1) === 4) {
        const u = img(st(a, 5));
        if (u) return u;
      }
    } catch {}
  }
  return "";
}

function detailMeta(raw) {
  const doc = nav(raw, 1, 2, 4);
  let offer = [], availability = [];
  try {
    const offerBytes = fb(doc, 8);
    const availabilityBytes = fb(doc, 9);
    if (offerBytes) offer = fs(offerBytes);
    if (availabilityBytes) availability = fs(availabilityBytes);
  } catch {}
  return {
    offerType: ii(offer, 8) || ii(availability, 6) || 1,
    currency: st(offer, 2),
    formattedAmount: st(offer, 3),
    availabilityRestriction: ii(availability, 5)
  };
}

function parseSearch(raw) {
  let r;
  try { r = fs(raw); } catch { return new Map(); }
  const m = new Map();
  for (const x of ab(r, 11)) {
    const p = st(nav(x, 2, 1), 1);
    const u = img(st(nav(x, 2, 2, 2, 1, 6), 1));
    if (p && u) m.set(p, u);
  }
  return m;
}

function target(i) {
  try {
    const u = new URL(typeof i === "string" || i instanceof URL ? i : i.url);
    if (u.hostname === "corsproxy.io") {
      const t = u.searchParams.get("url");
      return t ? new URL(t) : u;
    }
    return u;
  } catch { return null; }
}

function pv(n) {
  let x = BigInt(n), out = [];
  while (x > 0x7fn) { out.push(Number((x & 0x7fn) | 0x80n)); x >>= 7n; }
  out.push(Number(x));
  return out;
}

function logRequest(packageName) {
  const query = enc.encode(`confirmFreeDownload?doc=${packageName}`);
  return new Uint8Array([
    ...pv(8), ...pv(Date.now()),
    ...pv(18), ...pv(query.length), ...query
  ]);
}

async function registerFreeDownload(packageName, auth, options = {}) {
  const headers = B.buildHeaders(auth, options.country);
  headers["Content-Type"] = "application/x-protobuf";
  const url = B.relayUrl("https://android.clients.google.com/fdfe/log", headers);
  const response = await F(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-protobuf" },
    body: logRequest(packageName),
    cache: "no-store",
    referrerPolicy: "no-referrer"
  });
  if (!response.ok) throw new Error(`Google Play log HTTP ${response.status}`);
}

window.fetch = async (i, n = {}) => {
  const t = target(i), r = await F(i, n);
  if (t?.hostname === "android.clients.google.com" && t.pathname === "/fdfe/search" && r.ok) {
    try {
      searchIcons.set(t.searchParams.get("q") || "", parseSearch(new Uint8Array(await r.clone().arrayBuffer())));
    } catch {}
  }
  return r;
};

window.GooglePlayClient = Object.freeze({
  ...B,
  async details(...a) {
    const r = await B.details(...a);
    const u = detailIcon(r.raw);
    const meta = detailMeta(r.raw);
    if (u) icons.set(r.app.package, u);
    return { ...r, app: { ...r.app, ...meta, icon: u || r.app.icon || "" } };
  },
  async search(q, ...a) {
    const r = await B.search(q, ...a), m = searchIcons.get(String(q || "")) || new Map();
    for (const x of r) {
      const u = m.get(x.package) || x.icon || "";
      if (u) icons.set(x.package, u);
    }
    return r.map(x => ({ ...x, icon: icons.get(x.package) || x.icon || "" }));
  },
  async resolve(packageName, arch = "arm64", options = {}) {
    try {
      const pre = await B.details(packageName, arch, options);
      await registerFreeDownload(packageName, pre.auth, options);
      return await B.resolve(packageName, arch, { ...options, auth: pre.auth });
    } catch (error) {
      try {
        const details = await B.details(packageName, arch, options);
        const meta = detailMeta(details.raw);
        if (meta.availabilityRestriction === 2) {
          const region = String(options?.country || "Auto").toUpperCase();
          const currency = meta.currency ? ` · валюта ${meta.currency}` : "";
          throw new Error(`Google Play: приложение недоступно в регионе ${region} (GEO_RESTRICTED${currency}). Выберите другой регион, например RU, и повторите.`);
        }
      } catch (metaError) {
        if (String(metaError?.message || "").includes("GEO_RESTRICTED")) throw metaError;
      }
      throw error;
    }
  }
});

function paint(root = document) {
  root.querySelectorAll?.(".app-card[data-package]").forEach(c => {
    const u = icons.get(c.dataset.package), h = c.querySelector(".app-icon-placeholder");
    if (!u || !h || h.dataset.realIcon) return;
    const i = document.createElement("img");
    i.className = "app-icon";
    i.src = u;
    i.alt = "";
    i.loading = "lazy";
    i.referrerPolicy = "no-referrer";
    i.dataset.realIcon = "1";
    i.addEventListener("error", () => i.replaceWith(h));
    h.replaceWith(i);
  });
}

new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => {
  if (n.nodeType === 1) paint(n);
}))).observe(document.documentElement, { childList: true, subtree: true });

try {
  if (sessionStorage.getItem("gpd:runtime-fix") !== V) {
    for (const k of Object.keys(sessionStorage)) if (k.startsWith("gpd:search:")) sessionStorage.removeItem(k);
    sessionStorage.setItem("gpd:runtime-fix", V);
  }
} catch {}

import { directGoogleAuth } from "./google-auth.js";

const GOOGLE_ORIGIN = "https://android.clients.google.com";
const PLAY_SEARCH_ORIGIN = "https://play-fe.googleapis.com";
const decoder = new TextDecoder();
const DELIVERY_BACKOFF_MS = [1000, 3000];
const MAX_RETRY_AFTER_MS = 30000;

const ALLOWED_CORS_ORIGINS = new Set([
  "https://basil-as.github.io",
  "http://localhost:8000", "http://localhost:8080",
  "http://127.0.0.1:8000", "http://127.0.0.1:8080"
]);

const ALLOWED_FDFE_PATHS = [
  /^\/fdfe\/search$/,
  /^\/fdfe\/searchList$/,
  /^\/fdfe\/details$/,
  /^\/fdfe\/purchase$/,
  /^\/fdfe\/delivery$/
];

const ALLOWED_FORWARD_HEADERS = new Set([
  "authorization", "user-agent", "accept", "accept-language", "content-type",
  "x-dfe-device-id", "x-dfe-encoded-targets", "x-dfe-client-id",
  "x-dfe-network-type", "x-dfe-content-filters", "x-limit-ad-tracking-enabled",
  "x-ad-id", "x-dfe-userlanguages", "x-dfe-request-params", "x-dfe-cookie",
  "x-dfe-no-prefetch", "x-dfe-device-checkin-consistency-token",
  "x-dfe-device-config-token", "x-dfe-mccmnc", "x-dfe-phenotype"
]);

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  if (!origin) return {};
  let requestOrigin = "";
  try { requestOrigin = new URL(request.url).origin; } catch {}
  const sameOrigin = origin === requestOrigin;
  if (!sameOrigin && !ALLOWED_CORS_ORIGINS.has(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Accept,Content-Type,Authorization,Range,X-Play-Headers,X-Play-Country",
    "Access-Control-Expose-Headers": "Content-Type,Content-Length,Content-Disposition,Accept-Ranges,Content-Range,ETag,Retry-After,X-Play-Search-Flow",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function applyHeaders(target, values) {
  for (const [key, value] of Object.entries(values || {})) target.set(key, value);
}

function jsonResponse(value, status = 200, cors = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  applyHeaders(headers, cors || {});
  return new Response(JSON.stringify(value), { status, headers });
}

function jsonError(message, status, cors = {}, code = "") {
  return jsonResponse({ error: message, ...(code ? { code } : {}) }, status, cors);
}

function decodeBase64Url(value) {
  if (!value) return {};
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return {};
  }
}

function forwardedHeaders(request, queryValue = "") {
  const encoded = request.headers.get("X-Play-Headers") || queryValue;
  const input = decodeBase64Url(encoded);
  const output = new Headers();
  for (const [name, value] of Object.entries(input || {})) {
    if (!ALLOWED_FORWARD_HEADERS.has(name.toLowerCase())) continue;
    output.set(name, String(value));
  }
  return output;
}

function isAllowedDownload(url) {
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "play.googleapis.com" ||
    host === "android.clients.google.com" ||
    host.endsWith(".googleusercontent.com") ||
    host.endsWith(".ggpht.com") ||
    host.endsWith(".googleapis.com");
}

function retryDelayMs(headers, fallbackMs) {
  const raw = headers?.get?.("Retry-After");
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  return fallbackMs;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function authMode(env) {
  if (String(env.GOOGLE_ACCOUNT_EMAIL || "").trim() && String(env.GOOGLE_AAS_TOKEN || "").trim()) return "direct-google";
  if (String(env.PLAY_DISPENSER_URL || "").trim()) return "custom-dispenser";
  return "unconfigured";
}

function countryFrom(request) {
  return String(request.headers.get("X-Play-Country") || "").trim().toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
}

function extractSearchListPath(bytes) {
  try {
    const text = decoder.decode(bytes);
    const matches = [...text.matchAll(/searchList\?[A-Za-z0-9%&_=+.,~\-]+/g)].map(match => match[0]);
    if (!matches.length) return "";

    // Current Phonesky search uses play-fe and a ptkn continuation. Older
    // android.clients responses may expose ctntkn instead. Prefer ptkn,
    // retain ctntkn only as a compatibility fallback.
    const chosen = matches.slice().sort((a, b) => {
      const score = value => value.includes("ptkn=") ? 3 : value.includes("ctntkn=") ? 2 : 1;
      return score(b) - score(a) || b.length - a.length;
    })[0];

    const url = new URL(`/fdfe/${chosen}`, PLAY_SEARCH_ORIGIN);
    if (url.pathname !== "/fdfe/searchList") return "";
    return `${url.pathname}${url.search}`;
  } catch {
    return "";
  }
}

function fdfeTarget(suffix, sourceUrl) {
  const searchEndpoint = suffix === "/fdfe/search" || suffix === "/fdfe/searchList";
  const target = new URL(`${suffix}${sourceUrl.search}`, searchEndpoint ? PLAY_SEARCH_ORIGIN : GOOGLE_ORIGIN);
  if (suffix === "/fdfe/search") {
    if (!target.searchParams.has("sb")) target.searchParams.set("sb", "5");
    if (!target.searchParams.has("ksm")) target.searchParams.set("ksm", "1");
    if (!target.searchParams.has("ps")) target.searchParams.set("ps", "1");
    if (!target.searchParams.has("nocache_pwr")) target.searchParams.set("nocache_pwr", "true");
  }
  return target;
}

function protobufResponse(bytes, upstream, cors, extraHeaders = {}) {
  const responseHeaders = new Headers({
    "Content-Type": upstream.headers.get("Content-Type") || "application/x-protobuf",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  applyHeaders(responseHeaders, extraHeaders);
  applyHeaders(responseHeaders, cors);
  return new Response(bytes, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}

async function proxyCustomDispenser(request, cors, env) {
  let target;
  try { target = new URL(String(env.PLAY_DISPENSER_URL || "")); }
  catch { return jsonError("PLAY_DISPENSER_URL is invalid", 500, cors, "AUTH_CONFIG"); }
  if (target.protocol !== "https:") return jsonError("PLAY_DISPENSER_URL must use HTTPS", 500, cors, "AUTH_CONFIG");
  const headers = new Headers({ Accept: "application/json", "User-Agent": "AuroraStore/4.6.1 GooglePlayDownloader" });
  const contentType = request.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);
  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "POST" ? await request.arrayBuffer() : undefined,
      redirect: "follow"
    });
  } catch {
    return jsonError("Custom Play dispenser unavailable", 502, cors, "AUTH_UPSTREAM");
  }
  const responseHeaders = new Headers({ "Content-Type": upstream.headers.get("Content-Type") || "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  applyHeaders(responseHeaders, cors);
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

async function handleAuth(request, cors, env) {
  if (request.method !== "POST") return jsonError("Method not allowed", 405, cors);
  const mode = authMode(env);
  if (mode === "unconfigured") {
    return jsonError("Google Play auth backend is not configured. Set GOOGLE_ACCOUNT_EMAIL + GOOGLE_AAS_TOKEN secrets or PLAY_DISPENSER_URL.", 503, cors, "AUTH_NOT_CONFIGURED");
  }
  if (mode === "custom-dispenser") return proxyCustomDispenser(request, cors, env);
  let profile;
  try { profile = await request.json(); }
  catch { return jsonError("Invalid device profile JSON", 400, cors, "BAD_PROFILE"); }
  try {
    const bundle = await directGoogleAuth(profile || {}, countryFrom(request), env);
    return jsonResponse(bundle, 200, cors);
  } catch (error) {
    return jsonError(error?.message || "Direct Google authentication failed", 502, cors, "DIRECT_AUTH_FAILED");
  }
}

async function handleFdfe(request, url, cors) {
  if (!["GET", "POST"].includes(request.method)) return jsonError("Method not allowed", 405, cors);
  const suffix = url.pathname.slice("/api".length);
  if (!ALLOWED_FDFE_PATHS.some(pattern => pattern.test(suffix))) return jsonError("FDFE endpoint not allowed", 403, cors);
  const target = fdfeTarget(suffix, url);
  const headers = forwardedHeaders(request);
  if (!headers.get("Accept")) headers.set("Accept", "application/x-protobuf");
  const body = request.method === "POST" ? await request.arrayBuffer() : undefined;
  const maxAttempts = suffix === "/fdfe/delivery" ? 3 : 1;
  let upstream;
  let searchFlow = "";
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      upstream = await fetch(target.toString(), { method: request.method, headers, body, redirect: "follow" });
      if (upstream.status !== 429 || attempt === maxAttempts - 1) break;
      await sleep(retryDelayMs(upstream.headers, DELIVERY_BACKOFF_MS[attempt] || 3000));
    }

    if (suffix === "/fdfe/search" && request.method === "GET" && upstream.ok) {
      const firstBytes = new Uint8Array(await upstream.arrayBuffer());
      const searchListPath = extractSearchListPath(firstBytes);
      searchFlow = "play-fe-search";

      if (searchListPath) {
        const nextTarget = new URL(searchListPath, PLAY_SEARCH_ORIGIN);
        if (!nextTarget.searchParams.has("ps")) nextTarget.searchParams.set("ps", "1");
        const next = await fetch(nextTarget.toString(), { method: "GET", headers, redirect: "follow" });
        if (next.ok) {
          upstream = next;
          searchFlow = nextTarget.searchParams.has("ptkn") ? "play-fe-ptkn" : "play-fe-continuation";
        } else {
          // Never turn a usable 200 search shell into DF-DFERH-01 just because
          // a Google continuation rejected. The client can still parse any docs
          // present in the initial response.
          return protobufResponse(firstBytes, upstream, cors, { "X-Play-Search-Flow": "play-fe-continuation-fallback" });
        }
      } else {
        return protobufResponse(firstBytes, upstream, cors, { "X-Play-Search-Flow": searchFlow });
      }
    }
  } catch {
    return jsonError("Google Play FDFE unavailable", 502, cors);
  }
  const responseHeaders = new Headers({ "Content-Type": upstream.headers.get("Content-Type") || "application/x-protobuf", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  const retryAfter = upstream.headers.get("Retry-After");
  if (retryAfter) responseHeaders.set("Retry-After", retryAfter);
  if (searchFlow) responseHeaders.set("X-Play-Search-Flow", searchFlow);
  applyHeaders(responseHeaders, cors);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}

async function handleDownload(request, url, cors) {
  if (request.method !== "GET") return jsonError("Method not allowed", 405, cors);
  let target;
  try { target = new URL(url.searchParams.get("url") || ""); }
  catch { return jsonError("Invalid download URL", 400, cors); }
  if (!isAllowedDownload(target)) return jsonError("Download host not allowed", 403, cors);
  const headers = forwardedHeaders(request, url.searchParams.get("h") || "");
  const range = request.headers.get("Range");
  if (range) headers.set("Range", range);
  let upstream;
  try { upstream = await fetch(target.toString(), { headers, redirect: "follow" }); }
  catch { return jsonError("Google download unavailable", 502, cors); }
  const responseHeaders = new Headers({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
  for (const name of ["Content-Type", "Content-Length", "Accept-Ranges", "Content-Range", "ETag", "Last-Modified"]) {
    const value = upstream.headers.get(name); if (value) responseHeaders.set(name, value);
  }
  const name = (url.searchParams.get("name") || "").replace(/[\\/"\r\n]/g, "_");
  if (name) responseHeaders.set("Content-Disposition", `attachment; filename="${name}"`);
  applyHeaders(responseHeaders, cors);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}

async function handleApi(request, env) {
  const cors = corsHeaders(request);
  if (cors === null) return jsonError("Origin not allowed", 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  if (url.pathname === "/api/health") return jsonResponse({ ok: true, authMode: authMode(env) }, 200, cors);
  if (url.pathname === "/api/aurora-auth" || url.pathname === "/api/auth") return handleAuth(request, cors, env);
  if (url.pathname.startsWith("/api/fdfe/")) return handleFdfe(request, url, cors);
  if (url.pathname === "/api/download") return handleDownload(request, url, cors);
  return jsonError("Endpoint not allowed", 404, cors);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  }
};
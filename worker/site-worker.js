const AURORA_AUTH = "https://auroraoss.com/api/auth";
const GOOGLE_ORIGIN = "https://android.clients.google.com";
const DELIVERY_BACKOFF_MS = [1000, 3000];
const MAX_RETRY_AFTER_MS = 30000;

const ALLOWED_CORS_ORIGINS = new Set([
  "https://basil-as.github.io",
  "http://localhost:8000", "http://localhost:8080",
  "http://127.0.0.1:8000", "http://127.0.0.1:8080"
]);

const ALLOWED_FDFE_PATHS = [
  /^\/fdfe\/search$/,
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
  "x-dfe-device-config-token", "x-dfe-mccmnc"
]);

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  if (!origin) return {};
  if (!ALLOWED_CORS_ORIGINS.has(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Accept,Content-Type,Authorization,Range,X-Play-Headers",
    "Access-Control-Expose-Headers": "Content-Type,Content-Length,Content-Disposition,Accept-Ranges,Content-Range,ETag,Retry-After",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function applyHeaders(target, values) {
  for (const [key, value] of Object.entries(values || {})) target.set(key, value);
}

function jsonError(message, status, cors = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  applyHeaders(headers, cors || {});
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

function decodeBase64Url(value) {
  if (!value) return {};
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
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
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  return fallbackMs;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function handleAurora(request, cors) {
  if (!["GET", "POST"].includes(request.method)) return jsonError("Method not allowed", 405, cors);
  const headers = new Headers({
    Accept: "application/json",
    "User-Agent": "AuroraStore/4.6.1 GooglePlayDownloader"
  });
  const contentType = request.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);

  let upstream;
  try {
    upstream = await fetch(AURORA_AUTH, {
      method: request.method,
      headers,
      body: request.method === "POST" ? await request.arrayBuffer() : undefined,
      redirect: "follow"
    });
  } catch {
    return jsonError("Aurora dispenser unavailable", 502, cors);
  }

  const responseHeaders = new Headers({
    "Content-Type": upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  applyHeaders(responseHeaders, cors);
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

async function handleFdfe(request, url, cors) {
  if (!["GET", "POST"].includes(request.method)) return jsonError("Method not allowed", 405, cors);
  const suffix = url.pathname.slice("/api".length);
  if (!ALLOWED_FDFE_PATHS.some(pattern => pattern.test(suffix))) {
    return jsonError("FDFE endpoint not allowed", 403, cors);
  }

  const target = new URL(`${suffix}${url.search}`, GOOGLE_ORIGIN);
  const headers = forwardedHeaders(request);
  if (!headers.get("Accept")) headers.set("Accept", "application/x-protobuf");
  const body = request.method === "POST" ? await request.arrayBuffer() : undefined;
  const maxAttempts = suffix === "/fdfe/delivery" ? 3 : 1;

  let upstream;
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      upstream = await fetch(target.toString(), {
        method: request.method,
        headers,
        body,
        redirect: "follow"
      });
      if (upstream.status !== 429 || attempt === maxAttempts - 1) break;
      await sleep(retryDelayMs(upstream.headers, DELIVERY_BACKOFF_MS[attempt] || 3000));
    }
  } catch {
    return jsonError("Google Play FDFE unavailable", 502, cors);
  }

  const responseHeaders = new Headers({
    "Content-Type": upstream.headers.get("Content-Type") || "application/x-protobuf",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  const retryAfter = upstream.headers.get("Retry-After");
  if (retryAfter) responseHeaders.set("Retry-After", retryAfter);
  applyHeaders(responseHeaders, cors);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders
  });
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
  try {
    upstream = await fetch(target.toString(), { headers, redirect: "follow" });
  } catch {
    return jsonError("Google download unavailable", 502, cors);
  }

  const responseHeaders = new Headers({
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff"
  });
  for (const name of ["Content-Type", "Content-Length", "Accept-Ranges", "Content-Range", "ETag", "Last-Modified"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  const name = (url.searchParams.get("name") || "").replace(/[\\/"\r\n]/g, "_");
  if (name) responseHeaders.set("Content-Disposition", `attachment; filename="${name}"`);
  applyHeaders(responseHeaders, cors);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders
  });
}

async function handleApi(request) {
  const cors = corsHeaders(request);
  if (cors === null) return jsonError("Origin not allowed", 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const url = new URL(request.url);
  if (url.pathname === "/api/aurora-auth") return handleAurora(request, cors);
  if (url.pathname.startsWith("/api/fdfe/")) return handleFdfe(request, url, cors);
  if (url.pathname === "/api/download") return handleDownload(request, url, cors);
  return jsonError("Endpoint not allowed", 404, cors);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return handleApi(request);
    return env.ASSETS.fetch(request);
  }
};
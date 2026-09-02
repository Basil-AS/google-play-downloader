import base from "./site-worker.js";

const ALLOWED_CORS_ORIGINS = new Set([
  "https://basil-as.github.io",
  "http://localhost:8000", "http://localhost:8080",
  "http://127.0.0.1:8000", "http://127.0.0.1:8080"
]);

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  if (!origin) return {};
  let requestOrigin = "";
  try { requestOrigin = new URL(request.url).origin; } catch {}
  if (origin !== requestOrigin && !ALLOWED_CORS_ORIGINS.has(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Accept,Content-Type,X-Play-Country",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
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
  applyHeaders(headers, cors);
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

async function anonymousAuth(request, env) {
  const cors = corsHeaders(request);
  if (cors === null) return jsonError("Origin not allowed", 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return jsonError("Method not allowed", 405, cors);

  let target;
  try { target = new URL(String(env.PLAY_DISPENSER_URL || "https://auroraoss.com/api/auth")); }
  catch { return jsonError("Anonymous Play dispenser URL is invalid", 500, cors); }
  if (target.protocol !== "https:") return jsonError("Anonymous Play dispenser must use HTTPS", 500, cors);

  const headers = new Headers({
    Accept: "application/json",
    "User-Agent": "com.aurora.store",
    "Content-Type": request.headers.get("Content-Type") || "application/json"
  });

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method: "POST",
      headers,
      body: await request.arrayBuffer(),
      redirect: "follow"
    });
  } catch {
    return jsonError("Anonymous Play dispenser unavailable", 502, cors);
  }

  const responseHeaders = new Headers({
    "Content-Type": upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Play-Auth-Mode": "anonymous-dispenser"
  });
  applyHeaders(responseHeaders, cors);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/auth" && url.searchParams.get("mode") === "anonymous") {
      return anonymousAuth(request, env);
    }
    return base.fetch(request, env, ctx);
  }
};

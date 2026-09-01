(() => {
  "use strict";

  const VERSION = "20260901-1";
  const WORKER_ORIGIN = "https://google-play-downloader.basil-as.workers.dev";
  const nativeFetch = window.fetch.bind(window);
  let profileOptions = { locale: "ru-RU", density: "" };

  function hostname() {
    return String(location?.hostname || "");
  }

  function mode() {
    const host = hostname();
    if (host.endsWith(".workers.dev")) return "cloudflare-workers";
    if (host === "basil-as.github.io") return "github-pages-via-cloudflare";
    if (host === "localhost" || host === "127.0.0.1") return "local-via-cloudflare";
    return "external-cloudflare";
  }

  function apiOrigin() {
    return hostname().endsWith(".workers.dev") ? location.origin : WORKER_ORIGIN;
  }

  function apiUrl(path) {
    return `${apiOrigin()}${path}`;
  }

  function utf8ToB64(value) {
    const bytes = new TextEncoder().encode(String(value));
    let binary = "";
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
  }

  function encodeHeaders(headers) {
    return utf8ToB64(JSON.stringify(headers || {}));
  }

  function parseForwardedHeaders(url) {
    const headers = {};
    for (const item of url.searchParams.getAll("reqHeaders")) {
      const colon = item.indexOf(":");
      if (colon <= 0) continue;
      headers[item.slice(0, colon)] = item.slice(colon + 1);
    }
    return headers;
  }

  function mergeProfile(body) {
    if (!body || typeof body !== "string") return body;
    try {
      const profile = JSON.parse(body);
      if (profileOptions.locale) {
        const primary = profileOptions.locale;
        const fallback = primary.toLowerCase().startsWith("ru") ? "en-US" : "ru-RU";
        profile.Locales = `${primary},${fallback}`;
      }
      if (profileOptions.density) profile["Screen.Density"] = String(profileOptions.density);
      return JSON.stringify(profile);
    } catch {
      return body;
    }
  }

  function relayTarget(url) {
    if (url.hostname !== "corsproxy.io") return null;
    const raw = url.searchParams.get("url");
    if (!raw) return null;
    try { return new URL(raw); } catch { return null; }
  }

  function isAurora(url) {
    return url.hostname === "auroraoss.com" && url.pathname === "/api/auth";
  }

  function isFdfe(url) {
    return url.hostname === "android.clients.google.com" && url.pathname.startsWith("/fdfe/");
  }

  function isGoogleDownload(url) {
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (
      host === "play.googleapis.com" ||
      host === "android.clients.google.com" ||
      host.endsWith(".googleusercontent.com") ||
      host.endsWith(".ggpht.com") ||
      host.endsWith(".googleapis.com")
    );
  }

  function workerFetch(path, init = {}) {
    return nativeFetch(apiUrl(path), {
      ...init,
      cache: "no-store",
      referrerPolicy: "no-referrer"
    });
  }

  async function patchedFetch(input, init = {}) {
    const sourceUrl = (() => {
      try { return new URL(typeof input === "string" || input instanceof URL ? input : input.url); }
      catch { return null; }
    })();
    if (!sourceUrl) return nativeFetch(input, init);

    if (isAurora(sourceUrl)) {
      const headers = new Headers(init.headers || {});
      headers.set("Content-Type", "application/json");
      return workerFetch("/api/aurora-auth", {
        ...init,
        method: init.method || "POST",
        headers,
        body: mergeProfile(init.body)
      });
    }

    const target = relayTarget(sourceUrl);
    if (!target) return nativeFetch(input, init);

    const forwarded = parseForwardedHeaders(sourceUrl);
    const headers = new Headers(init.headers || {});
    headers.set("X-Play-Headers", encodeHeaders(forwarded));

    if (isAurora(target)) {
      headers.set("Content-Type", "application/json");
      return workerFetch("/api/aurora-auth", {
        ...init,
        headers,
        body: mergeProfile(init.body)
      });
    }

    if (isFdfe(target)) {
      const suffix = `${target.pathname.slice("/fdfe".length)}${target.search}`;
      return workerFetch(`/api/fdfe${suffix}`, { ...init, headers });
    }

    if (isGoogleDownload(target)) {
      const params = new URLSearchParams({
        url: target.href,
        h: encodeHeaders(forwarded)
      });
      return workerFetch(`/api/download?${params}`, { method: "GET", headers: {} });
    }

    throw new Error(`Blocked legacy relay target: ${target.hostname}`);
  }

  function downloadHeaders(file) {
    const headers = {};
    if (Array.isArray(file?.cookies) && file.cookies.length) {
      headers.Cookie = file.cookies
        .filter(item => item?.name)
        .map(item => `${item.name}=${item.value || ""}`)
        .join("; ");
    }
    return headers;
  }

  function downloadUrl(file, name = "") {
    if (!file?.url) return "#";
    const params = new URLSearchParams({
      url: file.url,
      h: encodeHeaders(downloadHeaders(file))
    });
    if (name) params.set("name", name);
    return apiUrl(`/api/download?${params}`);
  }

  function clearAuthCache() {
    try {
      Object.keys(localStorage)
        .filter(key => key.startsWith("gpd:play-auth:v1:"))
        .forEach(key => localStorage.removeItem(key));
    } catch {}
  }

  function setProfileOptions(next = {}) {
    const normalized = {
      locale: String(next.locale || "ru-RU"),
      density: next.density ? String(next.density) : ""
    };
    const changed = normalized.locale !== profileOptions.locale ||
      normalized.density !== profileOptions.density;
    profileOptions = normalized;
    if (changed) clearAuthCache();
    return changed;
  }

  window.fetch = patchedFetch;
  window.PlayTransport = Object.freeze({
    version: VERSION,
    workerOrigin: WORKER_ORIGIN,
    getMode: mode,
    getApiOrigin: apiOrigin,
    isConfigured: () => Boolean(apiOrigin()),
    downloadUrl,
    setProfileOptions,
    clearAuthCache,
    nativeFetch
  });
})();
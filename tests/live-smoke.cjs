const assert = require('node:assert/strict');

const nativeFetch = global.fetch;
const LEGACY_RELAY_ORIGIN = 'https://corsproxy.io';
const FREE_BINARY_RELAY = 'https://api.corsproxy.cyou/';
const forbidden = new Set(['cookie', 'user-agent', 'origin', 'referer', 'host']);

global.fetch = async (input, init = {}) => {
  const raw = input instanceof Request ? input.url : String(input);
  let url;
  try { url = new URL(raw); } catch { return nativeFetch(input, init); }
  if (url.origin !== LEGACY_RELAY_ORIGIN) return nativeFetch(input, init);

  const target = url.searchParams.get('url');
  if (!target) return nativeFetch(input, init);
  const headers = new Headers(init.headers || {});
  for (const entry of url.searchParams.getAll('reqHeaders')) {
    const i = entry.indexOf(':');
    if (i < 1) continue;
    const name = entry.slice(0, i).trim();
    const value = entry.slice(i + 1).trim();
    if (forbidden.has(name.toLowerCase())) headers.set(`x-cors-header-${name}`, value);
    else headers.set(name, value);
  }
  headers.set('x-cors-header-Origin', 'https://android.clients.google.com');
  return nativeFetch(`${FREE_BINARY_RELAY}${target}`, { ...init, headers });
};

const P = require('../assets/play-client.js');

function networkError(label, error) {
  const cause = error?.cause || {};
  const bits = [error?.message, cause?.code, cause?.message].filter(Boolean).join(' | ');
  throw new Error(`${label}: ${bits || error}`);
}

async function probeRelay(signal) {
  console.log('smoke: relay connectivity');
  try {
    const response = await nativeFetch(`${FREE_BINARY_RELAY}https://example.com/`, { signal });
    console.log(`smoke: relay basic HTTP ${response.status}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    networkError('relay connectivity failed', error);
  }
}

async function fetchAnonymousAuth(signal) {
  console.log('smoke: relay -> Aurora anonymous auth');
  let response;
  try {
    response = await nativeFetch(`${FREE_BINARY_RELAY}https://auroraoss.com/api/auth`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'x-cors-header-User-Agent': 'com.aurora.store-4.6.1-70',
        'x-cors-header-Origin': 'https://auroraoss.com'
      },
      body: JSON.stringify(P.profileFor('arm64'))
    });
  } catch (error) {
    networkError('Aurora relay request failed', error);
  }

  const text = await response.text();
  console.log(`smoke: Aurora HTTP ${response.status}, bytes=${text.length}`);
  if (!response.ok) throw new Error(`Aurora HTTP ${response.status}: ${text.slice(0, 220)}`);
  let auth;
  try { auth = JSON.parse(text); } catch { throw new Error(`Aurora returned non-JSON: ${text.slice(0, 220)}`); }
  assert.ok(auth.authToken, 'missing authToken');
  assert.ok(auth.gsfId, 'missing gsfId');
  return auth;
}

(async () => {
  const packageName = process.env.PLAY_SMOKE_PACKAGE || 'org.mozilla.firefox';
  const signal = AbortSignal.timeout(70000);

  await probeRelay(signal);
  const auth = await fetchAnonymousAuth(signal);
  console.log(`smoke: auth ok, gsfId=${String(auth.gsfId).slice(0, 6)}…`);

  console.log(`smoke: details -> purchase -> delivery for ${packageName}`);
  const result = await P.resolve(packageName, 'arm64', { auth, signal });
  assert.equal(result.app.package, packageName);
  assert.ok(result.app.versionCode > 0, 'missing versionCode');
  assert.match(result.delivery.base.url, /^https:\/\//);

  const host = new URL(result.delivery.base.url).hostname;
  assert.ok(/(^|\.)google(?:apis|usercontent)?\.com$|(^|\.)ggpht\.com$/.test(host), `unexpected CDN host ${host}`);
  console.log(`smoke: OK ${result.app.title} vc=${result.delivery.versionCode} base=${host} splits=${result.delivery.splits.length}`);
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});

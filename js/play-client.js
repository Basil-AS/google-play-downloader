(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GooglePlayClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DISPENSER_URL = 'https://auroraoss.com/api/auth';
  const FDFE = 'https://android.clients.google.com/fdfe';
  const RELAY = 'https://corsproxy.io/';
  const AUTH_CACHE_PREFIX = 'gpd:play-auth:v1:';
  const AUTH_TTL_MS = 45 * 60 * 1000;
  const REQUEST_TIMEOUT_MS = 22000;
  const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

  const BASE_PROFILE = Object.freeze({
    UserReadableName: 'Browser Google Play Client',
    'Build.HARDWARE': 'tegu', 'Build.RADIO': 'g5300t', 'Build.BOOTLOADER': 'tegu',
    'Build.FINGERPRINT': 'google/tegu/tegu:15/BD4A.250405.003/13238919:user/release-keys',
    'Build.BRAND': 'google', 'Build.DEVICE': 'tegu', 'Build.VERSION.SDK_INT': '35',
    'Build.VERSION.RELEASE': '15', 'Build.MODEL': 'Pixel 9a', 'Build.MANUFACTURER': 'Google',
    'Build.PRODUCT': 'tegu', 'Build.ID': 'BD4A.250405.003', 'Build.TYPE': 'user', 'Build.TAGS': 'release-keys',
    'Screen.Density': '420', 'Screen.Width': '1080', 'Screen.Height': '2424', Locales: 'en-US,ru-RU',
    SharedLibraries: 'android.ext.shared,android.test.base,android.test.mock,android.test.runner,com.android.future.usb.accessory,com.android.location.provider,com.google.android.gms,javax.obex,org.apache.http.legacy',
    Features: 'android.hardware.audio.output,android.hardware.bluetooth,android.hardware.bluetooth_le,android.hardware.camera,android.hardware.camera.autofocus,android.hardware.camera.flash,android.hardware.camera.front,android.hardware.faketouch,android.hardware.fingerprint,android.hardware.location,android.hardware.location.gps,android.hardware.location.network,android.hardware.microphone,android.hardware.nfc,android.hardware.screen.landscape,android.hardware.screen.portrait,android.hardware.sensor.accelerometer,android.hardware.sensor.compass,android.hardware.sensor.gyroscope,android.hardware.sensor.light,android.hardware.sensor.proximity,android.hardware.telephony,android.hardware.touchscreen,android.hardware.touchscreen.multitouch,android.hardware.usb.host,android.hardware.wifi,android.hardware.wifi.direct,android.software.app_widgets,android.software.backup,android.software.home_screen,android.software.input_methods,android.software.live_wallpaper,android.software.print,android.software.webview',
    'GSF.version': '251333035', 'Vending.version': '84582130', 'Vending.versionString': '45.8.21-31 [0] [PR] 747433787',
    Roaming: 'mobile-notroaming', TimeZone: 'UTC', CellOperator: '310', SimOperator: '38', Client: 'android-google',
    'GL.Version': '196610', 'GL.Extensions': 'GL_OES_EGL_image,GL_OES_EGL_image_external,GL_OES_EGL_sync,GL_OES_framebuffer_object,GL_OES_rgb8_rgba8,GL_OES_texture_npot,GL_OES_vertex_array_object',
    HasHardKeyboard: 'false', HasFiveWayNavigation: 'false', TouchScreen: '3', Keyboard: '1', Navigation: '1', ScreenLayout: '2'
  });

  const ARCH = Object.freeze({
    arm64: { platforms: 'arm64-v8a,armeabi-v7a,armeabi', name: 'ARM64' },
    armv7: { platforms: 'armeabi-v7a,armeabi', name: 'ARMv7' },
    x86_64: { platforms: 'x86_64,x86', name: 'x86_64' },
    x86: { platforms: 'x86', name: 'x86' },
    tv: { platforms: 'arm64-v8a,armeabi-v7a', name: 'Android TV', tv: true }
  });

  function profileFor(arch) {
    const cfg = ARCH[arch] || ARCH.arm64;
    return { ...BASE_PROFILE, UserReadableName: `Browser ${cfg.name}`, Platforms: cfg.platforms,
      'Build.SUPPORTED_ABIS': cfg.platforms,
      Features: cfg.tv ? `${BASE_PROFILE.Features},android.hardware.type.television,android.software.leanback` : BASE_PROFILE.Features };
  }

  function extractPackage(input) {
    const value = String(input || '').trim();
    if (PACKAGE_RE.test(value)) return value;
    try { const id = new URL(value).searchParams.get('id'); return id && PACKAGE_RE.test(id) ? id : ''; } catch { return ''; }
  }

  function timeoutSignal(ms, externalSignal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'AbortError')), ms);
    const abort = () => controller.abort(externalSignal?.reason);
    if (externalSignal) { if (externalSignal.aborted) abort(); else externalSignal.addEventListener('abort', abort, { once: true }); }
    return { signal: controller.signal, clear: () => clearTimeout(timer) };
  }

  function relayUrl(target, forwardedHeaders = {}) {
    const url = new URL(RELAY); url.searchParams.set('url', target);
    for (const [name, value] of Object.entries(forwardedHeaders)) if (value !== undefined && value !== null && String(value) !== '') url.searchParams.append('reqHeaders', `${name}:${value}`);
    return url.toString();
  }

  async function relayFetch(target, init = {}, options = {}) {
    const forwarded = {}; const sourceHeaders = new Headers(init.headers || {});
    sourceHeaders.forEach((value, name) => { forwarded[name] = value; });
    const timeout = timeoutSignal(options.timeoutMs || REQUEST_TIMEOUT_MS, options.signal || init.signal);
    const requestHeaders = new Headers();
    if (sourceHeaders.get('content-type')) requestHeaders.set('Content-Type', sourceHeaders.get('content-type'));
    if (sourceHeaders.get('accept')) requestHeaders.set('Accept', sourceHeaders.get('accept'));
    try {
      const response = await fetch(relayUrl(target, forwarded), { method: init.method || 'GET', body: init.body, headers: requestHeaders, signal: timeout.signal, cache: 'no-store', referrerPolicy: 'no-referrer' });
      if (!response.ok) { const text = await response.text().catch(() => ''); throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 140)}` : ''}`); }
      return response;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`Timeout при запросе ${new URL(target).hostname}`);
      throw error;
    } finally { timeout.clear(); }
  }

  async function dispenserFetch(profile, signal) {
    const body = JSON.stringify(profile);
    const attempts = [
      async () => fetch(DISPENSER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal, cache: 'no-store' }),
      async () => relayFetch(DISPENSER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'com.aurora.store-4.6.1-70' }, body }, { signal, timeoutMs: 30000 })
    ];
    let last;
    for (const attempt of attempts) {
      try { const response = await attempt(); if (!response.ok) throw new Error(`HTTP ${response.status}`); const data = await response.json(); if (!data?.authToken || !data?.gsfId) throw new Error('dispenser не вернул authToken/gsfId'); return data; }
      catch (error) { last = error; }
    }
    throw new Error(`Не удалось получить anonymous Google Play auth: ${last?.message || last}`);
  }

  function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function storageSet(key, value) { try { localStorage.setItem(key, value); } catch { } }

  async function getAuth(arch = 'arm64', options = {}) {
    const key = AUTH_CACHE_PREFIX + arch;
    if (!options.fresh) { const raw = storageGet(key); if (raw) try { const cached = JSON.parse(raw); if (cached?.expiresAt > Date.now() && cached?.data?.authToken) return cached.data; } catch { } }
    const data = await dispenserFetch(profileFor(arch), options.signal);
    storageSet(key, JSON.stringify({ expiresAt: Date.now() + AUTH_TTL_MS, data })); return data;
  }

  function buildHeaders(auth, country = '') {
    const device = auth.deviceInfoProvider || {}; const locale = country?.toUpperCase() === 'RU' ? 'ru_RU' : 'en_US';
    const headers = {
      Authorization: `Bearer ${auth.authToken}`,
      'User-Agent': device.userAgentString || 'Android-Finsky/45.8.21-31 [0] [PR] 747433787 (api=3,versionCode=84582130,sdk=35,device=tegu,hardware=tegu,product=tegu,platformVersionRelease=15,model=Pixel%209a,buildId=BD4A.250405.003,isWideScreen=0,supportedAbis=arm64-v8a)',
      'X-DFE-Device-Id': auth.gsfId || '', 'Accept-Language': locale.replace('_', '-'),
      'X-DFE-Encoded-Targets': 'CAESN/qigQYC2AMBFfUbyA7SM5Ij/CvfBoIDgxXrBPsDlQUdMfOLAfoFrwEHgAcBrQYhoA0cGt4MKK0Y2gI',
      'X-DFE-Client-Id': 'am-android-google', 'X-DFE-Network-Type': '4', 'X-DFE-Content-Filters': '',
      'X-Limit-Ad-Tracking-Enabled': 'false', 'X-Ad-Id': '', 'X-DFE-UserLanguages': locale,
      'X-DFE-Request-Params': 'timeoutMs=4000', 'X-DFE-Cookie': auth.dfeCookie || '', 'X-DFE-No-Prefetch': 'true', Accept: 'application/x-protobuf'
    };
    if (auth.deviceCheckInConsistencyToken) headers['X-DFE-Device-Checkin-Consistency-Token'] = auth.deviceCheckInConsistencyToken;
    if (auth.deviceConfigToken) headers['X-DFE-Device-Config-Token'] = auth.deviceConfigToken;
    if (device.mccMnc) headers['X-DFE-MCCMNC'] = device.mccMnc;
    return headers;
  }

  class ProtoDecoder {
    constructor(input) { this.data = input instanceof Uint8Array ? input : new Uint8Array(input || []); this.pos = 0; }
    varint() { let shift = 0n, value = 0n; for (let i = 0; i < 10; i += 1) { if (this.pos >= this.data.length) throw new Error('EOF varint'); const b = BigInt(this.data[this.pos++]); value |= (b & 0x7fn) << shift; if ((b & 0x80n) === 0n) return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value; shift += 7n; } throw new Error('Invalid varint'); }
    readAll() { const out = []; while (this.pos < this.data.length) { const key = this.varint(); const keyNum = typeof key === 'bigint' ? Number(key) : key; const field = keyNum >>> 3, wt = keyNum & 7; let value; if (wt === 0) value = this.varint(); else if (wt === 1) { if (this.pos + 8 > this.data.length) throw new Error('EOF fixed64'); value = this.data.slice(this.pos, this.pos + 8); this.pos += 8; } else if (wt === 2) { const lr = this.varint(); const len = typeof lr === 'bigint' ? Number(lr) : lr; if (len < 0 || this.pos + len > this.data.length) throw new Error('EOF bytes'); value = this.data.slice(this.pos, this.pos + len); this.pos += len; } else if (wt === 5) { if (this.pos + 4 > this.data.length) throw new Error('EOF fixed32'); value = this.data.slice(this.pos, this.pos + 4); this.pos += 4; } else throw new Error(`Unsupported protobuf wire type ${wt}`); out.push([field, wt, value]); } return out; }
  }

  const utf8 = new TextDecoder();
  function str(bytes) { if (!(bytes instanceof Uint8Array)) return ''; try { return utf8.decode(bytes); } catch { return ''; } }
  function firstBytes(fields, n) { return fields.find(([fn, wt, v]) => fn === n && wt === 2 && v instanceof Uint8Array)?.[2] || null; }
  function allBytes(fields, n) { return fields.filter(([fn, wt, v]) => fn === n && wt === 2 && v instanceof Uint8Array).map((x) => x[2]); }
  function firstString(fields, n) { return str(firstBytes(fields, n)); }
  function firstInt(fields, n) { const row = fields.find(([fn, wt, v]) => fn === n && wt === 0 && (typeof v === 'number' || typeof v === 'bigint')); return row ? Number(row[2]) : 0; }
  function navigate(raw, ...path) { let data = raw instanceof Uint8Array ? raw : new Uint8Array(raw); for (const n of path) { let fields; try { fields = new ProtoDecoder(data).readAll(); } catch { return []; } const sub = firstBytes(fields, n); if (!sub) return []; data = sub; } try { return new ProtoDecoder(data).readAll(); } catch { return []; } }

  function safeGoogleUrl(value) { try { const u = new URL(value), h = u.hostname; if (u.protocol === 'https:' && (h === 'android.clients.google.com' || h.endsWith('.google.com') || h.endsWith('.googleapis.com') || h.endsWith('.ggpht.com') || h.endsWith('.googleusercontent.com'))) return u.href; } catch { } return ''; }

  function parseDetails(raw) {
    const doc = navigate(raw, 1, 2, 4); if (!doc.length) return null;
    const dd = firstBytes(doc, 13), ad = dd ? firstBytes(new ProtoDecoder(dd).readAll(), 1) : null, app = ad ? new ProtoDecoder(ad).readAll() : [];
    return { package: firstString(doc, 1), title: firstString(doc, 5), developer: firstString(doc, 6), versionCode: firstInt(app, 3), version: firstString(app, 4), playUrl: firstString(doc, 17) };
  }
  function parsePurchase(raw) { const buy = navigate(raw, 1, 4); return buy.length ? firstString(buy, 55) : ''; }
  function parseCookie(raw) { const f = new ProtoDecoder(raw).readAll(), name = firstString(f, 1); return name ? { name, value: firstString(f, 2) } : null; }

  function extractDelivery(fields) {
    const result = { versionCode: firstInt(fields, 29), base: { name: 'base.apk', url: safeGoogleUrl(firstString(fields, 3)), size: firstInt(fields, 1), sha1: firstString(fields, 2), sha256: firstString(fields, 19), cookies: [] }, splits: [], additional: [] };
    for (const c of allBytes(fields, 5)) { const cookie = parseCookie(c); if (cookie) result.base.cookies.push(cookie); }
    for (const s of allBytes(fields, 15)) { const f = new ProtoDecoder(s).readAll(), url = safeGoogleUrl(firstString(f, 5)); if (url) result.splits.push({ name: firstString(f, 1) || `split${result.splits.length}`, url, size: firstInt(f, 2), sha1: firstString(f, 4), sha256: firstString(f, 9), cookies: [] }); }
    for (const x of allBytes(fields, 4)) { const f = new ProtoDecoder(x).readAll(), first = f.find(([fn]) => fn === 1); if (first?.[1] === 2) { const cookie = parseCookie(x); if (cookie) result.base.cookies.push(cookie); } else if (first?.[1] === 0) { const url = safeGoogleUrl(firstString(f, 4)); if (url) result.additional.push({ kind: firstInt(f, 1) === 2 ? 'asset' : (firstInt(f, 1) === 1 ? 'patch-obb' : 'main-obb'), versionCode: firstInt(f, 2), size: firstInt(f, 3), url, cookies: [] }); } }
    return result;
  }

  function extractStrings(raw, depth = 0, out = []) { if (depth > 8) return out; let fields; try { fields = new ProtoDecoder(raw).readAll(); } catch { return out; } for (const [, wt, v] of fields) { if (wt !== 2 || !(v instanceof Uint8Array)) continue; const s = str(v); if (/^[\x20-\x7e]{4,}$/.test(s)) out.push(s); if (v.length > 4) extractStrings(v, depth + 1, out); } return out; }
  function parseDelivery(raw) { for (const payload of [21, 5, 4, 6]) { const fields = navigate(raw, 1, payload, 2); if (fields.length && safeGoogleUrl(firstString(fields, 3))) return extractDelivery(fields); } const url = extractStrings(raw).map(safeGoogleUrl).find(Boolean) || ''; return { versionCode: 0, base: { name: 'base.apk', url, size: 0, sha1: '', sha256: '', cookies: [] }, splits: [], additional: [] }; }

  function findDocs(raw, depth = 0, out = []) { if (depth > 10) return out; let fields; try { fields = new ProtoDecoder(raw).readAll(); } catch { return out; } const pkg = firstString(fields, 1), title = firstString(fields, 5); if (PACKAGE_RE.test(pkg) && title) { out.push({ package: pkg, title, developer: firstString(fields, 6) }); return out; } for (const [, wt, v] of fields) if (wt === 2 && v instanceof Uint8Array && v.length > 20) findDocs(v, depth + 1, out); return out; }

  function parseSearch(raw) {
    let rootFields;
    try { rootFields = new ProtoDecoder(raw).readAll(); } catch { return []; }
    const rows = [];
    for (const item of allBytes(rootFields, 11)) {
      const packageFields = navigate(item, 2, 1);
      const titleFields = navigate(item, 2, 2, 1);
      const developerFields = navigate(item, 2, 3, 14);
      const pkg = firstString(packageFields, 1);
      const title = firstString(titleFields, 1);
      if (!PACKAGE_RE.test(pkg) || !title) continue;
      rows.push({ package: pkg, title, developer: firstString(developerFields, 1) });
    }
    if (rows.length) return rows;
    return findDocs(raw);
  }

  async function fdfe(path, auth, options = {}) {
    const headers = buildHeaders(auth, options.country); if (options.method === 'POST') headers['Content-Type'] = options.contentType || 'application/x-www-form-urlencoded';
    const response = await relayFetch(`${FDFE}${path}`, { method: options.method || 'GET', headers, body: options.body }, { signal: options.signal, timeoutMs: options.timeoutMs || REQUEST_TIMEOUT_MS });
    return new Uint8Array(await response.arrayBuffer());
  }

  async function details(packageName, arch = 'arm64', options = {}) { const auth = options.auth || await getAuth(arch, options); const raw = await fdfe(`/details?doc=${encodeURIComponent(packageName)}`, auth, options); const app = parseDetails(raw); if (!app?.package) throw new Error('Google Play не вернул карточку приложения для этого профиля'); return { auth, app, raw }; }
  async function search(query, arch = 'arm64', options = {}) { const packageName = extractPackage(query); if (packageName) { const { app } = await details(packageName, arch, options); return [app]; } const auth = options.auth || await getAuth(arch, options); const raw = await fdfe(`/search?q=${encodeURIComponent(query)}&c=3`, auth, options); const seen = new Set(); return parseSearch(raw).filter((d) => { if (seen.has(d.package)) return false; seen.add(d.package); return true; }).slice(0, 15); }
  async function resolve(packageName, arch = 'arm64', options = {}) { const { auth, app } = await details(packageName, arch, options); const body = `doc=${encodeURIComponent(packageName)}&ot=1&vc=${encodeURIComponent(app.versionCode)}`; const purchaseRaw = await fdfe('/purchase', auth, { ...options, method: 'POST', body, contentType: 'application/x-www-form-urlencoded' }); const token = parsePurchase(purchaseRaw); const deliveryRaw = await fdfe(`/delivery?doc=${encodeURIComponent(packageName)}&ot=1&vc=${encodeURIComponent(app.versionCode)}${token ? `&dtok=${encodeURIComponent(token)}` : ''}`, auth, options); const delivery = parseDelivery(deliveryRaw); if (!delivery.base.url) throw new Error('Google Play не вернул download URL для этого профиля/версии'); delivery.versionCode ||= app.versionCode; delivery.base.name = `${packageName}-${delivery.versionCode}.apk`; delivery.splits.forEach((s) => { s.name = `${packageName}-${delivery.versionCode}-${s.name}.apk`; }); return { arch, app, delivery }; }
  function downloadRelayUrl(file) { const headers = {}; if (file.cookies?.length) headers.Cookie = file.cookies.map((c) => `${c.name}=${c.value}`).join('; '); return relayUrl(file.url, headers); }

  return Object.freeze({ ARCH: Object.keys(ARCH), profileFor, extractPackage, relayUrl, getAuth, buildHeaders, ProtoDecoder, parseDetails, parsePurchase, parseDelivery, parseSearch, search, details, resolve, downloadRelayUrl });
});

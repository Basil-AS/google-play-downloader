(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ApkComboProvider = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const APKCOMBO_ORIGIN = 'https://apkcombo.com';
  const PUBLIC_PROXY = 'https://corsproxy.io/';
  const HTML_CACHE_PREFIX = 'gpd:apkcombo:v1:';
  const DEFAULT_TIMEOUT_MS = 16000;
  const BINARY_TIMEOUT_MS = 120000;
  const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

  function storageGet(key) {
    try { return sessionStorage.getItem(key); } catch { return null; }
  }

  function storageSet(key, value) {
    try { sessionStorage.setItem(key, value); } catch { /* storage is optional */ }
  }

  function readCache(url) {
    const raw = storageGet(HTML_CACHE_PREFIX + url);
    if (!raw) return null;
    try {
      const entry = JSON.parse(raw);
      if (!entry || Date.now() >= Number(entry.expiresAt || 0)) return null;
      return String(entry.value || '');
    } catch {
      return null;
    }
  }

  function writeCache(url, value, ttlMs) {
    storageSet(HTML_CACHE_PREFIX + url, JSON.stringify({ value, expiresAt: Date.now() + ttlMs }));
  }

  function proxyUrl(targetUrl) {
    let custom = '';
    try { custom = localStorage.getItem('playDownloaderProxyUrl') || ''; } catch { /* optional */ }
    custom = String((typeof globalThis !== 'undefined' && globalThis.PLAY_DOWNLOADER_PROXY) || custom).trim();
    if (custom) {
      if (custom.includes('{url}')) return custom.replace('{url}', encodeURIComponent(targetUrl));
      return `${custom}${custom.includes('?') ? '&' : '?'}url=${encodeURIComponent(targetUrl)}`;
    }
    const url = new URL(PUBLIC_PROXY);
    url.searchParams.set('url', targetUrl);
    return url.toString();
  }

  function timeoutSignal(timeoutMs, externalSignal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'AbortError')), timeoutMs);
    const abort = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) abort();
      else externalSignal.addEventListener('abort', abort, { once: true });
    }
    return { signal: controller.signal, clear: () => clearTimeout(timer) };
  }

  async function fetchHtml(targetUrl, options = {}) {
    const ttlMs = options.cacheTtlMs ?? 4 * 60 * 1000;
    if (!options.skipCache) {
      const cached = readCache(targetUrl);
      if (cached) return cached;
    }
    const timeout = timeoutSignal(options.timeoutMs || DEFAULT_TIMEOUT_MS, options.signal);
    try {
      const response = await fetch(proxyUrl(targetUrl), {
        signal: timeout.signal,
        headers: { Accept: 'text/html,application/xhtml+xml' },
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} при запросе APKCombo`);
      const text = await response.text();
      if (!/<html|<!doctype/i.test(text) && !/apkcombo/i.test(text)) {
        throw new Error('Публичный CORS relay вернул неожиданный ответ');
      }
      if (ttlMs > 0) writeCache(targetUrl, text, ttlMs);
      return text;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('APKCombo/CORS relay не ответил вовремя');
      throw error;
    } finally {
      timeout.clear();
    }
  }

  async function fetchBinary(targetUrl, options = {}) {
    const timeout = timeoutSignal(options.timeoutMs || BINARY_TIMEOUT_MS, options.signal);
    const attempts = [targetUrl, proxyUrl(targetUrl)];
    let lastError;
    try {
      for (const url of attempts) {
        try {
          const response = await fetch(url, {
            signal: timeout.signal,
            referrerPolicy: 'no-referrer',
            cache: 'no-store',
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response;
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          lastError = error;
        }
      }
      throw lastError || new Error('Не удалось скачать пакет');
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Скачивание через браузер превысило лимит времени');
      throw error;
    } finally {
      timeout.clear();
    }
  }

  function decodeEntities(value) {
    return String(value || '')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/&middot;|&#183;/gi, '·')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;|&#34;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  }

  function cleanText(value) {
    return decodeEntities(String(value || '')
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
  }

  function safeAbsolute(href) {
    try { return new URL(decodeEntities(href), APKCOMBO_ORIGIN).href; } catch { return ''; }
  }

  function extractPackage(input) {
    const value = String(input || '').trim();
    if (PACKAGE_RE.test(value)) return value;
    try {
      const url = new URL(value);
      const id = url.searchParams.get('id');
      if (id && PACKAGE_RE.test(id)) return id;
      const pathPackage = url.pathname.split('/').find((part) => PACKAGE_RE.test(part));
      if (pathPackage) return pathPackage;
    } catch { /* plain search query */ }
    return '';
  }

  function anchorMatches(html) {
    const rows = [];
    const re = /<a\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = re.exec(html))) {
      rows.push({ href: decodeEntities(match[2]), html: match[4], text: cleanText(match[4]), index: match.index, end: re.lastIndex });
    }
    return rows;
  }

  function parseSearchResults(html, query = '') {
    const wantedPackage = extractPackage(query);
    const seen = new Set();
    const rows = [];
    for (const anchor of anchorMatches(html)) {
      let path;
      try { path = new URL(anchor.href, APKCOMBO_ORIGIN).pathname; } catch { continue; }
      const match = path.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?([^/]+)\/([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)\/?$/i);
      if (!match) continue;
      const packageName = match[2];
      if (seen.has(packageName)) continue;
      const text = anchor.text;
      if (!text || /old versions|download apk|download xapk/i.test(text)) continue;
      seen.add(packageName);
      const bits = text.split(/\s+·\s+/);
      rows.push({
        package: packageName,
        title: bits[0]?.trim() || packageName,
        subtitle: bits.slice(1).join(' · '),
        url: safeAbsolute(path),
        exact: Boolean(wantedPackage && packageName === wantedPackage),
      });
    }
    rows.sort((a, b) => Number(b.exact) - Number(a.exact));
    return rows.slice(0, 30);
  }

  function metaContent(html, key, value) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<meta[^>]+${key}=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i');
    const reverse = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${key}=["']${escaped}["']`, 'i');
    return decodeEntities((html.match(re) || html.match(reverse) || [])[1] || '');
  }

  function parseVersionCode(text) {
    const matches = [...String(text || '').matchAll(/\((\d{3,})\)/g)];
    return matches.length ? Number(matches[matches.length - 1][1]) : 0;
  }

  function parseOldVersionLinks(html) {
    const seen = new Set();
    const rows = [];
    for (const anchor of anchorMatches(html)) {
      if (!/\/download\/(?:phone|tablet|tv|wear|auto|[^/]+)-/i.test(anchor.href)) continue;
      const url = safeAbsolute(anchor.href);
      if (!url || seen.has(url)) continue;
      const text = anchor.text;
      if (!/\b(?:APK|XAPK|APKS)\b/i.test(text)) continue;
      seen.add(url);
      const format = (text.match(/\b(APK|XAPK|APKS)\b/i) || [])[1]?.toUpperCase() || '';
      const android = (text.match(/Android\s+([^·]+?)(?=$|\s+[A-Z][a-z]{2}\s+\d{1,2},?\s+\d{4})/i) || [])[1]?.trim() || '';
      rows.push({ url, label: text, format, android, versionCode: parseVersionCode(text) });
    }
    return rows;
  }

  function parseAppPage(html, fallbackUrl = '') {
    const packageMatch = cleanText(html).match(/Google Play ID\s+([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)/i);
    const packageFromUrl = (() => {
      try { return new URL(fallbackUrl).pathname.split('/').find((x) => PACKAGE_RE.test(x)) || ''; } catch { return ''; }
    })();
    const packageName = packageMatch?.[1] || packageFromUrl;
    const rawTitle = metaContent(html, 'property', 'og:title');
    const title = rawTitle.replace(/\s+APK.*$/i, '').trim()
      || cleanText((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '')
      || packageName;
    const description = metaContent(html, 'name', 'description');
    const canonical = (html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
      || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i) || [])[1];
    const canonicalUrl = safeAbsolute(canonical || fallbackUrl);
    const pageText = cleanText(html);
    const versionLine = (pageText.match(/Latest Version\s+Version\s+(.+?)\s+Update\s+/i) || [])[1] || '';
    const versionCode = parseVersionCode(versionLine);
    const developer = (pageText.match(/Developer\s+(.+?)\s+Category\s+/i) || [])[1]?.trim() || '';
    const downloadAnchor = anchorMatches(html).find((a) => /\/download\/apk\/?(?:\?|$)/i.test(a.href));
    const oldVersions = parseOldVersionLinks(html);
    return {
      package: packageName,
      title,
      description,
      developer,
      version: versionLine.trim(),
      versionCode,
      url: canonicalUrl || fallbackUrl,
      downloadUrl: downloadAnchor ? safeAbsolute(downloadAnchor.href) : `${(canonicalUrl || fallbackUrl).replace(/\/$/, '')}/download/apk`,
      oldVersions,
    };
  }

  function findLastAbiContext(html, index) {
    const before = cleanText(html.slice(Math.max(0, index - 700), index));
    const abiPattern = /(?:arm64-v8a|armeabi-v7a|x86_64|x86)(?:\s*,\s*(?:arm64-v8a|armeabi-v7a|x86_64|x86))*/gi;
    const matches = [...before.matchAll(abiPattern)];
    if (!matches.length) return [];
    return [...new Set(matches[matches.length - 1][0].split(',').map((x) => x.trim()))];
  }

  function inferFileName(providerUrl, label, format) {
    try {
      const outer = new URL(providerUrl);
      const direct = outer.searchParams.get('u');
      if (direct) {
        const decoded = decodeURIComponent(direct);
        const filename = decoded.match(/filename(?:\*?=|%3D)(?:UTF-8''|%22|")?([^&"%]+(?:%20[^&"%]+)*)/i);
        if (filename?.[1]) return decodeURIComponent(filename[1].replace(/%22$/i, '')).trim();
      }
    } catch { /* use label */ }
    const safe = String(label || 'google-play-package').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 160).trim();
    return `${safe || 'google-play-package'}.${String(format || 'apk').toLowerCase()}`;
  }

  function directUrlFromProvider(providerUrl) {
    try {
      const url = new URL(providerUrl);
      return url.searchParams.get('u') ? decodeURIComponent(url.searchParams.get('u')) : providerUrl;
    } catch { return providerUrl; }
  }

  function parseDownloadVariants(html) {
    const rows = [];
    const seen = new Set();
    for (const anchor of anchorMatches(html)) {
      if (!/\/r2\?u=/i.test(anchor.href)) continue;
      const providerUrl = safeAbsolute(anchor.href);
      if (!providerUrl || seen.has(providerUrl)) continue;
      const label = anchor.text;
      const format = (label.match(/\b(APK|XAPK|APKS)\b/i) || [])[1]?.toUpperCase() || 'APK';
      const sizeMatch = label.match(/(\d+(?:\.\d+)?)\s*(KB|MB|GB)\b/i);
      const android = (label.match(/Android\s+(.+?)(?=\s+\d{2,4}(?:\s*-\s*\d{2,4})?dpi\b|$)/i) || [])[1]?.trim() || '';
      const dpi = (label.match(/(\d{2,4}(?:\s*-\s*\d{2,4})?dpi)\b/i) || [])[1] || '';
      const abis = findLastAbiContext(html, anchor.index);
      const versionCode = parseVersionCode(label);
      const directUrl = directUrlFromProvider(providerUrl);
      const filename = inferFileName(providerUrl, label, format);
      seen.add(providerUrl);
      rows.push({
        id: `v${rows.length + 1}`,
        label,
        format,
        size: sizeMatch ? `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}` : '',
        sizeBytes: sizeMatch ? Math.round(Number(sizeMatch[1]) * ({ KB: 1e3, MB: 1e6, GB: 1e9 }[sizeMatch[2].toUpperCase()] || 1)) : 0,
        android,
        dpi,
        abis,
        versionCode,
        providerUrl,
        directUrl,
        filename,
      });
    }
    return rows;
  }

  function architectureTags(variant) {
    const abis = variant.abis || [];
    const tags = [];
    if (abis.includes('arm64-v8a')) tags.push('arm64');
    if (abis.includes('armeabi-v7a')) tags.push('armv7');
    if (abis.includes('x86_64')) tags.push('x86_64');
    if (abis.includes('x86')) tags.push('x86');
    if (!tags.length) tags.push('universal');
    return tags;
  }

  async function search(query, options = {}) {
    const normalized = String(query || '').trim();
    if (normalized.length < 2) return [];
    const packageName = extractPackage(normalized);
    const term = packageName || normalized;
    const url = `${APKCOMBO_ORIGIN}/search/${encodeURIComponent(term)}`;
    const html = await fetchHtml(url, { ...options, cacheTtlMs: 2 * 60 * 1000 });
    return parseSearchResults(html, normalized);
  }

  async function getApp(url, options = {}) {
    const html = await fetchHtml(url, { ...options, cacheTtlMs: 10 * 60 * 1000 });
    const app = parseAppPage(html, url);
    if (!app.package) throw new Error('Не удалось определить package ID на странице APKCombo');
    const oldUrl = `${app.url.replace(/\/$/, '')}/old-versions/`;
    try {
      const oldHtml = await fetchHtml(oldUrl, { ...options, cacheTtlMs: 10 * 60 * 1000, timeoutMs: 12000 });
      const expanded = parseOldVersionLinks(oldHtml);
      const byUrl = new Map([...app.oldVersions, ...expanded].map((x) => [x.url, x]));
      app.oldVersions = [...byUrl.values()];
    } catch {
      // Main app page already contains a short history; failure here is non-fatal.
    }
    return app;
  }

  async function getVariants(url, options = {}) {
    const html = await fetchHtml(url, { ...options, cacheTtlMs: 90 * 1000, skipCache: options.fresh });
    const variants = parseDownloadVariants(html);
    if (!variants.length) throw new Error('APKCombo не вернул ни одной доступной сборки для этой версии');
    return variants;
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function makeApks(variant, app, onProgress = () => {}) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip не загрузился; обновите страницу и повторите');
    onProgress('Скачиваю исходный пакет в браузер…');
    const response = await fetchBinary(variant.directUrl || variant.providerUrl);
    const contentLength = Number(response.headers.get('content-length') || variant.sizeBytes || 0);
    if (contentLength > 900 * 1024 * 1024) throw new Error('Пакет больше 900 MiB: браузерная конвертация APKS отключена из-за расхода памяти. Скачайте XAPK напрямую.');
    const blob = await response.blob();
    const sourceName = (variant.filename || '').toLowerCase();
    const sourceIsArchive = variant.format !== 'APK' || /\.(xapk|apks|zip|apkm)$/.test(sourceName);
    const out = new JSZip();
    let apkCount = 0;

    if (sourceIsArchive) {
      onProgress('Разбираю XAPK/APKS локально…');
      const source = await JSZip.loadAsync(blob);
      for (const [name, entry] of Object.entries(source.files)) {
        if (entry.dir || !/\.apk$/i.test(name)) continue;
        const basename = name.split('/').pop();
        if (!basename) continue;
        out.file(basename, await entry.async('uint8array'));
        apkCount += 1;
      }
    } else {
      out.file(`${app.package || 'base'}-base.apk`, blob);
      apkCount = 1;
    }

    if (!apkCount) throw new Error('В исходном архиве не найдено APK-файлов');
    const timestamp = Date.now();
    const versionCode = Number(variant.versionCode || app.versionCode || 0);
    const v1 = { package: app.package, label: app.title || app.package, version_code: versionCode, version_name: app.version || '', export_timestamp: timestamp };
    const v2 = { ...v1, split_apk: apkCount > 1, meta_version: 2, min_sdk: 0, target_sdk: 0, backup_components: 0 };
    out.file('meta.sai_v1.json', JSON.stringify(v1, null, 2));
    out.file('meta.sai_v2.json', JSON.stringify(v2, null, 2));
    onProgress(`Собираю SAI-compatible APKS (${apkCount} APK)…`);
    const result = await out.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 5 } });
    const safeVersion = String(app.version || variant.versionCode || 'current').replace(/[^A-Za-z0-9._-]+/g, '_');
    triggerBlobDownload(result, `${app.package}-${safeVersion}.apks`);
    onProgress('APKS готов и скачан.');
    return { apkCount, size: result.size };
  }

  return Object.freeze({ APKCOMBO_ORIGIN, PUBLIC_PROXY, extractPackage, proxyUrl, cleanText, parseSearchResults, parseAppPage, parseOldVersionLinks, parseDownloadVariants, architectureTags, search, getApp, getVariants, makeApks });
});

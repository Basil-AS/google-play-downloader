(() => {
  'use strict';

  const nativeFetch = window.fetch.bind(window);
  const DISPENSER = 'https://auroraoss.com/api/auth';
  const LEGACY_RELAY_ORIGIN = 'https://corsproxy.io';
  const FREE_BINARY_RELAY = 'https://api.corsproxy.cyou/';
  const DIRECT_TIMEOUT_MS = 4500;

  const FORBIDDEN_HEADERS = new Set([
    'accept-charset', 'accept-encoding', 'access-control-request-headers',
    'access-control-request-method', 'connection', 'content-length', 'cookie',
    'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin',
    'referer', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'user-agent', 'via'
  ]);

  function combinedSignal(external, internal) {
    if (!external) return internal;
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([external, internal]);
    const controller = new AbortController();
    const abortExternal = () => controller.abort(external.reason);
    const abortInternal = () => controller.abort(internal.reason);
    if (external.aborted) abortExternal(); else external.addEventListener('abort', abortExternal, { once: true });
    if (internal.aborted) abortInternal(); else internal.addEventListener('abort', abortInternal, { once: true });
    return controller.signal;
  }

  function parseLegacyRelay(raw) {
    try {
      const url = new URL(raw, location.href);
      if (url.origin !== LEGACY_RELAY_ORIGIN) return null;
      const target = url.searchParams.get('url');
      if (!target || !/^https:\/\//i.test(target)) return null;
      return { target, forwarded: url.searchParams.getAll('reqHeaders') };
    } catch {
      return null;
    }
  }

  function splitForwardedHeader(entry) {
    const index = String(entry).indexOf(':');
    if (index < 1) return null;
    return { name: entry.slice(0, index).trim(), value: entry.slice(index + 1).trim() };
  }

  function isForbidden(name) {
    const lower = name.toLowerCase();
    return FORBIDDEN_HEADERS.has(lower) || lower.startsWith('proxy-') || lower.startsWith('sec-');
  }

  function adaptRelayRequest(raw, init = {}) {
    const parsed = parseLegacyRelay(raw);
    if (!parsed) return null;

    const headers = new Headers(init.headers || {});
    for (const encoded of parsed.forwarded) {
      const header = splitForwardedHeader(encoded);
      if (!header || !header.name) continue;
      if (isForbidden(header.name)) headers.set(`x-cors-header-${header.name}`, header.value);
      else headers.set(header.name, header.value);
    }

    // Browser fetch adds Origin to the proxy request. Android Finsky does not
    // send a web Origin, so make it target-local rather than github.io.
    headers.set('x-cors-header-Origin', 'https://android.clients.google.com');

    return {
      url: `${FREE_BINARY_RELAY}${parsed.target}`,
      init: { ...init, headers }
    };
  }

  window.fetch = function guardedFetch(input, init = {}) {
    const raw = input instanceof Request ? input.url : String(input);
    const adapted = adaptRelayRequest(raw, init);
    if (adapted) return nativeFetch(adapted.url, adapted.init);

    let isDirectDispenser = false;
    try { isDirectDispenser = new URL(raw, location.href).href === DISPENSER; } catch { /* native fetch will report it */ }
    if (!isDirectDispenser) return nativeFetch(input, init);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Aurora direct CORS timeout', 'AbortError')), DIRECT_TIMEOUT_MS);
    return nativeFetch(input, { ...init, signal: combinedSignal(init.signal, controller.signal) }).finally(() => clearTimeout(timer));
  };

  // Existing UI renders Google download URLs as legacy relay links. A normal
  // navigation cannot carry MarketDA because Cookie is a forbidden browser
  // header, so cookie-bearing downloads are fetched through the binary relay
  // and saved locally. Cookie-less signed Google URLs can navigate directly.
  document.addEventListener('click', async (event) => {
    const anchor = event.target.closest?.('a[href]');
    if (!anchor) return;
    const parsed = parseLegacyRelay(anchor.href);
    if (!parsed) return;

    const forwarded = parsed.forwarded.map(splitForwardedHeader).filter(Boolean);
    const needsCookie = forwarded.some((h) => h.name.toLowerCase() === 'cookie' && h.value);
    event.preventDefault();

    if (!needsCookie) {
      window.open(parsed.target, anchor.target === '_blank' ? '_blank' : '_self', 'noopener');
      return;
    }

    const originalText = anchor.textContent;
    anchor.textContent = 'Скачиваю…';
    anchor.setAttribute('aria-disabled', 'true');
    anchor.style.pointerEvents = 'none';

    try {
      const response = await window.fetch(anchor.href, { cache: 'no-store' });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const rowName = anchor.closest('.file-row')?.querySelector('.file-name')?.textContent?.trim();
      const filename = rowName || new URL(parsed.target).pathname.split('/').pop() || 'google-play-download.apk';
      const save = document.createElement('a');
      save.href = objectUrl;
      save.download = filename;
      save.style.display = 'none';
      document.body.appendChild(save);
      save.click();
      save.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 15000);
    } catch (error) {
      console.error('Google Play download failed', error);
      alert(`Не удалось скачать файл из Google Play: ${error?.message || error}`);
    } finally {
      anchor.textContent = originalText;
      anchor.removeAttribute('aria-disabled');
      anchor.style.pointerEvents = '';
    }
  }, true);
})();

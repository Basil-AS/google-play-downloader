(() => {
  'use strict';

  const nativeFetch = window.fetch.bind(window);
  const FAILOVER_TIMEOUT_MS = 8500;
  const APKCOMBO_HOST = 'apkcombo.com';

  const relayBuilders = [
    ['direct', (target) => target],
    ['allorigins', (target) => `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`],
    ['cors.lol', (target) => `https://api.cors.lol/?url=${encodeURIComponent(target)}`],
    ['corsproxy.io', (target) => `https://corsproxy.io/?url=${encodeURIComponent(target)}`],
  ];

  function headersFrom(init) {
    try { return new Headers(init?.headers || {}); } catch { return new Headers(); }
  }

  function isHtmlRequest(init) {
    return /text\/html|application\/xhtml\+xml/i.test(headersFrom(init).get('Accept') || '');
  }

  function targetFromCorsProxy(input) {
    try {
      const raw = input instanceof Request ? input.url : String(input);
      const url = new URL(raw, location.href);
      if (url.origin !== 'https://corsproxy.io') return '';
      const target = url.searchParams.get('url') || '';
      const parsed = new URL(target);
      return parsed.hostname === APKCOMBO_HOST || parsed.hostname.endsWith(`.${APKCOMBO_HOST}`) ? parsed.href : '';
    } catch {
      return '';
    }
  }

  function combineSignals(external, internal) {
    if (!external) return internal;
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([external, internal]);
    const controller = new AbortController();
    const abort = (signal) => () => controller.abort(signal.reason);
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', abort(external), { once: true });
    if (internal.aborted) controller.abort(internal.reason);
    else internal.addEventListener('abort', abort(internal), { once: true });
    return controller.signal;
  }

  async function fetchCandidate(name, url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException(`${name} timeout`, 'AbortError')), FAILOVER_TIMEOUT_MS);
    try {
      const response = await nativeFetch(url, {
        ...init,
        signal: combineSignals(init?.signal, controller.signal),
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (!/<html|<!doctype|apkcombo/i.test(text)) throw new Error('unexpected response');
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      const reason = error?.name === 'AbortError' ? 'timeout' : (error?.message || String(error));
      throw new Error(`${name}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchApkComboHtml(target, init) {
    const attempts = relayBuilders.map(([name, build]) =>
      fetchCandidate(name, build(target), init)
        .then((response) => ({ response, name }))
        .catch((error) => Promise.reject(error))
    );

    try {
      const winner = await Promise.any(attempts);
      console.info(`[google-play-downloader] APKCombo relay: ${winner.name}`);
      return winner.response;
    } catch (aggregate) {
      const details = Array.isArray(aggregate?.errors)
        ? aggregate.errors.map((error) => error?.message || String(error)).join(' · ')
        : (aggregate?.message || String(aggregate));
      throw new Error(`Каталог APKCombo недоступен через публичные relay: ${details}`);
    }
  }

  window.fetch = function failoverFetch(input, init = {}) {
    const target = targetFromCorsProxy(input);
    if (!target || !isHtmlRequest(init)) return nativeFetch(input, init);
    return fetchApkComboHtml(target, init);
  };

  window.PlayDownloaderFetchFailover = Object.freeze({
    relays: relayBuilders.map(([name]) => name),
    timeoutMs: FAILOVER_TIMEOUT_MS,
  });
})();

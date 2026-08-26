(() => {
  'use strict';

  const nativeFetch = window.fetch.bind(window);
  const DISPENSER = 'https://auroraoss.com/api/auth';
  const DIRECT_TIMEOUT_MS = 4500;

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

  window.fetch = function guardedFetch(input, init = {}) {
    const raw = input instanceof Request ? input.url : String(input);
    let isDirectDispenser = false;
    try { isDirectDispenser = new URL(raw, location.href).href === DISPENSER; } catch { /* native fetch will report it */ }
    if (!isDirectDispenser) return nativeFetch(input, init);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Aurora direct CORS timeout', 'AbortError')), DIRECT_TIMEOUT_MS);
    return nativeFetch(input, { ...init, signal: combinedSignal(init.signal, controller.signal) }).finally(() => clearTimeout(timer));
  };
})();

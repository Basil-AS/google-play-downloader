(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = { backend: '', selectedPackage: '', manifest: null };

  function guessBackend() {
    const qs = new URLSearchParams(location.search).get('api');
    if (qs) {
      const value = qs.replace(/\/$/, '');
      localStorage.setItem('playDownloaderBackend', value);
      return value;
    }
    const stored = localStorage.getItem('playDownloaderBackend');
    if (stored) return stored.replace(/\/$/, '');
    if (window.PLAY_DOWNLOADER_API) return String(window.PLAY_DOWNLOADER_API).replace(/\/$/, '');
    if (['localhost', '127.0.0.1'].includes(location.hostname)) return 'http://localhost:8080';
    return '';
  }

  function api(path) {
    if (!state.backend) throw new Error('Сначала укажите URL backend API');
    return `${state.backend}${path}`;
  }

  async function fetchJson(path, init = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(api(path), {
        ...init,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      });
      let data = null;
      try { data = await response.json(); } catch { /* no json */ }
      if (!response.ok) {
        const message = data?.detail || data?.error || `${response.status} ${response.statusText}`;
        const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeout = new Error(`Backend не ответил за ${Math.round(timeoutMs / 1000)} с. Запрос остановлен, чтобы интерфейс не зависал.`);
        timeout.status = 408;
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function formatBytes(bytes) {
    const n = Number(bytes || 0);
    if (!n) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = n; let i = 0;
    while (value >= 1000 && i < units.length - 1) { value /= 1000; i += 1; }
    return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  }

  function absoluteBackendPath(path) {
    return path.startsWith('http') ? path : api(path);
  }

  function setStatus(kind, text) {
    const node = $('backendState');
    node.className = `status status-${kind}`;
    node.textContent = text;
  }

  async function checkBackend(showOutput = false) {
    if (!state.backend) {
      setStatus('off', 'backend: не задан');
      return false;
    }
    setStatus('off', 'backend: проверка…');
    try {
      const data = await fetchJson('/api/status', {}, 8000);
      setStatus(data.linked ? 'on' : 'error', data.linked ? 'backend: ready' : 'backend: not linked');
      if (showOutput) {
        $('backendTest').hidden = false;
        $('backendTest').textContent = JSON.stringify(data, null, 2);
      }
      return data.linked;
    } catch (error) {
      setStatus('error', 'backend: offline');
      if (showOutput) {
        $('backendTest').hidden = false;
        $('backendTest').textContent = error.message;
      }
      return false;
    }
  }

  function showError(where, error) {
    const box = document.createElement('div');
    box.className = 'error-box';
    box.textContent = error?.message || String(error);
    where.prepend(box);
    setTimeout(() => box.remove(), 16000);
  }

  function selectPackage(pkg, title = '') {
    state.selectedPackage = pkg;
    $('selectedPackage').textContent = title ? `${title} · ${pkg}` : pkg;
    $('query').value = pkg;
    $('searchResults').hidden = true;
    $('optionsCard').hidden = false;
    $('manifestCard').hidden = true;
    $('optionsCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function search(query) {
    const results = $('searchResults');
    results.hidden = false;
    const isPackage = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(query);
    if (isPackage) {
      results.innerHTML = `<button class="search-result" data-package="${escapeHtml(query)}"><span><b>Открыть package напрямую</b><small>${escapeHtml(query)}</small></span><code>package</code></button><div class="empty">Параллельно ищу по каталогу…</div>`;
    } else {
      results.innerHTML = '<div class="empty">Ищу в Google Play…</div>';
    }
    try {
      const data = await fetchJson(`/api/search?q=${encodeURIComponent(query)}&limit=14`, {}, 20000);
      const rows = data.map((item) => `
        <button class="search-result" data-package="${escapeHtml(item.package)}" data-title="${escapeHtml(item.title)}">
          <span><b>${escapeHtml(item.title || item.package)}</b><small>${escapeHtml(item.creator || item.package)}</small></span>
          <code>${escapeHtml(item.package)}</code>
        </button>`).join('');
      const direct = isPackage && !data.some((x) => x.package === query)
        ? `<button class="search-result" data-package="${escapeHtml(query)}"><span><b>Открыть package напрямую</b><small>${escapeHtml(query)}</small></span><code>package</code></button>` : '';
      results.innerHTML = direct + (rows || '<div class="empty">Ничего не найдено. Если знаете package name — вставьте его полностью.</div>');
    } catch (error) {
      if (isPackage) return;
      results.innerHTML = '';
      showError(results, error);
    }
  }

  function selectedArchitectures() {
    return [...document.querySelectorAll('input[name="arch"]:checked')].map((node) => node.value);
  }

  function selectedLocales() {
    return $('locales').value.split(',').map((x) => x.trim()).filter(Boolean);
  }

  function startProgress(deepScan, arches) {
    const started = Date.now();
    const update = () => {
      const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
      let text;
      if (deepScan) {
        if (seconds < 4) text = 'Проверяю кэш device token и готовлю профили.';
        else if (seconds < 12) text = `Deep Scan: параллельно проверяю ${arches.length} архитектур(ы).`;
        else text = 'Deep Scan: Google Play отвечает по профилям; медленные профили ограничены таймаутом.';
      } else if (seconds < 3) {
        text = 'Проверяю кэш device token.';
      } else if (seconds < 8) {
        text = `Получаю details → purchase → delivery для ${arches.join(', ')}.`;
      } else {
        text = 'Google Play отвечает медленнее обычного; запрос ограничен таймаутом и не будет висеть бесконечно.';
      }
      $('progressText').textContent = `${text} · ${seconds} с`;
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }

  async function resolveManifest() {
    const arches = selectedArchitectures();
    if (!arches.length) throw new Error('Выберите хотя бы одну архитектуру');
    const versionRaw = $('versionCode').value.trim();
    if (versionRaw && !/^\d+$/.test(versionRaw)) throw new Error('versionCode должен быть положительным числом');

    const deepScan = $('deepScan').checked;
    const body = JSON.stringify({
      package: state.selectedPackage,
      architectures: arches,
      locales: selectedLocales(),
      versionCode: versionRaw ? Number(versionRaw) : null,
      deepScan,
      forceRefresh: $('forceRefresh').checked,
    });

    $('progressCard').hidden = false;
    $('manifestCard').hidden = true;
    $('resolveButton').disabled = true;
    $('progressCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    const stopProgress = startProgress(deepScan, arches);

    try {
      const timeoutMs = deepScan ? 135000 : 45000;
      let manifest;
      try {
        manifest = await fetchJson('/api/resolve-fast', { method: 'POST', body }, timeoutMs);
      } catch (error) {
        if (error.status !== 404 || error.message !== 'Not Found') throw error;
        manifest = await fetchJson('/api/resolve', { method: 'POST', body }, timeoutMs);
      }
      state.manifest = manifest;
      renderManifest(manifest);
    } finally {
      stopProgress();
      $('progressCard').hidden = true;
      $('resolveButton').disabled = false;
    }
  }

  function kindLabel(kind) {
    return ({ base: 'BASE', split: 'SPLIT', obb: 'OBB', asset: 'ASSET', dm: 'DEX META' })[kind] || kind.toUpperCase();
  }

  function renderManifest(manifest) {
    $('manifestTitle').textContent = manifest.title || manifest.package;
    const speed = manifest.cached ? 'cache hit' : (manifest.resolver?.parallel ? `parallel ×${manifest.resolver.workers}` : 'live');
    $('manifestMeta').textContent = [manifest.package, manifest.developer, `${manifest.variants.length} variant(s)`, `versionCode: ${manifest.versionCodes.join(', ')}`, speed].filter(Boolean).join(' · ');
    $('allZip').href = absoluteBackendPath(manifest.archives.allZip);

    $('variants').innerHTML = manifest.variants.map((variant) => {
      const files = variant.files.map((file) => `
        <div class="file-row">
          <span class="file-kind">${escapeHtml(kindLabel(file.kind))}</span>
          <span class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
          <span class="file-hash" title="${escapeHtml(file.sha256 || file.sha1 || '')}">${escapeHtml((file.sha256 || file.sha1 || 'no hash').slice(0, 22))}</span>
          <span class="file-size">${formatBytes(file.size)}</span>
          <a class="button" href="${escapeHtml(absoluteBackendPath(file.download))}">Скачать</a>
        </div>`).join('');
      const deviceBits = [variant.device, variant.sdk ? `SDK ${variant.sdk}` : '', variant.density ? `${variant.density} dpi` : '', variant.abis].filter(Boolean).join(' · ');
      return `
        <article class="variant">
          <div class="variant-head">
            <div>
              <div class="variant-title"><h3>${escapeHtml(variant.arch)}</h3><span class="pill">${escapeHtml(variant.profile)}</span><span class="pill">vc ${variant.versionCode}</span></div>
              <p class="variant-meta">${escapeHtml(deviceBits)} · ${escapeHtml(variant.locales.join(', '))}</p>
            </div>
            <div class="archive-actions">
              <a class="button" href="${escapeHtml(absoluteBackendPath(variant.archives.zip))}">ZIP originals</a>
              <a class="button" href="${escapeHtml(absoluteBackendPath(variant.archives.apks))}">APKS</a>
              <a class="button" href="${escapeHtml(absoluteBackendPath(variant.archives.mergedApk))}" title="Пересобранный и локально переподписанный APK">Merged APK*</a>
            </div>
          </div>
          <div class="files">${files || '<div class="empty">Нет файлов</div>'}</div>
        </article>`;
    }).join('');

    const diag = manifest.diagnostics || {};
    if (Object.keys(diag).length) {
      $('diagnosticsBlock').hidden = false;
      $('diagnostics').textContent = JSON.stringify(diag, null, 2);
    } else {
      $('diagnosticsBlock').hidden = true;
    }
    $('manifestCard').hidden = false;
    $('manifestCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function wire() {
    state.backend = guessBackend();
    $('backendUrl').value = state.backend;
    checkBackend();

    $('settingsButton').addEventListener('click', () => {
      $('backendUrl').value = state.backend;
      $('backendTest').hidden = true;
      $('settingsDialog').showModal();
    });
    $('testBackend').addEventListener('click', async () => {
      const previous = state.backend;
      state.backend = $('backendUrl').value.trim().replace(/\/$/, '');
      await checkBackend(true);
      state.backend = previous;
    });
    $('saveBackend').addEventListener('click', () => {
      state.backend = $('backendUrl').value.trim().replace(/\/$/, '');
      if (state.backend) localStorage.setItem('playDownloaderBackend', state.backend);
      else localStorage.removeItem('playDownloaderBackend');
      setTimeout(() => checkBackend(), 0);
    });

    $('searchForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const query = $('query').value.trim();
      if (query.length < 2) return;
      try { await search(query); } catch (error) { showError($('searchResults'), error); }
    });
    $('searchResults').addEventListener('click', (event) => {
      const button = event.target.closest('[data-package]');
      if (button) selectPackage(button.dataset.package, button.dataset.title || '');
    });
    $('clearSelection').addEventListener('click', () => {
      state.selectedPackage = '';
      $('optionsCard').hidden = true;
      $('manifestCard').hidden = true;
      $('query').focus();
    });
    $('selectAllArch').addEventListener('click', () => document.querySelectorAll('input[name="arch"]').forEach((x) => { x.checked = true; }));
    $('onlyArm64').addEventListener('click', () => document.querySelectorAll('input[name="arch"]').forEach((x) => { x.checked = x.value === 'arm64'; }));
    $('resolveForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try { await resolveManifest(); } catch (error) { showError($('optionsCard'), error); }
    });

    $('query').addEventListener('dblclick', () => {
      const value = $('query').value.trim();
      if (/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(value)) selectPackage(value);
    });
  }

  document.addEventListener('DOMContentLoaded', wire);
})();

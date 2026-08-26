(() => {
  'use strict';

  const P = window.ApkComboProvider;
  if (!P) throw new Error('ApkComboProvider is not loaded');
  const $ = (id) => document.getElementById(id);
  const state = { app: null, variants: [], visible: [], controller: null, startedAt: 0, progressTimer: null };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  }

  function setStatus(kind, text) {
    const node = $('providerState');
    node.className = `status status-${kind}`;
    node.textContent = text;
  }

  function showError(where, error) {
    const old = where.querySelector('.error-box');
    if (old) old.remove();
    const box = document.createElement('div');
    box.className = 'error-box';
    box.textContent = error?.message || String(error);
    where.prepend(box);
    setTimeout(() => box.remove(), 18000);
  }

  function startProgress(text) {
    state.startedAt = performance.now();
    $('progressCard').hidden = false;
    $('progressText').textContent = text;
    clearInterval(state.progressTimer);
    state.progressTimer = setInterval(() => {
      const seconds = Math.floor((performance.now() - state.startedAt) / 1000);
      $('progressTime').textContent = `${seconds} с`;
    }, 250);
  }

  function progress(text) { $('progressText').textContent = text; }
  function stopProgress() { clearInterval(state.progressTimer); state.progressTimer = null; $('progressCard').hidden = true; $('progressTime').textContent = ''; }
  function abortPending() { state.controller?.abort(); state.controller = null; }

  async function search(query) {
    abortPending();
    state.controller = new AbortController();
    const results = $('searchResults');
    results.hidden = false;
    results.innerHTML = '<div class="empty">Ищу приложение в каталоге…</div>';
    setStatus('off', 'provider: запрос…');
    startProgress('Получаю индекс APKCombo через публичный CORS relay…');
    try {
      const rows = await P.search(query, { signal: state.controller.signal });
      setStatus('on', 'provider: ready');
      if (!rows.length) { results.innerHTML = '<div class="empty">Ничего не найдено. Попробуйте точный package ID или ссылку Google Play.</div>'; return; }
      const exact = rows.find((row) => row.exact);
      if (exact && P.extractPackage(query)) { await selectApp(exact); return; }
      results.innerHTML = rows.map((row) => `
        <button class="search-result" type="button" data-app-url="${escapeHtml(row.url)}" data-package="${escapeHtml(row.package)}" data-title="${escapeHtml(row.title)}">
          <span><b>${escapeHtml(row.title)}</b><small>${escapeHtml(row.subtitle || row.package)}</small></span>
          <code>${escapeHtml(row.package)}</code>
        </button>`).join('');
    } finally { stopProgress(); }
  }

  async function selectApp(row) {
    abortPending();
    state.controller = new AbortController();
    $('searchResults').hidden = true;
    $('variantsCard').hidden = true;
    $('appCard').hidden = true;
    startProgress(`Открываю ${row.title || row.package} и историю версий…`);
    try {
      const app = await P.getApp(row.url, { signal: state.controller.signal });
      state.app = app;
      renderApp(app);
      $('appCard').hidden = false;
      $('appCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      setStatus('on', 'provider: ready');
    } finally { stopProgress(); }
  }

  function renderApp(app) {
    $('appTitle').textContent = app.title || app.package;
    $('appPackage').textContent = app.package;
    $('appMeta').textContent = [app.developer, app.version, `${app.oldVersions.length} старых версий`].filter(Boolean).join(' · ');
    $('openProvider').href = app.url;
    const versionSelect = $('versionSelect');
    versionSelect.innerHTML = `<option value="${escapeHtml(app.downloadUrl)}">Последняя · ${escapeHtml(app.version || 'current')}</option>`;
    app.oldVersions.forEach((version) => {
      const option = document.createElement('option'); option.value = version.url; option.textContent = version.label; versionSelect.appendChild(option);
    });
  }

  function selectedArchitectures() { return [...document.querySelectorAll('input[name="arch"]:checked')].map((x) => x.value); }

  function filterVariants() {
    const selected = selectedArchitectures();
    const formats = [...document.querySelectorAll('input[name="format"]:checked')].map((x) => x.value);
    const showUniversal = $('includeUniversal').checked;
    state.visible = state.variants.filter((variant) => {
      const tags = P.architectureTags(variant);
      const archMatch = tags.includes('universal') ? showUniversal : tags.some((tag) => selected.includes(tag));
      return archMatch && formats.includes(variant.format);
    });
    renderVariants();
  }

  function badges(variant) { const tags = P.architectureTags(variant); return [variant.format, ...tags, variant.android && `Android ${variant.android}`, variant.dpi].filter(Boolean); }

  function renderVariants() {
    const box = $('variants');
    $('variantCount').textContent = `${state.visible.length} из ${state.variants.length}`;
    if (!state.visible.length) { box.innerHTML = '<div class="empty">Для выбранных фильтров вариантов нет. Включите Universal/XAPK или другие ABI.</div>'; return; }
    box.innerHTML = state.visible.map((variant) => `
      <article class="variant" data-variant-id="${escapeHtml(variant.id)}">
        <div class="variant-head">
          <div>
            <div class="variant-title"><h3>${escapeHtml(variant.format)}</h3>${badges(variant).map((b) => `<span class="pill">${escapeHtml(b)}</span>`).join('')}</div>
            <p class="variant-meta">${escapeHtml(variant.label)}</p>
          </div>
          <div class="archive-actions">
            <a class="button primary" href="${escapeHtml(variant.providerUrl)}" target="_blank" rel="noopener noreferrer">Скачать ${escapeHtml(variant.format)}</a>
            <button class="button" type="button" data-action="apks" data-variant-id="${escapeHtml(variant.id)}">Сделать APKS</button>
          </div>
        </div>
        <div class="variant-facts">
          <span><b>ABI</b>${escapeHtml((variant.abis || []).join(', ') || 'universal / unspecified')}</span>
          <span><b>Размер</b>${escapeHtml(variant.size || '—')}</span>
          <span><b>Android</b>${escapeHtml(variant.android || '—')}</span>
          <span><b>DPI</b>${escapeHtml(variant.dpi || '—')}</span>
          <span><b>versionCode</b>${escapeHtml(variant.versionCode || '—')}</span>
        </div>
      </article>`).join('');
  }

  async function loadVariants() {
    if (!state.app) return;
    abortPending();
    state.controller = new AbortController();
    $('loadVariants').disabled = true;
    $('variantsCard').hidden = true;
    startProgress('Получаю список APK/XAPK вариантов: ABI, Android и DPI…');
    try {
      const url = $('versionSelect').value;
      state.variants = await P.getVariants(url, { signal: state.controller.signal, fresh: $('freshProvider').checked });
      filterVariants();
      $('variantsCard').hidden = false;
      $('variantsCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      setStatus('on', `provider: ${state.variants.length} variants`);
    } finally { $('loadVariants').disabled = false; stopProgress(); }
  }

  async function makeApks(variantId, button) {
    const variant = state.variants.find((item) => item.id === variantId);
    if (!variant || !state.app) return;
    button.disabled = true;
    startProgress('Подготавливаю локальный APKS…');
    try {
      const result = await P.makeApks(variant, state.app, progress);
      setStatus('on', `APKS: ${result.apkCount} APK`);
    } finally { button.disabled = false; setTimeout(stopProgress, 600); }
  }

  function wire() {
    setStatus('on', 'static: ready');
    $('searchForm').addEventListener('submit', async (event) => {
      event.preventDefault(); const query = $('query').value.trim(); if (query.length < 2) return;
      try { await search(query); } catch (error) { stopProgress(); showError($('searchResults'), error); setStatus('error', 'provider: error'); }
    });
    $('searchResults').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-app-url]'); if (!button) return;
      try { await selectApp({ url: button.dataset.appUrl, package: button.dataset.package, title: button.dataset.title }); }
      catch (error) { stopProgress(); showError($('searchResults'), error); setStatus('error', 'provider: error'); }
    });
    $('loadVariants').addEventListener('click', async () => { try { await loadVariants(); } catch (error) { stopProgress(); showError($('appCard'), error); setStatus('error', 'provider: error'); } });
    $('filters').addEventListener('change', filterVariants);
    $('selectAllArch').addEventListener('click', () => { document.querySelectorAll('input[name="arch"]').forEach((x) => { x.checked = true; }); filterVariants(); });
    $('onlyArm64').addEventListener('click', () => { document.querySelectorAll('input[name="arch"]').forEach((x) => { x.checked = x.value === 'arm64'; }); filterVariants(); });
    $('variants').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-action="apks"]'); if (!button) return;
      try { await makeApks(button.dataset.variantId, button); } catch (error) { stopProgress(); showError($('variantsCard'), error); setStatus('error', 'APKS: error'); }
    });
    $('resetApp').addEventListener('click', () => { abortPending(); state.app = null; state.variants = []; state.visible = []; $('appCard').hidden = true; $('variantsCard').hidden = true; $('query').focus(); });
    const packageFromUrl = new URLSearchParams(location.search).get('package');
    if (packageFromUrl) { $('query').value = packageFromUrl; search(packageFromUrl).catch((error) => { stopProgress(); showError($('searchResults'), error); }); }
  }

  document.addEventListener('DOMContentLoaded', wire);
})();

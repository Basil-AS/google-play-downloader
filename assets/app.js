(() => {
  'use strict';

  const P = window.GooglePlayClient;
  if (!P) throw new Error('GooglePlayClient is not loaded');
  const $ = (id) => document.getElementById(id);
  const state = { app: null, resolved: [], controller: null, startedAt: 0, timer: null };

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

  function setStatus(kind, text) { const n = $('providerState'); n.className = `status status-${kind}`; n.textContent = text; }
  function startProgress(text) { state.startedAt = performance.now(); $('progressCard').hidden = false; $('progressText').textContent = text; $('progressTime').textContent = '0 с'; clearInterval(state.timer); state.timer = setInterval(() => { $('progressTime').textContent = `${Math.floor((performance.now() - state.startedAt) / 1000)} с`; }, 250); }
  function progress(text) { $('progressText').textContent = text; }
  function stopProgress() { clearInterval(state.timer); state.timer = null; $('progressCard').hidden = true; $('progressTime').textContent = ''; }
  function abortPending() { state.controller?.abort(); state.controller = null; }
  function showError(where, error) { where.querySelector('.error-box')?.remove(); const box = document.createElement('div'); box.className = 'error-box'; box.textContent = error?.message || String(error); where.prepend(box); }

  async function search(query) {
    abortPending(); state.controller = new AbortController();
    const results = $('searchResults'); results.hidden = false; results.innerHTML = '<div class="empty">Авторизую анонимный Play-профиль и ищу в Google Play…</div>';
    setStatus('off', 'Google Play: auth…'); startProgress('Получаю anonymous auth bundle и обращаюсь к Google Play FDFE…');
    try {
      const rows = await P.search(query, 'arm64', { signal: state.controller.signal }); setStatus('on', 'Google Play: ready');
      if (!rows.length) { results.innerHTML = '<div class="empty">Google Play не вернул результатов. Попробуйте точный package ID.</div>'; return; }
      if (P.extractPackage(query)) { await selectApp(rows[0]); return; }
      results.innerHTML = rows.map((row) => `<button class="search-result" type="button" data-package="${escapeHtml(row.package)}" data-title="${escapeHtml(row.title)}"><span><b>${escapeHtml(row.title || row.package)}</b><small>${escapeHtml(row.developer || 'Google Play')}</small></span><code>${escapeHtml(row.package)}</code></button>`).join('');
    } finally { stopProgress(); }
  }

  async function selectApp(row) {
    abortPending(); state.controller = new AbortController(); $('searchResults').hidden = true; $('variantsCard').hidden = true; startProgress(`Получаю details для ${row.package} из Google Play…`);
    try {
      const { app } = await P.details(row.package, 'arm64', { signal: state.controller.signal }); state.app = app;
      $('appTitle').textContent = app.title || app.package; $('appPackage').textContent = app.package;
      $('appMeta').textContent = [app.developer, app.version, app.versionCode && `versionCode ${app.versionCode}`].filter(Boolean).join(' · ');
      $('openPlay').href = `https://play.google.com/store/apps/details?id=${encodeURIComponent(app.package)}`; $('appCard').hidden = false; $('appCard').scrollIntoView({ behavior: 'smooth', block: 'start' }); setStatus('on', 'Google Play: ready');
    } finally { stopProgress(); }
  }

  function selectedArchitectures() { return [...document.querySelectorAll('input[name="arch"]:checked')].map((x) => x.value); }
  function fileRows(result) { return [{ ...result.delivery.base, kind: 'BASE' }, ...result.delivery.splits.map((x) => ({ ...x, kind: 'SPLIT' })), ...result.delivery.additional.map((x, i) => ({ ...x, name: `${result.app.package}-${result.delivery.versionCode}-${x.kind || `extra${i}`}${x.kind?.includes('obb') ? '.obb' : '.apk'}`, kind: String(x.kind || 'EXTRA').toUpperCase() }))]; }
  function formatBytes(n) { const num = Number(n || 0); if (!num) return '—'; const units = ['B', 'KiB', 'MiB', 'GiB']; let value = num, i = 0; while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; } return `${value.toFixed(i ? 1 : 0)} ${units[i]}`; }

  function renderResolved() {
    const box = $('variants');
    if (!state.resolved.length) { box.innerHTML = '<div class="empty">Google Play не отдал ни одного совместимого профиля.</div>'; return; }
    box.innerHTML = state.resolved.map((result) => {
      const files = fileRows(result);
      return `<article class="variant" data-arch="${escapeHtml(result.arch)}"><div class="variant-head"><div><div class="variant-title"><h3>${escapeHtml(result.arch)}</h3><span class="pill">Google Play</span><span class="pill">vc ${escapeHtml(result.delivery.versionCode)}</span><span class="pill">${files.length} files</span></div><p class="variant-meta">${escapeHtml(result.app.version || '')} · base + ${result.delivery.splits.length} splits · ${result.delivery.additional.length} extras</p></div><div class="archive-actions"><button class="button" type="button" data-action="apks" data-arch="${escapeHtml(result.arch)}">Собрать APKS</button></div></div><div class="files">${files.map((file) => `<div class="file-row"><span class="file-kind">${escapeHtml(file.kind)}</span><span class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span><span class="file-size">${file.size ? escapeHtml(formatBytes(file.size)) : '—'}</span><a class="button" href="${escapeHtml(P.downloadRelayUrl(file))}" target="_blank" rel="noopener noreferrer">Скачать</a></div>`).join('')}</div></article>`;
    }).join('');
  }

  async function resolveSelected() {
    if (!state.app) return; const arches = selectedArchitectures(); if (!arches.length) return;
    abortPending(); state.controller = new AbortController(); state.resolved = []; $('resolveButton').disabled = true; $('variantsCard').hidden = true; startProgress('Запрашиваю purchase → delivery непосредственно у Google Play…'); const failures = [];
    try {
      for (let i = 0; i < arches.length; i += 1) {
        const arch = arches[i]; progress(`${arch}: anonymous auth → details → purchase → delivery (${i + 1}/${arches.length})`);
        try { state.resolved.push(await P.resolve(state.app.package, arch, { signal: state.controller.signal, fresh: $('freshAuth').checked })); }
        catch (error) { failures.push(`${arch}: ${error?.message || error}`); }
      }
      renderResolved(); $('variantsCard').hidden = false; $('diagnostics').textContent = failures.join('\n'); $('diagnosticsBlock').hidden = failures.length === 0; $('variantCount').textContent = String(state.resolved.length);
      setStatus(state.resolved.length ? 'on' : 'error', state.resolved.length ? `Google Play: ${state.resolved.length} profiles` : 'Google Play: error'); $('variantsCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } finally { $('resolveButton').disabled = false; stopProgress(); }
  }

  async function makeApks(arch, button) {
    const result = state.resolved.find((x) => x.arch === arch); if (!result) return; if (!window.JSZip) throw new Error('JSZip не загрузился'); button.disabled = true; startProgress(`${arch}: скачиваю APK-файлы с Google CDN в память браузера…`);
    try {
      const zip = new JSZip(); const apkFiles = fileRows(result).filter((x) => /\.apk$/i.test(x.name));
      for (let i = 0; i < apkFiles.length; i += 1) { const file = apkFiles[i]; progress(`${arch}: ${i + 1}/${apkFiles.length} ${file.name}`); const response = await fetch(P.downloadRelayUrl(file), { cache: 'no-store' }); if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`); zip.file(file.name, await response.arrayBuffer()); }
      zip.file('meta.sai_v1.json', JSON.stringify({ label: `${result.app.title || result.app.package} ${result.app.version || ''}`, version_name: result.app.version || '', version_code: result.delivery.versionCode || result.app.versionCode || 0 }, null, 2));
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${result.app.package}-${result.delivery.versionCode}-${arch}.apks`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 15000);
    } finally { button.disabled = false; stopProgress(); }
  }

  function wire() {
    setStatus('on', 'static: ready');
    $('searchForm').addEventListener('submit', async (event) => { event.preventDefault(); const query = $('query').value.trim(); if (query.length < 2) return; try { await search(query); } catch (error) { stopProgress(); showError($('searchResults'), error); setStatus('error', 'Google Play: error'); } });
    $('searchResults').addEventListener('click', async (event) => { const b = event.target.closest('[data-package]'); if (!b) return; try { await selectApp({ package: b.dataset.package, title: b.dataset.title }); } catch (error) { stopProgress(); showError($('searchResults'), error); setStatus('error', 'Google Play: error'); } });
    $('resolveButton').addEventListener('click', async () => { try { await resolveSelected(); } catch (error) { stopProgress(); showError($('appCard'), error); setStatus('error', 'Google Play: error'); } });
    $('variants').addEventListener('click', async (event) => { const b = event.target.closest('[data-action="apks"]'); if (!b) return; try { await makeApks(b.dataset.arch, b); } catch (error) { stopProgress(); showError($('variantsCard'), error); } });
    $('selectAllArch').addEventListener('click', () => { document.querySelectorAll('input[name="arch"]').forEach((x) => { x.checked = true; }); });
    $('onlyArm64').addEventListener('click', () => { document.querySelectorAll('input[name="arch"]').forEach((x) => { x.checked = x.value === 'arm64'; }); });
    $('resetApp').addEventListener('click', () => { abortPending(); state.app = null; state.resolved = []; $('appCard').hidden = true; $('variantsCard').hidden = true; $('query').focus(); });
    const packageFromUrl = new URLSearchParams(location.search).get('package'); if (packageFromUrl) { $('query').value = packageFromUrl; search(packageFromUrl).catch((error) => { stopProgress(); showError($('searchResults'), error); setStatus('error', 'Google Play: error'); }); }
  }

  document.addEventListener('DOMContentLoaded', wire);
})();

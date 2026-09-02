import {
  P, transport, state, dom,
  PACKAGE_RE, PACKAGE_PREFIX_RE, PACKAGE_LIKE_RE,
  normalize, searchTokens, extractPackage, escapeHtml,
  fileRows, selectedArchitectures, settings
} from "./common.js?v=20260902-7";
import {
  setStatus, emptyState, loadingState, showError,
  startProgress, progress, stopProgress,
  renderResults, renderSelectedApp, renderResolved
} from "./render.js?v=20260902-7";

const SEARCH_TTL_MS = 2 * 60 * 1000;
const SEARCH_CACHE_PREFIX = `gpd:search:${String(transport?.version || "unknown")}:`;
const MAX_VISIBLE_RESULTS = 8;
const ARCH_LABELS = {
  arm64: "ARM64", armv7: "ARMv7", x86_64: "x86_64", x86: "x86", tv: "Android TV"
};
const GENERIC_PACKAGE_PARTS = new Set(["com", "ru", "org", "net", "io", "app", "android"]);

function profileSignature(cfg) {
  return `${cfg.country || ""}|${cfg.locale || ""}|${cfg.density || ""}`;
}

function configureTransport(cfg) {
  return transport.setProfileOptions({
    country: cfg.country,
    locale: cfg.locale,
    density: cfg.density
  });
}

function cacheKey(query, cfg) {
  return `${normalize(query)}|${profileSignature(cfg)}`;
}

function sessionRead(key) {
  try {
    const raw = sessionStorage.getItem(`${SEARCH_CACHE_PREFIX}${key}`);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return value?.expiresAt > Date.now() && Array.isArray(value.rows) ? value.rows : null;
  } catch {
    return null;
  }
}

function sessionWrite(key, rows) {
  try {
    sessionStorage.setItem(`${SEARCH_CACHE_PREFIX}${key}`, JSON.stringify({
      expiresAt: Date.now() + SEARCH_TTL_MS,
      rows
    }));
  } catch {}
}

async function cachedSearch(query, signal, cfg, fresh = false) {
  const key = cacheKey(query, cfg);
  const memory = state.searchCache.get(key);
  if (memory?.expiresAt > Date.now()) return memory.rows;

  const stored = sessionRead(key);
  if (stored) {
    state.searchCache.set(key, { expiresAt: Date.now() + SEARCH_TTL_MS, rows: stored });
    return stored;
  }

  const rows = await P.search(query, "arm64", {
    signal,
    country: cfg.country,
    fresh
  });
  state.searchCache.set(key, { expiresAt: Date.now() + SEARCH_TTL_MS, rows });
  sessionWrite(key, rows);
  return rows;
}

function relevanceScore(app, query) {
  const q = normalize(query);
  const title = normalize(app.title);
  const pkg = normalize(app.package);
  const developer = normalize(app.developer);
  if (!q) return 0;
  if (pkg === q) return 10000;
  if (title === q) return 9500;
  if (title.startsWith(q)) return 8200;
  if (pkg.startsWith(q)) return 7800;
  if (title.includes(q)) return 6800;
  if (pkg.includes(q)) return 6400;

  const tokens = searchTokens(q);
  if (!tokens.length) return 0;
  const titleHits = tokens.filter(token => title.includes(token)).length;
  const packageHits = tokens.filter(token => pkg.includes(token)).length;
  const developerHits = tokens.filter(token => developer.includes(token)).length;
  if (titleHits === tokens.length) return 5200 + titleHits * 100;
  if (packageHits === tokens.length) return 4800 + packageHits * 100;
  if (titleHits + packageHits === tokens.length) return 4200 + (titleHits + packageHits) * 100;
  if (titleHits || packageHits) return 2600 + titleHits * 200 + packageHits * 150;
  if (developerHits === tokens.length) return 1800;
  return 0;
}

function cleanResults(rows, query) {
  const seen = new Set();
  return rows
    .filter(row => row?.package && !seen.has(row.package) && seen.add(row.package))
    .map((app, index) => ({ app, index, score: relevanceScore(app, query) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_VISIBLE_RESULTS)
    .map(item => item.app);
}

function packagePrefixSeed(prefix) {
  const parts = normalize(prefix).replace(/\.$/, "").split(".").filter(Boolean);
  return [...parts].reverse().find(part => part.length >= 3 && !GENERIC_PACKAGE_PARTS.has(part)) ||
    parts.at(-1) || prefix;
}

async function searchPrefix(prefix, signal, cfg, fresh) {
  const normalizedPrefix = normalize(prefix);
  const seed = packagePrefixSeed(prefix);
  const queries = [...new Set([prefix, seed])];
  const batches = [];
  for (const query of queries) batches.push(await cachedSearch(query, signal, cfg, fresh));

  const seen = new Set();
  return batches.flat()
    .filter(row => normalize(row?.package).startsWith(normalizedPrefix))
    .filter(row => row.package && !seen.has(row.package) && seen.add(row.package))
    .sort((a, b) => String(a.title || a.package).localeCompare(String(b.title || b.package), "ru"));
}

export async function selectPackage(packageName, options = {}) {
  const pkg = extractPackage(packageName) || packageName;
  if (!PACKAGE_RE.test(pkg)) throw new Error("Некорректный package name");

  let signal = options.signal;
  if (!signal) {
    state.searchController?.abort();
    state.searchController = new AbortController();
    signal = state.searchController.signal;
  }

  state.query = pkg;
  const cfg = settings();
  const profileChanged = configureTransport(cfg);
  startProgress(`Получаю карточку ${pkg} из Google Play…`);
  setStatus("Google Play: details…", "loading");

  try {
    const { app } = await P.details(pkg, "arm64", {
      signal,
      country: cfg.country,
      fresh: profileChanged
    });
    if (!app?.package || normalize(app.package) !== normalize(pkg)) {
      throw new Error("Google Play не вернул точное совпадение package");
    }
    state.app = app;
    state.resolved = [];
    renderSelectedApp(app);
    dom.variantsCard.hidden = true;
    renderResults([app]);
    setStatus("Точное совпадение", "ok");
    dom.appCard.scrollIntoView({ behavior: "smooth", block: "start" });
    return app;
  } finally {
    stopProgress();
  }
}

export async function searchApps(query) {
  const trimmed = String(query || "").trim();
  if (trimmed.length < 2) return;

  state.searchController?.abort();
  const controller = new AbortController();
  state.searchController = controller;
  state.query = trimmed;
  dom.appCard.hidden = true;
  dom.variantsCard.hidden = true;

  const exact = extractPackage(trimmed);
  if (exact) {
    loadingState("Проверяем точный package name…");
    try {
      await selectPackage(exact, { signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") return;
      showError("Package не найден или недоступен", error?.message || String(error));
      setStatus("Точного совпадения нет", "error");
    }
    return;
  }

  const cfg = settings();
  const profileChanged = configureTransport(cfg);
  loadingState(PACKAGE_PREFIX_RE.test(trimmed)
    ? `Ищем package prefix ${trimmed}*…`
    : "Ищем наиболее релевантные приложения…");
  setStatus("Google Play: search…", "loading");
  startProgress("Google Play auth → FDFE search…");

  try {
    let rows;
    if (PACKAGE_PREFIX_RE.test(trimmed)) {
      rows = await searchPrefix(trimmed, controller.signal, cfg, profileChanged);
      if (controller.signal.aborted || state.query !== trimmed) return;
      if (!rows.length) {
        emptyState("Совпадений по package prefix нет",
          `Google Play search не вернул пакеты, начинающиеся на ${trimmed}`);
        setStatus("Prefix: 0");
        return;
      }
      renderResults(rows);
      setStatus(`По префиксу: ${rows.length}`, "ok");
      return;
    }

    rows = await cachedSearch(trimmed, controller.signal, cfg, profileChanged);
    if (controller.signal.aborted || state.query !== trimmed) return;
    const apps = cleanResults(rows, trimmed);
    if (!apps.length) {
      emptyState("Ничего релевантного не найдено",
        "Попробуйте точнее сформулировать название или вставьте полный package name / ссылку Google Play.");
      setStatus("Результатов нет");
      return;
    }
    renderResults(apps);
    setStatus(`Показано: ${apps.length}`, "ok");
  } catch (error) {
    if (error?.name === "AbortError") return;
    console.error(error);
    showError("Не удалось обратиться к Google Play", `${error?.message || error}. Попробуйте ещё раз.`);
    setStatus("Google Play: error", "error");
  } finally {
    stopProgress();
  }
}

export async function updateSuggestions(query) {
  state.suggestionController?.abort();
  const controller = new AbortController();
  state.suggestionController = controller;
  if (query.length < 2 || PACKAGE_LIKE_RE.test(query)) {
    dom.suggestions.hidden = true;
    return;
  }

  try {
    const cfg = settings();
    const profileChanged = configureTransport(cfg);
    const rows = await cachedSearch(query, controller.signal, cfg, profileChanged);
    if (controller.signal.aborted ||
        dom.searchInput.value.trim() !== query ||
        document.activeElement !== dom.searchInput) return;

    const suggestions = cleanResults(rows, query).slice(0, 5);
    dom.suggestions.innerHTML = suggestions.map(item =>
      `<button type="button" data-suggestion-package="${escapeHtml(item.package)}">` +
      `<span>${escapeHtml(item.title || item.package)}</span>` +
      `<small>${escapeHtml(item.package)}</small></button>`
    ).join("");
    dom.suggestions.hidden = !suggestions.length;
  } catch (error) {
    if (error?.name !== "AbortError") dom.suggestions.hidden = true;
  }
}

function abortResolve() {
  state.resolveController?.abort();
  state.resolveController = null;
}

async function resolveOne(packageName, arch, cfg, signal, fresh) {
  try {
    return await P.resolve(packageName, arch, { signal, fresh, country: cfg.country });
  } catch (error) {
    if (signal.aborted) throw error;
    const message = String(error?.message || error);
    if (!fresh && /(?:401|403|auth|token|credential)/i.test(message)) {
      transport.clearAuthCache();
      return P.resolve(packageName, arch, { signal, fresh: true, country: cfg.country });
    }
    throw error;
  }
}

export async function resolveSelected() {
  if (!state.app) return;
  const arches = selectedArchitectures();
  if (!arches.length) throw new Error("Выберите хотя бы одну архитектуру");

  abortResolve();
  const controller = new AbortController();
  state.resolveController = controller;
  state.resolved = [];
  const cfg = settings();
  const profileChanged = configureTransport(cfg);
  const button = document.querySelector("#resolveButton");
  button.disabled = true;
  dom.variantsCard.hidden = true;
  startProgress("Получаю delivery из Google Play…");
  const failures = [];

  try {
    for (let index = 0; index < arches.length; index++) {
      const arch = arches[index];
      progress(`${ARCH_LABELS[arch] || arch}: auth → details → purchase → delivery (${index + 1}/${arches.length})`);
      try {
        const result = await resolveOne(
          state.app.package,
          arch,
          cfg,
          controller.signal,
          cfg.fresh || profileChanged
        );
        result.arch = arch;
        result.archLabel = ARCH_LABELS[arch] || arch;
        state.resolved.push(result);
      } catch (error) {
        if (controller.signal.aborted) return;
        failures.push(`${ARCH_LABELS[arch] || arch}: ${error?.message || error}`);
      }
    }

    renderResolved();
    dom.variantsCard.hidden = false;
    dom.variantCount.textContent = String(state.resolved.length);
    dom.diagnostics.textContent = failures.join("\n");
    dom.diagnosticsBlock.hidden = failures.length === 0;
    setStatus(
      state.resolved.length ? `Google Play: ${state.resolved.length} profiles` : "Google Play: delivery error",
      state.resolved.length ? "ok" : "error"
    );
    dom.variantsCard.scrollIntoView({ behavior: "smooth", block: "start" });
  } finally {
    button.disabled = false;
    stopProgress();
  }
}

export async function makeApks(arch, button) {
  const result = state.resolved.find(item => item.arch === arch);
  if (!result) return;
  if (!window.JSZip) throw new Error("JSZip не загрузился");

  const files = fileRows(result).filter(file => /\.apk$/i.test(file.name) && file.url);
  if (!files.length) throw new Error("Google Play не отдал APK-файлы для этого профиля");
  const total = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
  if (total > 500 * 1024 * 1024 &&
      !window.confirm(`Для APKS браузеру нужно обработать около ${Math.round(total / 1024 / 1024)} МБ в памяти. Продолжить?`)) return;

  button.disabled = true;
  startProgress(`${ARCH_LABELS[arch] || arch}: собираю APKS из оригинальных Google APK…`);
  try {
    const zip = new JSZip();
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      progress(`${ARCH_LABELS[arch] || arch}: ${index + 1}/${files.length} ${file.name}`);
      const response = await fetch(transport.downloadUrl(file, file.name), { cache: "no-store" });
      if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`);
      zip.file(file.name, await response.arrayBuffer());
    }
    zip.file("meta.sai_v1.json", JSON.stringify({
      label: `${result.app.title || result.app.package} ${result.app.version || ""}`.trim(),
      version_name: result.app.version || "",
      version_code: result.delivery.versionCode || result.app.versionCode || 0
    }, null, 2));

    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${result.app.package}-${result.delivery.versionCode || result.app.versionCode || "latest"}-${arch}.apks`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  } finally {
    button.disabled = false;
    stopProgress();
  }
}

export function resetApp() {
  state.searchController?.abort();
  abortResolve();
  state.app = null;
  state.resolved = [];
  dom.appCard.hidden = true;
  dom.variantsCard.hidden = true;
}
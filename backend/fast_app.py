from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, wait

from fastapi import HTTPException

import app as legacy

# Keep the original API/routes, but patch the expensive auth lookup used by
# search/details/resolve and add a parallel resolver for multi-architecture
# requests. This stays in a separate module so the upstream-facing Play
# protocol implementation in app.py remains easy to audit.
app = legacy.app
legacy.APP_VERSION = "1.1.0"
app.version = legacy.APP_VERSION

AUTH_MEMORY_TTL = max(60, min(int(os.getenv("AUTH_MEMORY_TTL", "2700")), 2940))
RESOLVE_CACHE_TTL = max(0, min(int(os.getenv("RESOLVE_CACHE_TTL", "180")), legacy.MANIFEST_TTL))
RESOLVE_WORKERS = max(1, min(int(os.getenv("RESOLVE_WORKERS", "5")), len(legacy.ARCHES)))
RESOLVE_TIMEOUT = max(5, min(int(os.getenv("RESOLVE_TIMEOUT", "35")), 120))
DEEP_SCAN_TIMEOUT = max(RESOLVE_TIMEOUT, min(int(os.getenv("DEEP_SCAN_TIMEOUT", "120")), 300))

_AUTH_CACHE: dict[tuple[str, str], tuple[float, dict]] = {}
_AUTH_CACHE_LOCK = threading.Lock()
_AUTH_GUARDS: dict[tuple[str, str], threading.Lock] = {}

_RESOLVE_CACHE: dict[str, tuple[float, str, dict[str, list[str]]]] = {}
_RESOLVE_CACHE_LOCK = threading.Lock()
_EXECUTOR = ThreadPoolExecutor(max_workers=RESOLVE_WORKERS, thread_name_prefix="play-resolve")


def _auth_key(arch: str) -> tuple[str, str]:
    return arch, legacy.ACCOUNT_EMAIL or ""


def _guard_for(key: tuple[str, str]) -> threading.Lock:
    with _AUTH_CACHE_LOCK:
        guard = _AUTH_GUARDS.get(key)
        if guard is None:
            guard = threading.Lock()
            _AUTH_GUARDS[key] = guard
        return guard


def _fast_require_auth(arch: str, force_refresh: bool = False) -> dict:
    """Cache dispenser-issued auth in memory, including email-pinned accounts.

    gplaydl intentionally bypasses its disk token cache whenever an explicit
    account email is supplied. That is correct for the CLI, but a long-running
    backend would otherwise mint a fresh device token for every API request.
    We cache it for less than Google's normal token lifetime and still force a
    refresh immediately after an AuthExpiredError.
    """
    key = _auth_key(arch)
    guard = _guard_for(key)
    with guard:
        if not force_refresh:
            with _AUTH_CACHE_LOCK:
                cached = _AUTH_CACHE.get(key)
            if cached and time.monotonic() - cached[0] < AUTH_MEMORY_TTL:
                return cached[1]

        try:
            auth = legacy.ensure_auth(
                arch=arch,
                dispenser_url=legacy.DISPENSER_URL,
                force_refresh=force_refresh,
                email=legacy.ACCOUNT_EMAIL,
            )
        except Exception as exc:  # preserve the public API's error contract
            raise HTTPException(502, f"Google Play authentication failed: {exc}") from exc

        if not auth or not auth.get("authToken"):
            raise HTTPException(
                503,
                "Backend is not linked to gplaydl. Run `gplaydl link` in the backend container or set GPLAYDL_API_KEY.",
            )

        with _AUTH_CACHE_LOCK:
            _AUTH_CACHE[key] = (time.monotonic(), auth)
        return auth


# Existing /api/search, /api/app and legacy /api/resolve functions look this
# name up in the app module at call time, so they benefit from the cache too.
legacy._require_auth = _fast_require_auth


def _request_key(request: legacy.ResolveRequest) -> str:
    raw = json.dumps(request.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def _cached_resolve(request: legacy.ResolveRequest) -> dict | None:
    if RESOLVE_CACHE_TTL <= 0 or request.forceRefresh:
        return None
    key = _request_key(request)
    with _RESOLVE_CACHE_LOCK:
        cached = _RESOLVE_CACHE.get(key)
    if not cached or time.monotonic() - cached[0] >= RESOLVE_CACHE_TTL:
        return None
    _, manifest_id, diagnostics = cached
    try:
        manifest = legacy._get_manifest(manifest_id)
    except HTTPException:
        with _RESOLVE_CACHE_LOCK:
            _RESOLVE_CACHE.pop(key, None)
        return None
    payload = manifest.public()
    payload["diagnostics"] = diagnostics
    payload["cached"] = True
    return payload


def _remember_resolve(request: legacy.ResolveRequest, manifest: legacy.Manifest, diagnostics: dict[str, list[str]]) -> None:
    if RESOLVE_CACHE_TTL <= 0:
        return
    with _RESOLVE_CACHE_LOCK:
        _RESOLVE_CACHE[_request_key(request)] = (time.monotonic(), manifest.id, diagnostics)
        stale = [key for key, value in _RESOLVE_CACHE.items() if time.monotonic() - value[0] >= RESOLVE_CACHE_TTL]
        for key in stale:
            _RESOLVE_CACHE.pop(key, None)


def _resolve_one(request: legacy.ResolveRequest, arch: str):
    return legacy._resolve_arch(
        request.package,
        arch,
        request.locales,
        request.versionCode,
        request.deepScan,
        request.forceRefresh,
    )


@app.post("/api/resolve-fast")
def resolve_fast(request: legacy.ResolveRequest) -> dict:
    """Resolve selected architectures concurrently with bounded latency."""
    if not legacy._linked():
        raise HTTPException(
            503,
            "Backend is not linked. Run `docker compose exec backend gplaydl link` once, or set GPLAYDL_API_KEY.",
        )

    cached = _cached_resolve(request)
    if cached is not None:
        return cached

    futures: dict[Future, str] = {
        _EXECUTOR.submit(_resolve_one, request, arch): arch for arch in request.architectures
    }
    timeout = DEEP_SCAN_TIMEOUT if request.deepScan else RESOLVE_TIMEOUT
    done, pending = wait(futures, timeout=timeout)

    all_variants: list[legacy.Variant] = []
    representative: legacy.play_api.AppDetails | None = None
    errors: dict[str, list[str]] = {}
    fatal_http: list[HTTPException] = []

    for future in done:
        arch = futures[future]
        try:
            variants, details, arch_errors = future.result()
            all_variants.extend(variants)
            representative = representative or details
            if arch_errors:
                errors[arch] = arch_errors[-8:]
        except HTTPException as exc:
            fatal_http.append(exc)
            errors[arch] = [str(exc.detail)]
        except Exception as exc:
            errors[arch] = [str(exc)]

    for future in pending:
        arch = futures[future]
        future.cancel()
        errors[arch] = [f"timed out after {timeout}s"]

    if not all_variants:
        if fatal_http and len(fatal_http) == len(done) and not pending:
            raise fatal_http[0]
        hint = "; ".join(f"{arch}: {values[-1]}" for arch, values in errors.items() if values)
        status = 504 if pending else 404
        raise HTTPException(status, f"Google Play returned no downloadable variant. {hint}".strip())

    manifest = legacy.Manifest(
        id=legacy.secrets.token_urlsafe(18),
        package=request.package,
        title=representative.title if representative else request.package,
        developer=representative.developer if representative else "",
        created_at=time.time(),
        variants=all_variants,
    )
    legacy._cleanup_cache()
    with legacy._CACHE_LOCK:
        legacy._CACHE[manifest.id] = manifest

    _remember_resolve(request, manifest, errors)
    payload = manifest.public()
    payload["diagnostics"] = errors
    payload["cached"] = False
    payload["resolver"] = {
        "parallel": len(request.architectures) > 1,
        "workers": min(RESOLVE_WORKERS, len(request.architectures)),
        "timeoutSeconds": timeout,
    }
    return payload

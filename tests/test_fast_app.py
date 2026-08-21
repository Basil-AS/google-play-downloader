from __future__ import annotations

import time

import fast_app


def _reset_state() -> None:
    with fast_app._AUTH_CACHE_LOCK:
        fast_app._AUTH_CACHE.clear()
        fast_app._AUTH_GUARDS.clear()
    with fast_app._RESOLVE_CACHE_LOCK:
        fast_app._RESOLVE_CACHE.clear()
    with fast_app.legacy._CACHE_LOCK:
        fast_app.legacy._CACHE.clear()


def test_email_pinned_auth_is_cached_in_memory(monkeypatch):
    _reset_state()
    monkeypatch.setattr(fast_app.legacy, "ACCOUNT_EMAIL", "spare@example.com")
    calls: list[dict] = []

    def fake_ensure_auth(**kwargs):
        calls.append(kwargs)
        return {"authToken": f"token-{len(calls)}", "deviceInfoProvider": {}}

    monkeypatch.setattr(fast_app.legacy, "ensure_auth", fake_ensure_auth)

    first = fast_app._fast_require_auth("arm64")
    second = fast_app._fast_require_auth("arm64")

    assert first["authToken"] == "token-1"
    assert second["authToken"] == "token-1"
    assert len(calls) == 1
    assert calls[0]["email"] == "spare@example.com"


def test_force_refresh_bypasses_memory_auth_cache(monkeypatch):
    _reset_state()
    monkeypatch.setattr(fast_app.legacy, "ACCOUNT_EMAIL", "spare@example.com")
    calls = 0

    def fake_ensure_auth(**_kwargs):
        nonlocal calls
        calls += 1
        return {"authToken": f"token-{calls}", "deviceInfoProvider": {}}

    monkeypatch.setattr(fast_app.legacy, "ensure_auth", fake_ensure_auth)

    assert fast_app._fast_require_auth("arm64")["authToken"] == "token-1"
    assert fast_app._fast_require_auth("arm64", force_refresh=True)["authToken"] == "token-2"
    assert calls == 2


def test_parallel_resolver_returns_all_architectures_and_reuses_result(monkeypatch):
    _reset_state()
    monkeypatch.setattr(fast_app.legacy, "_linked", lambda: True)
    calls: list[str] = []

    def fake_resolve_one(request, arch):
        calls.append(arch)
        # A small sleep makes it possible for the executor to overlap workers
        # without relying on external Google/dispenser network access.
        time.sleep(0.03)
        details = fast_app.legacy.play_api.AppDetails(
            package=request.package,
            title="Example",
            developer="Example Dev",
            version_string="1.0",
            version_code=100,
        )
        variant = fast_app.legacy.Variant(
            id=f"variant-{arch}",
            arch=arch,
            profile="test",
            device=f"Device {arch}",
            sdk=35,
            density=420,
            abis=arch,
            locales=request.locales,
            version_code=100,
            version_name="1.0",
            files=[],
        )
        return [variant], details, []

    monkeypatch.setattr(fast_app, "_resolve_one", fake_resolve_one)
    request = fast_app.legacy.ResolveRequest(
        package="org.example.app",
        architectures=["arm64", "x86_64", "x86"],
        locales=["en-US"],
    )

    first = fast_app.resolve_fast(request)
    assert {item["arch"] for item in first["variants"]} == {"arm64", "x86_64", "x86"}
    assert first["resolver"]["parallel"] is True
    assert first["cached"] is False
    assert sorted(calls) == ["arm64", "x86", "x86_64"]

    second = fast_app.resolve_fast(request)
    assert second["cached"] is True
    assert sorted(calls) == ["arm64", "x86", "x86_64"]

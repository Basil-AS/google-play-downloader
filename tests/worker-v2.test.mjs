import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/site-worker-v2.js";

test("anonymous auth mode proxies Aurora dispenser with expected client UA", async () => {
  const nativeFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ authToken: "anon-token", gsfId: "abc123" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const request = new Request("https://google-play-downloader.example/api/auth?mode=anonymous", {
      method: "POST",
      headers: {
        Origin: "https://basil-as.github.io",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ "Build.MODEL": "Pixel 9a" })
    });
    const response = await worker.fetch(request, {}, {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://basil-as.github.io");
    assert.equal(response.headers.get("X-Play-Auth-Mode"), "anonymous-dispenser");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://auroraoss.com/api/auth");
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.get("User-Agent"), "com.aurora.store");
    assert.equal(headers.get("Accept"), "application/json");
    assert.deepEqual(await response.json(), { authToken: "anon-token", gsfId: "abc123" });
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("anonymous auth mode rejects foreign browser origins", async () => {
  const request = new Request("https://google-play-downloader.example/api/auth?mode=anonymous", {
    method: "POST",
    headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
    body: "{}"
  });
  const response = await worker.fetch(request, {}, {});
  assert.equal(response.status, 403);
});

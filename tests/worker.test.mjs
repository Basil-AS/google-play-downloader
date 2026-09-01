import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/site-worker.js";

function b64(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

test("Worker forwards only allowed FDFE request", async () => {
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "application/x-protobuf" }
    });
  };
  try {
    const req = new Request(
      "https://google-play-downloader.basil-as.workers.dev/api/fdfe/search?q=firefox&c=3&gl=DE",
      { headers: {
        Origin: "https://basil-as.github.io",
        "X-Play-Headers": b64({
          Authorization: "Bearer test-token",
          "X-DFE-Device-Id": "123",
          "User-Agent": "Android-Finsky/test",
          "X-Not-Allowed": "drop-me"
        })
      } }
    );
    const res = await worker.fetch(req, { ASSETS: { fetch: () => new Response("asset") } });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^https:\/\/android\.clients\.google\.com\/fdfe\/search\?/);
    assert.match(calls[0].url, /gl=DE/);
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.get("Authorization"), "Bearer test-token");
    assert.equal(headers.get("X-DFE-Device-Id"), "123");
    assert.equal(headers.get("User-Agent"), "Android-Finsky/test");
    assert.equal(headers.get("X-Not-Allowed"), null);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("Worker proxies Aurora auth and rejects arbitrary download host", async () => {
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response('{"authToken":"x","gsfId":"1"}', {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const auth = await worker.fetch(new Request("https://worker/api/aurora-auth", {
      method: "POST",
      headers: { Origin: "https://basil-as.github.io", "Content-Type": "application/json" },
      body: "{}"
    }), { ASSETS: { fetch: () => new Response("asset") } });
    assert.equal(auth.status, 200);
    assert.equal(calls[0].url, "https://auroraoss.com/api/auth");

    const blocked = await worker.fetch(new Request(
      "https://worker/api/download?url=https%3A%2F%2Fevil.example%2Ffile.apk",
      { headers: { Origin: "https://basil-as.github.io" } }
    ), { ASSETS: { fetch: () => new Response("asset") } });
    assert.equal(blocked.status, 403);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("Worker streams allowed Google download and preserves Range", async () => {
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(new Uint8Array([7, 8]), {
      status: 206,
      headers: {
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Range": "bytes 0-1/2",
        "Accept-Ranges": "bytes"
      }
    });
  };
  try {
    const target = encodeURIComponent("https://play.googleapis.com/download/base.apk");
    const req = new Request(`https://worker/api/download?url=${target}&name=base.apk`, {
      headers: { Origin: "https://basil-as.github.io", Range: "bytes=0-1" }
    });
    const res = await worker.fetch(req, { ASSETS: { fetch: () => new Response("asset") } });
    assert.equal(res.status, 206);
    assert.equal(new Headers(calls[0].init.headers).get("Range"), "bytes=0-1");
    assert.match(res.headers.get("Content-Disposition"), /base\.apk/);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("Worker retries delivery once after HTTP 429", async () => {
  let calls = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "application/x-protobuf" }
    });
  };
  try {
    const req = new Request(
      "https://worker/api/fdfe/delivery?doc=com.example.app&ot=1&vc=1&gl=US",
      { headers: { Origin: "https://basil-as.github.io", "X-Play-Headers": b64({ Authorization: "Bearer x" }) } }
    );
    const res = await worker.fetch(req, { ASSETS: { fetch: () => new Response("asset") } });
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
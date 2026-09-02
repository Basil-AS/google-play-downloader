const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { TextEncoder, TextDecoder } = require("node:util");

function varint(data, state) {
  let value = 0n, shift = 0n;
  for (let i = 0; i < 10; i++) {
    const byte = BigInt(data[state.pos++]);
    value |= (byte & 0x7fn) << shift;
    if (!(byte & 0x80n)) return Number(value);
    shift += 7n;
  }
  throw new Error("invalid varint");
}

function fields(input) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  const state = { pos: 0 }, out = [];
  while (state.pos < data.length) {
    const key = varint(data, state), field = key >>> 3, wire = key & 7;
    if (wire === 0) out.push([field, wire, varint(data, state)]);
    else if (wire === 2) {
      const length = varint(data, state);
      out.push([field, wire, data.slice(state.pos, state.pos + length)]);
      state.pos += length;
    } else throw new Error(`unexpected wire ${wire}`);
  }
  return out;
}

const bytes = (rows, field) => rows.find(([f, w]) => f === field && w === 2)?.[2];
const integer = (rows, field) => rows.find(([f, w]) => f === field && w === 0)?.[2];
const string = (rows, field) => new TextDecoder().decode(bytes(rows, field) || new Uint8Array());

test("runtime uses acquire -> query purchase -> delivery", async () => {
  const calls = [];
  const baseClient = {
    buildHeaders: () => ({ Authorization: "Bearer test" }),
    relayUrl: target => target,
    details: async packageName => ({
      auth: { authToken: "test", gsfId: "1" },
      app: { package: packageName, versionCode: 2 },
      raw: new Uint8Array()
    }),
    parsePurchase: () => "delivery-token",
    parseDelivery: () => ({
      versionCode: 2,
      base: { name: "base.apk", url: "https://play.googleapis.com/download/base.apk", cookies: [] },
      splits: [],
      additional: []
    }),
    search: async () => []
  };
  const sessionStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
  };
  const window = {
    GooglePlayClient: baseClient,
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(new Uint8Array([1]), { status: 200 });
    }
  };
  class MutationObserver { observe() {} }
  const document = { documentElement: {}, querySelectorAll: () => [] };
  const context = vm.createContext({
    window, document, MutationObserver, sessionStorage,
    TextEncoder, TextDecoder, URL, URLSearchParams, Uint8Array, Response,
    crypto: webcrypto, btoa, console, Math, BigInt
  });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync("js/runtime-fixes.js", "utf8"), context);

  const result = await window.GooglePlayClient.resolve("com.arslan.vkdatingapp1", "arm64", {});
  assert.equal(result.delivery.base.name, "com.arslan.vkdatingapp1-2.apk");
  assert.equal(calls.length, 3);

  assert.equal(calls[0].url, "https://android.clients.google.com/fdfe/acquire");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/x-protobuf");

  const top = fields(calls[0].init.body);
  const pkg = fields(bytes(top, 1));
  const payload = fields(bytes(pkg, 1));
  const version = fields(bytes(top, 12));
  const m30 = fields(bytes(top, 30));

  assert.equal(string(payload, 1), "com.arslan.vkdatingapp1");
  assert.equal(integer(payload, 2), 1);
  assert.equal(integer(payload, 3), 3);
  assert.equal(integer(pkg, 2), 1);
  assert.equal(integer(version, 1), 2);
  assert.equal(integer(version, 3), 0);
  assert.equal(integer(top, 13), 1);
  assert.equal(integer(top, 15), 0);
  assert.match(string(top, 22), /^nonce=[A-Za-z0-9_-]+$/);
  assert.equal(integer(top, 25), 2);
  assert.equal(integer(m30, 1), 2);
  assert.equal(integer(m30, 2), 0);

  const purchase = new URL(calls[1].url);
  assert.equal(purchase.pathname, "/fdfe/purchase");
  assert.equal(purchase.searchParams.get("doc"), "com.arslan.vkdatingapp1");
  assert.equal(purchase.searchParams.get("ot"), "1");
  assert.equal(purchase.searchParams.get("vc"), "2");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.body, undefined);

  const delivery = new URL(calls[2].url);
  assert.equal(delivery.pathname, "/fdfe/delivery");
  assert.equal(delivery.searchParams.get("doc"), "com.arslan.vkdatingapp1");
  assert.equal(delivery.searchParams.get("ot"), "1");
  assert.equal(delivery.searchParams.get("vc"), "2");
  assert.equal(delivery.searchParams.get("dtok"), "delivery-token");
  assert.equal(calls[2].init.method, "GET");
});

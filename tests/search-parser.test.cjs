const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("./play-client-runtime.cjs");

function vi(n) {
  const out = [];
  let x = BigInt(n);
  while (x > 0x7fn) {
    out.push(Number((x & 0x7fn) | 0x80n));
    x >>= 7n;
  }
  out.push(Number(x));
  return Buffer.from(out);
}
function fieldBytes(n, value) {
  const b = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([vi((n << 3) | 2), vi(b.length), b]);
}
function searchItem(pkg, title, developer) {
  const doc = Buffer.concat([
    fieldBytes(1, fieldBytes(1, pkg)),
    fieldBytes(2, fieldBytes(1, fieldBytes(1, title))),
    fieldBytes(3, fieldBytes(14, fieldBytes(1, developer)))
  ]);
  return fieldBytes(11, fieldBytes(2, doc));
}

test("modern Play search parser reads top-level field 11 app cards", () => {
  const raw = Buffer.concat([
    searchItem("com.google.android.apps.photos", "Google Photos", "Google LLC"),
    searchItem("com.instagram.android", "Instagram", "Instagram")
  ]);
  assert.deepEqual(P.parseSearch(raw), [
    { package: "com.google.android.apps.photos", title: "Google Photos", developer: "Google LLC" },
    { package: "com.instagram.android", title: "Instagram", developer: "Instagram" }
  ]);
});

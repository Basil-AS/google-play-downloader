import test from "node:test";
import assert from "node:assert/strict";
import { directGoogleAuth } from "../worker/google-auth.js";

function varint(value) {
  let n = BigInt(value);
  const out = [];
  while (n > 0x7fn) { out.push(Number((n & 0x7fn) | 0x80n)); n >>= 7n; }
  out.push(Number(n));
  return Buffer.from(out);
}

function fieldBytes(number, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint((number << 3) | 2), varint(data.length), data]);
}

function fieldFixed64(number, value) {
  let n = BigInt(value);
  const bytes = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 1) { bytes[i] = Number(n & 0xffn); n >>= 8n; }
  return Buffer.concat([varint((number << 3) | 1), bytes]);
}

const profile = {
  "Build.DEVICE":"tegu","Build.ID":"BD4A.250405.003","Build.FINGERPRINT":"google/tegu/tegu:15/test:user/release-keys",
  "Build.HARDWARE":"tegu","Build.BRAND":"google","Build.RADIO":"radio","Build.BOOTLOADER":"boot","Client":"android-google",
  "Build.MODEL":"Pixel 9a","Build.MANUFACTURER":"Google","Build.PRODUCT":"tegu","Build.VERSION.SDK_INT":"35","Build.VERSION.RELEASE":"15",
  "GSF.version":"251333035","Vending.version":"84582130","Vending.versionString":"45.8.21","Platforms":"arm64-v8a",
  "Screen.Density":"420","Screen.Width":"1080","Screen.Height":"2424","Locales":"en-US","Features":"android.hardware.wifi",
  "SharedLibraries":"android.ext.shared","GL.Extensions":"GL_OES_EGL_image","GL.Version":"196610","TouchScreen":"3","Keyboard":"1","Navigation":"1","ScreenLayout":"2",
  "HasHardKeyboard":"false","HasFiveWayNavigation":"false","Roaming":"mobile-notroaming","CellOperator":"310","SimOperator":"38","TimeZone":"UTC"
};

test("direct Google auth decodes fixed64 androidId from checkin response", async () => {
  const oldFetch = globalThis.fetch;
  const androidId = 0x123456789abcdefn;
  const calls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.endsWith("/checkin")) {
      return new Response(Buffer.concat([fieldFixed64(7, androidId), fieldBytes(12, "consistency-token")]), { status: 200 });
    }
    if (target.endsWith("/fdfe/uploadDeviceConfig")) {
      return new Response(fieldBytes(1, fieldBytes(28, fieldBytes(1, "config-token"))), { status: 200 });
    }
    if (target.endsWith("/auth")) return new Response("Auth=bearer-token\n", { status: 200 });
    if (target.endsWith("/fdfe/toc")) return new Response(fieldBytes(1, fieldBytes(6, fieldBytes(22, "dfe-cookie"))), { status: 200 });
    throw new Error(`Unexpected URL: ${target}`);
  };

  try {
    const auth = await directGoogleAuth(profile, "US", {
      GOOGLE_ACCOUNT_EMAIL: "throwaway@example.com",
      GOOGLE_AAS_TOKEN: "aas_et/test-token"
    });
    assert.equal(auth.gsfId, androidId.toString(16));
    assert.equal(auth.authToken, "bearer-token");
    assert.equal(auth.deviceCheckInConsistencyToken, "consistency-token");
    assert.equal(calls.length, 4);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

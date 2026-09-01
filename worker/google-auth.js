const GOOGLE_ORIGIN = "https://android.clients.google.com";
const DIRECT_AUTH_CACHE_MS = 45 * 60 * 1000;
const COUNTRY_LOCALE = Object.freeze({ RU: "ru_RU", DE: "de_DE", GB: "en_GB", IN: "en_IN", US: "en_US" });
const ENCODED_TARGETS = "CAESN/qigQYC2AMBFfUbyA7SM5Ij/CvfBoIDgxXrBPsDlQUdMfOLAfoFrwEHgAcBrQYhoA0cGt4MKK0Y2gI";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const directAuthCache = new Map();

function concatBytes(...parts) {
  const arrays = parts.flat().filter(Boolean).map(value => value instanceof Uint8Array ? value : new Uint8Array(value));
  const total = arrays.reduce((sum, value) => sum + value.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const value of arrays) { out.set(value, offset); offset += value.length; }
  return out;
}

function varint(value) {
  let n = typeof value === "bigint" ? value : BigInt(value || 0);
  const out = [];
  while (n > 0x7fn) { out.push(Number((n & 0x7fn) | 0x80n)); n >>= 7n; }
  out.push(Number(n));
  return Uint8Array.from(out);
}

function protoVarint(field, value) {
  return concatBytes(varint(BigInt(field) << 3n), varint(value));
}

function protoBytes(field, value) {
  const data = typeof value === "string" ? encoder.encode(value) : (value instanceof Uint8Array ? value : new Uint8Array(value || []));
  return concatBytes(varint((BigInt(field) << 3n) | 2n), varint(data.length), data);
}

function profileBool(profile, key) {
  return String(profile?.[key] || "false").toLowerCase() === "true" ? 1 : 0;
}

function profileInt(profile, key) {
  const value = Number.parseInt(String(profile?.[key] || "0"), 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function deviceConfiguration(profile) {
  const chunks = [];
  for (const [number, key] of [
    [1, "TouchScreen"], [2, "Keyboard"], [3, "Navigation"], [4, "ScreenLayout"],
    [7, "Screen.Density"], [8, "GL.Version"], [12, "Screen.Width"], [13, "Screen.Height"],
    [20, "TotalMemoryBytes"], [21, "MaxNumOfCPUCores"]
  ]) if (profile?.[key]) chunks.push(protoVarint(number, profileInt(profile, key)));
  chunks.push(protoVarint(5, profileBool(profile, "HasHardKeyboard")));
  chunks.push(protoVarint(6, profileBool(profile, "HasFiveWayNavigation")));
  chunks.push(protoVarint(19, profileBool(profile, "LowRamDevice")));
  for (const [number, key] of [[9, "SharedLibraries"], [10, "Features"], [11, "Platforms"], [14, "Locales"], [15, "GL.Extensions"]]) {
    for (const value of String(profile?.[key] || "").split(",").map(v => v.trim()).filter(Boolean)) chunks.push(protoBytes(number, value));
  }
  for (const feature of String(profile?.Features || "").split(",").map(v => v.trim()).filter(Boolean)) {
    chunks.push(protoBytes(26, concatBytes(protoBytes(1, feature), protoVarint(2, 0))));
  }
  chunks.push(protoVarint(16, 0));
  return concatBytes(...chunks);
}

function googleAuthUserAgent(profile) {
  return `GoogleAuth/1.4 (${profile?.["Build.DEVICE"] || ""} ${profile?.["Build.ID"] || ""})`;
}

function finskyUserAgent(profile) {
  const platforms = String(profile?.Platforms || "").replaceAll(",", ";");
  const values = [
    ["api", "3"], ["versionCode", profile?.["Vending.version"] || ""], ["sdk", profile?.["Build.VERSION.SDK_INT"] || ""],
    ["device", profile?.["Build.DEVICE"] || ""], ["hardware", profile?.["Build.HARDWARE"] || ""],
    ["product", profile?.["Build.PRODUCT"] || ""], ["platformVersionRelease", profile?.["Build.VERSION.RELEASE"] || ""],
    ["model", String(profile?.["Build.MODEL"] || "").replaceAll(" ", "%20")], ["buildId", profile?.["Build.ID"] || ""],
    ["isWideScreen", "0"], ["supportedAbis", platforms]
  ];
  return `Android-Finsky/${profile?.["Vending.versionString"] || ""} (${values.map(([k, v]) => `${k}=${v}`).join(",")})`;
}

function checkinRequest(profile, deviceConfig, locale) {
  const build = [];
  for (const [number, key] of [[1,"Build.FINGERPRINT"],[2,"Build.HARDWARE"],[3,"Build.BRAND"],[4,"Build.RADIO"],[5,"Build.BOOTLOADER"],[6,"Client"]]) {
    build.push(protoBytes(number, String(profile?.[key] || "").replaceAll("\\:", ":")));
  }
  build.push(protoVarint(7, Math.floor(Date.now() / 1000)));
  build.push(protoVarint(8, profileInt(profile, "GSF.version")));
  for (const [number, key] of [[9,"Build.DEVICE"],[11,"Build.MODEL"],[12,"Build.MANUFACTURER"],[13,"Build.PRODUCT"]]) build.push(protoBytes(number, profile?.[key] || ""));
  build.push(protoVarint(10, profileInt(profile, "Build.VERSION.SDK_INT")));
  build.push(protoVarint(14, profileBool(profile, "OtaInstalled")));
  const checkin = [protoBytes(1, concatBytes(...build)), protoVarint(2, 0)];
  for (const [number, key] of [[6,"CellOperator"],[7,"SimOperator"],[8,"Roaming"]]) checkin.push(protoBytes(number, profile?.[key] || ""));
  checkin.push(protoVarint(9, 0));
  return concatBytes(
    protoVarint(2, 0), protoBytes(4, concatBytes(...checkin)), protoBytes(6, locale),
    protoBytes(12, profile?.TimeZone || "UTC"), protoVarint(14, 3), protoBytes(18, deviceConfig), protoVarint(20, 0)
  );
}

function readVarint(data, start) {
  let pos = start, shift = 0n, value = 0n;
  for (let i = 0; i < 10; i += 1) {
    if (pos >= data.length) throw new Error("EOF varint");
    const b = BigInt(data[pos++]);
    value |= (b & 0x7fn) << shift;
    if ((b & 0x80n) === 0n) return [value, pos];
    shift += 7n;
  }
  throw new Error("Invalid varint");
}

function readFields(input) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  const fields = [];
  let pos = 0;
  while (pos < data.length) {
    const [key, afterKey] = readVarint(data, pos); pos = afterKey;
    const field = Number(key >> 3n), wire = Number(key & 7n);
    if (wire === 0) {
      const [value, next] = readVarint(data, pos); pos = next; fields.push([field, wire, value]);
    } else if (wire === 1) {
      if (pos + 8 > data.length) throw new Error("EOF fixed64"); fields.push([field, wire, data.slice(pos, pos + 8)]); pos += 8;
    } else if (wire === 2) {
      const [lengthRaw, afterLength] = readVarint(data, pos); pos = afterLength; const length = Number(lengthRaw);
      if (!Number.isSafeInteger(length) || pos + length > data.length) throw new Error("EOF bytes");
      fields.push([field, wire, data.slice(pos, pos + length)]); pos += length;
    } else if (wire === 5) {
      if (pos + 4 > data.length) throw new Error("EOF fixed32"); fields.push([field, wire, data.slice(pos, pos + 4)]); pos += 4;
    } else throw new Error(`Unsupported protobuf wire type ${wire}`);
  }
  return fields;
}

function firstField(data, number, wire = null) {
  return readFields(data).find(([field, wt]) => field === number && (wire === null || wt === wire))?.[2];
}

function responseString(data, ...path) {
  let value = data instanceof Uint8Array ? data : new Uint8Array(data || []);
  for (const number of path) {
    value = firstField(value, number, 2);
    if (!(value instanceof Uint8Array)) throw new Error("Invalid Google auth response");
  }
  return decoder.decode(value);
}

function playHeaders(bundle, profile, country = "") {
  const locale = COUNTRY_LOCALE[country] || (country ? `en_${country}` : "en_US");
  const headers = new Headers({
    "User-Agent": bundle?.deviceInfoProvider?.userAgentString || finskyUserAgent(profile),
    "X-DFE-Device-Id": bundle?.gsfId || "",
    "Accept-Language": locale.replaceAll("_", "-"),
    "X-DFE-Encoded-Targets": ENCODED_TARGETS,
    "X-DFE-Client-Id": "am-android-google",
    "X-DFE-Network-Type": "4",
    "X-DFE-Content-Filters": "",
    "X-Limit-Ad-Tracking-Enabled": "false",
    "X-Ad-Id": "",
    "X-DFE-UserLanguages": locale,
    "X-DFE-Request-Params": "timeoutMs=4000",
    "X-DFE-Cookie": bundle?.dfeCookie || "",
    "X-DFE-No-Prefetch": "true",
    Accept: "application/x-protobuf"
  });
  if (bundle?.authToken) headers.set("Authorization", `Bearer ${bundle.authToken}`);
  if (bundle?.deviceCheckInConsistencyToken) headers.set("X-DFE-Device-Checkin-Consistency-Token", bundle.deviceCheckInConsistencyToken);
  if (bundle?.deviceConfigToken) headers.set("X-DFE-Device-Config-Token", bundle.deviceConfigToken);
  const mccMnc = bundle?.deviceInfoProvider?.mccMnc || profile?.SimOperator || "";
  if (mccMnc) headers.set("X-DFE-MCCMNC", mccMnc);
  return headers;
}

function authCacheKey(profile, country) {
  return [profile?.["Build.FINGERPRINT"] || "", profile?.Platforms || "", profile?.["Screen.Density"] || "", country || ""].join("|");
}

async function directGoogleAuth(profile, country, env) {
  const email = String(env.GOOGLE_ACCOUNT_EMAIL || "").trim();
  const aasToken = String(env.GOOGLE_AAS_TOKEN || "").trim();
  if (!email || !aasToken) throw new Error("Direct Google auth secrets are incomplete");
  if (!aasToken.startsWith("aas_et/")) throw new Error("GOOGLE_AAS_TOKEN must start with aas_et/");

  const cacheKey = authCacheKey(profile, country);
  const cached = directAuthCache.get(cacheKey);
  if (cached?.expiresAt > Date.now() && cached?.data?.authToken) return cached.data;

  const locale = COUNTRY_LOCALE[country] || (country ? `en_${country}` : "en_US");
  const authUserAgent = googleAuthUserAgent(profile);
  const userAgent = finskyUserAgent(profile);
  const deviceConfig = deviceConfiguration(profile);

  const checkin = await fetch(`${GOOGLE_ORIGIN}/checkin`, {
    method: "POST",
    headers: { app: "com.google.android.gms", "Content-Type": "application/x-protobuffer", "User-Agent": authUserAgent },
    body: checkinRequest(profile, deviceConfig, locale)
  });
  if (!checkin.ok) throw new Error(`Google checkin HTTP ${checkin.status}`);
  const checkinBytes = new Uint8Array(await checkin.arrayBuffer());
  const androidIdRaw = firstField(checkinBytes, 7, 0);
  const consistencyToken = responseString(checkinBytes, 12);
  if (typeof androidIdRaw !== "bigint") throw new Error("Google checkin did not return androidId");
  const gsfId = androidIdRaw.toString(16);

  const partial = {
    authToken: "",
    gsfId,
    deviceCheckInConsistencyToken: consistencyToken,
    deviceConfigToken: "",
    dfeCookie: "",
    deviceInfoProvider: { userAgentString: userAgent, mccMnc: profile?.SimOperator || "" }
  };

  const uploadHeaders = playHeaders(partial, profile, country);
  uploadHeaders.delete("Authorization");
  uploadHeaders.set("Content-Type", "application/x-protobuf");
  const upload = await fetch(`${GOOGLE_ORIGIN}/fdfe/uploadDeviceConfig`, {
    method: "POST",
    headers: uploadHeaders,
    body: protoBytes(1, deviceConfig)
  });
  if (!upload.ok) throw new Error(`Google device config HTTP ${upload.status}`);
  const uploadBytes = new Uint8Array(await upload.arrayBuffer());
  const configToken = responseString(uploadBytes, 1, 28, 1);

  const authBody = new URLSearchParams({
    Email: email,
    Token: aasToken,
    service: "oauth2:https://www.googleapis.com/auth/googleplay",
    app: "com.android.vending",
    client_sig: "38918a453d07199354f8b19af05ec6562ced5788",
    callerPkg: "com.google.android.gms",
    callerSig: "38918a453d07199354f8b19af05ec6562ced5788",
    androidId: gsfId,
    google_play_services_version: String(profile?.["GSF.version"] || ""),
    sdk_version: String(profile?.["Build.VERSION.SDK_INT"] || ""),
    device_country: (country || "US").toLowerCase(),
    lang: locale.split("_", 1)[0].toLowerCase(),
    oauth2_foreground: "1",
    token_request_options: "CAA4AVAB",
    check_email: "1",
    system_partition: "1",
    droidguard_results: "null"
  });
  const auth = await fetch(`${GOOGLE_ORIGIN}/auth`, {
    method: "POST",
    headers: { app: "com.google.android.gms", device: gsfId, "User-Agent": authUserAgent, "Content-Type": "application/x-www-form-urlencoded" },
    body: authBody
  });
  const authText = await auth.text();
  const authValues = Object.fromEntries(authText.split(/\r?\n/).filter(line => line.includes("=")).map(line => line.split(/=(.*)/s).slice(0, 2)));
  if (!auth.ok) throw new Error(`Google token exchange HTTP ${auth.status}${authValues.Error ? ` (${authValues.Error})` : ""}`);
  if (!authValues.Auth) throw new Error("Google token exchange returned no bearer token");

  const bundle = { ...partial, authToken: authValues.Auth, deviceConfigToken: configToken };
  try {
    const toc = await fetch(`${GOOGLE_ORIGIN}/fdfe/toc`, { headers: playHeaders(bundle, profile, country) });
    if (toc.ok) {
      const tocBytes = new Uint8Array(await toc.arrayBuffer());
      try { bundle.dfeCookie = responseString(tocBytes, 1, 6, 22); } catch {}
    }
  } catch {}

  directAuthCache.set(cacheKey, { expiresAt: Date.now() + DIRECT_AUTH_CACHE_MS, data: bundle });
  return bundle;
}

export { directGoogleAuth };

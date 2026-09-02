import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/site-worker.js";

function b64(value) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function vi(n) { const a=[]; let x=BigInt(n); while(x>0x7fn){a.push(Number((x&0x7fn)|0x80n));x>>=7n}a.push(Number(x));return Buffer.from(a); }
function fieldVarint(n,v){return Buffer.concat([vi(n<<3),vi(v)]);}
function fieldBytes(n,v){const b=Buffer.isBuffer(v)?v:Buffer.from(v);return Buffer.concat([vi((n<<3)|2),vi(b.length),b]);}
const assets = { fetch: () => new Response("asset") };

const profile = {
  "Build.DEVICE":"tegu","Build.ID":"BD4A.250405.003","Build.FINGERPRINT":"google/tegu/tegu:15/test:user/release-keys",
  "Build.HARDWARE":"tegu","Build.BRAND":"google","Build.RADIO":"radio","Build.BOOTLOADER":"boot","Client":"android-google",
  "Build.MODEL":"Pixel 9a","Build.MANUFACTURER":"Google","Build.PRODUCT":"tegu","Build.VERSION.SDK_INT":"35","Build.VERSION.RELEASE":"15",
  "GSF.version":"251333035","Vending.version":"84582130","Vending.versionString":"45.8.21","Platforms":"arm64-v8a",
  "Screen.Density":"420","Screen.Width":"1080","Screen.Height":"2424","Locales":"en-US","Features":"android.hardware.wifi",
  "SharedLibraries":"android.ext.shared","GL.Extensions":"GL_OES_EGL_image","GL.Version":"196610","TouchScreen":"3","Keyboard":"1","Navigation":"1","ScreenLayout":"2",
  "HasHardKeyboard":"false","HasFiveWayNavigation":"false","Roaming":"mobile-notroaming","CellOperator":"310","SimOperator":"38","TimeZone":"UTC"
};

test("Worker keeps non-search FDFE on android.clients and filters headers", async () => {
  const calls = []; const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return new Response(new Uint8Array([1,2,3]), { status:200, headers:{"Content-Type":"application/x-protobuf"} }); };
  try {
    const req = new Request("https://google-play-downloader.basil-as.workers.dev/api/fdfe/details?doc=org.mozilla.firefox&gl=DE", { headers:{ Origin:"https://basil-as.github.io", "X-Play-Headers":b64({Authorization:"Bearer test-token","X-DFE-Device-Id":"123","User-Agent":"Android-Finsky/test","X-Not-Allowed":"drop-me"}) } });
    const res = await worker.fetch(req,{ASSETS:assets}); assert.equal(res.status,200); assert.equal(calls.length,1); assert.match(calls[0].url,/^https:\/\/android\.clients\.google\.com\/fdfe\/details\?/); assert.match(calls[0].url,/gl=DE/);
    const headers=new Headers(calls[0].init.headers); assert.equal(headers.get("Authorization"),"Bearer test-token"); assert.equal(headers.get("X-DFE-Device-Id"),"123"); assert.equal(headers.get("User-Agent"),"Android-Finsky/test"); assert.equal(headers.get("X-Not-Allowed"),null);
  } finally { globalThis.fetch=oldFetch; }
});

test("Worker uses play-fe search and follows ptkn continuation", async () => {
  const calls=[]; const oldFetch=globalThis.fetch;
  const continuation="searchList?q=firefox&o=0&c=3&ksm=1&sb=5&ps=1&ptkn=abc_DEF-123";
  globalThis.fetch=async(url,init={})=>{
    const u=String(url); calls.push({url:u,init});
    if(u.includes("play-fe.googleapis.com/fdfe/search?")) return new Response(fieldBytes(1,fieldBytes(10,continuation)),{status:200,headers:{"Content-Type":"application/x-protobuf"}});
    if(u.includes("play-fe.googleapis.com/fdfe/searchList?")) return new Response(new Uint8Array([9,8,7]),{status:200,headers:{"Content-Type":"application/x-protobuf"}});
    throw new Error(`Unexpected URL ${u}`);
  };
  try {
    const req=new Request("https://worker/api/fdfe/search?q=firefox&c=3",{headers:{Origin:"https://basil-as.github.io","X-Play-Headers":b64({Authorization:"Bearer x"})}});
    const res=await worker.fetch(req,{ASSETS:assets});
    assert.equal(res.status,200); assert.equal(calls.length,2);
    assert.match(calls[0].url,/^https:\/\/play-fe\.googleapis\.com\/fdfe\/search\?/);
    assert.match(calls[0].url,/sb=5/); assert.match(calls[0].url,/ksm=1/); assert.match(calls[0].url,/ps=1/); assert.match(calls[0].url,/nocache_pwr=true/);
    assert.match(calls[1].url,/^https:\/\/play-fe\.googleapis\.com\/fdfe\/searchList\?/); assert.match(calls[1].url,/ptkn=abc_DEF-123/);
    assert.equal(res.headers.get("X-Play-Search-Flow"),"play-fe-ptkn");
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())],[9,8,7]);
  } finally {globalThis.fetch=oldFetch;}
});

test("Worker falls back to android.clients searchList when Play continuation fails", async () => {
  const calls=[]; const oldFetch=globalThis.fetch;
  const first=fieldBytes(1,fieldBytes(10,"searchList?q=mail&o=0&c=3&ksm=1&sb=5&ptkn=bad-token"));
  globalThis.fetch=async(url,init={})=>{
    const u=String(url); calls.push({url:u,init});
    if(u.includes("play-fe.googleapis.com/fdfe/search?")) return new Response(first,{status:200,headers:{"Content-Type":"application/x-protobuf"}});
    if(u.includes("play-fe.googleapis.com/fdfe/searchList?")) return new Response("DF-DFERH-01",{status:400});
    if(u.includes("android.clients.google.com/fdfe/searchList?")) return new Response(new Uint8Array([4,5,6]),{status:200,headers:{"Content-Type":"application/x-protobuf"}});
    throw new Error(`Unexpected URL ${u}`);
  };
  try {
    const req=new Request("https://worker/api/fdfe/search?q=mail&c=3",{headers:{Origin:"https://basil-as.github.io","X-Play-Headers":b64({Authorization:"Bearer x"})}});
    const res=await worker.fetch(req,{ASSETS:assets});
    assert.equal(res.status,200); assert.equal(calls.length,3); assert.equal(res.headers.get("X-Play-Search-Flow"),"android-searchList-fallback");
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())],[4,5,6]);
  } finally {globalThis.fetch=oldFetch;}
});

test("Worker falls back to android.clients searchList when play-fe search itself fails", async () => {
  const calls=[]; const oldFetch=globalThis.fetch;
  globalThis.fetch=async(url,init={})=>{
    const u=String(url); calls.push({url:u,init});
    if(u.includes("play-fe.googleapis.com/fdfe/search?")) return new Response("blocked",{status:403});
    if(u.includes("android.clients.google.com/fdfe/searchList?")) return new Response(new Uint8Array([7,7,7]),{status:200,headers:{"Content-Type":"application/x-protobuf"}});
    throw new Error(`Unexpected URL ${u}`);
  };
  try {
    const req=new Request("https://worker/api/fdfe/search?q=spotify&c=3",{headers:{Origin:"https://basil-as.github.io","X-Play-Headers":b64({Authorization:"Bearer x"})}});
    const res=await worker.fetch(req,{ASSETS:assets});
    assert.equal(res.status,200); assert.equal(calls.length,2); assert.equal(res.headers.get("X-Play-Search-Flow"),"android-searchList-fallback");
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())],[7,7,7]);
  } finally {globalThis.fetch=oldFetch;}
});

test("Worker reports auth backend state and does not use AuroraOSS implicitly", async () => {
  const oldFetch=globalThis.fetch; let calls=0; globalThis.fetch=async()=>{calls+=1;return new Response("unexpected")};
  try {
    const health=await worker.fetch(new Request("https://worker/api/health",{headers:{Origin:"https://basil-as.github.io"}}),{ASSETS:assets});
    assert.equal(health.status,200); assert.equal((await health.json()).authMode,"unconfigured");
    const auth=await worker.fetch(new Request("https://worker/api/auth",{method:"POST",headers:{Origin:"https://basil-as.github.io","Content-Type":"application/json"},body:"{}"}),{ASSETS:assets});
    assert.equal(auth.status,503); assert.equal((await auth.json()).code,"AUTH_NOT_CONFIGURED"); assert.equal(calls,0);
  } finally { globalThis.fetch=oldFetch; }
});

test("Worker supports explicitly configured custom dispenser", async () => {
  const calls=[]; const oldFetch=globalThis.fetch;
  globalThis.fetch=async(url,init={})=>{calls.push({url:String(url),init});return new Response('{"authToken":"x","gsfId":"1"}',{status:200,headers:{"Content-Type":"application/json"}})};
  try {
    const auth=await worker.fetch(new Request("https://worker/api/auth",{method:"POST",headers:{Origin:"https://basil-as.github.io","Content-Type":"application/json"},body:"{}"}),{ASSETS:assets,PLAY_DISPENSER_URL:"https://tokens.example/api/auth"});
    assert.equal(auth.status,200); assert.equal(calls[0].url,"https://tokens.example/api/auth");
  } finally {globalThis.fetch=oldFetch;}
});

test("Worker can create Play auth bundle directly from configured Google AAS secrets", async () => {
  const calls=[]; const oldFetch=globalThis.fetch;
  globalThis.fetch=async(url,init={})=>{
    const u=String(url); calls.push({url:u,init});
    if(u.endsWith("/checkin")) return new Response(Buffer.concat([fieldVarint(7,0x1234),fieldBytes(12,"consistency-token")]),{status:200});
    if(u.endsWith("/fdfe/uploadDeviceConfig")) return new Response(fieldBytes(1,fieldBytes(28,fieldBytes(1,"config-token"))),{status:200});
    if(u.endsWith("/auth")) return new Response("Auth=bearer-token\n",{status:200});
    if(u.endsWith("/fdfe/toc")) return new Response(fieldBytes(1,fieldBytes(6,fieldBytes(22,"dfe-cookie"))),{status:200});
    throw new Error(`Unexpected URL ${u}`);
  };
  try {
    const req=new Request("https://worker/api/auth",{method:"POST",headers:{Origin:"https://basil-as.github.io","Content-Type":"application/json","X-Play-Country":"US"},body:JSON.stringify(profile)});
    const res=await worker.fetch(req,{ASSETS:assets,GOOGLE_ACCOUNT_EMAIL:"throwaway@example.com",GOOGLE_AAS_TOKEN:"aas_et/test-token"});
    assert.equal(res.status,200); const data=await res.json(); assert.equal(data.authToken,"bearer-token"); assert.equal(data.gsfId,"1234"); assert.equal(data.deviceConfigToken,"config-token"); assert.equal(data.dfeCookie,"dfe-cookie"); assert.equal(calls.length,4);
  } finally {globalThis.fetch=oldFetch;}
});

test("Worker rejects arbitrary download host", async () => {
  const oldFetch=globalThis.fetch; let calls=0; globalThis.fetch=async()=>{calls+=1;return new Response("unexpected")};
  try {
    const blocked=await worker.fetch(new Request("https://worker/api/download?url=https%3A%2F%2Fevil.example%2Ffile.apk",{headers:{Origin:"https://basil-as.github.io"}}),{ASSETS:assets});
    assert.equal(blocked.status,403); assert.equal(calls,0);
  } finally {globalThis.fetch=oldFetch;}
});

test("Worker streams allowed Google download and preserves Range", async () => {
  const calls=[]; const oldFetch=globalThis.fetch;
  globalThis.fetch=async(url,init={})=>{calls.push({url:String(url),init});return new Response(new Uint8Array([7,8]),{status:206,headers:{"Content-Type":"application/vnd.android.package-archive","Content-Range":"bytes 0-1/2","Accept-Ranges":"bytes"}})};
  try {
    const target=encodeURIComponent("https://play.googleapis.com/download/base.apk"); const req=new Request(`https://worker/api/download?url=${target}&name=base.apk`,{headers:{Origin:"https://basil-as.github.io",Range:"bytes=0-1"}}); const res=await worker.fetch(req,{ASSETS:assets}); assert.equal(res.status,206); assert.equal(new Headers(calls[0].init.headers).get("Range"),"bytes=0-1"); assert.match(res.headers.get("Content-Disposition"),/base\.apk/);
  } finally {globalThis.fetch=oldFetch;}
});

test("Worker retries delivery once after HTTP 429", async () => {
  let calls=0; const oldFetch=globalThis.fetch;
  globalThis.fetch=async()=>{calls+=1;if(calls===1)return new Response("rate limited",{status:429,headers:{"Retry-After":"0"}});return new Response(new Uint8Array([1,2,3]),{status:200,headers:{"Content-Type":"application/x-protobuf"}})};
  try {
    const req=new Request("https://worker/api/fdfe/delivery?doc=com.example.app&ot=1&vc=1&gl=US",{headers:{Origin:"https://basil-as.github.io","X-Play-Headers":b64({Authorization:"Bearer x"})}}); const res=await worker.fetch(req,{ASSETS:assets}); assert.equal(res.status,200); assert.equal(calls,2);
  } finally {globalThis.fetch=oldFetch;}
});

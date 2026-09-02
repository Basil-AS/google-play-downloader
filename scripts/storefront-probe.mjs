import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../tests/play-client-runtime.cjs");
const WORKER = process.env.WORKER_ORIGIN || "https://google-play-downloader.basil-as.workers.dev";
const PACKAGE = process.env.PACKAGE || "com.arslan.vkdatingapp1";
const source = fs.readFileSync(new URL("../js/runtime-fixes.js", import.meta.url), "utf8");
const DFE_TARGETS = source.match(/const DFE_TARGETS = "([^"]+)";/)?.[1] || "";
const DFE_PHENOTYPE = source.match(/const DFE_PHENOTYPE = "([^"]+)";/)?.[1] || "";
const MCC = { PK:"41001", US:"31038", DE:"26201", GB:"23430", IN:"40420", SE:"24001", RU:"25001" };
assert.ok(DFE_TARGETS.length > 500);
assert.match(DFE_PHENOTYPE, /^H4sI/);

const b64 = value => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const decoder = new TextDecoder();
function fields(raw) { return new P.ProtoDecoder(raw).readAll(); }
function bytes(rows, n) { return rows.find(([f,w,v]) => f===n && w===2 && v instanceof Uint8Array)?.[2] || null; }
function integer(rows, n) { const row=rows.find(([f,w]) => f===n && w===0); return row ? Number(row[2]) : 0; }
function string(rows, n) { const value=bytes(rows,n); return value ? decoder.decode(value) : ""; }
function nav(raw, ...path) { let value=raw; for (const n of path) { value=bytes(fields(value),n); if (!value) return []; } return fields(value); }
function meta(raw) {
  const doc=nav(raw,1,2,4), ob=bytes(doc,8), ab=bytes(doc,9);
  const offer=ob?fields(ob):[], availability=ab?fields(ab):[];
  return { offerType:integer(offer,8)||integer(availability,6)||1, currency:string(offer,2), restriction:integer(availability,5) };
}
function profile(country) {
  const p={...P.profileFor("arm64")};
  if (country && MCC[country]) { p.CellOperator=MCC[country]; p.SimOperator=MCC[country]; }
  p.Locales=country==="RU"?"ru-RU,en-US":"en-US,ru-RU";
  return p;
}
async function anonymous(country) {
  const headers={"Content-Type":"application/json"};
  if(country) headers["X-Play-Country"]=country;
  const response=await fetch(`${WORKER}/api/auth?mode=anonymous`,{method:"POST",headers,body:JSON.stringify(profile(country))});
  const text=await response.text();
  if(!response.ok) throw new Error(`auth ${country||"AUTO"} HTTP ${response.status}: ${text.slice(0,160)}`);
  const auth=JSON.parse(text); assert.ok(auth.authToken&&auth.gsfId); return auth;
}
function headers(auth,country) {
  const h={...P.buildHeaders(auth,country),"X-DFE-Encoded-Targets":DFE_TARGETS,"X-DFE-Phenotype":DFE_PHENOTYPE};
  if(country&&MCC[country]) h["X-DFE-MCCMNC"]=MCC[country];
  return h;
}
async function fdfe(auth,path,country) {
  const url=new URL(`${WORKER}/api/fdfe${path}`);
  if(country) url.searchParams.set("gl",country);
  const response=await fetch(url,{headers:{"X-Play-Headers":b64(headers(auth,country))}});
  return {status:response.status,raw:new Uint8Array(await response.arrayBuffer())};
}

const rows=[];
for (const country of ["","PK","US","DE","GB","IN","SE","RU"]) {
  try {
    const account=await anonymous(country);
    const details=await fdfe(account,`/details?doc=${encodeURIComponent(PACKAGE)}`,country);
    if(details.status!==200) throw new Error(`details HTTP ${details.status}`);
    const app=P.parseDetails(details.raw), m=meta(details.raw);
    const q=new URLSearchParams({doc:PACKAGE,ot:String(m.offerType),vc:String(app.versionCode)});
    const delivery=await fdfe(account,`/delivery?${q}`,country);
    const parsed=delivery.status===200?P.parseDelivery(delivery.raw):null;
    const row={country:country||"AUTO",restriction:m.restriction,currency:m.currency,versionCode:app.versionCode,accountMccMnc:account?.deviceInfoProvider?.mccMnc||"",directDelivery:Boolean(parsed?.base?.url)};
    rows.push(row); console.log(JSON.stringify(row));
  } catch(error) {
    const row={country:country||"AUTO",error:error?.message||String(error)}; rows.push(row); console.log(JSON.stringify(row));
  }
}
assert.equal(rows.length,8);
console.log("SUMMARY "+rows.map(r=>`${r.country}:${r.restriction??"ERR"}/${r.currency||"-"}/${r.directDelivery?"URL":"NOURL"}`).join(" "));

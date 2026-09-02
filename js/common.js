import "./runtime-fixes.js?v=20260902-1";

export const P = window.GooglePlayClient;
export const transport = window.PlayTransport;

export const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
export const PACKAGE_PREFIX_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+\.$/;
export const PACKAGE_LIKE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]*)+$/;

export const state = { query:"", app:null, resolved:[], searchController:null, suggestionController:null, resolveController:null, searchCache:new Map(), startedAt:0, timer:null, progressDepth:0 };
export const $ = selector => document.querySelector(selector);
export const dom = { searchInput:$("#searchInput"), clearSearch:$("#clearSearch"), suggestions:$("#searchSuggestions"), results:$("#searchResults"), apiStatus:$("#apiStatus"), progressCard:$("#progressCard"), progressText:$("#progressText"), progressTime:$("#progressTime"), appCard:$("#appCard"), appTitle:$("#appTitle"), appPackage:$("#appPackage"), appMeta:$("#appMeta"), openPlay:$("#openPlay"), variantsCard:$("#variantsCard"), variants:$("#variants"), diagnostics:$("#diagnostics"), diagnosticsBlock:$("#diagnosticsBlock"), variantCount:$("#variantCount") };
export function escapeHtml(value=""){return String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}
export function formatBytes(bytes){const value=Number(bytes);if(!Number.isFinite(value)||value<=0)return"—";const units=["Б","КБ","МБ","ГБ"];const index=Math.min(Math.floor(Math.log(value)/Math.log(1024)),units.length-1);return`${(value/1024**index).toFixed(index>1?1:0)} ${units[index]}`}
export function normalize(value){return String(value||"").normalize("NFKC").toLocaleLowerCase("ru-RU").trim()}
export function extractPackage(input){return P?.extractPackage?.(input)||""}
export function searchTokens(value){return normalize(value).split(/[^\p{L}\p{N}._-]+/u).filter(token=>token.length>=2)}
export function fileRows(result){const base=result?.delivery?.base?.url?[{...result.delivery.base,name:result.delivery.base.name||`${result.app.package}-${result.delivery.versionCode}.apk`,kind:"BASE"}]:[];const splits=(result?.delivery?.splits||[]).map((item,index)=>({...item,name:item.name?.endsWith(".apk")?item.name:`${result.app.package}-${result.delivery.versionCode}-${item.name||`split${index}`}.apk`,kind:"SPLIT"}));const additional=(result?.delivery?.additional||[]).map((item,index)=>{const kind=String(item.kind||"EXTRA").toUpperCase();const obb=kind.includes("OBB");return{...item,name:item.name||`${result.app.package}-${result.delivery.versionCode}-${String(item.kind||`extra${index}`).replaceAll("/","-")}${obb?".obb":".apk"}`,kind}});return[...base,...splits,...additional]}
export function selectedArchitectures(){return[...document.querySelectorAll('input[name="arch"]:checked')].map(node=>node.value)}
export function settings(){return{country:($("#country")?.value||"").trim().toUpperCase(),locale:$("#locale")?.value||"ru-RU",density:$("#density")?.value||"",fresh:Boolean($("#freshAuth")?.checked)}}
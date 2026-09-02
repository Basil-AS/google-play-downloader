import "./runtime-fixes.js?v=20260902-3";
import { $,dom,state,PACKAGE_RE,PACKAGE_PREFIX_RE,PACKAGE_LIKE_RE,transport } from "./common.js?v=20260902-9";
import { setStatus,emptyState } from "./render.js?v=20260902-10";
import { searchApps,updateSuggestions,selectPackage,resolveSelected,makeApks,resetApp } from "./actions.js?v=20260902-9";

const SEARCH_CACHE_MARKER = "gpd:search:transport-version-v2";
function invalidateStaleSearchCache(){
  try{
    const version=String(transport?.version||"unknown");
    if(sessionStorage.getItem(SEARCH_CACHE_MARKER)===version)return;
    for(const key of Object.keys(sessionStorage))if(key.startsWith("gpd:search:"))sessionStorage.removeItem(key);
    sessionStorage.setItem(SEARCH_CACHE_MARKER,version);
    state.searchCache.clear();
  }catch{}
}

let searchTimer,suggestionTimer;
function transportLabel(mode){return({"cloudflare-workers":"Cloudflare Workers","github-pages-via-cloudflare":"GitHub Pages + Cloudflare","local-via-cloudflare":"Local + Cloudflare","external-cloudflare":"Cloudflare backend"})[mode]||mode||"API"}
async function resetStatus(){
  if(!transport?.isConfigured?.()){setStatus("Нужен API-прокси","error");return}
  setStatus(`Проверяю ${transportLabel(transport.getMode?.())}…`,"loading");
  const health=await transport.health?.();
  if(!health?.ok){setStatus("Cloudflare Worker недоступен","error");return}
  if(health.authMode==="unconfigured"){setStatus("Worker подключён · Google Play auth не настроен","error");return}
  const authLabel=health.authMode==="direct-google"?"direct Google auth":health.authMode==="custom-dispenser"?"custom dispenser":health.authMode;
  setStatus(`API подключён · ${authLabel}`,"ok");
}
function closeSuggestions({abort=true}={}){clearTimeout(suggestionTimer);if(abort){state.suggestionController?.abort();state.suggestionController=null}dom.suggestions.hidden=true}
function scheduleSuggestions(query,delay=220){clearTimeout(suggestionTimer);if(query.length<2||PACKAGE_LIKE_RE.test(query)){closeSuggestions();return}suggestionTimer=setTimeout(()=>{if(dom.searchInput.value.trim()!==query||document.activeElement!==dom.searchInput)return;updateSuggestions(query)},delay)}
function scheduleSearch(query,delay=600){clearTimeout(searchTimer);if(query.length<2)return;searchTimer=setTimeout(()=>{if(dom.searchInput.value.trim()===query)searchApps(query)},delay)}
function closeHelpTips(except=null){document.querySelectorAll('.help-tip[aria-expanded="true"]').forEach(button=>{if(button!==except)button.setAttribute("aria-expanded","false")})}
function setupHelpTips(){document.querySelectorAll(".help-tip").forEach(button=>{button.setAttribute("aria-expanded","false");button.addEventListener("click",event=>{event.preventDefault();event.stopPropagation();const open=button.getAttribute("aria-expanded")==="true";closeHelpTips(button);button.setAttribute("aria-expanded",open?"false":"true")})})}

dom.searchInput.addEventListener("input",()=>{const query=dom.searchInput.value.trim();dom.clearSearch.classList.toggle("hidden",!query);clearTimeout(searchTimer);clearTimeout(suggestionTimer);state.searchController?.abort();if(!query){state.query="";closeSuggestions();resetApp();emptyState("Введите название приложения","Можно искать по названию, полному package name, ссылке Google Play или package prefix с точкой на конце.");resetStatus();return}scheduleSuggestions(query);const fast=PACKAGE_RE.test(query)||PACKAGE_PREFIX_RE.test(query)||/^https:\/\/play\.google\.com\//i.test(query);scheduleSearch(query,fast?350:600)});
dom.searchInput.addEventListener("focus",()=>{const query=dom.searchInput.value.trim();if(query.length>=2&&!PACKAGE_LIKE_RE.test(query))scheduleSuggestions(query,100)});
dom.searchInput.addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();clearTimeout(searchTimer);closeSuggestions();if(dom.searchInput.value.trim().length>=2)searchApps(dom.searchInput.value)}else if(event.key==="Escape"){closeSuggestions();dom.searchInput.blur()}});
dom.clearSearch.addEventListener("click",()=>{dom.searchInput.value="";dom.searchInput.dispatchEvent(new Event("input"));dom.searchInput.focus()});
dom.suggestions.addEventListener("click",event=>{const button=event.target.closest("[data-suggestion-package]");if(!button)return;const pkg=button.dataset.suggestionPackage;dom.searchInput.value=pkg;dom.clearSearch.classList.remove("hidden");clearTimeout(searchTimer);closeSuggestions();selectPackage(pkg).catch(error=>setStatus(error?.message||"Google Play error","error"))});

document.addEventListener("click",async event=>{if(!event.target.closest(".help-tip"))closeHelpTips();if(!event.target.closest(".search-control"))closeSuggestions();const example=event.target.closest("[data-example]");if(example){dom.searchInput.value=example.dataset.example;dom.searchInput.dispatchEvent(new Event("input"));dom.searchInput.focus();return}const action=event.target.closest("[data-action]");if(!action)return;try{if(action.dataset.action==="retry-search"){searchApps(state.query);return}if(action.dataset.action==="copy-package"){const packageName=action.closest(".app-card")?.dataset.package||action.textContent.trim();try{await navigator.clipboard.writeText(packageName);const old=action.textContent;action.textContent="Скопировано";setTimeout(()=>{action.textContent=old},900)}catch{window.prompt("Скопируйте package name:",packageName)}return}if(action.dataset.action==="select-app"){const packageName=action.closest(".app-card")?.dataset.package;if(packageName)await selectPackage(packageName);return}if(action.dataset.action==="apks")await makeApks(action.dataset.arch,action)}catch(error){console.error(error);setStatus(error?.message||"Google Play error","error")}});
$("#resolveButton").addEventListener("click",()=>resolveSelected().catch(error=>{console.error(error);setStatus(error?.message||"Delivery error","error")}));
$("#selectAllArch").addEventListener("click",()=>document.querySelectorAll('input[name="arch"]').forEach(node=>{node.checked=true}));
$("#onlyArm64").addEventListener("click",()=>document.querySelectorAll('input[name="arch"]').forEach(node=>{node.checked=node.value==="arm64"}));
$("#resetApp").addEventListener("click",()=>{resetApp();dom.searchInput.focus()});
document.addEventListener("keydown",event=>{if(event.key==="Escape"){closeSuggestions();closeHelpTips()}});
invalidateStaleSearchCache();
setupHelpTips();
resetStatus();
const packageFromUrl=new URLSearchParams(location.search).get("package");
if(packageFromUrl){dom.searchInput.value=packageFromUrl;dom.clearSearch.classList.remove("hidden");searchApps(packageFromUrl)}else emptyState("Введите название приложения","Поиск работает через Google Play FDFE. Полный package name или ссылка Play ищутся точно.");

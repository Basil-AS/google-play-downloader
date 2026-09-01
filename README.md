# Google Play APK Downloader

Неофициальный open-source веб-инструмент для поиска приложений в **Google Play** и получения тех файлов, которые Google Play delivery отдаёт выбранному Android device profile: `base.apk`, split APK, OBB/дополнительные файлы и локально собранный `.apks`.

**Основной frontend:** https://basil-as.github.io/google-play-downloader/

## Архитектура

Проект приведён к той же схеме, что и `Basil-AS/rustore-downloader`:

```text
GitHub Pages
    ↓
browser UI
    ↓
google-play-downloader.basil-as.workers.dev
    ├─ /api/aurora-auth → Aurora anonymous dispenser
    ├─ /api/fdfe/*      → android.clients.google.com/fdfe
    └─ /api/download    → Google delivery CDN
```

Cloudflare Worker не является APK-зеркалом: файлы не сохраняются на проекте. Он нужен как server-side transport к приватному Android FDFE API и для передачи временных download cookies, которые обычный GitHub Pages JavaScript не может надёжно отправлять напрямую.

## Возможности

- поиск по названию через Google Play FDFE;
- debounce + `AbortController`;
- dropdown-подсказки;
- двухминутный search cache: подсказки и основная выдача переиспользуют один FDFE search;
- локальное ранжирование и отсечение нерелевантного мусора;
- максимум 8 релевантных карточек в обычной выдаче;
- полный package name и Google Play URL ищутся точно;
- package prefix с точкой на конце (`com.google.`) жёстко фильтрует package ID из результатов Google Play search;
- ARM64, ARMv7, x86_64, x86 и Android TV;
- country/region, locale и density override;
- anonymous auth через Aurora dispenser и 45-минутный browser auth cache;
- retry со свежим token при типичной auth/token ошибке;
- `details → purchase → delivery`;
- base APK, split APK, OBB и дополнительные delivery-файлы;
- скачивание файлов отдельно и локальная сборка SAI-compatible `.apks`;
- HTTP Range для больших Google CDN downloads через Worker.

> В отличие от RuStore, приватный Play search не предоставляет надёжный публичный способ перечислить **все** приложения по package-prefix. Поэтому prefix-режим здесь строгий по `startsWith`, но ограничен кандидатами, которые вернула поисковая выдача Google Play.

## Cloudflare Worker

Создай Worker из GitHub-репозитория и укажи:

```text
Repository: Basil-AS/google-play-downloader
Production branch: master
Build command: npm run build
Deploy command: npx wrangler deploy
Root directory: /
```

`Protect with Cloudflare Access` не включай.

Ожидаемый production URL:

```text
https://google-play-downloader.basil-as.workers.dev
```

Он уже прописан backend-адресом для GitHub Pages в `api-patch.js`. Если выберешь другое имя Worker/subdomain, измени `WORKER_ORIGIN`.

`wrangler.jsonc` разворачивает одновременно `dist/` как Static Assets и `worker/site-worker.js` как API backend. После deploy работают и GitHub Pages, и Worker URL.

## Безопасность Worker

Worker не является универсальным proxy. FDFE разрешены только `/fdfe/search`, `/fdfe/details`, `/fdfe/purchase`, `/fdfe/delivery`. Download proxy принимает только HTTPS URL на разрешённых Google-hosts. CORS внешнего frontend разрешён только для `https://basil-as.github.io` и localhost dev origins.

## Протокольный слой и параллельная поддержка с RuStore

`js/play-client.js` сохраняет существующую Google Play FDFE/protobuf реализацию: device profiles, Aurora auth bundle, FDFE headers, protobuf decoder, details, purchase и delivery parsers.

`api-patch.js` — transport adapter. Он переводит старый relay contract протокольного слоя на собственный constrained Cloudflare Worker. Благодаря этому store-specific FDFE/parser можно обновлять независимо от общего frontend/Worker-кода.

Общие слои с `rustore-downloader` теперь одинаковые по назначению:

```text
index.html
css/base.css + css/components.css
js/common.js + render.js + actions.js + main.js
api-patch.js
worker/site-worker.js
scripts/build.mjs
wrangler.jsonc
CI
```

## Почему не universal APK

App Bundle обычно доставляется набором подписанных APK (`base.apk`, ABI/density/language splits). Пересборка их в один APK потребовала бы новой подписи. Проект сохраняет оригинальные артефакты и предлагает `.apks`.

## Ограничения

- Google Play FDFE — приватный reverse-engineered Android API и может измениться без уведомления.
- Aurora anonymous dispenser может быть недоступен или rate-limit'ить.
- Anonymous accounts могут видеть другой регион/staged rollout и не иметь права на конкретный продукт.
- Paid apps не гарантируются.
- Package-prefix поиск не является полным перечислением каталога.
- Большой `.apks` собирается в памяти браузера; для крупных приложений лучше скачивать файлы отдельно.

## Разработка

```bash
npm install
npm run build
npm test
```

Live external smoke оставлен только ручным, чтобы downtime Aurora/Google не делал обычный CI красным.

Проект не использует APKCombo, APKPure, APKMirror и другие APK-зеркала. Google Play flow ориентирован на open-source практики Aurora Store / Aurora GPlayApi и `goopdl`: anonymous authentication, device profiles, purchase/delivery, base/split APK, OBB и дополнительные delivery assets.

См. [`LICENSE`](LICENSE), [`NOTICE`](NOTICE) и [`CONTRIBUTORS.md`](CONTRIBUTORS.md).

Google Play является товарным знаком Google LLC. Aurora Store/Aurora Dispenser — независимые проекты. Репозиторий не связан и не аффилирован с Google или Aurora OSS.

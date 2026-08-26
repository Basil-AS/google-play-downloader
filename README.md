# Google Play APK Downloader

A browser-only downloader for **Google Play itself**, designed to run from GitHub Pages.

**No VPS. No project backend. No Docker. No browser extension. No personal Google account.** Open the page, search Google Play, select one or more device/ABI profiles and request the files that Google Play delivers to those profiles.

Live site: https://basil-as.github.io/google-play-downloader/

## Architecture

```text
GitHub Pages
    ↓
Browser JavaScript
    ↓
Aurora anonymous auth dispenser
    ↓
public CORS relay (transport only)
    ↓
android.clients.google.com/fdfe
    search / details / purchase / delivery
    ↓
Google Play CDN
    ↓
base APK + split APK + OBB / asset files
```

The APK source is Google Play. **APKCombo, APKPure, APKMirror and other APK mirrors/catalogues are not used.** The public relay only allows an ordinary browser origin to send the headers required by Google's Android FDFE API and, when necessary, forwards Google download cookies to the Google CDN.

The protocol implementation is based on the current open-source Aurora/goopdl Google Play flow: a short-lived anonymous auth bundle contains `authToken`, `gsfId`, device/check-in tokens and device metadata; the browser then performs `details → purchase → delivery` against Google FDFE and decodes the protobuf responses locally.

## Features

- search through Google Play FDFE;
- exact package ID, e.g. `org.mozilla.firefox`;
- Google Play URL input (`?id=` is extracted automatically);
- direct `details`, `purchase` and `delivery` calls to Google;
- ARM64, ARMv7, x86_64, x86 and Android TV profiles;
- base APK and split APK enumeration from Google's delivery protobuf;
- OBB / additional delivery files when Google exposes them;
- Google-provided versionCode, sizes and hashes where available;
- direct download of delivered files through the browser;
- local SAI-compatible `.apks` packaging with JSZip;
- 45-minute browser cache for anonymous Play auth to avoid repeatedly hitting the dispenser;
- hard request timeouts so a broken external dependency cannot leave the UI spinning forever.

## Anonymous authentication

The page does not ask for your Google credentials. It requests a temporary anonymous Google Play auth bundle from Aurora's public dispenser at `https://auroraoss.com/api/auth` using an Android device profile. The bundle is cached locally in the browser for up to 45 minutes.

The dispenser is an external public service and can rate-limit or become unavailable. If it cannot issue an anonymous account, direct Google Play delivery cannot start; the UI reports the error instead of silently hanging.

## CORS relay

Google FDFE is not a browser-facing web API and does not provide the CORS policy needed by a GitHub Pages origin. Therefore requests are transported through a public CORS relay. The relay is **not the application source** and is not a project backend: the target remains `android.clients.google.com/fdfe`, and delivery URLs are accepted only when they belong to known Google domains.

The current default relay is `corsproxy.io`, the same practical browser transport pattern used by the companion RuStore downloader. Availability therefore depends on the relay allowing the required request headers and binary responses.

## Limits

- This is an unofficial implementation of Google's private Android FDFE protocol; Google can change it without notice.
- Anonymous accounts can have regional, device, staged-rollout or acquisition restrictions.
- Paid apps and apps unavailable to the anonymous account are not guaranteed to work.
- Selecting several architectures performs separate device-profile deliveries because Google can return different split sets for each profile.
- Google Play does not provide a complete public archive of every historic version. An old version can only be obtained while Google still delivers that version to a compatible profile/account.
- Large browser-side `.apks` generation can consume substantial RAM; direct file download is preferable for very large packages.

## Development

There is no backend setup. Serve the repository as static files:

```bash
python -m http.server 8000
```

### Tests

```bash
node --check assets/play-client.js
node --check assets/app.js
node --test tests/play-client.test.cjs
```

The unit tests construct synthetic protobuf messages and verify package parsing, architecture profiles, protobuf decoding, FDFE details fields, purchase tokens and delivery base/split extraction.

## CI / CD

GitHub Actions validates JavaScript syntax, protobuf unit tests, the direct-Google origin contract, absence of mirror-provider code and absence of the old FastAPI/Docker architecture. GitHub Pages deploys the static `master` branch.

## Privacy

This project operates no application server and keeps no project-side user database. Temporary anonymous auth data is cached in the user's browser. Network requests are still visible to GitHub Pages, the Aurora dispenser, the selected CORS relay and Google, which apply their own logging/privacy policies.

## Contributors

- **Basil-AS** — project owner, maintainer and product direction.
- **OpenAI ChatGPT (GPT-5.6 Sol)** — AI-assisted architecture, browser FDFE implementation, protobuf tests, CI/CD and documentation. See [`CONTRIBUTORS.md`](CONTRIBUTORS.md).

## License / credits

See [`LICENSE`](LICENSE), [`NOTICE`](NOTICE) and [`CONTRIBUTORS.md`](CONTRIBUTORS.md).

Google Play is a trademark of Google LLC. Aurora Store, corsproxy.io and JSZip are independent third-party projects/services. This repository is unofficial and unaffiliated with Google or those projects.

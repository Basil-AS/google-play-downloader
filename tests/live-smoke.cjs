const assert = require('node:assert/strict');
const P = require('../assets/play-client.js');

(async () => {
  const packageName = process.env.PLAY_SMOKE_PACKAGE || 'org.mozilla.firefox';
  const signal = AbortSignal.timeout(70000);

  console.log('smoke: anonymous auth for arm64');
  const auth = await P.getAuth('arm64', { fresh: true, signal });
  assert.ok(auth.authToken, 'missing authToken');
  assert.ok(auth.gsfId, 'missing gsfId');
  console.log(`smoke: auth ok, gsfId=${String(auth.gsfId).slice(0, 6)}…`);

  console.log(`smoke: details -> purchase -> delivery for ${packageName}`);
  const result = await P.resolve(packageName, 'arm64', { auth, signal });
  assert.equal(result.app.package, packageName);
  assert.ok(result.app.versionCode > 0, 'missing versionCode');
  assert.match(result.delivery.base.url, /^https:\/\//);

  const host = new URL(result.delivery.base.url).hostname;
  assert.ok(/(^|\.)google(?:apis|usercontent)?\.com$|(^|\.)ggpht\.com$/.test(host), `unexpected CDN host ${host}`);
  console.log(`smoke: OK ${result.app.title} vc=${result.delivery.versionCode} base=${host} splits=${result.delivery.splits.length}`);
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});

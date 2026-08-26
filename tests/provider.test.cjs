const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../assets/provider-apkcombo.js');

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'apkcombo.html'), 'utf8');

test('extractPackage accepts package and Google Play URL', () => {
  assert.equal(P.extractPackage('com.google.android.play.games'), 'com.google.android.play.games');
  assert.equal(P.extractPackage('https://play.google.com/store/apps/details?id=com.google.android.play.games'), 'com.google.android.play.games');
  assert.equal(P.extractPackage('Google Play Games'), '');
});

test('search parser finds canonical app links', () => {
  const rows = P.parseSearchResults(fixture, 'com.google.android.play.games');
  assert.equal(rows[0].package, 'com.google.android.play.games');
  assert.equal(rows[0].exact, true);
  assert.match(rows[0].url, /google-play-games\/com\.google\.android\.play\.games/);
});

test('app parser finds package, current download and old versions', () => {
  const app = P.parseAppPage(fixture, 'https://apkcombo.com/google-play-games/com.google.android.play.games/');
  assert.equal(app.package, 'com.google.android.play.games');
  assert.match(app.downloadUrl, /\/download\/apk$/);
  assert.ok(app.oldVersions.length >= 1);
});

test('download parser preserves architectures and formats', () => {
  const variants = P.parseDownloadVariants(fixture);
  assert.equal(variants.length, 4);
  assert.deepEqual(variants[0].abis, ['arm64-v8a', 'armeabi-v7a']);
  assert.equal(variants[0].format, 'XAPK');
  assert.equal(variants[1].abis[0], 'armeabi-v7a');
  assert.equal(variants[2].abis[0], 'arm64-v8a');
  assert.equal(variants[3].abis[0], 'x86_64');
  assert.equal(P.architectureTags(variants[2])[0], 'arm64');
});

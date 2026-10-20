// Guards the scaffold against drifting from docs/ARCHITECTURE.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../src/shared/constants.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

test('src/shared/constants.js is the ARCHITECTURE.md §3.2 block, verbatim', () => {
  const doc = read('docs/ARCHITECTURE.md');
  const heading = doc.indexOf('### 3.2 ');
  assert.ok(heading >= 0, 'section 3.2 exists');
  const open = doc.indexOf('```js\n', heading);
  const close = doc.indexOf('\n```', open + 6);
  const block = doc.slice(open + 6, close + 1);
  assert.equal(read('src/shared/constants.js'), block);
});

test('constants are internally consistent', () => {
  assert.equal(C.ALL_THEME_IDS.length, 16);
  assert.ok(C.FREE_THEME_IDS.every((id) => C.ALL_THEME_IDS.includes(id)));
  assert.ok(C.FREE_CALM_KEYS.every((k) => C.CALM_KEYS.includes(k)));
  assert.deepEqual(C.FEATURES.filter((f) => f.startsWith('calm-')), C.CALM_KEYS.map((k) => `calm-${k}`));
  assert.deepEqual(Object.keys(C.DEFAULT_SETTINGS.calm), C.CALM_KEYS);
  assert.ok(C.ALL_THEME_IDS.includes(C.DEFAULT_SETTINGS.themeId));
  assert.ok(C.PAGE_TYPES.includes('other'));
  assert.ok(C.STYLE_ID.length > 0 && C.CD_PREFIX === 'cd-');
});

test('manifest.json matches ARCHITECTURE.md §5', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.equal(m.manifest_version, 3);
  assert.equal(m.name, 'Cinedrape');
  assert.match(m.description, /not affiliated with Google/i);
  assert.ok(m.description.length <= 132, 'Chrome Web Store description limit');
  assert.equal(m.minimum_chrome_version, '105');
  assert.deepEqual(m.permissions, ['storage', 'alarms', 'scripting']);
  assert.deepEqual(m.host_permissions, ['https://www.youtube.com/*', 'https://youtube.com/*']);
  assert.equal(m.web_accessible_resources, undefined);
  assert.deepEqual(m.background, { service_worker: 'service-worker.js', type: 'module' });
  assert.equal(m.action.default_popup, 'popup/popup.html');
  assert.deepEqual(m.content_scripts, [{
    matches: ['https://www.youtube.com/*', 'https://youtube.com/*'], js: ['content.js'], run_at: 'document_start',
  }]);
  assert.deepEqual(Object.keys(m.icons), ['16', '32', '48', '64', '96', '128', '256', '512']);
  for (const [size, path] of Object.entries(m.icons)) {
    assert.equal(path, `icons/icon-${size}.png`);
    assert.ok(existsSync(join(ROOT, path)), `${path} exists`);
  }
});

test('package.json scripts and dev dependencies match the contract', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'cinedrape');
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies');
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['esbuild', 'jsdom', 'puppeteer-core']);
  for (const s of ['build', 'build:dev', 'build:strict', 'test', 'keys', 'sign-map', 'licence:dev', 'e2e']) {
    assert.ok(pkg.scripts[s], `script ${s}`);
  }
  assert.match(pkg.scripts['build:dev'], /--dev/);
  assert.match(pkg.scripts['build:strict'], /--strict/);
});

test('manifest icon PNGs are real PNGs of the declared size', () => {
  const manifest = JSON.parse(read('manifest.json'));
  for (const size of [16, 32, 48, 128]) {
    const buf = readFileSync(join(ROOT, manifest.icons[size]));
    assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG');
    assert.equal(buf.readUInt32BE(16), size);
    assert.equal(buf.readUInt32BE(20), size);
    assert.equal(buf[25], 6, 'RGBA');
  }
});

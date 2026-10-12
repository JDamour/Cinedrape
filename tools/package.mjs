// Packages a PRODUCTION build of the extension as release/cinedrape-<version>.zip (the file the Chrome Web Store takes).
// Usage: npm run package [-- --allow-dev-keys]
// It always rebuilds with the strict production build first, then refuses to ship anything that is obviously not releasable.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readKeyStatus } from './gen-keys.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowDevKeys = process.argv.includes('--allow-dev-keys');
const fail = (msg) => { console.error(`package: ${msg}`); process.exit(1); };

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// 1. Production build, strict (budgets, forbidden constructs, every manifest file present).
const build = spawnSync(process.execPath, [join(root, 'build.mjs'), '--strict'], { cwd: root, stdio: 'inherit', env: { ...process.env, CINEDRAPE_DEV: '' } });
if (build.status !== 0) fail('the strict production build failed');

// 2. It must really be a production build.
const dist = join(root, 'dist');
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
if (String(manifest.version_name || '').includes('dev')) fail('dist/ is a dev build (version_name contains "dev")');
if (manifest.version !== pkg.version) fail(`manifest version ${manifest.version} does not match package.json ${pkg.version}`);
if (manifest.web_accessible_resources) fail('manifest has web_accessible_resources; the contract says none');
const perms = [...(manifest.permissions || [])].sort().join(',');
if (perms !== 'alarms,storage') fail(`permissions must be exactly alarms,storage (got "${perms}")`);
const hosts = (manifest.host_permissions || []).join(',');
if (hosts !== 'https://www.youtube.com/*') fail(`host_permissions must be exactly https://www.youtube.com/* (got "${hosts}")`);

// 3. The dev signing keys must be replaced before a store release: anyone with this repository could mint a Pro licence.
// The test is the explicit sentinel tools/gen-keys.mjs writes (KEY_STATUS = 'dev' | 'production'), never the header prose, so a
// real rotation (npm run keys -- --production, or KMS/HSM public keys pasted with KEY_STATUS = 'production') satisfies it.
const KEY_STATUS = await readKeyStatus(root);
if (KEY_STATUS !== 'production') {
  const why = KEY_STATUS === 'dev' ? 'still holds the DEV signing keys' : 'has no valid KEY_STATUS sentinel (expected "dev" or "production")';
  const msg = `src/shared/public-keys.js ${why}. Anyone with a copy of this repository could mint a Pro licence or a selector map your users would trust. Run "npm run keys -- --production" (keep the private keys in a KMS/HSM or offline store, not in .keys/), re-sign the map with "npm run sign-map", then package again.`;
  if (!allowDevKeys) fail(msg + ' (Use --allow-dev-keys only for a private test build.)');
  console.warn(`package: WARNING: ${msg}`);
}

// 4. Zip dist/ (contents at the archive root, as the store expects).
const outDir = join(root, 'release');
mkdirSync(outDir, { recursive: true });
const zip = join(outDir, `cinedrape-${pkg.version}.zip`);
rmSync(zip, { force: true });
const result = process.platform === 'win32'
  ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path '${join(dist, '*')}' -DestinationPath '${zip}' -CompressionLevel Optimal`], { stdio: 'inherit' })
  : spawnSync('zip', ['-r', '-q', zip, '.'], { cwd: dist, stdio: 'inherit' });
if (result.status !== 0 || !existsSync(zip)) fail('could not create the zip (needs PowerShell on Windows or the zip command elsewhere)');
console.log(`package: wrote ${zip} (${(statSync(zip).size / 1024).toFixed(1)} KB)${allowDevKeys ? ' [DEV KEYS: private test build only]' : ''}`);

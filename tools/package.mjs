// Packages a PRODUCTION build of the extension (for Chrome Web Store, Firefox Add-ons AMO, or Edge Add-ons).
// Usage: node tools/package.mjs [--target chrome|firefox|edge|all] [--allow-dev-keys]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readKeyStatus } from './gen-keys.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowDevKeys = process.argv.includes('--allow-dev-keys');
const targetAt = Math.max(process.argv.indexOf('--target'), process.argv.indexOf('--browser'));
const rawTarget = targetAt >= 0 ? String(process.argv[targetAt + 1] ?? '').toLowerCase() : 'chrome';
const targets = rawTarget === 'all' || process.argv.includes('--all')
  ? ['chrome', 'edge', 'firefox']
  : [rawTarget];

const fail = (msg) => { console.error(`package: ${msg}`); process.exit(1); };

for (const t of targets) {
  if (!['chrome', 'firefox', 'edge'].includes(t)) {
    fail(`unknown target "${t}" (must be "chrome", "firefox", "edge", or "all")`);
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// Dev signing keys check
const KEY_STATUS = await readKeyStatus(root);
if (KEY_STATUS !== 'production') {
  const why = KEY_STATUS === 'dev' ? 'still holds the DEV signing keys' : 'has no valid KEY_STATUS sentinel (expected "dev" or "production")';
  const msg = `src/shared/public-keys.js ${why}. Anyone with a copy of this repository could mint a Pro licence or a selector map your users would trust. Run "npm run keys -- --production" (keep the private keys in a KMS/HSM or offline store, not in .keys/), re-sign the map with "npm run sign-map", then package again.`;
  if (!allowDevKeys) fail(msg + ' (Use --allow-dev-keys only for a private test build.)');
  console.warn(`package: WARNING: ${msg}`);
}

const outDir = join(root, 'release');
mkdirSync(outDir, { recursive: true });

for (const target of targets) {
  console.log(`\n--- Packaging for ${target.toUpperCase()} ---`);

  // 1. Production build, strict
  const build = spawnSync(process.execPath, [join(root, 'build.mjs'), '--strict', '--target', target], {
    cwd: root, stdio: 'inherit', env: { ...process.env, CINEDRAPE_DEV: '' },
  });
  if (build.status !== 0) fail(`the strict production build for ${target} failed`);

  // 2. Validate production manifest
  const distDirName = target === 'chrome' ? 'dist' : `dist-${target}`;
  const dist = join(root, distDirName);
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
  if (String(manifest.version_name || '').includes('dev')) fail(`${distDirName}/ is a dev build (version_name contains "dev")`);
  if (manifest.version !== pkg.version) fail(`manifest version ${manifest.version} does not match package.json ${pkg.version}`);
  if (manifest.web_accessible_resources) fail('manifest has web_accessible_resources; the contract says none');
  const perms = [...(manifest.permissions || [])].sort().join(',');
  if (perms !== 'alarms,scripting,storage') fail(`permissions must be exactly alarms,scripting,storage (got "${perms}")`);
  const hosts = (manifest.host_permissions || []).join(',');
  if (hosts !== 'https://www.youtube.com/*,https://youtube.com/*') fail(`host_permissions must contain only desktop YouTube (got "${hosts}")`);

  if (target === 'firefox') {
    if (!manifest.browser_specific_settings?.gecko?.id) fail('Firefox manifest missing browser_specific_settings.gecko.id');
    if (!manifest.background?.scripts?.includes('service-worker.js')) fail('Firefox manifest missing background.scripts');
  } else {
    if (manifest.background?.service_worker !== 'service-worker.js') fail('Chromium manifest missing background.service_worker');
  }

  // 3. Zip dist
  const zipName = target === 'chrome' ? `cinedrape-${pkg.version}.zip` : `cinedrape-${target}-${pkg.version}.zip`;
  const zip = join(outDir, zipName);
  rmSync(zip, { force: true });
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Compress-Archive -Path '${join(dist, '*')}' -DestinationPath '${zip}' -CompressionLevel Optimal`], { stdio: 'inherit' })
    : spawnSync('zip', ['-r', '-q', zip, '.'], { cwd: dist, stdio: 'inherit' });
  if (result.status !== 0 || !existsSync(zip)) fail(`could not create zip for ${target}`);
  console.log(`package: wrote ${zip} (${(statSync(zip).size / 1024).toFixed(1)} KB)${allowDevKeys ? ' [DEV KEYS: private test build only]' : ''}`);

  if (target === 'chrome') {
    // Also create cinedrape-chrome-<version>.zip alias
    const chromeAlias = join(outDir, `cinedrape-chrome-${pkg.version}.zip`);
    rmSync(chromeAlias, { force: true });
    if (existsSync(zip)) {
      const { copyFileSync } = await import('node:fs');
      copyFileSync(zip, chromeAlias);
    }
  }
}

// Real-Chrome e2e for F3 (layout modes) and F5 (calm mode) on live logged-out youtube.com. Not a unit test (the name does not match
// *.test.js). Reads the harness in test/e2e/lib read-only; builds nothing: pass the extension directory built with
//   node build.mjs --strict --out dist-home
// Usage: node test/e2e/features-home-calm.mjs [--extension dist-home] [--out test/e2e/out/home] [--phases f3,f5] [--viewport 1440x900]
// Writes <out>/report.json and <out>/report.md. The page never sends data out: everything is read through page.evaluate and the
// extension's service worker (to seed chrome.storage), all in a temporary Chrome profile.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startSession } from './features-home-calm-lib.mjs';
import { withTimeout } from './lib/browser.mjs';
import { REPO_ROOT } from './lib/cli.mjs';
import { runAll } from './features-home-calm-phases.mjs';

const args = process.argv.slice(2);
const get = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const out = resolve(REPO_ROOT, get('out', 'test/e2e/out/home'));
mkdirSync(out, { recursive: true });
const [w, h] = String(get('viewport', '1440x900')).split('x').map(Number);
let ctx = null;
const code = await withTimeout((async () => {
  ctx = await startSession({ extension: get('extension', 'dist-home'), viewport: { width: w, height: h } });
  ctx.extension = get('extension', 'dist-home');
  return runAll(ctx, { out, phases: String(get('phases', 'f3,f5')).split(','), only: get('only', ''), pages: get('pages', '') ? String(get('pages', '')).split(',') : null });
})(), 35 * 60 * 1000, 'features-home-calm').catch((err) => { console.error(err && err.stack ? err.stack : err); return 6; });
if (ctx) await ctx.close();
writeFileSync(join(out, '.done'), String(code));
process.exit(code);

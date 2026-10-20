// Export the current brand master; never regenerate the retired curtain artwork.
// node tools/make-icons.mjs
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 32, 48, 64, 96, 128, 256, 512];

export function makeIcons(outDir = join(ROOT, 'icons')) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-File', join(ROOT, 'tools/export-brand-icons.ps1'),
    '-OutputDirectory', outDir,
  ], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Icon export failed');
  return SIZES.map((size) => join(outDir, `icon-${size}.png`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const file of makeIcons()) console.log('wrote', file);
}

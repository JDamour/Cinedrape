// !! DEV ONLY !! Mints a licence token signed with the local DEV licence key (.keys/licence.private.jwk.json).
//   node tools/dev-licence.mjs [--plan pro|free] [--days N | --lifetime] [--sub email] [--devices N] [--root <dir>]
//   npm run licence:dev -- --plan pro --days 30
//
// The token goes to stdout, everything else to stderr, so `npm run licence:dev -s -- --plan pro` pipes cleanly.
// Real licences are minted by the licence server with the production key. Refuses to run without the private key, and
// refuses when that key is not the pair of LICENCE_PUBLIC_KEY in src/shared/public-keys.js (the extension would reject it).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PLANS, parseClaims, signLicenceToken, verifyLicenceToken } from '../src/shared/licence.js';
import { ToolError, loadKeyPair } from './gen-keys.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAY_S = 86400;
const MAX_DAYS = 36500;

export const BANNER = '*** DEV ONLY *** signed with the local DEV licence key. Never sell, ship or share it; real licences come from the licence server.';

/**
 * @param {{root?: string, plan?: string, days?: number, lifetime?: boolean, sub?: string, devices?: number, now?: number}} [options]
 *   `days` is the validity from `now` (default 30); `lifetime` omits `exp`; `now` is ms.
 * @returns {Promise<{token: string, claims: object}>}
 */
export async function makeDevLicence({ root = REPO_ROOT, plan = 'pro', days = 30, lifetime = false, sub = 'dev@cinedrape.local', devices, now = Date.now() } = {}) {
  if (!PLANS.includes(plan)) throw new ToolError(`--plan must be one of ${PLANS.join(', ')}, got ${JSON.stringify(plan)}.`);
  if (!lifetime && !(typeof days === 'number' && Number.isFinite(days) && days > 0 && days <= MAX_DAYS)) {
    throw new ToolError(`--days must be a number greater than 0 and at most ${MAX_DAYS}, got ${JSON.stringify(days)}.`);
  }
  if (typeof sub !== 'string' || sub.trim() === '' || sub.length > 320) throw new ToolError('--sub must be a non-empty string of at most 320 characters.');

  const iat = Math.floor(now / 1000);
  const claims = { v: 1, sub, plan, iat };
  if (!lifetime) claims.exp = iat + Math.round(days * DAY_S);
  if (devices !== undefined) claims.devices = devices;
  const parsed = parseClaims(claims);
  if (!parsed.ok) throw new ToolError(`the claims are not valid (${parsed.reason}); check --devices and --days.`);

  const { privateJwk, publicJwk } = await loadKeyPair(root, 'licence');
  const token = await signLicenceToken(parsed.claims, privateJwk);
  const check = await verifyLicenceToken(token, now, publicJwk);
  if (!check.valid) throw new ToolError(`the fresh token does not verify (${check.reason}).`);
  return { token, claims: parsed.claims };
}

const USAGE = 'usage: node tools/dev-licence.mjs [--plan pro|free] [--days N | --lifetime] [--sub email] [--devices N] [--root <dir>]';

export async function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        plan: { type: 'string' }, days: { type: 'string' }, lifetime: { type: 'boolean' }, sub: { type: 'string' },
        devices: { type: 'string' }, root: { type: 'string' }, help: { type: 'boolean' },
      },
      strict: true,
    }));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.lifetime && values.days !== undefined) {
    console.error(`--lifetime and --days cannot be combined.\n${USAGE}`);
    return 2;
  }
  const num = (text) => (text === undefined ? undefined : text.trim() === '' ? NaN : Number(text));
  try {
    const { token, claims } = await makeDevLicence({
      root: values.root ? resolve(values.root) : REPO_ROOT,
      plan: values.plan,
      days: num(values.days),
      lifetime: Boolean(values.lifetime),
      sub: values.sub,
      devices: num(values.devices),
    });
    console.error(BANNER);
    console.error(`plan ${claims.plan}, sub ${claims.sub}, ${claims.exp ? `expires ${new Date(claims.exp * 1000).toISOString()}` : 'no expiry'}${claims.devices ? `, ${claims.devices} devices` : ''}`);
    console.log(token);
    return 0;
  } catch (err) {
    if (!(err instanceof ToolError)) console.error(err && err.stack ? err.stack : err);
    else console.error(`dev-licence: ${err.message}`);
    return 1;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) process.exitCode = await main();

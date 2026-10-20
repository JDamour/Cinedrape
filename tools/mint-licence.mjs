// Mints a production licence token signed with .keys/licence.private.jwk.json and appends to .keys/sales.csv.
//   node tools/mint-licence.mjs --order <orderId> --tier founder|standard [--root <dir>]
//   npm run licence:mint -- --order 12345 --tier founder
//
// The token goes to stdout, everything else to stderr, so it pipes cleanly.
// Requires --order and --tier. sub is 'ls_<orderId>', never personal data (email). Lifetime: no exp claim.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { TIERS, parseClaims, signLicenceToken, verifyLicenceToken } from '../src/shared/licence.js';
import { ToolError, loadKeyPair } from './gen-keys.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const salesPath = (root) => join(root, '.keys', 'sales.csv');
export const CSV_HEADER = 'orderId,sub,tier,iat\n';

function csvCell(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * @param {{root?: string, order: string, tier: string, now?: number}} options
 * @returns {Promise<{token: string, claims: object, salesRow: string}>}
 */
export async function mintLicence({ root = REPO_ROOT, order, tier, now = Date.now() } = {}) {
  if (typeof order !== 'string' || order.trim() === '') {
    throw new ToolError('--order <orderId> is required and must be a non-empty string.');
  }
  const orderId = order.trim();
  if (orderId.includes('@')) {
    throw new ToolError('--order must be an order ID, not an email address.');
  }
  if (typeof tier !== 'string' || !TIERS.includes(tier)) {
    throw new ToolError(`--tier must be one of ${TIERS.join(', ')}, got ${JSON.stringify(tier)}.`);
  }

  const sub = orderId.startsWith('ls_') ? orderId : `ls_${orderId}`;
  if (sub.length > 320) {
    throw new ToolError(`order ID is too long (sub exceeds 320 characters).`);
  }

  const iat = Math.floor(now / 1000);
  const rawClaims = {
    v: 1,
    sub,
    plan: 'pro',
    iat,
    devices: 3,
    tier,
  };

  const parsed = parseClaims(rawClaims);
  if (!parsed.ok) {
    throw new ToolError(`the claims are not valid (${parsed.reason}).`);
  }

  const { privateJwk, publicJwk } = await loadKeyPair(root, 'licence');
  const token = await signLicenceToken(parsed.claims, privateJwk);
  const check = await verifyLicenceToken(token, now, publicJwk);
  if (!check.valid) {
    throw new ToolError(`the fresh token does not verify (${check.reason}).`);
  }

  const salesFile = salesPath(root);
  const salesDir = dirname(salesFile);
  if (!existsSync(salesDir)) {
    mkdirSync(salesDir, { recursive: true });
  }
  if (!existsSync(salesFile)) {
    writeFileSync(salesFile, CSV_HEADER, 'utf8');
  }

  const salesRow = `${csvCell(orderId)},${csvCell(sub)},${csvCell(tier)},${iat}\n`;
  appendFileSync(salesFile, salesRow, 'utf8');

  return { token, claims: parsed.claims, salesRow };
}

const USAGE = 'usage: node tools/mint-licence.mjs --order <orderId> --tier founder|standard [--root <dir>]';

export async function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        order: { type: 'string' },
        tier: { type: 'string' },
        root: { type: 'string' },
        help: { type: 'boolean' },
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

  if (!values.order || !values.tier) {
    console.error(`--order and --tier are required.\n${USAGE}`);
    return 2;
  }

  try {
    const { token, claims } = await mintLicence({
      root: values.root ? resolve(values.root) : REPO_ROOT,
      order: values.order,
      tier: values.tier,
    });
    console.error(`mint-licence: plan ${claims.plan} (${claims.tier}), sub ${claims.sub}, ${claims.devices} devices, no expiry`);
    console.log(token);
    return 0;
  } catch (err) {
    if (!(err instanceof ToolError)) console.error(err && err.stack ? err.stack : err);
    else console.error(`mint-licence: ${err.message}`);
    return 1;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) process.exitCode = await main();

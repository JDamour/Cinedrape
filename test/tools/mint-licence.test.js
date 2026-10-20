import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runGenKeys, publicKeysPath } from '../../tools/gen-keys.mjs';
import { mintLicence, main as mintLicenceMain, salesPath, CSV_HEADER } from '../../tools/mint-licence.mjs';
import { verifyLicenceToken, licenceState } from '../../src/shared/licence.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOLS = join(REPO, 'tools');
const NOW = Date.UTC(2026, 9, 15, 10, 0, 0);

const roots = [];
after(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });

function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'cd-mint-'));
  roots.push(dir);
  return dir;
}

async function keyedRoot() {
  const root = makeRoot();
  await runGenKeys({ root });
  return root;
}

const importFresh = (file) => import(`${pathToFileURL(file).href}?t=${Date.now()}-${Math.random()}`);
const shipped = (root) => importFresh(publicKeysPath(root));

async function runMain(main, args) {
  const out = [];
  const err = [];
  const { log, error } = console;
  console.log = (...parts) => out.push(parts.join(' '));
  console.error = (...parts) => err.push(parts.join(' '));
  try {
    const code = await main(args);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('mint-licence: mints a founder token with no exp, sub=ls_<order>, 3 devices, appends to sales.csv', async () => {
  const root = await keyedRoot();
  const keys = await shipped(root);
  const iat = Math.floor(NOW / 1000);

  const { token, claims, salesRow } = await mintLicence({
    root,
    order: 'ord_12345',
    tier: 'founder',
    now: NOW,
  });

  assert.deepEqual(claims, {
    v: 1,
    sub: 'ls_ord_12345',
    plan: 'pro',
    iat,
    devices: 3,
    tier: 'founder',
  });
  assert.equal('exp' in claims, false, 'lifetime tokens must have no exp');

  // Signature verification with public key
  const verified = await verifyLicenceToken(token, NOW, keys.LICENCE_PUBLIC_KEY);
  assert.equal(verified.valid, true);
  assert.deepEqual(verified.claims, claims);

  // Still valid far in the future
  const futureCheck = await verifyLicenceToken(token, Date.UTC(2036, 0, 1), keys.LICENCE_PUBLIC_KEY);
  assert.equal(futureCheck.valid, true);

  // Engine licence state evaluates to active
  const state = licenceState({ token, claims: verified.claims, checkedAt: NOW }, NOW);
  assert.deepEqual(state, { plan: 'pro', status: 'active' });

  // Wrong key fails
  const wrongKeyCheck = await verifyLicenceToken(token, NOW, keys.SELECTOR_MAP_PUBLIC_KEY);
  assert.equal(wrongKeyCheck.valid, false);

  // sales.csv created with header and row
  const csvFile = salesPath(root);
  assert.ok(existsSync(csvFile));
  const content = readFileSync(csvFile, 'utf8');
  assert.equal(content, `${CSV_HEADER}ord_12345,ls_ord_12345,founder,${iat}\n`);
  assert.equal(salesRow, `ord_12345,ls_ord_12345,founder,${iat}\n`);
});

test('mint-licence: handles order prefix ls_ and standard tier, appends to existing sales.csv without repeating header', async () => {
  const root = await keyedRoot();
  const iat1 = Math.floor(NOW / 1000);
  const iat2 = iat1 + 60;

  await mintLicence({ root, order: '1001', tier: 'founder', now: NOW });
  const res2 = await mintLicence({ root, order: 'ls_1002', tier: 'standard', now: NOW + 60000 });

  assert.equal(res2.claims.sub, 'ls_1002');
  assert.equal(res2.claims.tier, 'standard');

  const content = readFileSync(salesPath(root), 'utf8');
  const lines = content.trim().split(/\r?\n/);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'orderId,sub,tier,iat');
  assert.equal(lines[1], `1001,ls_1001,founder,${iat1}`);
  assert.equal(lines[2], `ls_1002,ls_1002,standard,${iat2}`);
});

test('mint-licence: rejects email addresses as order ID to protect privacy', async () => {
  const root = await keyedRoot();
  await assert.rejects(
    mintLicence({ root, order: 'user@example.com', tier: 'founder', now: NOW }),
    /--order must be an order ID, not an email address/
  );
});

test('mint-licence: rejects invalid arguments (missing order, invalid tier, excessive length)', async () => {
  const root = await keyedRoot();

  await assert.rejects(
    mintLicence({ root, order: '', tier: 'founder', now: NOW }),
    /--order <orderId> is required/
  );
  await assert.rejects(
    mintLicence({ root, order: '   ', tier: 'founder', now: NOW }),
    /--order <orderId> is required/
  );
  await assert.rejects(
    mintLicence({ root, order: '123', tier: 'invalid', now: NOW }),
    /--tier must be one of founder, standard/
  );
  await assert.rejects(
    mintLicence({ root, order: '123', tier: undefined, now: NOW }),
    /--tier must be one of founder, standard/
  );
  await assert.rejects(
    mintLicence({ root, order: 'a'.repeat(320), tier: 'founder', now: NOW }),
    /sub exceeds 320 characters/
  );
});

test('mint-licence: CLI argument parsing and stdout/stderr split', async () => {
  const root = await keyedRoot();

  // Missing args -> code 2
  const noArgs = await runMain(mintLicenceMain, ['--root', root]);
  assert.equal(noArgs.code, 2);
  assert.match(noArgs.err, /--order and --tier are required/);

  // Missing order -> code 2
  const missingOrder = await runMain(mintLicenceMain, ['--root', root, '--tier', 'founder']);
  assert.equal(missingOrder.code, 2);

  // Missing tier -> code 2
  const missingTier = await runMain(mintLicenceMain, ['--root', root, '--order', 'ord_123']);
  assert.equal(missingTier.code, 2);

  // Help -> code 0
  const help = await runMain(mintLicenceMain, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /usage: node tools\/mint-licence.mjs/);

  // Tool error (e.g. email) -> code 1
  const emailErr = await runMain(mintLicenceMain, ['--root', root, '--order', 'test@test.com', '--tier', 'standard']);
  assert.equal(emailErr.code, 1);
  assert.match(emailErr.err, /mint-licence: --order must be an order ID/);

  // Valid run -> code 0, token on stdout, diagnostics on stderr
  const valid = await runMain(mintLicenceMain, ['--root', root, '--order', 'order_success', '--tier', 'founder']);
  assert.equal(valid.code, 0);
  assert.match(valid.err, /mint-licence: plan pro \(founder\), sub ls_order_success, 3 devices, no expiry/);
  const token = valid.out.trim();
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  // Token is verified with shipped key
  const keys = await shipped(root);
  const verified = await verifyLicenceToken(token, Date.now(), keys.LICENCE_PUBLIC_KEY);
  assert.equal(verified.valid, true);
  assert.equal(verified.claims.tier, 'founder');
  assert.equal(verified.claims.sub, 'ls_order_success');
});

test('mint-licence: child process spawn works cleanly via node executable', async () => {
  const root = await keyedRoot();
  const res = spawnSync(
    process.execPath,
    [join(TOOLS, 'mint-licence.mjs'), '--root', root, '--order', 'cli_spawn_test', '--tier', 'standard'],
    { encoding: 'utf8', timeout: 30_000 }
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /mint-licence: plan pro/);
  const token = res.stdout.trim();
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

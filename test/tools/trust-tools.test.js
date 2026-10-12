// tools/gen-keys.mjs, tools/sign-map.mjs, tools/dev-licence.mjs. Everything runs against throw-away temp roots (the
// tools take a `root`), so the real .keys/ and src/ are never written. A handful of tests spawn the CLIs to prove the
// wiring (exit codes, stdout/stderr split); all the logic is tested in-process.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KEY_SPECS, ToolError, loadKeyPair, main as genKeysMain, privateKeyPath, publicKeysPath, renderPublicKeysModule, runGenKeys } from '../../tools/gen-keys.mjs';
import { main as signMapMain, signMap, signedPath, sourcePath } from '../../tools/sign-map.mjs';
import { BANNER, main as devLicenceMain, makeDevLicence } from '../../tools/dev-licence.mjs';
import { base64urlDecode, compareMapVersions, signEnvelope, toPublicJwk, verifyEnvelope } from '../../src/shared/signing.js';
import { licenceState, verifyLicenceToken } from '../../src/shared/licence.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOLS = join(REPO, 'tools');
const DAY_S = 86400;

// ---- helpers -------------------------------------------------------------------------------------------------------

const roots = [];
after(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });

function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'cd-trust-'));
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
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Every file under `root` as { relativePath: text }, for "nothing was touched" assertions. */
function tree(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(root, full).replace(/\\/g, '/')] = readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return out;
}

async function rejectsWith(promise, pattern, ErrorClass = ToolError) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ErrorClass, `expected ${ErrorClass.name}, got ${err && err.constructor.name}: ${err && err.message}`);
    assert.match(err.message, pattern);
    return true;
  });
}

const mapAt = (mapVersion, extra = {}) => ({ schema: 1, mapVersion, issuedAt: '2026-10-08T00:00:00Z', roles: { app: ['ytd-app'] }, ...extra });
const writeSource = (root, map) => {
  mkdirSync(dirname(sourcePath(root)), { recursive: true });
  writeFileSync(sourcePath(root), typeof map === 'string' ? map : `${JSON.stringify(map, null, 2)}\n`);
};
const accept = () => ({ ok: true, errors: [] });

/** Runs a tool's main() in-process with console output captured. */
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

function runTool(script, args) {
  const result = spawnSync(process.execPath, [join(TOOLS, script), ...args], { encoding: 'utf8', timeout: 30_000 });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

// ---- gen-keys ------------------------------------------------------------------------------------------------------

test('gen-keys: creates two private keys and a public-keys.js that matches them', async () => {
  const root = makeRoot();
  const lines = [];
  const result = await runGenKeys({ root, log: (line) => lines.push(line) });
  assert.deepEqual(result.generated, ['selector-map', 'licence']);
  assert.deepEqual(result.reused, []);
  assert.equal(result.wrotePublicKeys, true);

  const mapPrivate = readJson(privateKeyPath(root, 'selector-map'));
  const licencePrivate = readJson(privateKeyPath(root, 'licence'));
  for (const [jwk, kid] of [[mapPrivate, 'selector-map-1'], [licencePrivate, 'licence-1']]) {
    assert.equal(jwk.kty, 'EC');
    assert.equal(jwk.crv, 'P-256');
    assert.equal(jwk.kid, kid);
    assert.equal(base64urlDecode(jwk.d).length, 32);
    assert.equal(base64urlDecode(jwk.x).length, 32);
    assert.equal(base64urlDecode(jwk.y).length, 32);
  }
  assert.notEqual(mapPrivate.d, licencePrivate.d, 'two independent keys');
  assert.notEqual(mapPrivate.x, licencePrivate.x);

  const keys = await shipped(root);
  assert.deepEqual(Object.keys(keys).sort(), ['KEY_STATUS', 'LICENCE_PUBLIC_KEY', 'SELECTOR_MAP_PUBLIC_KEY'], 'two public keys and the status sentinel');
  assert.deepEqual({ ...keys.SELECTOR_MAP_PUBLIC_KEY }, toPublicJwk(mapPrivate));
  assert.deepEqual({ ...keys.LICENCE_PUBLIC_KEY }, toPublicJwk(licencePrivate));
  assert.ok(Object.isFrozen(keys.SELECTOR_MAP_PUBLIC_KEY));
  for (const jwk of [keys.SELECTOR_MAP_PUBLIC_KEY, keys.LICENCE_PUBLIC_KEY]) assert.ok(!('d' in jwk), 'no private member in the shipped key');

  // the pairs really work, and are not interchangeable
  const envelope = await signEnvelope('{"hello":"map"}', mapPrivate, 'selector-map-1');
  assert.equal((await verifyEnvelope(envelope, keys.SELECTOR_MAP_PUBLIC_KEY)).ok, true);
  assert.equal((await verifyEnvelope(envelope, keys.LICENCE_PUBLIC_KEY)).ok, false);

  // no private material anywhere it should not be
  const source = readFileSync(publicKeysPath(root), 'utf8');
  for (const secret of [mapPrivate.d, licencePrivate.d]) {
    assert.ok(!source.includes(secret), 'public-keys.js leaks a private scalar');
    assert.ok(!lines.join('\n').includes(secret), 'log output leaks a private scalar');
  }
  assert.ok(lines.length > 0);
});

test('gen-keys: public-keys.js carries the DEV-key warning, LF line endings and a trailing newline', async () => {
  const root = await keyedRoot();
  const source = readFileSync(publicKeysPath(root), 'utf8');
  assert.match(source, /GENERATED by tools\/gen-keys\.mjs/);
  assert.match(source, /DEV KEYS/);
  assert.match(source, /replace them with production keys/);
  assert.match(source, /Chrome Web Store release/);
  assert.match(source, /\.keys\/.*gitignored/s);
  assert.match(source, /Back that folder up/);
  assert.match(source, /Never commit it/);
  assert.ok(!source.includes('\r'), 'LF only');
  assert.ok(source.endsWith('\n') && !source.endsWith('\n\n'));
  assert.deepEqual([...source.matchAll(/^export const (\w+)/gm)].map((m) => m[1]), [...KEY_SPECS.map((s) => s.exportName), 'KEY_STATUS']);
});

test('gen-keys: idempotent. A second run keeps every file byte-for-byte', async () => {
  const root = makeRoot();
  await runGenKeys({ root });
  const before = tree(root);
  const again = await runGenKeys({ root });
  assert.deepEqual(again.generated, []);
  assert.deepEqual(again.reused, ['selector-map', 'licence']);
  assert.equal(again.wrotePublicKeys, false);
  assert.deepEqual(tree(root), before);
  assert.deepEqual(Object.keys(before).sort(), ['.keys/licence.private.jwk.json', '.keys/selector-map.private.jwk.json', 'src/shared/public-keys.js']);
});

test('gen-keys: a deleted public-keys.js is rebuilt identically from the private keys', async () => {
  const root = await keyedRoot();
  const before = tree(root);
  rmSync(publicKeysPath(root));
  const result = await runGenKeys({ root });
  assert.deepEqual(result.generated, []);
  assert.equal(result.wrotePublicKeys, true);
  assert.deepEqual(tree(root), before);
});

test('gen-keys: a missing private key is regenerated alone when no public key is shipped for it yet', async () => {
  const root = await keyedRoot();
  const mapBefore = readFileSync(privateKeyPath(root, 'selector-map'), 'utf8');
  rmSync(privateKeyPath(root, 'licence'));
  rmSync(publicKeysPath(root));
  const result = await runGenKeys({ root });
  assert.deepEqual(result.generated, ['licence']);
  assert.deepEqual(result.reused, ['selector-map']);
  assert.equal(readFileSync(privateKeyPath(root, 'selector-map'), 'utf8'), mapBefore, 'the existing key is untouched');
  assert.equal(readJson(privateKeyPath(root, 'licence')).kid, 'licence-1');
});

test('gen-keys: refuses to replace the shipped public key when its private half is gone (would orphan every signature)', async () => {
  const root = await keyedRoot();
  rmSync(privateKeyPath(root, 'licence'));
  const before = tree(root);
  await rejectsWith(runGenKeys({ root }), /different LICENCE_PUBLIC_KEY.*private key is missing.*--force/s);
  assert.deepEqual(tree(root), before, 'nothing written, nothing created');
});

test('gen-keys: refuses to overwrite a hand-placed (production) public key that does not match .keys/', async () => {
  const root = await keyedRoot();
  const foreign = await (async () => {
    const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey);
    return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid: 'licence-prod-1' };
  })();
  const keys = await shipped(root);
  writeFileSync(publicKeysPath(root), renderPublicKeysModule({ 'selector-map': keys.SELECTOR_MAP_PUBLIC_KEY, licence: foreign }));
  const before = tree(root);
  await rejectsWith(runGenKeys({ root }), /different LICENCE_PUBLIC_KEY.*private key in \.keys/s);
  assert.deepEqual(tree(root), before);
});

test('gen-keys --force: fresh pairs under the next kid, old private keys kept as backups, public file replaced', async () => {
  const root = await keyedRoot();
  const oldPrivate = { 'selector-map': readFileSync(privateKeyPath(root, 'selector-map'), 'utf8'), licence: readFileSync(privateKeyPath(root, 'licence'), 'utf8') };
  const oldPublic = readFileSync(publicKeysPath(root), 'utf8');
  const result = await runGenKeys({ root, force: true });
  assert.deepEqual(result.generated, ['selector-map', 'licence']);
  assert.equal(result.backups.length, 2);

  assert.equal(readJson(privateKeyPath(root, 'selector-map')).kid, 'selector-map-2');
  assert.equal(readJson(privateKeyPath(root, 'licence')).kid, 'licence-2');
  assert.notEqual(readFileSync(privateKeyPath(root, 'licence'), 'utf8'), oldPrivate.licence);
  const backedUp = result.backups.map((file) => readFileSync(file, 'utf8')).sort();
  assert.deepEqual(backedUp, Object.values(oldPrivate).sort(), 'both old private keys survive verbatim');
  for (const file of result.backups) assert.match(file, /\.private\.jwk\..+\.bak\.json$/);

  const keys = await shipped(root);
  assert.equal(keys.SELECTOR_MAP_PUBLIC_KEY.kid, 'selector-map-2');
  assert.notEqual(readFileSync(publicKeysPath(root), 'utf8'), oldPublic);
  await loadKeyPair(root, 'selector-map');
  await loadKeyPair(root, 'licence');

  const third = await runGenKeys({ root, force: true });
  assert.equal(readJson(privateKeyPath(root, 'licence')).kid, 'licence-3');
  assert.equal(third.backups.length, 2);
});

test('gen-keys: a corrupt private key stops the run and is never silently replaced', async () => {
  const cases = {
    'not json': () => 'this is not json',
    'not an EC key': () => JSON.stringify({ kty: 'RSA', n: 'abc', e: 'AQAB' }),
    'wrong curve': (good) => JSON.stringify({ ...good, crv: 'P-384' }),
    'missing d': (good) => JSON.stringify({ ...good, d: undefined }),
  };
  for (const [label, corrupt] of Object.entries(cases)) {
    const root = await keyedRoot();
    const file = privateKeyPath(root, 'selector-map');
    writeFileSync(file, corrupt(readJson(file)));
    const before = tree(root);
    await rejectsWith(runGenKeys({ root }), /refusing to overwrite a private key/, ToolError);
    assert.deepEqual(tree(root), before, label);
  }
});

test('gen-keys: a private scalar that does not belong to its x/y fails the self-test', async () => {
  const root = await keyedRoot();
  const map = readJson(privateKeyPath(root, 'selector-map'));
  const licence = readJson(privateKeyPath(root, 'licence'));
  writeFileSync(privateKeyPath(root, 'selector-map'), JSON.stringify({ ...map, d: licence.d }));
  const before = tree(root);
  await assert.rejects(runGenKeys({ root }), /self-test failed|Invalid|data/i);
  assert.deepEqual(tree(root), before);
});

test('gen-keys --force replaces even an unreadable key, keeping it as a backup', async () => {
  const root = await keyedRoot();
  writeFileSync(privateKeyPath(root, 'licence'), '{broken');
  const result = await runGenKeys({ root, force: true });
  assert.equal(result.backups.length, 2);
  assert.ok(result.backups.some((file) => readFileSync(file, 'utf8') === '{broken'));
  assert.equal(readJson(privateKeyPath(root, 'licence')).kid, 'licence-1', 'no readable kid to increment');
  await loadKeyPair(root, 'licence');
});

test('gen-keys: warns when .gitignore does not ignore .keys/, stays quiet when it does', async () => {
  const bad = makeRoot();
  writeFileSync(join(bad, '.gitignore'), 'node_modules\ndist\n');
  const lines = [];
  await runGenKeys({ root: bad, log: (l) => lines.push(l) });
  assert.ok(lines.some((l) => /WARNING.*\.gitignore.*\.keys/.test(l)), lines.join('\n'));

  for (const content of ['.keys\n', '/.keys/\n', 'node_modules\n.keys\r\ndist\n']) {
    const good = makeRoot();
    writeFileSync(join(good, '.gitignore'), content);
    const out = [];
    await runGenKeys({ root: good, log: (l) => out.push(l) });
    assert.ok(!out.some((l) => /WARNING/.test(l)), JSON.stringify(content));
  }
});

test('gen-keys: the repository ignores .keys/ and ships well-formed DEV public keys', async () => {
  const gitignore = readFileSync(join(REPO, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(gitignore.includes('.keys'), '.keys is gitignored');
  const keys = await importFresh(publicKeysPath(REPO));
  assert.equal(keys.SELECTOR_MAP_PUBLIC_KEY.kid.startsWith('selector-map-'), true);
  assert.equal(keys.LICENCE_PUBLIC_KEY.kid.startsWith('licence-'), true);
  for (const jwk of [keys.SELECTOR_MAP_PUBLIC_KEY, keys.LICENCE_PUBLIC_KEY]) {
    assert.equal(jwk.kty, 'EC');
    assert.equal(jwk.crv, 'P-256');
    assert.equal(base64urlDecode(jwk.x).length, 32);
    assert.equal(base64urlDecode(jwk.y).length, 32);
    assert.ok(!('d' in jwk));
  }
  assert.notEqual(keys.SELECTOR_MAP_PUBLIC_KEY.x, keys.LICENCE_PUBLIC_KEY.x);
  assert.match(readFileSync(publicKeysPath(REPO), 'utf8'), /DEV KEYS/);
  // the extension verifies with these exact exports
  assert.equal((await verifyEnvelope({ payload: 'x', sig: 'A'.repeat(86), kid: keys.LICENCE_PUBLIC_KEY.kid }, keys.LICENCE_PUBLIC_KEY)).reason, 'bad-signature');
  // on the developer's machine the private halves must match; a fresh clone has no .keys/ and this part is skipped
  for (const spec of KEY_SPECS) {
    if (existsSync(privateKeyPath(REPO, spec.name))) await loadKeyPair(REPO, spec.name);
  }
});

test('loadKeyPair: refuses a missing key, a mismatched pair and an unknown name', async () => {
  const bare = makeRoot();
  await rejectsWith(loadKeyPair(bare, 'licence'), /not found.*npm run keys/s);

  const root = await keyedRoot();
  const pair = await loadKeyPair(root, 'licence');
  assert.equal(pair.privateJwk.kid, 'licence-1');
  assert.equal(pair.publicJwk.kid, 'licence-1');

  const wrongKid = await keyedRoot();
  const keys = await shipped(wrongKid);
  writeFileSync(publicKeysPath(wrongKid), renderPublicKeysModule({
    'selector-map': keys.SELECTOR_MAP_PUBLIC_KEY, licence: { ...keys.LICENCE_PUBLIC_KEY, kid: 'licence-9' },
  }));
  await rejectsWith(loadKeyPair(wrongKid, 'licence'), /does not match LICENCE_PUBLIC_KEY/);

  const swapped = await keyedRoot();
  const swappedKeys = await shipped(swapped);
  writeFileSync(publicKeysPath(swapped), renderPublicKeysModule({
    'selector-map': swappedKeys.LICENCE_PUBLIC_KEY, licence: swappedKeys.SELECTOR_MAP_PUBLIC_KEY,
  }));
  await rejectsWith(loadKeyPair(swapped, 'licence'), /does not match/);

  await assert.rejects(loadKeyPair(root, 'nonsense'), /unknown key/);
  rmSync(publicKeysPath(root));
  await rejectsWith(loadKeyPair(root, 'licence'), /public-keys\.js is missing/);
});

// ---- sign-map ------------------------------------------------------------------------------------------------------

test('sign-map: signs JSON.stringify(map) into a { payload, sig, kid } envelope the shipped key verifies', async () => {
  const root = await keyedRoot();
  const map = mapAt('2026.10.08.1', { extra: { unicode: 'café ✓ 🎬' }, _unverified: ['x'] });
  writeSource(root, map);
  const result = await signMap({ root, validate: accept });

  assert.equal(result.changed, true);
  assert.equal(result.mapVersion, '2026.10.08.1');
  assert.equal(result.previousVersion, null);
  assert.equal(result.file, signedPath(root));

  const text = readFileSync(signedPath(root), 'utf8');
  assert.ok(text.endsWith('}\n') && !text.includes('\r'), 'LF, one trailing newline');
  const envelope = JSON.parse(text);
  assert.deepEqual(Object.keys(envelope).sort(), ['kid', 'payload', 'sig']);
  assert.equal(envelope.kid, 'selector-map-1');
  assert.equal(envelope.payload, JSON.stringify(map), 'payload is the compact JSON of the source map');
  assert.deepEqual(JSON.parse(envelope.payload), map);
  assert.equal(base64urlDecode(envelope.sig).length, 64);

  const keys = await shipped(root);
  assert.deepEqual(await verifyEnvelope(envelope, keys.SELECTOR_MAP_PUBLIC_KEY), { ok: true, payload: envelope.payload });
  assert.equal((await verifyEnvelope(envelope, keys.LICENCE_PUBLIC_KEY)).ok, false, 'not valid under the licence key');
  assert.equal((await verifyEnvelope({ ...envelope, payload: envelope.payload.replace('2026.10.08.1', '2099.01.01.1') }, keys.SELECTOR_MAP_PUBLIC_KEY)).ok, false, 'editing the signed file breaks it');

  assert.deepEqual(readdirSync(dirname(signedPath(root))).sort(), ['selector-map.signed.json', 'selector-map.source.json'], 'no temp files left');
});

test('sign-map: running again on an unchanged, already-signed map does nothing', async () => {
  const root = await keyedRoot();
  writeSource(root, mapAt('2026.10.08.1'));
  await signMap({ root, validate: accept });
  const before = readFileSync(signedPath(root), 'utf8');
  const again = await signMap({ root, validate: accept });
  assert.equal(again.changed, false);
  assert.equal(again.mapVersion, '2026.10.08.1');
  assert.equal(readFileSync(signedPath(root), 'utf8'), before, 'no new random signature');
});

test('sign-map: the version must rise strictly; a changed map under the same version is refused (--force overrides)', async () => {
  const root = await keyedRoot();
  writeSource(root, mapAt('2026.10.08.1'));
  await signMap({ root, validate: accept });
  const signed = readFileSync(signedPath(root), 'utf8');

  writeSource(root, mapAt('2026.10.08.1', { roles: { app: ['ytd-app'], extra: ['x'] } }));
  await rejectsWith(signMap({ root, validate: accept }), /2026\.10\.08\.1 is not greater than the signed 2026\.10\.08\.1.*--force/s);
  assert.equal(readFileSync(signedPath(root), 'utf8'), signed, 'the signed file is untouched');

  writeSource(root, mapAt('2026.10.07.9'));
  await rejectsWith(signMap({ root, validate: accept }), /not greater/);
  writeSource(root, mapAt('2025.12.31.99'));
  await rejectsWith(signMap({ root, validate: accept }), /not greater/);
  assert.equal(readFileSync(signedPath(root), 'utf8'), signed);

  writeSource(root, mapAt('2026.10.08.1', { roles: { app: ['ytd-app'], extra: ['x'] } }));
  const forced = await signMap({ root, validate: accept, force: true });
  assert.equal(forced.changed, true);
  assert.notEqual(readFileSync(signedPath(root), 'utf8'), signed);

  writeSource(root, mapAt('2026.10.08.2'));
  const bumped = await signMap({ root, validate: accept });
  assert.equal(bumped.previousVersion, '2026.10.08.1');
  assert.equal(JSON.parse(readJson(signedPath(root)).payload).mapVersion, '2026.10.08.2');
});

test('sign-map: versions compare as numbers per segment (…9 -> …10 is an upgrade, …10 -> …9 a downgrade)', async () => {
  const root = await keyedRoot();
  writeSource(root, mapAt('2026.10.08.9'));
  await signMap({ root, validate: accept });
  writeSource(root, mapAt('2026.10.08.10'));
  assert.equal((await signMap({ root, validate: accept })).changed, true, '10 > 9');
  writeSource(root, mapAt('2026.10.08.9'));
  await rejectsWith(signMap({ root, validate: accept }), /not greater/);
  assert.ok(compareMapVersions('2026.10.08.10', '2026.10.08.9') > 0, 'same ordering as the extension');
});

test('sign-map: malformed mapVersion values are refused before anything is signed', async () => {
  const root = await keyedRoot();
  for (const version of [undefined, null, 5, '', 'latest', '2026.10.07.', '1..2', 'v1.2', '1.2.3-beta', ' 1.2', '1e3', [], {}]) {
    writeSource(root, { ...mapAt('x'), mapVersion: version });
    const before = tree(root);
    await rejectsWith(signMap({ root, validate: accept, force: true }), /mapVersion must be a dotted numeric string/);
    assert.deepEqual(tree(root), before, JSON.stringify(version));
  }
});

test('sign-map: validateMapShape failures block signing in every shape, even with --force', async () => {
  const failing = {
    'ok:false with errors': () => ({ ok: false, errors: [{ path: 'roles.app', message: 'needs 2 selectors' }, { path: 'schema', message: 'must be 1' }] }),
    'ok:false without errors': () => ({ ok: false }),
    'errors without ok': () => ({ errors: ['one problem'] }),
    'plain false': () => false,
    'array of errors': () => ['e1', 'e2'],
    'throws': () => { throw new Error('exploded inside the validator'); },
    'async ok:false': async () => ({ ok: false, errors: ['async problem'] }),
  };
  const root = await keyedRoot();
  writeSource(root, mapAt('2026.10.08.1'));
  for (const [label, validate] of Object.entries(failing)) {
    const before = tree(root);
    await rejectsWith(signMap({ root, validate, force: true }), /failed validateMapShape:\n  - /, ToolError);
    assert.deepEqual(tree(root), before, `${label}: nothing written`);
  }
  await rejectsWith(signMap({ root, validate: () => ({ ok: false, errors: [{ path: 'roles.app', message: 'needs 2 selectors' }] }) }), /roles\.app: needs 2 selectors/);
  for (const passing of [() => ({ ok: true, errors: [] }), () => ({ ok: true }), () => true, () => undefined, () => [], async () => ({ ok: true })]) {
    const okRoot = await keyedRoot();
    writeSource(okRoot, mapAt('2026.10.08.1'));
    assert.equal((await signMap({ root: okRoot, validate: passing })).changed, true);
  }
});

test('sign-map: the validator is handed the parsed source map', async () => {
  const root = await keyedRoot();
  const map = mapAt('2026.10.08.1', { roles: { a: ['b'] } });
  writeSource(root, map);
  let seen;
  await signMap({ root, validate: (m) => { seen = m; return accept(); } });
  assert.deepEqual(seen, map);
});

test('sign-map: clear errors for a missing, unparsable or non-object source', async () => {
  const root = await keyedRoot();
  await rejectsWith(signMap({ root, validate: accept }), /selector-map\.source\.json does not exist.*nothing to sign/s);
  writeSource(root, '{ not json');
  await rejectsWith(signMap({ root, validate: accept }), /selector map source .*is not valid JSON/);
  for (const text of ['[]', 'null', '"map"', '42']) {
    writeSource(root, text);
    await rejectsWith(signMap({ root, validate: accept }), /must contain a JSON object/, ToolError);
  }
  assert.ok(!existsSync(signedPath(root)), 'nothing signed');
});

test('sign-map: without the private key it stops and points at npm run keys', async () => {
  const root = makeRoot();
  writeSource(root, mapAt('2026.10.08.1'));
  await rejectsWith(signMap({ root, validate: accept }), /private key .*not found.*npm run keys/s);
  assert.ok(!existsSync(signedPath(root)));
});

test('sign-map: refuses to sign with a key the extension does not ship', async () => {
  const root = await keyedRoot();
  writeSource(root, mapAt('2026.10.08.1'));
  const other = await keyedRoot();
  copyFileSync(publicKeysPath(other), publicKeysPath(root));       // public-keys.js now belongs to a different key pair
  await rejectsWith(signMap({ root, validate: accept }), /does not match SELECTOR_MAP_PUBLIC_KEY/);
  assert.ok(!existsSync(signedPath(root)));
});

test('sign-map: an unreadable existing signed file blocks the run unless --force', async () => {
  const root = await keyedRoot();
  writeSource(root, mapAt('2026.10.08.1'));
  for (const garbage of ['{ nope', '{"payload":"not json","sig":"x","kid":"k"}', '{"payload":"{}","sig":"x","kid":"k"}', '[]']) {
    writeFileSync(signedPath(root), garbage);
    await rejectsWith(signMap({ root, validate: accept }), /existing .*selector-map\.signed\.json is unreadable.*--force/s);
    assert.equal(readFileSync(signedPath(root), 'utf8'), garbage, 'garbage left alone');
  }
  assert.equal((await signMap({ root, validate: accept, force: true })).changed, true);
  const keys = await shipped(root);
  assert.equal((await verifyEnvelope(readJson(signedPath(root)), keys.SELECTOR_MAP_PUBLIC_KEY)).ok, true);
});

test('sign-map: a previously signed envelope whose signature is bad does not count as "already up to date"', async () => {
  const root = await keyedRoot();
  const map = mapAt('2026.10.08.1');
  writeSource(root, map);
  await signMap({ root, validate: accept });
  const envelope = readJson(signedPath(root));
  const forged = { ...envelope, sig: `${envelope.sig.slice(0, 40)}${envelope.sig[40] === 'A' ? 'B' : 'A'}${envelope.sig.slice(41)}` };
  writeFileSync(signedPath(root), JSON.stringify(forged));
  await rejectsWith(signMap({ root, validate: accept }), /not greater/, ToolError);       // same version, signature not trusted
  assert.equal((await signMap({ root, validate: accept, force: true })).changed, true);
});

test('sign-map: without an injected validator it uses src/shared/selector-map.js (or refuses if that is absent)', async (t) => {
  const root = await keyedRoot();
  writeSource(root, mapAt('2026.10.08.1'));
  if (existsSync(join(REPO, 'src', 'shared', 'selector-map.js'))) {
    // the real validator rejects this stub map (it is far too small), and the tool must surface that, not sign it
    await assert.rejects(signMap({ root }), (err) => err instanceof ToolError && /failed validateMapShape/.test(err.message));
    assert.ok(!existsSync(signedPath(root)));
  } else {
    t.diagnostic('src/shared/selector-map.js not written yet: checking the refusal path');
    await rejectsWith(signMap({ root }), /selector-map\.js does not exist.*Refusing to sign an unvalidated map/s);
  }
});

test('sign-map: the real source map signs with the real validator (skipped until both exist)', async (t) => {
  const source = sourcePath(REPO);
  if (!existsSync(source) || !existsSync(join(REPO, 'src', 'shared', 'selector-map.js'))) {
    t.skip('src/shared/selector-map.js is not written yet');
    return;
  }
  const root = await keyedRoot();
  mkdirSync(dirname(sourcePath(root)), { recursive: true });
  copyFileSync(source, sourcePath(root));
  const result = await signMap({ root });
  assert.equal(result.changed, true);
  const keys = await shipped(root);
  const envelope = readJson(signedPath(root));
  assert.equal((await verifyEnvelope(envelope, keys.SELECTOR_MAP_PUBLIC_KEY)).ok, true);
  assert.equal(JSON.parse(envelope.payload).mapVersion, JSON.parse(readFileSync(source, 'utf8')).mapVersion);
  assert.equal(envelope.payload, JSON.stringify(JSON.parse(readFileSync(source, 'utf8'))));
  // and the CLI does the same end to end
  const cliRoot = await keyedRoot();
  mkdirSync(dirname(sourcePath(cliRoot)), { recursive: true });
  copyFileSync(source, sourcePath(cliRoot));
  const cli = runTool('sign-map.mjs', ['--root', cliRoot]);
  assert.equal(cli.code, 0, cli.err);
  assert.match(cli.out, /signed selector map/);
  const again = runTool('sign-map.mjs', ['--root', cliRoot]);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /already signed and unchanged/);
});

// ---- dev-licence ---------------------------------------------------------------------------------------------------

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0, 345);

test('dev-licence: mints a pro token that the shipped licence key verifies', async () => {
  const root = await keyedRoot();
  const { token, claims } = await makeDevLicence({ root, now: NOW });
  const keys = await shipped(root);
  const iat = Math.floor(NOW / 1000);
  assert.deepEqual(claims, { v: 1, sub: 'dev@cinedrape.local', plan: 'pro', iat, exp: iat + 30 * DAY_S });
  const verified = await verifyLicenceToken(token, NOW, keys.LICENCE_PUBLIC_KEY);
  assert.deepEqual(verified, { valid: true, reason: 'ok', claims });
  assert.equal((await verifyLicenceToken(token, NOW, keys.SELECTOR_MAP_PUBLIC_KEY)).valid, false, 'wrong key');
  assert.deepEqual(licenceState({ token, claims: verified.claims, checkedAt: NOW }, NOW), { plan: 'pro', status: 'active' });
  assert.equal((await verifyLicenceToken(token, NOW + 31 * DAY_S * 1000, keys.LICENCE_PUBLIC_KEY)).reason, 'expired');
});

test('dev-licence: plan, days, sub, devices and lifetime are honoured', async () => {
  const root = await keyedRoot();
  const keys = await shipped(root);
  const iat = Math.floor(NOW / 1000);

  const free = await makeDevLicence({ root, now: NOW, plan: 'free', days: 7, sub: 'buyer@example.com', devices: 3 });
  assert.deepEqual(free.claims, { v: 1, sub: 'buyer@example.com', plan: 'free', iat, exp: iat + 7 * DAY_S, devices: 3 });
  assert.equal((await verifyLicenceToken(free.token, NOW, keys.LICENCE_PUBLIC_KEY)).claims.plan, 'free');

  const half = await makeDevLicence({ root, now: NOW, days: 0.5 });
  assert.equal(half.claims.exp, iat + 43200);

  const lifetime = await makeDevLicence({ root, now: NOW, lifetime: true });
  assert.ok(!('exp' in lifetime.claims));
  assert.equal((await verifyLicenceToken(lifetime.token, Date.UTC(2100, 0, 1), keys.LICENCE_PUBLIC_KEY)).valid, true);

  const one = await makeDevLicence({ root, now: NOW, days: 1 });
  const two = await makeDevLicence({ root, now: NOW, days: 1 });
  assert.notEqual(one.token, two.token, 'signatures are randomised');
});

test('dev-licence: bad options are refused with a message, nothing is minted', async () => {
  const root = await keyedRoot();
  for (const [label, options, pattern] of [
    ['plan gold', { plan: 'gold' }, /--plan must be one of free, pro/],
    ['plan PRO', { plan: 'PRO' }, /--plan/],
    ['plan empty', { plan: '' }, /--plan/],
    ['days 0', { days: 0 }, /--days/],
    ['days negative', { days: -3 }, /--days/],
    ['days NaN', { days: NaN }, /--days/],
    ['days Infinity', { days: Infinity }, /--days/],
    ['days string', { days: '30' }, /--days/],
    ['days huge', { days: 1e6 }, /--days/],
    ['sub empty', { sub: '' }, /--sub/],
    ['sub blank', { sub: '   ' }, /--sub/],
    ['sub too long', { sub: 'a'.repeat(321) }, /--sub/],
    ['sub number', { sub: 5 }, /--sub/],
    ['devices 0', { devices: 0 }, /--devices/],
    ['devices 1.5', { devices: 1.5 }, /--devices/],
    ['devices NaN', { devices: NaN }, /--devices/],
    ['devices -1', { devices: -1 }, /--devices/],
  ]) {
    await rejectsWith(makeDevLicence({ root, now: NOW, ...options }), pattern);
  }
});

test('dev-licence: refuses without the private key, or with a key the extension does not ship', async () => {
  const bare = makeRoot();
  await rejectsWith(makeDevLicence({ root: bare, now: NOW }), /private key .*not found.*npm run keys/s);

  const root = await keyedRoot();
  rmSync(privateKeyPath(root, 'licence'));
  await rejectsWith(makeDevLicence({ root, now: NOW }), /not found/);

  const mismatched = await keyedRoot();
  const other = await keyedRoot();
  copyFileSync(publicKeysPath(other), publicKeysPath(mismatched));
  await rejectsWith(makeDevLicence({ root: mismatched, now: NOW }), /does not match LICENCE_PUBLIC_KEY/);

  // the selector-map key cannot be used to mint licences
  const swapped = await keyedRoot();
  copyFileSync(privateKeyPath(swapped, 'selector-map'), privateKeyPath(swapped, 'licence'));
  await rejectsWith(makeDevLicence({ root: swapped, now: NOW }), /does not match LICENCE_PUBLIC_KEY/);
});

test('dev-licence: the DEV ONLY banner is explicit', () => {
  assert.match(BANNER, /^\*\*\* DEV ONLY \*\*\*/);
  assert.match(BANNER, /Never sell, ship or share/);
});

// ---- CLI wiring (a few quick spawns) -------------------------------------------------------------------------------

test('CLIs: exit codes, stdout/stderr split and the --root flag', async () => {
  const root = makeRoot();

  const gen = runTool('gen-keys.mjs', ['--root', root]);
  assert.equal(gen.code, 0, gen.err);
  assert.match(gen.out, /generated selector-map key selector-map-1/);
  assert.match(gen.out, /DEV keys/);
  assert.ok(existsSync(publicKeysPath(root)));
  const regen = runTool('gen-keys.mjs', ['--root', root]);
  assert.equal(regen.code, 0, regen.err);
  assert.match(regen.out, /kept\s+licence key licence-1/);

  const licence = runTool('dev-licence.mjs', ['--plan', 'pro', '--days', '30', '--sub', 'qa@example.com', '--devices', '2', '--root', root]);
  assert.equal(licence.code, 0, licence.err);
  assert.match(licence.err, /DEV ONLY/);
  assert.match(licence.err, /plan pro, sub qa@example\.com, expires \d{4}-\d\d-\d\dT.*, 2 devices/);
  const token = licence.out.trim();
  assert.equal(licence.out, `${token}\n`, 'stdout is exactly the token');
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/);
  assert.doesNotMatch(licence.out, /DEV ONLY/);
  const keys = await shipped(root);
  const verified = await verifyLicenceToken(token, Date.now(), keys.LICENCE_PUBLIC_KEY);
  assert.equal(verified.valid, true);
  assert.equal(verified.claims.sub, 'qa@example.com');
  assert.equal(verified.claims.devices, 2);
  assert.ok(Math.abs(verified.claims.exp - verified.claims.iat - 30 * DAY_S) <= 1);

  const lifetime = runTool('dev-licence.mjs', ['--lifetime', '--plan', 'free', '--root', root]);
  assert.equal(lifetime.code, 0, lifetime.err);
  assert.match(lifetime.err, /no expiry/);

  const noSource = runTool('sign-map.mjs', ['--root', root]);
  assert.equal(noSource.code, 1);
  assert.match(noSource.err, /sign-map: .*selector-map\.source\.json does not exist/);
  assert.equal(noSource.out, '');
});

test('CLIs: bad usage exits 2, tool errors exit 1 with a one-line message (main() in-process)', async () => {
  const root = makeRoot();
  const bogus = await runMain(genKeysMain, ['--bogus']);
  assert.equal(bogus.code, 2);
  assert.match(bogus.err, /usage: node tools\/gen-keys\.mjs/);
  assert.equal((await runMain(signMapMain, ['--nope'])).code, 2);
  assert.equal((await runMain(devLicenceMain, ['--nope'])).code, 2);
  assert.equal((await runMain(devLicenceMain, ['--plan'])).code, 2, 'option without a value');
  const both = await runMain(devLicenceMain, ['--days', '3', '--lifetime', '--root', root]);
  assert.equal(both.code, 2);
  assert.match(both.err, /cannot be combined/);

  const noKey = await runMain(devLicenceMain, ['--root', root]);
  assert.equal(noKey.code, 1);
  assert.match(noKey.err, /dev-licence: private key .*npm run keys/);
  assert.equal(noKey.out, '', 'no token on stdout when refusing');
  await runGenKeys({ root });
  for (const args of [['--plan', 'gold'], ['--days', 'abc'], ['--days', ''], ['--days=-1'], ['--days=0'], ['--devices', 'x']]) {
    const result = await runMain(devLicenceMain, [...args, '--root', root]);
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(result.out, '', 'nothing minted');
    assert.equal(result.err.split('\n').length, 1, 'one-line message');
  }

  for (const main of [genKeysMain, signMapMain, devLicenceMain]) {
    const help = await runMain(main, ['--help']);
    assert.equal(help.code, 0);
    assert.match(help.out, /^usage: node tools\//);
  }
});

test('importing a tool has no side effects (only running it does)', async () => {
  const root = makeRoot();
  const before = tree(root);
  await import(`${pathToFileURL(join(TOOLS, 'gen-keys.mjs')).href}?again=${Math.random()}`);
  await import(`${pathToFileURL(join(TOOLS, 'sign-map.mjs')).href}?again=${Math.random()}`);
  await import(`${pathToFileURL(join(TOOLS, 'dev-licence.mjs')).href}?again=${Math.random()}`);
  assert.deepEqual(tree(root), before);
});

// ---- KEY_STATUS sentinel (the release guard tests this, never the header prose) -------------------------------------------

import { readKeyStatus } from '../../tools/gen-keys.mjs';

test('gen-keys writes an explicit KEY_STATUS sentinel: dev by default and after --force, kept by an idempotent re-run', async () => {
  const root = await keyedRoot();
  const source = readFileSync(publicKeysPath(root), 'utf8');
  assert.match(source, /^export const KEY_STATUS = 'dev';$/m);
  assert.equal(await readKeyStatus(root), 'dev');
  assert.equal((await runGenKeys({ root })).status, 'dev');
  assert.equal((await runGenKeys({ root, force: true })).status, 'dev');
  assert.equal(await readKeyStatus(root), 'dev');
});

test('gen-keys --production makes fresh pairs and the sentinel says production; a later idempotent run does not downgrade it; --force does', async () => {
  const root = await keyedRoot();
  const dev = await shipped(root);
  const result = await runGenKeys({ root, production: true });
  assert.equal(result.status, 'production');
  assert.deepEqual(result.generated.sort(), ['licence', 'selector-map']);
  assert.equal(result.backups.length, 2, 'the dev private keys are kept as backups, not reused as production keys');
  const prod = await shipped(root);
  assert.notEqual(prod.LICENCE_PUBLIC_KEY.x, dev.LICENCE_PUBLIC_KEY.x, 'a production label never lands on keys that were already in use');
  const source = readFileSync(publicKeysPath(root), 'utf8');
  assert.match(source, /^export const KEY_STATUS = 'production';$/m);
  assert.doesNotMatch(source, /!! DEV KEYS !!/, 'the header no longer claims the keys are dev keys');
  assert.match(source, /KMS\/HSM/);
  assert.equal(await readKeyStatus(root), 'production');
  assert.equal((await runGenKeys({ root })).status, 'production', 'idempotent: same keys, same status');
  assert.equal((await runGenKeys({ root })).wrotePublicKeys, false);
  assert.equal((await runGenKeys({ root, force: true })).status, 'dev', 'fresh dev pairs are dev again');
});

test('readKeyStatus: a missing file, a file without the sentinel and an unknown value are all "not releasable" (null)', async () => {
  const root = makeRoot();
  assert.equal(await readKeyStatus(root), null);
  mkdirSync(dirname(publicKeysPath(root)), { recursive: true });
  writeFileSync(publicKeysPath(root), "// old file\nexport const LICENCE_PUBLIC_KEY = {};\n");
  assert.equal(await readKeyStatus(root), null);
  writeFileSync(publicKeysPath(root), "export const KEY_STATUS = 'staging';\n");
  assert.equal(await readKeyStatus(root), null);
  writeFileSync(publicKeysPath(root), "export const KEY_STATUS = 'production';\n");
  assert.equal(await readKeyStatus(root), 'production');
});

test('package.mjs tests the sentinel and no longer keys on the header wording', () => {
  const src = readFileSync(join(REPO, 'tools', 'package.mjs'), 'utf8');
  assert.match(src, /readKeyStatus/);
  assert.match(src, /KEY_STATUS !== 'production'/);
  assert.doesNotMatch(src, /DEV keys\/i/);
  assert.doesNotMatch(src, /\.test\(keysSrc\)/);
});

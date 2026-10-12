// Signs the selector map: src/data/selector-map.source.json -> src/data/selector-map.signed.json   (npm run sign-map)
//   node tools/sign-map.mjs [--force] [--root <dir>]
//
// The envelope is { payload: JSON.stringify(map), sig, kid } (see src/shared/signing.js). Rules:
//   - the map must pass validateMapShape (src/shared/selector-map.js); --force never skips that;
//   - mapVersion must be strictly greater than the one already signed (compared segment by segment as numbers), so a
//     stale file can never replace a newer one; --force allows an equal or lower version;
//   - running again on an unchanged, already-signed map is a no-op (ECDSA signatures are randomised, so re-signing would
//     only churn the file);
//   - the key must be the pair whose public half is in src/shared/public-keys.js, or no installed extension would accept it.
// Nothing is written unless every check passes.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { compareMapVersions, signEnvelope, verifyEnvelope } from '../src/shared/signing.js';
import { ToolError, loadKeyPair } from './gen-keys.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELECTOR_MODULE = join(REPO_ROOT, 'src', 'shared', 'selector-map.js');

export const sourcePath = (root) => join(root, 'src', 'data', 'selector-map.source.json');
export const signedPath = (root) => join(root, 'src', 'data', 'selector-map.signed.json');

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Real validator from src/shared/selector-map.js, imported lazily because another module owns (and may not have written) it. */
async function loadValidator() {
  if (!existsSync(SELECTOR_MODULE)) {
    throw new ToolError(`${SELECTOR_MODULE} does not exist yet, so the map cannot be validated. Refusing to sign an unvalidated map.`);
  }
  const mod = await import(pathToFileURL(SELECTOR_MODULE).href);
  if (typeof mod.validateMapShape !== 'function') throw new ToolError(`${SELECTOR_MODULE} does not export validateMapShape.`);
  return mod.validateMapShape;
}

/** Accepts the ways a validator can say no: throwing, false, {ok:false,errors}, {errors:[…]}, or a non-empty array of errors. */
function validationFailure(result) {
  if (result === false) return ['validation failed'];
  if (Array.isArray(result)) return result.length ? result.map(String) : null;
  if (isPlain(result)) {
    const errors = Array.isArray(result.errors) ? result.errors : [];
    if (result.ok === false || (result.ok === undefined && errors.length)) {
      return errors.length ? errors.map((e) => (isPlain(e) ? `${e.path ? `${e.path}: ` : ''}${e.message ?? JSON.stringify(e)}` : String(e))) : ['validation failed'];
    }
  }
  return null;
}

function readJson(file, what) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new ToolError(`cannot read ${what} ${file}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ToolError(`${what} ${file} is not valid JSON: ${err.message}`);
  }
}

function previousVersion(file, force) {
  if (!existsSync(file)) return { version: null, payload: null, envelope: null };
  try {
    const envelope = JSON.parse(readFileSync(file, 'utf8'));
    const payload = envelope.payload;
    const version = JSON.parse(payload).mapVersion;
    if (typeof version !== 'string') throw new Error('no mapVersion in the signed payload');
    return { version, payload, envelope };
  } catch (err) {
    if (force) return { version: null, payload: null, envelope: null };
    throw new ToolError(`the existing ${file} is unreadable (${err.message}), so its version cannot be compared. Fix or delete it, or pass --force.`);
  }
}

/**
 * @param {{root?: string, force?: boolean, validate?: (map: object) => unknown}} [options] `validate` replaces the real
 *   validateMapShape (tests only).
 * @returns {Promise<{changed: boolean, mapVersion: string, previousVersion: string|null, envelope: object, file: string}>}
 */
export async function signMap({ root = REPO_ROOT, force = false, validate } = {}) {
  const src = sourcePath(root);
  if (!existsSync(src)) {
    throw new ToolError(`${src} does not exist. The selector map source is written by the selectors/mapData work; there is nothing to sign yet.`);
  }
  const map = readJson(src, 'selector map source');
  if (!isPlain(map)) throw new ToolError(`${src} must contain a JSON object (the map), not ${Array.isArray(map) ? 'an array' : typeof map}.`);

  let failures;
  try {
    failures = validationFailure(await (validate || (await loadValidator()))(map));
  } catch (err) {
    if (err instanceof ToolError) throw err;
    failures = [err && err.message ? err.message : String(err)];
  }
  if (failures) throw new ToolError(`${src} failed validateMapShape:\n  - ${failures.join('\n  - ')}`);

  const version = map.mapVersion;
  if (typeof version !== 'string' || Number.isNaN(compareMapVersions(version, version))) {
    throw new ToolError(`mapVersion must be a dotted numeric string such as "2026.10.07.1", got ${JSON.stringify(version)}.`);
  }

  const out = signedPath(root);
  const prev = previousVersion(out, force);
  const payload = JSON.stringify(map);
  const { privateJwk, publicJwk } = await loadKeyPair(root, 'selector-map');

  if (prev.envelope && prev.payload === payload && prev.envelope.kid === privateJwk.kid && (await verifyEnvelope(prev.envelope, publicJwk)).ok) {
    return { changed: false, mapVersion: version, previousVersion: prev.version, envelope: prev.envelope, file: out };
  }
  if (prev.version !== null && !force && !(compareMapVersions(version, prev.version) > 0)) {
    throw new ToolError(
      `mapVersion ${version} is not greater than the signed ${prev.version}. Bump mapVersion in ${src} (a lower or equal version would be rejected as a downgrade), or pass --force.`,
    );
  }

  const envelope = await signEnvelope(payload, privateJwk, privateJwk.kid);
  const check = await verifyEnvelope(envelope, publicJwk);
  if (!check.ok || check.payload !== payload) throw new ToolError(`the fresh signature does not verify against the shipped public key (${check.reason}).`);

  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(envelope, null, 2)}\n`);
  renameSync(tmp, out);
  return { changed: true, mapVersion: version, previousVersion: prev.version, envelope, file: out };
}

const USAGE = 'usage: node tools/sign-map.mjs [--force] [--root <dir>]';

export async function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { force: { type: 'boolean' }, root: { type: 'string' }, help: { type: 'boolean' } }, strict: true }));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    const result = await signMap({ root: values.root ? resolve(values.root) : REPO_ROOT, force: Boolean(values.force) });
    console.log(result.changed
      ? `signed selector map ${result.mapVersion} (kid ${result.envelope.kid}, previous ${result.previousVersion ?? 'none'}) -> ${result.file}`
      : `selector map ${result.mapVersion} is already signed and unchanged; nothing to do`);
    return 0;
  } catch (err) {
    if (!(err instanceof ToolError)) console.error(err && err.stack ? err.stack : err);
    else console.error(`sign-map: ${err.message}`);
    return 1;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) process.exitCode = await main();

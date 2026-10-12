// Shared setup for the engine and ad-safety tests: real signed map, real themes, a jsdom page, the chrome mock and
// throwaway key pairs. Not a test file (the name does not match *.test.js).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPage } from './dom.js';
import { createChromeMock } from './chrome-mock.js';
import { createEngine } from '../../src/content/engine.js';
import { THEMES } from '../../src/themes/index.js';
import { signEnvelope, toPublicJwk } from '../../src/shared/signing.js';
import { signLicenceToken } from '../../src/shared/licence.js';
import { STORAGE_KEYS } from '../../src/shared/constants.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
export const bundledEnvelope = JSON.parse(readFileSync(path.join(SRC, 'data', 'selector-map.signed.json'), 'utf8'));
export const MAP = JSON.parse(bundledEnvelope.payload);
export { THEMES };

/** A throwaway ECDSA P-256 key pair: {privateJwk, publicJwk(kid)}. */
export async function makeKeyPair(kid) {
  const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await globalThis.crypto.subtle.exportKey('jwk', pair.privateKey);
  return { privateJwk, publicJwk: toPublicJwk(privateJwk, kid) };
}

/** A Pro licence record as the background stores it ({token, claims, checkedAt}) signed by `privateJwk`. */
export async function proLicence(privateJwk, { now = Date.now(), plan = 'pro', days = 30 } = {}) {
  const claims = { v: 1, sub: 'tester', plan, iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + days * 86400 };
  const token = await signLicenceToken(claims, privateJwk);
  return { token, claims, checkedAt: now };
}

/** A signed selector-map envelope with a different mapVersion (and optionally an extra role) signed by `privateJwk`. */
export async function signedMap(privateJwk, mapVersion, patch = (m) => m) {
  const map = patch(structuredClone({ ...MAP, mapVersion }));
  return signEnvelope(JSON.stringify(map), privateJwk, 'selector-map-1');
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `fn` until it returns truthy (rejects with `label` after `ms`). */
export async function waitFor(fn, label = 'condition', ms = 1500) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await sleep(4);
  }
}

/**
 * Builds a page + chrome mock + engine. `stored` pre-fills chrome.storage.local (settings/licence/selectorMap by short name).
 * Nothing is started; the caller decides when. The page window is closed by `env.close()`.
 */
export async function createEnv(kind = 'home', { page: pageOpts = {}, stored = {}, engine: engineOpts = {} } = {}) {
  const page = createPage(kind, pageOpts);
  const mock = createChromeMock();
  const keyOf = { settings: STORAGE_KEYS.settings, licence: STORAGE_KEYS.licence, selectorMap: STORAGE_KEYS.selectorMap };
  const items = {};
  for (const [name, value] of Object.entries(stored)) items[keyOf[name] || name] = value;
  if (Object.keys(items).length) await mock.chrome.storage.local.set(items);
  const engine = createEngine({
    doc: page.document, win: page.window, chrome: mock.chrome, themes: THEMES, bundledEnvelope, healthTimeoutMs: 0, readability: false, ...engineOpts,
  });
  const env = {
    page, mock, engine, document: page.document, window: page.window, chrome: mock.chrome,
    html: page.document.documentElement,
    style: () => page.document.getElementById('cinedrape-theme'),
    set: (name, value) => mock.chrome.storage.local.set({ [keyOf[name] || name]: value }),
    attr: (name) => page.document.documentElement.getAttribute(name),
    close: () => { try { engine.stop(); } catch { /* already stopped */ } page.window.close(); },
  };
  return env;
}

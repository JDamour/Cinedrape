// Selector map helpers (ARCHITECTURE.md section 3.1 and section 4 "shared/selector-map.js").
//
// The map is data the server can update without a store release: roles -> selectors, the protected ad / sponsor / player
// control groups, the colour bridge. Everything here is pure and tolerant of a broken map object (it returns '' or the input
// unchanged instead of throwing), except validateMapShape, whose whole job is to say what is wrong.
//
//   roleCss(map, role)         comma-joined selectors of a role ('' when missing)
//   protectedCss(map, group?)  comma-joined protected selectors (no group = ads + sponsor + playerControls)
//   safeHide(map, selector)    selector + :not(:has(<protected ads>)); EVERY engine-generated hide rule goes through this
//   validateMapShape(map)      {ok, errors:[{path, message}]}
//   parseEnvelopePayload(env)  the map inside a (signature-verified) envelope, or null
//   buildAllowList(map)        re-exported from css-validator.js
import { buildAllowList, parseSelectorString } from './css-validator.js';

export { buildAllowList };

/** Role names every healthy map defines (ARCHITECTURE.md section 3.1). */
export const REQUIRED_ROLES = Object.freeze(['app', 'pageManager', 'masthead', 'guide', 'miniGuide', 'homeBrowse', 'homeGrid',
  'richItem', 'videoTile', 'tileLink', 'tileTitle', 'tileThumb', 'tileDuration', 'tileChannel', 'tileMeta', 'continuation', 'chips',
  'watchFlexy', 'watchPlayer', 'watchPlayerContainer', 'watchPrimary', 'watchSecondary', 'watchRelated', 'watchMetadata', 'watchTitle',
  'comments', 'endScreens', 'viewCounts', 'shortsShelf', 'shortsNavEntry', 'shortsTiles',
  'searchResults', 'channelHeader', 'subscriptionsGrid', 'historyList', 'playlistPanel']);
export const PROTECTED_GROUPS = Object.freeze(['ads', 'sponsor', 'playerControls', 'containers']);
export const VAR_KEYS = Object.freeze(['bg', 'surface', 'menu', 'text', 'muted', 'accent', 'accentHover', 'border', 'borderOpaque', 'overlay']);
export const TILE_FIELD_KEYS = Object.freeze(['link', 'title', 'thumb', 'duration', 'channel', 'meta']);

const MAX_ROLES = 256;
const MAX_SELECTORS_PER_LIST = 64;
const MAX_PROTECTED_SELECTORS = 256;
const MAX_SELECTOR_CHARS = 1000;
const MAX_PAYLOAD_CHARS = 1_000_000;
const MAX_ERRORS = 60;
const LEGACY_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Non-empty trimmed string entries of map[section][key], or []. Never throws. */
function listOf(map, section, key) {
  try {
    if (!isObj(map) || typeof key !== 'string') return [];
    const sec = map[section];
    if (!isObj(sec) || !own(sec, key)) return [];
    const list = sec[key];
    if (!Array.isArray(list)) return [];
    return list.filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.trim());
  } catch {
    return [];
  }
}

/** Splits a selector list on its top-level commas (not those inside (), [] or strings). Empty members are dropped. */
export function splitSelectorList(css) {
  const out = [];
  if (typeof css !== 'string') return out;
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) { out.push(css.slice(start, i)); start = i + 1; }
  }
  out.push(css.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Text that can sit inside a selector list without breaking out of it: balanced brackets and quotes, no braces, semicolons or comments. */
function isSafeSelectorText(s) {
  if (/[{};\n\r\f]|\/\*|\*\/|<!--|-->/.test(s)) return false;
  const stack = [];
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') stack.push(ch === '(' ? ')' : ']');
    else if (ch === ')' || ch === ']') { if (stack.pop() !== ch) return false; }
  }
  return !quote && stack.length === 0;
}

/**
 * Comma-joined selectors of a role, in map order. '' when the map or the role is missing or malformed.
 * @param {object} map @param {string} role
 * @returns {string}
 */
export function roleCss(map, role) {
  return listOf(map, 'roles', role).join(', ');
}

/**
 * Comma-joined protected selectors. With no group: ads + sponsor + playerControls (the things that must never be hidden).
 * `containers` is a group of its own: elements that may CONTAIN an ad.
 * @param {object} map @param {'ads'|'sponsor'|'playerControls'|'containers'} [group]
 * @returns {string}
 */
export function protectedCss(map, group) {
  if (group === undefined || group === null) {
    return ['ads', 'sponsor', 'playerControls'].flatMap((g) => listOf(map, 'protected', g)).join(', ');
  }
  if (typeof group !== 'string' || !PROTECTED_GROUPS.includes(group)) return '';
  return listOf(map, 'protected', group).join(', ');
}

/** Index at which a guard may be attached to a complex selector: before any trailing pseudo-element, else at the end. */
function guardIndex(m) {
  let depth = 0;
  let quote = '';
  let pseudoEl = -1;
  for (let i = 0; i < m.length; i++) {
    const ch = m[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '[') { depth++; continue; }
    if (ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;
    if (ch === ' ' || ch === '\t' || ch === '>' || ch === '+' || ch === '~') { pseudoEl = -1; continue; }
    if (ch === ':') {
      if (m[i + 1] === ':') {
        if (pseudoEl < 0) pseudoEl = i;
        i++;
      } else if (pseudoEl < 0) {
        const name = /^[A-Za-z-]+/.exec(m.slice(i + 1));
        if (name && LEGACY_ELEMENTS.has(name[0].toLowerCase())) pseudoEl = i;
      }
    }
  }
  return pseudoEl >= 0 ? pseudoEl : m.length;
}

/**
 * The only way to build a hide rule. Appends :not(:has(<protected.ads>)) to the selector, so an element that contains an ad
 * (a feed row, a shelf, a wrapper) is never matched. Selector lists are guarded member by member; a trailing pseudo-element
 * stays last (a.b::after -> a.b:not(:has(...))::after). A map with NO protected.ads returns the selector unchanged (validateMapShape
 * reports such a map, and the engine refuses to emit rules built from it); a map whose list has an entry that cannot sit inside the
 * guard (a brace, a semicolon, a newline, unbalanced brackets) returns '' (no rule at all) instead of a weaker guard.
 * @param {object} map @param {string} selector
 * @returns {string}
 */
export function safeHide(map, selector) {
  if (typeof selector !== 'string') return '';
  const members = splitSelectorList(selector);
  if (!members.length) return '';
  const listed = listOf(map, 'protected', 'ads');
  const ads = listed.filter(isSafeSelectorText);
  // Fail CLOSED: a guard that had to drop an entry protects less than the map says, so no rule is better than that rule.
  if (listed.length > 0 && ads.length !== listed.length) return '';
  if (!ads.length) return selector;
  const guard = `:not(:has(${ads.join(', ')}))`;
  return members.map((m) => {
    const at = guardIndex(m);
    if (m.slice(0, at).endsWith(guard)) return m;   // already guarded (also when a pseudo-element follows the guard)
    return m.slice(0, at) + guard + m.slice(at);
  }).join(', ');
}

// ---- shape validation ---------------------------------------------------------------------------------------------------

function selectorList(err, path, value, { min = 1, max = MAX_SELECTORS_PER_LIST } = {}) {
  if (!Array.isArray(value)) { err(path, 'Must be an array of selector strings.'); return; }
  if (value.length < min) err(path, min === 1 ? 'Must list at least one selector.' : `Must list at least ${min} selectors.`);
  if (value.length > max) err(path, `Must list at most ${max} selectors.`);
  for (let i = 0; i < Math.min(value.length, max); i++) {
    const at = `${path}[${i}]`;
    const sel = value[i];
    if (typeof sel !== 'string') { err(at, 'Must be a string.'); continue; }
    if (sel.trim() === '') { err(at, 'Must not be empty.'); continue; }
    if (sel.length > MAX_SELECTOR_CHARS) { err(at, `Must be at most ${MAX_SELECTOR_CHARS} characters.`); continue; }
    const parsed = parseSelectorString(sel);
    if (!parsed.list) { err(at, `Is not a valid selector: ${parsed.errors[0] ? parsed.errors[0].message : 'syntax error'}.`); continue; }
    if (parsed.list.length !== 1) err(at, 'Must be ONE complex selector with no top-level comma (list each alternative as its own entry).');
  }
}

function checkShape(map, err) {
  if (!isObj(map)) { err('', 'The selector map must be a JSON object.'); return; }
  if (map.schema !== 1) err('schema', 'Must be the number 1.');
  if (typeof map.mapVersion !== 'string' || !/^\d{1,9}(?:\.\d{1,9}){0,5}$/.test(map.mapVersion)) err('mapVersion', 'Must be a dotted numeric string such as "2026.10.07.1".');
  if (typeof map.issuedAt !== 'string' || Number.isNaN(Date.parse(map.issuedAt))) err('issuedAt', 'Must be an ISO date string.');

  const roles = isObj(map.roles) ? map.roles : null;
  if (!roles) err('roles', 'Must be an object of role -> selector list.');
  else {
    const names = Object.keys(roles);
    if (names.length > MAX_ROLES) err('roles', `Must define at most ${MAX_ROLES} roles.`);
    for (const name of REQUIRED_ROLES) if (!own(roles, name)) err(`roles.${name}`, 'Required role is missing.');
    for (const name of names.slice(0, MAX_ROLES)) {
      if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name)) { err(`roles.${name}`, 'Role names are letters and digits, starting with a letter.'); continue; }
      selectorList(err, `roles.${name}`, roles[name]);
    }
  }

  const known = (name) => roles !== null && own(roles, name);
  const roleRefs = (path, value) => {
    if (!isObj(value)) { err(path, 'Must be an object of name -> role list.'); return; }
    for (const key of Object.keys(value)) {
      const list = value[key];
      if (!Array.isArray(list) || list.length > MAX_ROLES || !list.every((r) => typeof r === 'string')) { err(`${path}.${key}`, 'Must be an array of role names.'); continue; }
      for (const r of list) if (!known(r)) err(`${path}.${key}`, `Names the unknown role "${r}".`);
    }
  };
  roleRefs('pageRoles', map.pageRoles);
  roleRefs('requires', map.requires);

  const prot = isObj(map.protected) ? map.protected : null;
  if (!prot) err('protected', 'Must be an object with ads, sponsor, playerControls and containers.');
  else for (const g of PROTECTED_GROUPS) selectorList(err, `protected.${g}`, prot[g], { max: MAX_PROTECTED_SELECTORS });

  if (!isObj(map.vars)) err('vars', 'Must be an object of colour token -> YouTube variable names.');
  else {
    for (const key of VAR_KEYS) {
      const v = map.vars[key];
      if (!Array.isArray(v) || v.length === 0 || v.length > 32 || !v.every((n) => typeof n === 'string' && /^--[A-Za-z0-9_-]+$/.test(n))) {
        err(`vars.${key}`, 'Must be a non-empty array of CSS custom property names (--name).');
      }
    }
  }

  if (!isObj(map.tileFields)) err('tileFields', 'Must be an object of field -> selector list.');
  else for (const key of TILE_FIELD_KEYS) selectorList(err, `tileFields.${key}`, map.tileFields[key]);

  if (map._unverified !== undefined) {
    const u = map._unverified;
    if (!Array.isArray(u) || !u.every((r) => typeof r === 'string' && known(r))) err('_unverified', 'Must be an array of known role names.');
  }
}

/**
 * Structural check of a selector map. Deep enough that an engine reading it cannot be blanked or fooled: every selector must
 * parse as exactly one complex selector, every protected group must be non-empty (the ad guard cannot be empty), and
 * pageRoles/requires may only name roles that exist.
 * @param {object} map
 * @returns {{ok: boolean, errors: Array<{path: string, message: string}>}}
 */
export function validateMapShape(map) {
  const errors = [];
  const err = (path, message) => { if (errors.length < MAX_ERRORS) errors.push({ path, message }); };
  try {
    checkShape(map, err);
  } catch {
    err('', 'The selector map could not be read.');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * The map inside a signed envelope {payload, sig, kid}. This does NOT verify the signature (signing.js does, first); it parses
 * the payload and shape-checks it. A string envelope is parsed as JSON first.
 * @param {object|string} envelope
 * @returns {object|null}
 */
export function parseEnvelopePayload(envelope) {
  try {
    const env = typeof envelope === 'string' && envelope.length <= MAX_PAYLOAD_CHARS ? JSON.parse(envelope) : envelope;
    if (!isObj(env) || typeof env.payload !== 'string' || env.payload.length > MAX_PAYLOAD_CHARS) return null;
    const map = JSON.parse(env.payload);
    return validateMapShape(map).ok ? map : null;
  } catch {
    return null;
  }
}

// Data tests for src/data/selector-map.source.json (owner: mapData agent).
//
// What this proves, in order:
//   1. The file is clean JSON (no duplicate keys, right keys, right version/date format, bounded size).
//   2. Every required role exists with real fallbacks, no selector is over-broad, comma-free and parseable.
//   3. pageRoles / requires only name real roles / real FEATURES, and are HONEST: every role a feature requires on a page is
//      present in that page's fixture (also with zero tiles, an empty-state page, and both home tile shapes), so the health
//      check cannot false-alarm on a healthy page.
//   4. The tile-metadata selectors (viewCounts, tileChannel) pick the right text in every metadata shape of ARCHITECTURE.md
//      section 1 - including the LIVE shape (leading eye icon, verified-badge icon) that the trimmed fixtures stripped.
//   5. Fallbacks really are fallbacks: simulated YouTube renames keep the role alive (or fail safe: nothing wrong is matched).
//   6. protected.* matches the synthetic ads/sponsor markup, does not match ordinary content, covers every wrapper that
//      can hold an ad, and never overlaps the elements calm mode needs to hide.
//   7. The colour bridge names exist in YouTube's live variable set (test/fixtures/real/computed-colors.json).
//   8. validateMapShape (src/shared/selector-map.js, written by another agent) accepts the map. That module may not exist yet:
//      this file is then SKIPPED LOUDLY, and becomes fully active in the reconcile pass.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { createPage, loadFixture, applyRename, readTile } from '../helpers/dom.js';
import { FEATURES, PAGE_TYPES } from '../../src/shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAP_FILE = path.join(ROOT, 'src', 'data', 'selector-map.source.json');
const DOC_FILE = path.join(ROOT, 'test', 'data', 'LIVE-VERIFICATION.md');
const RAW = readFileSync(MAP_FILE, 'utf8');
const MAP = JSON.parse(RAW);

const REQUIRED_ROLES = ['app', 'pageManager', 'masthead', 'guide', 'miniGuide', 'homeBrowse', 'homeGrid', 'homeGridContents',
  'richItem', 'videoTile', 'tileLink', 'tileTitle', 'tileThumb', 'tileDuration', 'tileChannel', 'tileMeta', 'continuation', 'chips',
  'watchFlexy', 'watchPlayer', 'watchPlayerContainer', 'watchPrimary', 'watchSecondary', 'watchRelated', 'watchMetadata',
  'watchTitle', 'comments', 'endScreens', 'viewCounts', 'shortsShelf', 'shortsNavEntry', 'shortsTiles', 'searchResults',
  'channelHeader', 'subscriptionsGrid', 'historyList', 'playlistPanel'];
const TOP_KEYS = ['schema', 'mapVersion', 'issuedAt', 'roles', 'pageRoles', 'requires', 'protected', 'vars', 'tileFields', '_unverified'];
const GROUPS = ['ads', 'sponsor', 'playerControls', 'containers'];
const VAR_KEYS = ['bg', 'surface', 'menu', 'text', 'muted', 'accent', 'accentHover', 'border', 'borderOpaque', 'overlay'];
// Tokens that have a well-known legacy equivalent (older cohorts). The others only exist in the new sys family.
const KEYS_WITH_LEGACY = ['bg', 'surface', 'menu', 'text', 'muted', 'accent', 'border'];
const TILE_FIELDS = { link: 'tileLink', title: 'tileTitle', thumb: 'tileThumb', duration: 'tileDuration', channel: 'tileChannel', meta: 'tileMeta' };

// A role may carry a single selector only when a second one would be fiction. Each exception is justified here and pinned
// (a test fails if an exception stops being a single selector, so the list cannot rot).
const SINGLE_SELECTOR_OK = {
  app: 'ytd-app is the unique root custom element of the whole site; if it is renamed nothing on YouTube is recognisable and no alternative anchor exists',
  miniGuide: 'ytd-mini-guide-renderer is a unique custom element; its only other handles (role=navigation, #items) are shared with the full guide',
};
// Per-role selector budget. The contract says 2-3 is a guide, not a cap where section 1 lists more live shapes.
const MAX_SELECTORS = { default: 4, viewCounts: 9, shortsShelf: 5 };
// Roles that are one element per page by nature: every individual selector must match at most one element per fixture page
// (catches an accidentally over-broad selector far better than a ban-list). Roles with several legitimate hits are absent.
const SINGLETON_ROLES = ['app', 'pageManager', 'masthead', 'guide', 'miniGuide', 'homeBrowse', 'homeGrid', 'homeGridContents',
  'watchFlexy', 'watchPlayer', 'watchPlayerContainer', 'watchPrimary', 'watchSecondary', 'watchRelated', 'watchMetadata',
  'watchTitle', 'searchResults', 'channelHeader', 'subscriptionsGrid', 'historyList', 'playlistPanel'];
// Selectors whose subject (the last compound) is a bare HTML tag. Allowed only when an ancestor compound anchors them to a
// YouTube custom element or class; anything new must be reviewed and added here on purpose.
const ALLOWED_BARE_SUBJECT = new Set([
  'ytd-channel-name a', '.ytThumbnailViewModelImage img', 'yt-thumbnail-view-model img', 'ytd-thumbnail img', 'ytd-watch-metadata h1',
  'ytd-watch-metadata #title h1', 'ytd-watch-flexy #title h1', 'ytd-watch-grid #title h1',
  '#contents > div', // protected.containers only: the unclassed wrapper <div> around each playlist row
]);
const BANNED_WHOLE = new Set(['*', 'div', 'a', 'span', 'img', 'p', 'li', 'ul', 'ol', 'button', 'input', 'h1', 'h2', 'h3', 'h4', 'body',
  'html', ':root', 'svg', 'path', 'section', 'article', 'nav', 'main', 'header', 'footer', 'video', 'text', 'label', 'form', 'table']);
// Which fixture pages exercise which feature (the pages where its requirements are evaluated by health).
const FEATURE_PAGES = {
  theme: ['home', 'watch', 'search', 'channel', 'subscriptions', 'history', 'playlist'],
  'layout-home': ['home'], 'layout-watch': ['watch'], density: ['home'],
  'calm-hideShorts': ['home', 'watch', 'search', 'channel', 'subscriptions', 'history', 'playlist'],
  'calm-hideHomeRecs': ['home'], 'calm-hideComments': ['watch'], 'calm-hideEndScreens': ['watch'], 'calm-hideViewCounts': ['watch'],
  'calm-hideLive': ['home'],
};

// ---- selector utilities --------------------------------------------------------------------------------------------

/** Splits a selector at TOP-LEVEL commas and combinators (ignoring strings, [..] and (..)). */
function topLevel(sel) {
  const commas = [];
  const compounds = [];
  let cur = '';
  let quote = null;
  let bracket = 0;
  let paren = 0;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[') bracket++; else if (ch === ']') bracket--; else if (ch === '(') paren++; else if (ch === ')') paren--;
    if (bracket === 0 && paren === 0) {
      if (ch === ',') { commas.push(i); continue; }
      if (ch === ' ' || ch === '>' || ch === '+' || ch === '~') { if (cur) compounds.push(cur); cur = ''; continue; }
    }
    cur += ch;
  }
  if (cur) compounds.push(cur);
  return { commas, compounds };
}
const subjectOf = (sel) => topLevel(sel).compounds.at(-1) ?? '';
const isBareTag = (compound) => /^[a-z][a-z0-9]*$/i.test(compound);
const hasAnchor = (sel) => /[.#[]|[a-z]-[a-z]/i.test(sel);
const commaJoin = (list) => list.join(', ');

const allSelectors = () => {
  const out = [];
  for (const [role, list] of Object.entries(MAP.roles)) list.forEach((s) => out.push({ where: `roles.${role}`, selector: s }));
  for (const g of GROUPS) MAP.protected[g].forEach((s) => out.push({ where: `protected.${g}`, selector: s }));
  for (const [k, list] of Object.entries(MAP.tileFields)) list.forEach((s) => out.push({ where: `tileFields.${k}`, selector: s }));
  return out;
};

// ---- page cache (read-only pages are shared; anything that mutates builds its own) ------------------------------------

const pages = new Map();
function pageFor(kind, opts = {}) {
  const key = kind + JSON.stringify(opts);
  if (!pages.has(key)) pages.set(key, createPage(kind, { tiles: 6, ...opts }));
  return pages.get(key);
}
after(() => { for (const p of pages.values()) p.window.close(); });

const VARIANTS = [
  ['home', {}], ['home', { tileStyle: 'home' }], ['watch', {}], ['search', {}], ['channel', {}], ['subscriptions', {}], ['history', {}], ['playlist', {}],
];
const label = (kind, opts) => kind + (opts.tileStyle ? `(${opts.tileStyle} tiles)` : '') + (opts.tiles === 0 ? '(0 tiles)' : '');

/** First selector (in map order) with any match, i.e. what selectors.find/findAll will return. */
function firstNonEmpty(root, role) {
  const list = MAP.roles[role];
  for (let i = 0; i < list.length; i++) {
    const els = [...root.querySelectorAll(list[i])];
    if (els.length) return { index: i, selector: list[i], els };
  }
  return null;
}
const unionMatches = (root, selectors) => [...root.querySelectorAll(commaJoin(selectors))];
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();

// ==================================================================================================================
// 1. File hygiene
// ==================================================================================================================

/** Duplicate keys are silently collapsed by JSON.parse, so scan the raw text. */
function findDuplicateKeys(raw) {
  const dupes = [];
  let i = 0;
  const skipWs = () => { while (i < raw.length && /\s/.test(raw[i])) i++; };
  const readString = () => {
    let s = '';
    i++;
    while (raw[i] !== '"') { if (raw[i] === '\\') { s += raw[i] + raw[i + 1]; i += 2; } else { s += raw[i++]; } }
    i++;
    return s;
  };
  const readValue = (pathStr) => {
    skipWs();
    const ch = raw[i];
    if (ch === '{') {
      i++;
      const seen = new Set();
      skipWs();
      if (raw[i] === '}') { i++; return; }
      for (;;) {
        skipWs();
        const key = readString();
        if (seen.has(key)) dupes.push(`${pathStr}.${key}`);
        seen.add(key);
        skipWs(); i++; // colon
        readValue(`${pathStr}.${key}`);
        skipWs();
        if (raw[i] === ',') { i++; continue; }
        i++; // }
        return;
      }
    } else if (ch === '[') {
      i++;
      skipWs();
      if (raw[i] === ']') { i++; return; }
      for (let n = 0; ; n++) {
        readValue(`${pathStr}[${n}]`);
        skipWs();
        if (raw[i] === ',') { i++; continue; }
        i++; // ]
        return;
      }
    } else if (ch === '"') { readString(); } else { while (i < raw.length && !/[,}\]\s]/.test(raw[i])) i++; }
  };
  readValue('$');
  return dupes;
}

test('the duplicate-key scanner itself works (so the real check below can be trusted)', () => {
  assert.deepEqual(findDuplicateKeys('{"a":1,"b":{"c":[1,{"d":1,"d":2}],"b":1},"a":2}'), ['$.b.c[1].d', '$.a']);
  assert.deepEqual(findDuplicateKeys('{"a":{"x":1},"b":{"x":2}}'), []);
});

test('file hygiene: valid JSON, LF, trailing newline, no duplicate keys, only the contract keys', () => {
  assert.ok(RAW.endsWith('\n') && !RAW.includes('\r'), 'LF line endings with a trailing newline');
  assert.deepEqual(findDuplicateKeys(RAW), [], 'duplicate keys would be silently dropped by JSON.parse');
  assert.deepEqual(Object.keys(MAP), TOP_KEYS, 'top-level keys, in contract order');
  assert.equal(MAP.schema, 1);
  assert.match(MAP.mapVersion, /^\d{4}\.\d{2}\.\d{2}\.\d+$/, 'mapVersion is date.counter so it is monotonic as a string-compare of fields');
  assert.equal(MAP.mapVersion, '2026.10.14.1');
  assert.match(MAP.issuedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(MAP.issuedAt.slice(0, 10), MAP.mapVersion.slice(0, 10).replaceAll('.', '-'), 'issuedAt day matches the mapVersion day');
  assert.ok(Number.isFinite(Date.parse(MAP.issuedAt)));
});

test('size budget: the map is shipped inside the extension and stored in chrome.storage', () => {
  assert.ok(RAW.length < 48 * 1024, `selector-map.source.json is ${RAW.length} bytes; keep it under 48 KB (content-script budget is 150 KB gzipped)`);
});

// ==================================================================================================================
// 2. Roles
// ==================================================================================================================

test('every required role exists, and nothing is unnamed junk', () => {
  for (const role of REQUIRED_ROLES) assert.ok(Array.isArray(MAP.roles[role]), `missing required role "${role}"`);
  const extra = Object.keys(MAP.roles).filter((r) => !REQUIRED_ROLES.includes(r));
  assert.deepEqual(extra, [], 'roles beyond the contract list must be added to REQUIRED_ROLES/ARCHITECTURE.md on purpose');
  for (const role of Object.keys(MAP.roles)) assert.match(role, /^[a-z][A-Za-z0-9]*$/, `role name "${role}" must be camelCase`);
});

test('every role has real fallbacks (>= 2 selectors) unless it is a documented single-selector exception', () => {
  for (const [role, list] of Object.entries(MAP.roles)) {
    assert.ok(Array.isArray(list) && list.length >= 1, `${role}: needs at least one selector`);
    if (role in SINGLE_SELECTOR_OK) {
      assert.equal(list.length, 1, `${role} is a documented single-selector exception (${SINGLE_SELECTOR_OK[role]}); remove it from SINGLE_SELECTOR_OK if it now has fallbacks`);
    } else {
      assert.ok(list.length >= 2, `${role} has ${list.length} selector; add a fallback or justify it in SINGLE_SELECTOR_OK`);
    }
    const max = MAX_SELECTORS[role] ?? MAX_SELECTORS.default;
    assert.ok(list.length <= max, `${role} has ${list.length} selectors (budget ${max}); a longer list needs a MAX_SELECTORS entry and a reason`);
  }
});

test('selector strings are clean: non-empty strings, trimmed, unique within a role, no top-level commas', () => {
  for (const { where, selector } of allSelectors()) {
    assert.equal(typeof selector, 'string', `${where}: selectors are strings`);
    assert.ok(selector.length > 0 && selector === selector.trim(), `${where}: "${selector}" must be non-empty and trimmed`);
    assert.ok(!/\s{2,}|\n|\t/.test(selector), `${where}: "${selector}" has odd whitespace`);
    // Each entry is ONE complex selector. Callers (safeHide, buildAllowList, "<sel> #background") split or suffix on this.
    assert.deepEqual(topLevel(selector).commas, [], `${where}: "${selector}" has a top-level comma; list alternatives as separate entries`);
  }
  for (const [role, list] of Object.entries(MAP.roles)) assert.equal(new Set(list).size, list.length, `${role}: duplicate selector`);
  for (const g of GROUPS) assert.equal(new Set(MAP.protected[g]).size, MAP.protected[g].length, `protected.${g}: duplicate selector`);
});

test('every selector parses in jsdom (:has / :not(complex) / sibling combinators included)', () => {
  const { document } = pageFor('home');
  for (const { where, selector } of allSelectors()) {
    assert.doesNotThrow(() => document.querySelectorAll(selector), `${where}: jsdom rejected "${selector}"`);
  }
});

test('ban-list: no selector is a bare tag / universal / document selector, and every selector is anchored', () => {
  for (const { where, selector } of allSelectors()) {
    assert.ok(!BANNED_WHOLE.has(selector.toLowerCase()), `${where}: "${selector}" is far too broad`);
    assert.ok(hasAnchor(selector), `${where}: "${selector}" has no class, id, attribute or custom-element tag to anchor it`);
    assert.ok(!/(^|[\s>+~(])\*([\s>+~).:[]|$)/.test(selector), `${where}: "${selector}" uses a universal selector`);
    const subj = subjectOf(selector);
    if (isBareTag(subj) && !ALLOWED_BARE_SUBJECT.has(selector)) {
      assert.fail(`${where}: "${selector}" ends in a bare <${subj}>; anchor the subject or add the whole selector to ALLOWED_BARE_SUBJECT with a reason`);
    }
  }
  // The allow-list must not carry dead weight.
  const present = new Set(allSelectors().map((s) => s.selector));
  for (const s of ALLOWED_BARE_SUBJECT) assert.ok(present.has(s), `ALLOWED_BARE_SUBJECT has "${s}" which is no longer in the map`);
});

test('ban-list test has teeth: it rejects the selectors it is meant to reject', () => {
  for (const bad of ['*', 'div', 'a', 'span', 'img', 'DIV']) assert.ok(BANNED_WHOLE.has(bad.toLowerCase()));
  assert.equal(hasAnchor('div span'), false);
  assert.equal(hasAnchor('div.row'), true);
  assert.equal(isBareTag(subjectOf('ytd-thumbnail img')), true, 'a custom-element ancestor does not anchor a bare subject');
  assert.equal(isBareTag(subjectOf('a[href^="/shorts/"]')), false);
  assert.deepEqual(topLevel('a:not(.x, .y), b').commas.length, 1, 'only the top-level comma counts');
});

test('singleton roles are not accidentally broad: each selector hits at most one element per fixture page', () => {
  for (const [kind, opts] of [...VARIANTS, ['home', { tiles: 0 }]]) {
    const { document } = pageFor(kind, opts);
    for (const role of SINGLETON_ROLES) {
      for (const sel of MAP.roles[role]) {
        const n = document.querySelectorAll(sel).length;
        assert.ok(n <= 1, `${role} "${sel}" matched ${n} elements on ${label(kind, opts)}`);
      }
    }
  }
});

test('contract shapes are all present (section 3.1): chips x3, continuation x2, Shorts shapes, Shorts nav entry rules', () => {
  const m = MAP.roles;
  assert.ok(m.chips.includes('ytd-feed-filter-chip-bar-renderer') && m.chips.includes('chip-bar-view-model') && m.chips.includes('yt-chip-cloud-renderer'));
  assert.ok(m.continuation.includes('ytd-continuation-item-renderer') && m.continuation.includes('yt-continuation-item-view-model'));
  const shorts = commaJoin([...m.shortsShelf, ...m.shortsTiles]);
  for (const shape of ['grid-shelf-view-model', 'ytm-shorts-lockup-view-model-v2', 'ytd-rich-grid-renderer[is-shorts-grid]', 'ytd-reel-shelf-renderer', 'ytd-rich-shelf-renderer[is-shorts]', 'a[href^="/shorts/"]']) {
    assert.ok(shorts.includes(shape), `Shorts shape ${shape} missing from shortsShelf/shortsTiles`);
  }
  assert.ok(m.shortsNavEntry.includes('ytd-mini-guide-renderer a[href="/shorts/"]'), 'mini-guide link');
  assert.ok(m.shortsNavEntry.includes('a[title="Shorts"]'), 'title handle (the full guide entry has no href)');
  assert.ok(m.shortsNavEntry.every((s) => !/ytd-guide-entry-renderer a\[href\^?=\s*"\/shorts/.test(s)), 'never rely on an href on the full-guide entry: it has none');
  assert.ok(m.homeGridContents.every((s) => s.includes('ytd-rich-grid-renderer')), 'home contents are scoped to the rich grid');
  assert.ok(m.masthead.includes('ytd-masthead'));
  assert.ok(m.viewCounts.some((s) => s.includes('ytd-watch-info-text')), 'watch info text is the view-count source on the watch page');
  assert.ok(m.playlistPanel.some((s) => s.includes('yt-item-section-renderer')), 'playlist pages use the yt-* view-model family');
});

// ==================================================================================================================
// 3. pageRoles / requires: references and honesty
// ==================================================================================================================

test('pageRoles keys are exactly PAGE_TYPES and only name real roles; requires keys are real FEATURES with real roles', () => {
  assert.deepEqual(Object.keys(MAP.pageRoles).sort(), [...PAGE_TYPES].sort());
  for (const [page, roles] of Object.entries(MAP.pageRoles)) {
    assert.ok(roles.length > 0, `pageRoles.${page} is empty`);
    assert.equal(new Set(roles).size, roles.length, `pageRoles.${page} has duplicates`);
    for (const r of roles) assert.ok(r in MAP.roles, `pageRoles.${page}: unknown role "${r}"`);
  }
  assert.deepEqual(Object.keys(MAP.requires).sort(), [...FEATURES].sort(), 'every FEATURE has a requires entry, and nothing else does');
  for (const [feature, roles] of Object.entries(MAP.requires)) {
    assert.ok(roles.length > 0, `requires.${feature} is empty`);
    assert.equal(new Set(roles).size, roles.length);
    for (const r of roles) assert.ok(r in MAP.roles, `requires.${feature}: unknown role "${r}"`);
  }
});

test('requires is minimal: every required role is evaluated on at least one page, and no feature requires an unverified role', () => {
  const evaluated = new Set(Object.values(MAP.pageRoles).flat());
  for (const [feature, roles] of Object.entries(MAP.requires)) {
    for (const r of roles) {
      assert.ok(evaluated.has(r), `requires.${feature} lists "${r}" but no pageRoles entry contains it, so health would never evaluate it`);
      assert.ok(!MAP._unverified.includes(r), `requires.${feature} lists "${r}", which is marked _unverified (cannot be verified logged-out)`);
    }
  }
});

test('requires omits roles that are legitimately absent on healthy pages (the false-alarm list)', () => {
  const required = new Set(Object.values(MAP.requires).flat());
  const reasons = {
    continuation: 'absent whenever the list is short (3-tile home feed, 3-tile channel list, no more comments)',
    tileChannel: 'absent on the channel-grid tile shape (no channel row)',
    tileDuration: 'a premiere or upcoming stream has no duration badge',
    richItem: 'absent on an empty-state home and on every non-grid page',
    videoTile: 'absent on an empty-state page; tile mount failures are reported by the layout through health.record',
    shortsShelf: 'Shorts shelves come and go per result set',
    shortsTiles: 'same',
    shortsNavEntry: 'the watch page has no rendered guide, and Shorts can be removed from the guide for some accounts',
    chips: 'three different renderers, absent on some channel tabs and on the watch page',
  };
  for (const [role, why] of Object.entries(reasons)) assert.ok(!required.has(role), `"${role}" must not be required: ${why}`);
  // homeGrid and homeGridContents are intentionally required by layout-home and density: a grid rename must raise
  // the breakage notice. The logged-out empty-state (no grid rendered) is the accepted trade-off; health.record
  // already handles tile-mount failures for that path, and logged-in sessions always have the grid.
  assert.ok(required.has('homeGrid'), 'homeGrid is required so grid renames raise the breakage notice');
  assert.ok(required.has('homeGridContents'), 'homeGridContents is required for the same reason');
});

test('HONEST: every role a feature requires on a page matches that page\'s fixture (both home tile shapes, and with zero tiles)', () => {
  const cases = [...VARIANTS, ['home', { tiles: 0 }], ['home', { tiles: 0, tileStyle: 'home' }], ['channel', { tiles: 0 }], ['search', { tiles: 0 }],
    ['playlist', { tiles: 0 }], ['watch', { tiles: 0 }], ['history', { tiles: 0 }], ['subscriptions', { tiles: 0 }]];
  let checked = 0;
  for (const [kind, opts] of cases) {
    const { document } = pageFor(kind, opts);
    const expected = new Set(MAP.pageRoles[kind]);
    for (const [feature, roles] of Object.entries(MAP.requires)) {
      for (const role of roles.filter((r) => expected.has(r))) {
        checked++;
        assert.ok(firstNonEmpty(document, role), `health would false-alarm: feature "${feature}" requires "${role}" on ${label(kind, opts)} but no selector of it matches`);
      }
    }
  }
  assert.ok(checked > 40, `only ${checked} feature x page x role checks ran; the pageRoles/requires wiring looks wrong`);
});

test('HONEST (strong form): every role a feature requires matches on every page where that feature is evaluated, whatever pageRoles says', () => {
  for (const [feature, kinds] of Object.entries(FEATURE_PAGES)) {
    for (const kind of kinds) {
      for (const opts of kind === 'home' ? [{}, { tileStyle: 'home' }, { tiles: 0 }] : [{}, { tiles: 0 }]) {
        const { document } = pageFor(kind, opts);
        for (const role of MAP.requires[feature]) {
          if (!MAP.pageRoles[kind].includes(role)) continue; // not evaluated on this page type
          assert.ok(firstNonEmpty(document, role), `${feature}/${role} missing on ${label(kind, opts)}`);
        }
      }
    }
  }
});

test('pageRoles are honest too: every role expected on a page matches its fixture (home with both tile shapes)', () => {
  for (const [kind, opts] of VARIANTS) {
    const { document } = pageFor(kind, opts);
    for (const role of MAP.pageRoles[kind]) {
      assert.ok(firstNonEmpty(document, role), `pageRoles.${kind} expects "${role}" but nothing matches on ${label(kind, opts)}`);
    }
  }
  // Shorts / other pages have no fixture: they may only list the shell, which every fixture page carries.
  const shell = new Set(MAP.pageRoles.home.slice(0, 5));
  for (const kind of ['shorts', 'other']) for (const r of MAP.pageRoles[kind]) assert.ok(shell.has(r), `pageRoles.${kind} may only list shell roles (got ${r})`);
});

test('every role has a fixture page where its primary selector matches (the primary is the live-verified one)', () => {
  // Primary-in-fixture exceptions: the role only exists in a shape the trimmed fixtures cannot show. The fallback is what matches.
  const primaryNeedsLive = { tileChannel: 'channel-grid tiles carry no channel; home-shaped tiles do (checked below)', continuation: 'present in channel/home/search fixtures; the playlist uses the second shape' };
  const everyPage = [...VARIANTS, ['search', { shorts: 'grid' }], ['home', { shorts: 'rich', tileStyle: 'home' }], ['watch', { shorts: 'reel' }]];
  for (const role of REQUIRED_ROLES) {
    const primary = MAP.roles[role][0];
    const hit = everyPage.some(([kind, opts]) => pageFor(kind, opts).document.querySelectorAll(primary).length > 0);
    if (primaryNeedsLive[role]) continue;
    assert.ok(hit, `${role}: the primary selector "${primary}" matches no fixture page`);
  }
  // ...and for the two exceptions the primary does match on the page that has that shape.
  assert.ok(pageFor('home', { tileStyle: 'home' }).document.querySelectorAll(MAP.roles.tileChannel[0]).length > 0);
  assert.ok(pageFor('channel').document.querySelectorAll(MAP.roles.continuation[0]).length > 0);
  assert.ok(pageFor('playlist').document.querySelectorAll(MAP.roles.continuation[1]).length > 0);
});

test('_unverified lists only real roles, is a sorted-unique array, and names exactly the roles the logged-out session could not see', () => {
  assert.ok(Array.isArray(MAP._unverified));
  assert.equal(new Set(MAP._unverified).size, MAP._unverified.length);
  for (const r of MAP._unverified) assert.ok(r in MAP.roles, `_unverified names unknown role "${r}"`);
  assert.deepEqual([...MAP._unverified].sort(), ['historyList', 'subscriptionsGrid'], 'logged-out YouTube shows only sign-in empty states for these two');
});

// ==================================================================================================================
// 4. Tile metadata shapes (viewCounts / tileChannel)
// ==================================================================================================================

const VIEW_TILE_SELECTORS = MAP.roles.viewCounts.filter((s) => s.startsWith('.ytLockupViewModelHost'));
const LEGACY_VIEW_SELECTOR = 'ytd-video-meta-block #metadata-line > span.inline-metadata-item:first-of-type';

function lockups(document) {
  return [...document.querySelectorAll('yt-lockup-view-model')].filter((l) => !l.querySelector('yt-collection-thumbnail-view-model'));
}
function el(document, cls, tag = 'span', attrs = {}) {
  const e = document.createElement(tag);
  e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
/** The live (2026-10-07) markup the trimmed fixtures stripped: a leading eye icon before the views text, a Verified icon after the channel. */
function injectLiveIcons(document) {
  for (const lockup of lockups(document)) {
    const rows = [...lockup.querySelectorAll('.ytContentMetadataViewModelMetadataRow')];
    const hasAvatar = !!lockup.querySelector('.ytLockupMetadataViewModelAvatar');
    const viewsRow = hasAvatar ? (rows.length === 1 ? rows[0] : rows[1]) : rows[0];
    const texts = [...viewsRow.querySelectorAll(':scope > .ytContentMetadataViewModelMetadataText')];
    const viewsText = hasAvatar && rows.length === 1 ? texts[1] : texts[0];
    viewsRow.insertBefore(el(document, 'ytIconWrapperHost ytContentMetadataViewModelLeadingIcon', 'span', { style: 'width: 12px; height: 12px;' }), viewsText);
    if (hasAvatar) {
      const channelRow = rows[0];
      const channel = channelRow.querySelector(':scope > .ytContentMetadataViewModelMetadataText');
      channelRow.insertBefore(el(document, 'ytIconWrapperHost ytContentMetadataViewModelIcon', 'span', { 'aria-label': 'Verified' }), channel.nextSibling);
    }
  }
}
/** Expected views / channel text per lockup, read from the pristine markup with logic independent of the selectors. */
function expectedFor(lockup) {
  const rows = [...lockup.querySelectorAll('.ytContentMetadataViewModelMetadataRow')].map((r) => [...r.querySelectorAll(':scope > .ytContentMetadataViewModelMetadataText')].map(text));
  const hasAvatar = !!lockup.querySelector('.ytLockupMetadataViewModelAvatar');
  if (!hasAvatar) return { views: rows[0][0], channel: null, age: rows[0][1] };
  if (rows.length === 1) return { views: rows[0][1], channel: rows[0][0], age: rows[0].at(-1) };
  return { views: rows[1][0], channel: rows[0][0], age: rows[1].at(-1) };
}

function assertViewCountsPerTile(document, expectTiles, what) {
  const tiles = lockups(document);
  assert.ok(tiles.length >= expectTiles, `${what}: expected at least ${expectTiles} tiles, found ${tiles.length}`);
  for (const tile of tiles) {
    const exp = expectedFor(tile);
    const hit = unionMatches(tile, VIEW_TILE_SELECTORS);
    assert.equal(hit.length, 1, `${what}: ${hit.length} view-count matches in one tile (${hit.map(text).join(' | ')})`);
    assert.equal(text(hit[0]), exp.views, `${what}: hid "${text(hit[0])}" instead of the view count "${exp.views}"`);
    assert.notEqual(text(hit[0]), exp.age, `${what}: matched the age text`);
    if (exp.channel) assert.notEqual(text(hit[0]), exp.channel, `${what}: matched the channel name`);
  }
}

for (const withIcons of [false, true]) {
  const suffix = withIcons ? ' (live markup: leading + verified icons injected between the texts)' : ' (fixture markup)';
  test(`viewCounts picks exactly the view count in every tile shape${suffix}`, () => {
    const shapes = [['channel', {}, 'channel grid: row "views, age"'], ['home', { tileStyle: 'home' }, 'home: avatar + one row "channel, views, age"'],
      ['watch', {}, 'watch related: row 1 channel, row 2 "views, age"'], ['playlist', {}, 'playlist row: same two-row shape'],
      ['subscriptions', {}, 'subscriptions grid: channel-grid shape'], ['home', {}, 'home with channel-grid tiles']];
    for (const [kind, opts, what] of shapes) {
      const { document } = createPage(kind, { tiles: 7, ...opts });
      if (withIcons) injectLiveIcons(document);
      assertViewCountsPerTile(document, 4, what);
      document.defaultView.close();
    }
  });

  test(`tileChannel returns the channel name for avatar shapes and nothing for the channel-grid shape${suffix}`, () => {
    for (const [kind, opts, hasChannel] of [['home', { tileStyle: 'home' }, true], ['watch', {}, true], ['playlist', {}, true], ['channel', {}, false], ['home', {}, false]]) {
      const { document } = createPage(kind, { tiles: 6, ...opts });
      if (withIcons) injectLiveIcons(document);
      for (const tile of lockups(document)) {
        const found = firstNonEmpty(tile, 'tileChannel');
        if (!hasChannel) { assert.equal(found, null, `${kind}: a channel-grid tile must not report a channel (it would be the view count)`); continue; }
        assert.ok(found, `${kind}: tileChannel found nothing`);
        assert.equal(found.els.length, 1);
        assert.equal(text(found.els[0]), expectedFor(tile).channel);
      }
      document.defaultView.close();
    }
  });
}

test('viewCounts edge shapes: live home tile with only "channel, views" (no age), a lone text, and a collection lockup', () => {
  const { document } = createPage('home', { tiles: 4, tileStyle: 'home' });
  injectLiveIcons(document);
  const [first, second, third] = lockups(document);
  // (a) two texts only (a live stream has "channel, N watching"): the second text is still the viewer count.
  const row = first.querySelector('.ytContentMetadataViewModelMetadataRow');
  const texts = [...row.querySelectorAll(':scope > .ytContentMetadataViewModelMetadataText')];
  const delims = [...row.querySelectorAll(':scope > .ytContentMetadataViewModelDelimiter')];
  texts[2].remove(); delims.at(-1).remove();
  const hitA = unionMatches(first, VIEW_TILE_SELECTORS);
  assert.deepEqual(hitA.map(text), [text(texts[1])], 'two-text home row: hide the viewer count, never the channel');
  // (b) channel text only: nothing to hide, nothing wrongly hidden.
  const row2 = second.querySelector('.ytContentMetadataViewModelMetadataRow');
  [...row2.querySelectorAll(':scope > .ytContentMetadataViewModelMetadataText')].slice(1).forEach((t) => t.remove());
  assert.deepEqual(unionMatches(second, VIEW_TILE_SELECTORS).map(text), [], 'a row with one text must hide nothing');
  // (c) a playlist/collection lockup (search results) is excluded even when it looks like a two-row avatar tile.
  const coll = third.cloneNode(true);
  coll.querySelector('.ytLockupViewModelHost').classList.add('ytLockupViewModelCollectionStack2');
  coll.querySelector('.ytLockupViewModelHost').appendChild(document.createElement('yt-collection-thumbnail-view-model'));
  third.after(coll);
  assert.deepEqual(unionMatches(coll, VIEW_TILE_SELECTORS).map(text), [], 'collection lockups carry no view count; their rows are "Updated ..." / "N videos"');
  document.defaultView.close();
});

test('viewCounts live-only shapes seen on the 2026-10-07 home feed: collab channels, trailing icon-only row, live streams', () => {
  const { document } = createPage('home', { tiles: 6, tileStyle: 'home' });
  injectLiveIcons(document);
  const [collab, trailing, live] = lockups(document);
  // (1) collab upload: row = [Ayra Starr][verified][|][and zayn][verified][|][leading icon][1.9m][|][2 days ago] - FOUR texts.
  const row = collab.querySelector('.ytContentMetadataViewModelMetadataRow');
  const t1 = row.querySelector(':scope > .ytContentMetadataViewModelMetadataText');
  const second = t1.cloneNode(true);
  second.textContent = 'and zayn';
  const delim = row.querySelector(':scope > .ytContentMetadataViewModelDelimiter').cloneNode(true);
  const icon = row.querySelector(':scope > .ytContentMetadataViewModelIcon').cloneNode(true);
  const afterIcon = row.querySelector(':scope > .ytContentMetadataViewModelIcon');
  afterIcon.after(delim, second, icon);
  const collabTexts = [...row.querySelectorAll(':scope > .ytContentMetadataViewModelMetadataText')].map(text);
  assert.equal(collabTexts.length, 4);
  assert.deepEqual(unionMatches(collab, VIEW_TILE_SELECTORS).map(text), [collabTexts[2]], 'collab row: hide the view count, not the second channel');
  assert.equal(text(firstNonEmpty(collab, 'tileChannel').els[0]), collabTexts[0], 'tileChannel is the first channel');
  // (2) a trailing icon-only row (e.g. an Auto-dubbed marker) must not stop the single text row from being recognised.
  const expectedTrailingViews = expectedFor(trailing).views; // oracle read BEFORE the extra row exists
  const trailingRow = document.createElement('div');
  trailingRow.className = 'ytContentMetadataViewModelMetadataRow';
  trailingRow.appendChild(el(document, 'ytIconWrapperHost ytContentMetadataViewModelIcon'));
  trailing.querySelector('.ytContentMetadataViewModelMetadataRow').after(trailingRow);
  assert.equal(unionMatches(trailing, VIEW_TILE_SELECTORS).length, 1);
  assert.equal(text(unionMatches(trailing, VIEW_TILE_SELECTORS)[0]), expectedTrailingViews);
  // (3) a live stream: row = [channel][verified][|][591 watching]; badges = LIVE (+ an empty second badge).
  const liveRow = live.querySelector('.ytContentMetadataViewModelMetadataRow');
  const liveTexts = [...liveRow.querySelectorAll(':scope > .ytContentMetadataViewModelMetadataText')];
  liveTexts[1].textContent = '591 watching';
  liveTexts[2].previousElementSibling.remove();
  liveTexts[2].remove();
  assert.deepEqual(unionMatches(live, VIEW_TILE_SELECTORS).map(text), ['591 watching'], 'live row: the viewer count is the last text, the channel stays visible');
  const badges = live.querySelector('yt-thumbnail-bottom-overlay-view-model .ytThumbnailBottomOverlayViewModelBadgeContainer');
  badges.querySelector('.ytBadgeShapeText').textContent = 'LIVE';
  badges.appendChild(badges.firstElementChild.cloneNode(true)).querySelector('.ytBadgeShapeText').textContent = '';
  const dur = firstNonEmpty(live, 'tileDuration');
  assert.equal(text(dur.els[0]), 'LIVE', 'a live tile reports LIVE as its duration (first badge); consumers must not parse it as time');
  assert.equal(dur.els.length, 2, 'live tiles carry a second, empty badge in the bottom overlay (seen live)');
  document.defaultView.close();
});

test('viewCounts on a channel-grid collab tile (live 2026-10-09, /@NatGeo/videos): one row [channel][and partner][views][age] and no avatar', () => {
  const { document } = createPage('channel', { tiles: 4 });
  injectLiveIcons(document);
  const [collab, plain] = lockups(document);
  const row = collab.querySelector('.ytContentMetadataViewModelMetadataRow');
  const texts = () => [...row.querySelectorAll(':scope > .ytContentMetadataViewModelMetadataText')];
  const [viewsText, ageText] = texts().map(text);
  assert.ok(!collab.querySelector('.ytLockupMetadataViewModelAvatar, yt-decorated-avatar-view-model'), 'channel tiles carry no avatar, also for collabs');
  const mk = (t) => { const e = el(document, 'ytAttributedStringHost ytContentMetadataViewModelMetadataText'); e.textContent = t; return e; };
  const added = [];
  const first = row.firstElementChild;
  for (const n of [mk('National Geographic'), el(document, 'ytIconWrapperHost ytContentMetadataViewModelIcon'), el(document, 'ytContentMetadataViewModelDelimiter'), mk('and ROLEX'), el(document, 'ytIconWrapperHost ytContentMetadataViewModelIcon'), el(document, 'ytContentMetadataViewModelDelimiter')]) {
    row.insertBefore(n, first);
    added.push(n);
  }
  assert.deepEqual(texts().map(text), ['National Geographic', 'and ROLEX', viewsText, ageText]);
  assert.deepEqual(unionMatches(collab, VIEW_TILE_SELECTORS).map(text), [viewsText], 'four-text channel row: hide the view count, neither channel name nor age');
  // Three texts ([channel][views][age]) hide the second to last as well; the plain two-text channel tile is unchanged.
  added.slice(3).forEach((n) => n.remove());
  assert.deepEqual(texts().map(text), ['National Geographic', viewsText, ageText]);
  assert.deepEqual(unionMatches(collab, VIEW_TILE_SELECTORS).map(text), [viewsText]);
  assert.deepEqual(unionMatches(plain, VIEW_TILE_SELECTORS).map(text), [expectedFor(plain).views], 'a plain "views, age" channel tile still hides its first text only');
  // A two-row tile without avatar markup is not claimed by the multi-text rule (a later row with text disqualifies it).
  const second = row.cloneNode(true);
  row.after(second);
  assert.equal(unionMatches(collab, VIEW_TILE_SELECTORS).filter((x) => x.parentElement === row).length, 0, 'first row of a two-row tile is left alone by the multi-text rule');
  document.defaultView.close();
});

test('viewCounts on the legacy renderers (search results, history): first inline-metadata-item only', () => {
  for (const kind of ['search', 'history']) {
    const { document } = createPage(kind, { tiles: 5 });
    const rows = [...document.querySelectorAll('ytd-video-renderer')];
    assert.ok(rows.length >= 3);
    for (const r of rows) {
      const items = [...r.querySelectorAll('#metadata-line .inline-metadata-item')].map(text);
      const hit = [...r.querySelectorAll(LEGACY_VIEW_SELECTOR)].map(text);
      assert.deepEqual(hit, [items[0]], `${kind}: only the view count (${items.join(' | ')})`);
    }
    // The search playlist lockup is not a view-count tile.
    assert.deepEqual(unionMatches(document, VIEW_TILE_SELECTORS), [], `${kind}: the new-shape selectors must match nothing on a legacy-only page`);
    document.defaultView.close();
  }
});

test('viewCounts on the watch page: the info-text span carrying the count, nothing else from the description line', () => {
  const { document } = pageFor('watch');
  const hit = [...document.querySelectorAll(MAP.roles.viewCounts[0])];
  assert.equal(hit.length, 1);
  assert.match(text(hit[0]), /views$/, 'real capture: "84k views"');
  const info = document.querySelector('ytd-watch-info-text #info');
  assert.notEqual(text(hit[0]), text(info), 'only the first span, not the whole line (date and hashtags stay visible)');
});

test('per-tile cardinality: exactly one link/title/thumb/duration per video tile, never an over-broad hit inside a tile', () => {
  const shapes = [['home', {}], ['home', { tileStyle: 'home' }], ['channel', {}], ['subscriptions', {}], ['watch', {}], ['playlist', {}], ['search', {}], ['history', {}]];
  let tilesSeen = 0;
  for (const [kind, opts] of shapes) {
    const { document } = pageFor(kind, opts);
    const tiles = unionMatches(document, MAP.roles.videoTile).filter((t) => !t.querySelector('yt-collection-thumbnail-view-model') && !t.closest('yt-lockup-view-model:has(yt-collection-thumbnail-view-model)'));
    assert.ok(tiles.length >= 3, `${label(kind, opts)}: found ${tiles.length} tiles`);
    for (const tile of tiles) {
      tilesSeen++;
      for (const role of ['tileLink', 'tileTitle', 'tileThumb', 'tileDuration']) {
        const found = firstNonEmpty(tile, role);
        assert.ok(found, `${label(kind, opts)}: tile has no ${role}`);
        assert.equal(found.els.length, 1, `${label(kind, opts)}: ${role} matched ${found.els.length} elements in one tile via "${found.selector}"`);
      }
      assert.match(firstNonEmpty(tile, 'tileLink').els[0].getAttribute('href'), /^\/watch\?v=/);
      const title = firstNonEmpty(tile, 'tileTitle').els[0];
      assert.ok(text(title).length > 5, 'title text');
      const channel = firstNonEmpty(tile, 'tileChannel');
      assert.ok(!channel || channel.els.length === 1, `${label(kind, opts)}: tileChannel matched ${channel?.els.length} elements`);
      assert.ok(firstNonEmpty(tile, 'tileMeta'), 'tileMeta');
    }
  }
  assert.ok(tilesSeen > 30);
});

test('tile roles work when the search root is the rich item OR the lockup (what extractTile / collectTiles will pass)', () => {
  // jsdom quirk (pinned by this test): when the element passed to querySelector is ALSO the first compound of a selector that
  // uses :has/:first-of-type, jsdom returns nothing. Browsers do not have the quirk. The tile selectors are therefore anchored on
  // .ytLockupViewModelHost, which is strictly inside both roots. Passing the host div itself as the root only works in browsers.
  for (const tileStyle of ['home', 'grid']) {
    const { document, window } = createPage('home', { tiles: 4, tileStyle });
    injectLiveIcons(document);
    const item = document.querySelector('ytd-rich-item-renderer');
    const lockup = item.querySelector('yt-lockup-view-model');
    const expected = expectedFor(lockup);
    for (const root of [item, lockup]) {
      const channel = firstNonEmpty(root, 'tileChannel');
      if (tileStyle === 'home') assert.equal(text(channel.els[0]), expected.channel, `tileChannel from <${root.tagName.toLowerCase()}>`);
      else assert.equal(channel, null);
      assert.equal(unionMatches(root, VIEW_TILE_SELECTORS).map(text)[0], expected.views, `viewCounts from <${root.tagName.toLowerCase()}>`);
    }
    window.close();
  }
});

test('the rich-item metadata of the captured channel tile matches readTile (independent reader)', () => {
  const { document } = pageFor('channel');
  const item = document.querySelector('ytd-rich-item-renderer');
  assert.equal(unionMatches(item, VIEW_TILE_SELECTORS).map(text)[0], readTile(item).views);
  assert.equal(text(firstNonEmpty(item, 'tileTitle').els[0]), readTile(item).title);
  assert.equal(text(firstNonEmpty(item, 'tileDuration').els[0]), readTile(item).duration);
});

// ==================================================================================================================
// 5. Fallbacks under simulated YouTube changes
// ==================================================================================================================

test('fallbacks: renaming the primary element keeps the role alive through the next selector', () => {
  const cases = [
    ['home', {}, 'ytd-rich-item-renderer', 'richItem', 1],
    ['channel', {}, 'ytd-rich-item-renderer', 'richItem', 1],
    ['home', {}, 'ytd-masthead', 'masthead', 1],
    ['home', {}, 'ytd-browse', 'homeBrowse', 1],
    ['watch', {}, 'ytd-watch-flexy', 'watchFlexy', 1],
    ['watch', {}, '#movie_player', 'watchPlayer', 1],
    ['watch', {}, '#player-container-outer', 'watchPlayerContainer', 1],
    ['watch', {}, '.ytp-ce-element', 'endScreens', 1],
    ['watch', {}, 'ytd-comments', 'comments', 2],
    ['watch', {}, 'ytd-watch-metadata', 'watchMetadata', 1],
    ['watch', {}, 'ytd-page-manager', 'pageManager', 2],
  ];
  for (const [kind, opts, rename, role, expectIndex] of cases) {
    const page = createPage(kind, { tiles: 5, ...opts });
    const before = firstNonEmpty(page.document, role);
    assert.equal(before.index, 0, `${role}: primary matches the pristine ${kind} fixture`);
    const touched = applyRename(page.document, [rename]);
    assert.ok(touched > 0, `rename ${rename} touched nothing in the ${kind} fixture`);
    const after = firstNonEmpty(page.document, role);
    assert.ok(after, `${role}: lost entirely after renaming ${rename}; the fallbacks did not hold`);
    assert.equal(after.index, expectIndex, `${role}: expected to fall back to entry #${expectIndex} (${MAP.roles[role][expectIndex]}) after renaming ${rename}`);
    page.window.close();
  }
});

test('fallbacks: renaming the legacy and view-model lockup tags is detected (role becomes missing), not silently masked', () => {
  const page = createPage('home', { tiles: 5, tileStyle: 'home' });
  assert.ok(applyRename(page.document, ['yt-lockup-view-model']) > 0);
  assert.equal(firstNonEmpty(page.document, 'videoTile'), null, 'a total videoTile rename must surface as "missing" so health can report it');
  page.window.close();
  const search = createPage('search', { tiles: 4 });
  assert.ok(applyRename(search.document, ['ytd-video-renderer']) > 0);
  assert.equal(search.document.querySelectorAll('ytd-video-renderer').length, 0);
  assert.equal(firstNonEmpty(search.document, 'videoTile').els.length, 1, 'only the playlist lockup remains: the video rows are gone from the role');
  search.window.close();
});

test('fail-safe: if YouTube renames the avatar markup, viewCounts hides nothing wrong (never the channel name)', () => {
  for (const renames of [['.ytLockupMetadataViewModelAvatar'], ['yt-decorated-avatar-view-model'], ['.ytLockupMetadataViewModelAvatar', 'yt-decorated-avatar-view-model']]) {
    const page = createPage('home', { tiles: 6, tileStyle: 'home' });
    injectLiveIcons(page.document);
    const channelNames = new Set(lockups(page.document).map((l) => expectedFor(l).channel));
    assert.ok(applyRename(page.document, renames) > 0);
    for (const tile of lockups(page.document)) {
      for (const hit of unionMatches(tile, VIEW_TILE_SELECTORS)) {
        assert.ok(!channelNames.has(text(hit)), `after renaming ${renames.join('+')} the selectors hid the channel name "${text(hit)}"`);
      }
    }
    page.window.close();
  }
});

test('fail-safe: renaming the metadata text/row classes makes viewCounts match nothing (a hider that hides nothing is safe)', () => {
  for (const rename of ['.ytContentMetadataViewModelMetadataText', '.ytContentMetadataViewModelMetadataRow']) {
    const page = createPage('channel', { tiles: 5 });
    assert.ok(applyRename(page.document, [rename]) > 0);
    assert.deepEqual(unionMatches(page.document, VIEW_TILE_SELECTORS), []);
    page.window.close();
  }
});

// ==================================================================================================================
// 6. Protected groups
// ==================================================================================================================

const ADS_SEL = commaJoin(MAP.protected.ads);
const SPONSOR_SEL = commaJoin(MAP.protected.sponsor);
const CONTROLS_SEL = commaJoin(MAP.protected.playerControls);
const CONTAINERS_SEL = commaJoin(MAP.protected.containers);
const KNOWN_EMPTY_AD_SLOTS = '#masthead-ad, #player-ads, .ytp-ad-progress-list, ytd-ads-engagement-panel-content-renderer';

test('protected: four non-empty groups, no overlap between groups, the contract-named items are present', () => {
  assert.deepEqual(Object.keys(MAP.protected), GROUPS);
  for (const g of GROUPS) assert.ok(MAP.protected[g].length >= 8, `protected.${g} is thin (${MAP.protected[g].length})`);
  const seen = new Map();
  for (const g of GROUPS) for (const s of MAP.protected[g]) {
    assert.ok(!seen.has(s), `"${s}" is in both protected.${seen.get(s)} and protected.${g}`);
    seen.set(s, g);
  }
  const must = {
    ads: ['ytd-ad-slot-renderer', 'ytd-in-feed-ad-layout-renderer', 'ytd-display-ad-renderer', 'ytd-banner-promo-renderer', 'ytd-companion-slot-renderer',
      'ytd-promoted-video-renderer', 'ytd-promoted-sparkles-web-renderer', '#masthead-ad', '#player-ads', '.video-ads', '.ytp-ad-module', '.ytp-ad-progress-list',
      'ytd-ads-engagement-panel-content-renderer', '[class^="ytp-ad-"]'],
    sponsor: ['.ytp-paid-content-overlay', '.ytp-suggested-action', 'ytd-info-panel-container-renderer'],
    playerControls: ['.ytp-chrome-bottom', '.ytp-chrome-top', '.ytp-progress-bar-container', '.ytp-gradient-bottom', '.ytp-gradient-top', '.ytp-right-controls'],
    containers: ['ytd-rich-item-renderer', 'ytd-rich-section-renderer', 'ytd-item-section-renderer', '#player', '#movie_player', 'ytd-watch-flexy', '#contents'],
  };
  for (const [g, list] of Object.entries(must)) for (const s of list) assert.ok(MAP.protected[g].includes(s), `protected.${g} must include ${s}`);
});

test('protected.ads matches every synthetic ad element, protected.sponsor the synthetic disclosure', () => {
  const page = createPage('watch', { tiles: 6, ads: 3 });
  const home = createPage('home', { tiles: 6, ads: 3 });
  const search = createPage('search', { tiles: 4, ads: 2 });
  let roots = 0;
  for (const { document } of [page, home, search]) {
    for (const node of document.querySelectorAll('[data-cd-synthetic]')) {
      const kind = node.getAttribute('data-cd-synthetic');
      if (kind.startsWith('shorts-')) continue;
      roots++;
      if (kind === 'feed-ad') {
        // The grid cell that wraps the ad: a container, never an ad itself, and it must contain a matched ad.
        assert.ok(node.matches(CONTAINERS_SEL) && !node.matches(ADS_SEL), 'feed-ad cell is a container');
        assert.ok(node.querySelector(ADS_SEL), 'feed-ad cell contains a protected ad');
      } else if (kind === 'sponsor') {
        assert.ok(node.matches(SPONSOR_SEL), 'synthetic paid-promotion disclosure must match protected.sponsor');
        for (const child of node.querySelectorAll('*')) assert.ok(child.matches(SPONSOR_SEL), `disclosure child <${child.tagName.toLowerCase()} class="${child.className}"> is unprotected`);
      } else {
        assert.ok(node.matches(ADS_SEL), `synthetic "${kind}" (<${node.tagName.toLowerCase()} class="${node.className}">) is not matched by protected.ads`);
      }
    }
  }
  assert.ok(roots >= 12, `only ${roots} synthetic ad nodes were exercised`);
  // Every node INSIDE an ad is covered by an ancestor that matches, so no descendant hide rule can slip through the guard.
  for (const { document } of [page, home, search]) {
    for (const ad of document.querySelectorAll('ytd-ad-slot-renderer, ytd-video-masthead-ad-v3-renderer, .video-ads')) {
      for (const inner of ad.querySelectorAll('*')) assert.ok(inner.closest(ADS_SEL), `<${inner.tagName.toLowerCase()}> inside an ad has no protected ancestor`);
    }
  }
  [page, home, search].forEach((p) => p.window.close());
});

test('protected.ads / sponsor do not swallow ordinary content: on real captures they match only the known empty slots and disclosure shells', () => {
  for (const [kind, opts] of [...VARIANTS, ['search', { shorts: 'grid' }], ['home', { shorts: 'rich' }], ['watch', { shorts: 'reel' }]]) {
    const { document } = pageFor(kind, opts);
    for (const e of document.querySelectorAll(ADS_SEL)) {
      assert.ok(e.matches(KNOWN_EMPTY_AD_SLOTS), `${label(kind, opts)}: protected.ads matched real content <${e.tagName.toLowerCase()} id="${e.id}" class="${e.className}">`);
      assert.equal(text(e), '', 'a known ad slot is empty on a capture without ads');
      assert.equal(e.querySelectorAll('a, img, h1, h2, h3').length, 0);
    }
    for (const e of document.querySelectorAll(SPONSOR_SEL)) {
      assert.ok(e.closest('.ytp-paid-content-overlay, .ytp-suggested-action'), `${label(kind, opts)}: protected.sponsor matched unrelated <${e.tagName.toLowerCase()} class="${e.className}">`);
    }
  }
});

test('protected.playerControls matches the real player controls of the watch capture and nothing outside the player', () => {
  const { document } = pageFor('watch');
  for (const sel of ['.ytp-chrome-bottom', '.ytp-chrome-top', '.ytp-progress-bar-container', '.ytp-gradient-bottom', '.ytp-right-controls', '.ytp-play-button', '.ytp-fullscreen-button']) {
    assert.ok(document.querySelector(sel), `fixture lost ${sel}`);
    assert.ok(MAP.protected.playerControls.includes(sel), `${sel} is a real control and must be protected`);
  }
  const matched = [...document.querySelectorAll(CONTROLS_SEL)];
  assert.ok(matched.length >= 10);
  for (const e of matched) assert.ok(e.closest('#movie_player'), `<${e.tagName.toLowerCase()} class="${e.className}"> is protected but sits outside the player`);
  const { document: home } = pageFor('home');
  assert.equal(home.querySelectorAll(CONTROLS_SEL).length, 0, 'no control selector may match a home page');
});

test('protected.containers covers every wrapper between each synthetic ad / disclosure and the app root', () => {
  const builds = [['home', { ads: 3, tileStyle: 'home' }], ['channel', { ads: 2 }], ['subscriptions', { ads: 2 }], ['search', { ads: 2 }], ['watch', { ads: 3 }]];
  const covered = (e) => e.matches(`${CONTAINERS_SEL}, ${ADS_SEL}, ${SPONSOR_SEL}, ${CONTROLS_SEL}`);
  let ads = 0;
  for (const [kind, opts] of builds) {
    const { document, window } = createPage(kind, { tiles: 8, ...opts });
    const targets = document.querySelectorAll(`${ADS_SEL}, ${SPONSOR_SEL}`);
    for (const ad of targets) {
      ads++;
      const missing = [];
      for (let a = ad.parentElement; a && a !== document.documentElement && a !== document.body; a = a.parentElement) {
        // A wrapper INSIDE a protected ad root is not enumerable (ad internals are unknown); the validator refuses descendant rules under protected roots.
        if (a.closest(`${ADS_SEL}, ${SPONSOR_SEL}`)) continue;
        if (!covered(a)) missing.push(`<${a.tagName.toLowerCase()}${a.id ? '#' + a.id : ''}${a.className ? '.' + String(a.className).trim().split(/\s+/)[0] : ''}>`);
      }
      assert.deepEqual(missing, [], `${kind}: wrapper(s) of <${ad.tagName.toLowerCase()} class="${ad.className}"> can hide the ad but are not in protected.*`);
    }
    window.close();
  }
  assert.ok(ads > 20, `only ${ads} protected elements were walked`);
});

test('protected.containers covers the wrappers of real tiles and of every real empty ad slot on every capture', () => {
  const covered = (e) => e.matches(`${CONTAINERS_SEL}, ${ADS_SEL}, ${SPONSOR_SEL}, ${CONTROLS_SEL}`);
  for (const [kind, opts] of [...VARIANTS, ['home', { shorts: 'rich' }], ['search', { shorts: 'grid' }], ['watch', { shorts: 'reel' }]]) {
    const { document } = pageFor(kind, opts);
    const subjects = document.querySelectorAll(`ytd-rich-item-renderer, yt-lockup-view-model, ytd-video-renderer, ${KNOWN_EMPTY_AD_SLOTS}, ytd-reel-shelf-renderer, grid-shelf-view-model`);
    const missing = new Set();
    for (const s of subjects) for (let a = s.parentElement; a && a !== document.documentElement && a !== document.body; a = a.parentElement) {
      if (!covered(a)) missing.add(`<${a.tagName.toLowerCase()}${a.id ? '#' + a.id : ''}${a.className ? '.' + String(a.className).trim().split(/\s+/)[0] : ''}> (parent of <${s.tagName.toLowerCase()}>)`);
    }
    // The page header and filter chip bars sit beside the lists, never around an in-feed ad.
    const real = [...missing].filter((m) => !/#header>|ytd-search-header-renderer|yt-page-header|ytd-tabbed-page-header|ytd-feed-filter/.test(m));
    assert.deepEqual(real, [], `${label(kind, opts)}: uncovered ancestors`);
  }
});

test('calm-mode hide targets are never inside protected.ads / sponsor / playerControls (a hide rule on them would be refused)', () => {
  const calmRoles = ['shortsShelf', 'shortsTiles', 'shortsNavEntry', 'comments', 'endScreens', 'viewCounts'];
  const pagesToCheck = [['search', { shorts: 'grid', ads: 2 }], ['home', { shorts: 'rich', ads: 2 }], ['home', { shorts: 'rich', tileStyle: 'home', ads: 2 }],
    ['watch', { shorts: 'reel', ads: 2 }], ['channel', { ads: 1 }], ['playlist', {}], ['history', {}]];
  let hits = 0;
  for (const [kind, opts] of pagesToCheck) {
    const { document, window } = createPage(kind, { tiles: 6, ...opts });
    for (const role of calmRoles) {
      for (const sel of MAP.roles[role]) {
        for (const e of document.querySelectorAll(sel)) {
          hits++;
          assert.ok(!e.matches(`${ADS_SEL}, ${SPONSOR_SEL}, ${CONTROLS_SEL}`), `${role} "${sel}" selects a protected element <${e.tagName.toLowerCase()} class="${e.className}"> on ${kind}`);
          assert.ok(!e.closest(`${ADS_SEL}, ${SPONSOR_SEL}`), `${role} "${sel}" selects something INSIDE an ad/disclosure on ${kind}`);
        }
      }
    }
    window.close();
  }
  assert.ok(hits > 50);
});

test('home Shorts shelf as seen live (items carry is-shelf-item, not is-shorts-grid): section, shelf and cells are all found', () => {
  const { document, window } = createPage('home', { tiles: 6, shorts: 'rich' });
  const cells = [...document.querySelectorAll('ytd-rich-shelf-renderer ytd-rich-item-renderer')];
  assert.equal(cells.length, 3);
  for (const c of cells) { c.removeAttribute('is-shorts-grid'); c.setAttribute('is-shelf-item', ''); }
  assert.equal(document.querySelectorAll(MAP.roles.shortsTiles[1]).length, 3, 'cells found through their Shorts link, whatever attribute YouTube puts on them');
  assert.equal(document.querySelectorAll(MAP.roles.shortsShelf[1]).length, 1);
  assert.equal(document.querySelectorAll(MAP.roles.shortsShelf[3]).length, 1);
  // Regular grid tiles are never Shorts cells.
  const normal = [...document.querySelectorAll('ytd-rich-item-renderer:not(:has(ytm-shorts-lockup-view-model-v2))')];
  assert.equal(normal.length, 6);
  for (const n of normal) assert.equal(n.matches(commaJoin(MAP.roles.shortsTiles)), false);
  window.close();
});

test('Shorts roles hit the real Shorts markup: search shelf, channel Shorts grid, nav entries (and the synthetic rich/reel shelves)', () => {
  const search = pageFor('search', { shorts: 'grid' }).document;
  assert.equal(firstNonEmpty(search, 'shortsShelf').index, 0, 'grid-shelf-view-model is the live search shelf');
  assert.equal(search.querySelectorAll(MAP.roles.shortsShelf[0]).length, 1);
  assert.ok(firstNonEmpty(search, 'shortsTiles').els.length >= 3);
  const rich = pageFor('home', { shorts: 'rich' }).document;
  assert.equal(rich.querySelectorAll('ytd-rich-section-renderer:has(a[href^="/shorts/"])').length, 1, 'the whole shelf section is the hide target, not just the inner renderer');
  assert.ok(rich.querySelectorAll(MAP.roles.shortsShelf[3]).length === 1);
  const reel = pageFor('watch', { shorts: 'reel' }).document;
  assert.ok(reel.querySelectorAll(MAP.roles.shortsShelf[2]).length === 1);
  const nav = pageFor('home').document;
  const entries = unionMatches(nav, MAP.roles.shortsNavEntry);
  assert.ok(entries.length >= 3, 'mini link, title handle, and the entry wrappers');
  // A regular video tile or a Shorts-titled video must never be a Shorts tile.
  for (const tile of lockups(pageFor('home').document)) assert.equal(tile.matches(commaJoin(MAP.roles.shortsTiles)), false);
  // A channel's Shorts tab (real capture shorts-grid.html): the cell and the lockup match shortsTiles, the grid matches shortsShelf.
  const dom =new JSDOM(`<body>${loadFixture('real/shorts-grid')}</body>`);
  const d = dom.window.document;
  assert.equal(d.querySelectorAll(MAP.roles.shortsShelf[4]).length, 1);
  assert.equal(d.querySelectorAll(MAP.roles.shortsTiles[0]).length, 2);
  assert.equal(d.querySelectorAll(MAP.roles.shortsTiles[1]).length, 2);
  dom.window.close();
});

// ==================================================================================================================
// 7. Colour bridge (vars) and tileFields
// ==================================================================================================================

const COMPUTED = JSON.parse(loadFixture('computed-colors.json'));

test('vars: every token has a list of valid custom-property names, with both the yt-sys-color-baseline and the legacy families', () => {
  assert.deepEqual(Object.keys(MAP.vars), VAR_KEYS);
  const all = [];
  for (const k of VAR_KEYS) {
    const list = MAP.vars[k];
    assert.ok(Array.isArray(list) && list.length >= 1, `vars.${k} needs at least the sys name`);
    assert.equal(new Set(list).size, list.length, `vars.${k} has duplicates`);
    for (const name of list) { assert.match(name, /^--yt-(sys-color-baseline|deprecated|spec)-[a-z0-9-]+$/, `vars.${k}: "${name}" is not a YouTube colour variable`); all.push(name); }
    assert.ok(list.some((n) => n.startsWith('--yt-sys-color-baseline--')), `vars.${k} lacks a --yt-sys-color-baseline-- name`);
    if (KEYS_WITH_LEGACY.includes(k)) assert.ok(list.some((n) => n.startsWith('--yt-spec-') || n.startsWith('--yt-deprecated-')), `vars.${k} lacks a legacy name (--yt-spec-* or --yt-deprecated-*)`);
  }
  assert.ok(all.some((n) => n.startsWith('--yt-spec-')) && all.some((n) => n.startsWith('--yt-deprecated-general-background-')) && all.some((n) => n.startsWith('--yt-sys-color-baseline--')));
  // A variable listed under two tokens would be set twice with different colours; the last one wins silently.
  assert.equal(new Set(all).size, all.length, 'a YouTube variable is bridged by two different tokens');
  // The contract example for bg is a floor, not a ceiling.
  for (const n of ['--yt-sys-color-baseline--base-background', '--yt-deprecated-general-background-a', '--yt-spec-base-background']) assert.ok(MAP.vars.bg.includes(n));
  assert.ok(MAP.vars.bg.includes('--yt-deprecated-general-background-b') && MAP.vars.bg.includes('--yt-deprecated-general-background-c'));
});

test('vars: every --yt-sys-color-baseline-- name exists in YouTube\'s live variable set; the known-empty ones are not used', () => {
  const live = new Set(Object.keys(COMPUTED.sysColorsBaseline));
  // computed-colors.json records the live values (getComputedStyle, 2026-10-07) of every name the bridge uses.
  for (const name of Object.values(MAP.vars).flat()) {
    if (!name.startsWith('--yt-sys-color-baseline--')) continue;
    assert.ok(live.has(name), `${name} was not measured live; do not bridge to a guessed name`);
  }
  const emptyLive = ['--yt-sys-color-baseline--brand-background-solid', '--yt-sys-color-baseline--static-white', '--yt-sys-color-baseline--badge-background', '--yt-sys-color-baseline--themed-blue'];
  for (const name of emptyLive) assert.ok(!Object.values(MAP.vars).flat().includes(name), `${name} resolves to an empty string on YouTube today`);
  // The ad marker colour must never be re-coloured by the bridge.
  for (const name of Object.values(MAP.vars).flat()) assert.ok(!/ad-yellow|icon-warning|static-brand-red|red-indicator/.test(name), `${name} would recolour a safety / brand marker`);
  // Dark deprecated backgrounds are real too.
  for (const n of MAP.vars.bg.filter((x) => x.startsWith('--yt-deprecated-general-background-'))) assert.ok(n in COMPUTED.deprecatedGeneralBackground, `${n} not measured live`);
});

test('vars: the measured dark values line up with the token meaning (bg is the page background, surface is lighter than bg, ...)', () => {
  const v = COMPUTED.sysColorsBaseline;
  assert.equal(v[MAP.vars.bg[0]], '#0f0f0f');
  assert.equal(v[MAP.vars.surface[0]], '#212121');
  assert.equal(v[MAP.vars.menu[0]], '#282828');
  assert.equal(v[MAP.vars.text[0]], '#f1f1f1');
  assert.equal(v[MAP.vars.muted[0]], '#aaa');
  assert.equal(v[MAP.vars.accent[0]], '#3ea6ff');
  assert.equal(v[MAP.vars.accentHover[0]], '#65b8ff');
  assert.equal(v[MAP.vars.border[0]], 'rgba(255,255,255,0.2)');
  assert.equal(v[MAP.vars.borderOpaque[0]], '#3f3f3f');
  assert.equal(v[MAP.vars.overlay[0]], 'rgba(15,15,15,0.8)');
  assert.equal(COMPUTED.surfaces.html.backgroundColor, 'rgb(15, 15, 15)', 'html paints the page from base-background');
});

test('tileFields mirror the tile roles exactly (one source of truth)', () => {
  assert.deepEqual(Object.keys(MAP.tileFields), Object.keys(TILE_FIELDS));
  for (const [field, role] of Object.entries(TILE_FIELDS)) assert.deepEqual(MAP.tileFields[field], MAP.roles[role], `tileFields.${field} drifted from roles.${role}`);
});

// ==================================================================================================================
// 8. Documentation stays in step with the data
// ==================================================================================================================

test('LIVE-VERIFICATION.md exists, is dated, has a row per role and marks every _unverified role', () => {
  assert.ok(existsSync(DOC_FILE), 'test/data/LIVE-VERIFICATION.md is missing');
  const doc = readFileSync(DOC_FILE, 'utf8');
  assert.match(doc, /2026-10-07/, 'verification date');
  assert.ok(doc.includes(MAP.mapVersion), 'the doc names the map version it verified');
  for (const url of ['https://www.youtube.com/@NatGeo/videos', 'https://www.youtube.com/results?search_query=nature+documentary', 'https://www.youtube.com/watch?v=BzpdP2APcIM']) {
    assert.ok(doc.includes(url), `doc lacks the live URL ${url}`);
  }
  const lines = doc.split('\n');
  for (const role of Object.keys(MAP.roles)) {
    const row = lines.find((l) => l.startsWith(`| \`${role}\` |`));
    assert.ok(row, `LIVE-VERIFICATION.md has no table row for role "${role}"`);
    if (MAP._unverified.includes(role)) assert.match(row, /UNVERIFIED/, `${role} is in _unverified but its doc row does not say UNVERIFIED`);
    else assert.doesNotMatch(row, /UNVERIFIED/, `${role} is verified in the map but marked UNVERIFIED in the doc`);
  }
});

// ==================================================================================================================
// 9. validateMapShape (src/shared/selector-map.js, owned by the css-validator agent)
// ==================================================================================================================

async function loadSelectorMapModule() {
  // CD_SELECTOR_MAP_MODULE lets the logic of these two tests be rehearsed against a scratch implementation; unset in CI.
  const file = process.env.CD_SELECTOR_MAP_MODULE || path.join(ROOT, 'src', 'shared', 'selector-map.js');
  if (!existsSync(file)) return null;
  try {
    return await import(pathToFileURL(file).href);
  } catch (err) {
    // The file exists but fails to load: that is a real failure, not a skip.
    throw new Error(`src/shared/selector-map.js exists but cannot be imported: ${err.message}`, { cause: err });
  }
}
const okOf = (r) => (typeof r === 'boolean' ? r : r && typeof r === 'object' ? (typeof r.ok === 'boolean' ? r.ok : Array.isArray(r.errors) ? r.errors.length === 0 : true) : r === undefined);
const verdict = (fn, ...args) => { try { return okOf(fn(...args)); } catch { return false; } };

test('validateMapShape accepts the real map and rejects broken ones (needs src/shared/selector-map.js)', async (t) => {
  const mod = await loadSelectorMapModule();
  if (!mod || typeof mod.validateMapShape !== 'function') {
    const msg = 'SKIPPED: src/shared/selector-map.js (validateMapShape) does not exist yet. The reconcile pass MUST run this file again - until then the map shape is NOT validated against the real validator.';
    console.warn(`\n!!! ${msg}\n`);
    t.skip(msg);
    return;
  }
  const { validateMapShape } = mod;
  const result = validateMapShape(MAP);
  assert.ok(okOf(result), `validateMapShape rejected the real map: ${JSON.stringify(result)}`);
  const broken = [
    ['a required role removed', (m) => { delete m.roles.homeGrid; }],
    ['a role with no selectors', (m) => { m.roles.richItem = []; }],
    ['a non-string selector', (m) => { m.roles.richItem = [42]; }],
    ['protected group missing', (m) => { delete m.protected.ads; }],
    ['requires names an unknown role', (m) => { m.requires.theme = ['noSuchRole']; }],
    ['schema removed', (m) => { delete m.schema; }],
  ];
  let rejected = 0;
  for (const [what, mutate] of broken) {
    const copy = structuredClone(MAP);
    mutate(copy);
    if (!verdict(validateMapShape, copy)) rejected++;
    else console.warn(`validateMapShape accepted a map with ${what} (not necessarily wrong for that module, noted for the reconcile pass)`);
  }
  assert.ok(rejected >= 3, `validateMapShape rejected only ${rejected}/${broken.length} broken maps; it is too lax to protect the engine`);
});

test('roleCss / safeHide / protectedCss work on the real map, and a safeHide rule leaves in-feed ads visible (needs src/shared/selector-map.js)', async (t) => {
  const mod = await loadSelectorMapModule();
  if (!mod || typeof mod.safeHide !== 'function' || typeof mod.roleCss !== 'function') {
    const msg = 'SKIPPED: src/shared/selector-map.js (roleCss/safeHide) does not exist yet; run again in the reconcile pass.';
    console.warn(`\n!!! ${msg}\n`);
    t.skip(msg);
    return;
  }
  const { roleCss, safeHide } = mod;
  for (const role of REQUIRED_ROLES) {
    const css = roleCss(MAP, role);
    assert.equal(typeof css, 'string');
    for (const s of MAP.roles[role]) assert.ok(css.includes(s), `roleCss(${role}) lost "${s}"`);
  }
  const { document, window } = createPage('home', { tiles: 6, ads: 2 });
  const guarded = safeHide(MAP, 'ytd-rich-item-renderer');
  assert.ok(guarded.includes(':not(:has('), 'safeHide must add the :not(:has(ads)) guard');
  assert.ok(guarded.includes('ytd-ad-slot-renderer') && guarded.includes('#masthead-ad'), 'the guard lists the protected ads');
  const style = document.createElement('style');
  style.textContent = `${guarded} { display: none !important; }`;
  document.head.appendChild(style);
  const items = [...document.querySelectorAll('ytd-rich-item-renderer')];
  const adItems = items.filter((i) => i.querySelector('ytd-ad-slot-renderer'));
  assert.equal(adItems.length, 2);
  for (const i of items) {
    const hidden = window.getComputedStyle(i).display === 'none';
    assert.equal(hidden, !adItems.includes(i), adItems.includes(i) ? 'an in-feed ad item was hidden' : 'a normal tile was not hidden');
  }
  // The big wrapper cannot be hidden at all while a (even empty) ad slot lives inside it.
  const wrapper = safeHide(MAP, 'ytd-rich-grid-renderer');
  style.textContent = `${wrapper} { display: none !important; }`;
  assert.notEqual(window.getComputedStyle(document.querySelector('ytd-rich-grid-renderer')).display, 'none', 'the rich grid holds #masthead-ad, so hiding it must be refused by the guard');
  window.close();
});

// Tests for src/shared/selector-map.js (owner: css-validator). ARCHITECTURE.md section 3.1, section 4 "shared/selector-map.js", section 6.
//
// Real data throughout: src/data/selector-map.source.json for the map, test/helpers/dom.js pages (with ads) for the guard, and the real
// css-validator for "does the output of safeHide() count as safe".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  validateMapShape, roleCss, protectedCss, safeHide, parseEnvelopePayload, splitSelectorList, buildAllowList,
  REQUIRED_ROLES, PROTECTED_GROUPS, VAR_KEYS, TILE_FIELD_KEYS,
} from '../../src/shared/selector-map.js';
import { validateCss, buildAllowList as validatorBuildAllowList } from '../../src/shared/css-validator.js';
import { createPage } from '../helpers/dom.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAP = JSON.parse(readFileSync(path.join(ROOT, 'src', 'data', 'selector-map.source.json'), 'utf8'));
const clone = () => structuredClone(MAP);
const ADS = MAP.protected.ads;
const GUARD = `:not(:has(${ADS.join(', ')}))`;
const CTX = { allowList: buildAllowList(MAP), protectedSelectors: [...MAP.protected.ads, ...MAP.protected.sponsor, ...MAP.protected.playerControls] };

const shapeErrors = (map) => validateMapShape(map).errors;
const hasError = (map, pathRe, msgRe) => shapeErrors(map).some((e) => pathRe.test(e.path) && (!msgRe || msgRe.test(e.message)));

// ---- constants and re-exports ----------------------------------------------------------------------------------------------

test('exports: the constant lists are frozen and agree with the real map', () => {
  for (const list of [REQUIRED_ROLES, PROTECTED_GROUPS, VAR_KEYS, TILE_FIELD_KEYS]) assert.ok(Object.isFrozen(list));
  assert.deepEqual([...PROTECTED_GROUPS], ['ads', 'sponsor', 'playerControls', 'containers']);
  for (const role of REQUIRED_ROLES) assert.ok(Array.isArray(MAP.roles[role]) && MAP.roles[role].length > 0, `real map defines ${role}`);
  for (const key of VAR_KEYS) assert.ok(MAP.vars[key].length > 0, key);
  for (const key of TILE_FIELD_KEYS) assert.ok(MAP.tileFields[key].length > 0, key);
  assert.equal(new Set(REQUIRED_ROLES).size, REQUIRED_ROLES.length, 'no duplicate required roles');
});

test('buildAllowList is re-exported from css-validator.js, not copied', () => {
  assert.equal(buildAllowList, validatorBuildAllowList);
});

// ---- validateMapShape: the real map and broken variants --------------------------------------------------------------------------

test('validateMapShape accepts the real selector map and returns {ok, errors: []}', () => {
  const r = validateMapShape(MAP);
  assert.deepEqual(Object.keys(r).sort(), ['errors', 'ok']);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.errors, []);
});

test('validateMapShape does not mutate the map it checks', () => {
  const m = clone();
  const before = JSON.stringify(m);
  validateMapShape(m);
  assert.equal(JSON.stringify(m), before);
});

test('validateMapShape: anything that is not a JSON object is one error at the root, never an exception', () => {
  for (const bad of [undefined, null, 0, 42, true, 'map', '{}', [], [MAP], () => MAP, Symbol('x'), 10n]) {
    const r = validateMapShape(bad);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].path, '');
    assert.match(r.errors[0].message, /JSON object/);
  }
});

test('validateMapShape: an empty object lists every top-level problem with a path and a message', () => {
  const r = validateMapShape({});
  assert.equal(r.ok, false);
  const paths = r.errors.map((e) => e.path);
  for (const p of ['schema', 'mapVersion', 'issuedAt', 'roles', 'pageRoles', 'requires', 'protected', 'vars', 'tileFields']) assert.ok(paths.includes(p), `reports ${p}`);
  for (const e of r.errors) {
    assert.deepEqual(Object.keys(e).sort(), ['message', 'path']);
    assert.equal(typeof e.message, 'string');
    assert.ok(e.message.length > 0);
  }
});

/** [label, mutate(map), path pattern, message pattern] */
const BROKEN = [
  ['schema is not 1', (m) => { m.schema = 2; }, /^schema$/, /number 1/],
  ['schema is the string "1"', (m) => { m.schema = '1'; }, /^schema$/],
  ['mapVersion missing', (m) => { delete m.mapVersion; }, /^mapVersion$/],
  ['mapVersion is a number', (m) => { m.mapVersion = 20261007; }, /^mapVersion$/],
  ['mapVersion has a v prefix', (m) => { m.mapVersion = 'v2026.10.07.1'; }, /^mapVersion$/, /dotted numeric/],
  ['mapVersion has an empty part', (m) => { m.mapVersion = '2026..1'; }, /^mapVersion$/],
  ['mapVersion has too many parts', (m) => { m.mapVersion = '1.2.3.4.5.6.7'; }, /^mapVersion$/],
  ['issuedAt is not a date', (m) => { m.issuedAt = 'yesterday'; }, /^issuedAt$/, /ISO date/],
  ['issuedAt is a number', (m) => { m.issuedAt = 1760000000; }, /^issuedAt$/],
  ['a required role is missing', (m) => { delete m.roles.richItem; }, /^roles\.richItem$/, /Required role/],
  ['every role is missing', (m) => { m.roles = {}; }, /^roles\.app$/, /Required role/],
  ['roles is an array', (m) => { m.roles = []; }, /^roles$/],
  ['a role is not an array', (m) => { m.roles.app = '#app'; }, /^roles\.app$/, /array of selector strings/],
  ['a role is an empty list', (m) => { m.roles.app = []; }, /^roles\.app$/, /at least one/],
  ['a role holds a non-string', (m) => { m.roles.app = ['ytd-app', 5]; }, /^roles\.app\[1\]$/, /string/],
  ['a role holds an empty string', (m) => { m.roles.app = ['  ']; }, /^roles\.app\[0\]$/, /empty/],
  ['a role selector is a list with a top-level comma', (m) => { m.roles.app = ['ytd-app, ytd-browse']; }, /^roles\.app\[0\]$/, /ONE complex selector/],
  ['a role selector does not parse', (m) => { m.roles.app = ['ytd-app >']; }, /^roles\.app\[0\]$/, /not a valid selector/],
  ['a role selector is longer than 1000 characters', (m) => { m.roles.app = [`.${'a'.repeat(1001)}`]; }, /^roles\.app\[0\]$/, /1000/],
  ['a role has more than 64 selectors', (m) => { m.roles.app = Array.from({ length: 65 }, (_, i) => `ytd-x${i}`); }, /^roles\.app$/, /at most 64/],
  ['a role name has a space', (m) => { m.roles['bad name'] = ['a']; }, /^roles\.bad name$/, /letters and digits/],
  ['a role name starts with an underscore', (m) => { m.roles._x = ['a']; }, /^roles\._x$/],
  ['more than 256 roles', (m) => { for (let i = 0; i < 300; i++) m.roles[`extra${i}`] = ['ytd-x']; }, /^roles$/, /at most 256/],
  ['pageRoles names an unknown role', (m) => { m.pageRoles.home.push('noSuchRole'); }, /^pageRoles\.home$/, /unknown role "noSuchRole"/],
  ['pageRoles entry is not an array', (m) => { m.pageRoles.home = 'app'; }, /^pageRoles\.home$/, /array of role names/],
  ['pageRoles is missing', (m) => { delete m.pageRoles; }, /^pageRoles$/],
  ['requires names an unknown role', (m) => { m.requires.watch = ['noSuchRole']; }, /^requires\.watch$/, /unknown role/],
  ['requires holds a non-string', (m) => { m.requires.watch = [1]; }, /^requires\.watch$/],
  ['protected is missing', (m) => { delete m.protected; }, /^protected$/],
  ['protected.ads is empty (the ad guard cannot be empty)', (m) => { m.protected.ads = []; }, /^protected\.ads$/, /at least one/],
  ['protected.ads is missing', (m) => { delete m.protected.ads; }, /^protected\.ads$/, /array of selector strings/],
  ['protected.sponsor is empty', (m) => { m.protected.sponsor = []; }, /^protected\.sponsor$/],
  ['protected.playerControls is empty', (m) => { m.protected.playerControls = []; }, /^protected\.playerControls$/],
  ['protected.containers is missing', (m) => { delete m.protected.containers; }, /^protected\.containers$/],
  ['a protected selector does not parse', (m) => { m.protected.ads[3] = '.ytp-ad-module:'; }, /^protected\.ads\[3\]$/, /not a valid selector/],
  ['a protected selector smuggles a second rule', (m) => { m.protected.ads[0] = 'ytd-ad-slot-renderer{display:none}'; }, /^protected\.ads\[0\]$/],
  ['a protected selector is a comma list', (m) => { m.protected.ads[0] = 'ytd-ad-slot-renderer, .evil'; }, /^protected\.ads\[0\]$/, /ONE complex selector/],
  ['more than 256 protected selectors', (m) => { m.protected.containers = Array.from({ length: 257 }, (_, i) => `ytd-c${i}`); }, /^protected\.containers$/, /at most 256/],
  ['vars is missing', (m) => { delete m.vars; }, /^vars$/],
  ['a colour token is missing', (m) => { delete m.vars.accent; }, /^vars\.accent$/],
  ['a colour token has an empty list', (m) => { m.vars.bg = []; }, /^vars\.bg$/, /non-empty array/],
  ['a colour token names a non-custom property', (m) => { m.vars.bg = ['color']; }, /^vars\.bg$/],
  ['a colour token has an injectable name', (m) => { m.vars.bg = ['--x;color:red']; }, /^vars\.bg$/],
  ['tileFields is missing', (m) => { delete m.tileFields; }, /^tileFields$/],
  ['a tile field is missing', (m) => { delete m.tileFields.link; }, /^tileFields\.link$/],
  ['a tile field selector does not parse', (m) => { m.tileFields.title = ['a[']; }, /^tileFields\.title\[0\]$/],
  ['_unverified names an unknown role', (m) => { m._unverified = ['noSuchRole']; }, /^_unverified$/, /known role names/],
  ['_unverified is not an array', (m) => { m._unverified = 'historyList'; }, /^_unverified$/],
];
for (const [label, mutate, pathRe, msgRe] of BROKEN) {
  test(`validateMapShape refuses: ${label}`, () => {
    const m = clone();
    mutate(m);
    const r = validateMapShape(m);
    assert.equal(r.ok, false, 'a broken map must not validate');
    assert.ok(hasError(m, pathRe, msgRe), `expected an error at ${pathRe} ${msgRe || ''}; got ${JSON.stringify(r.errors.slice(0, 5))}`);
  });
}

test('validateMapShape: optional parts may be absent or empty', () => {
  const m = clone();
  delete m._unverified;
  assert.equal(validateMapShape(m).ok, true);
  m._unverified = [];
  assert.equal(validateMapShape(m).ok, true);
  m.mapVersion = '1';
  assert.equal(validateMapShape(m).ok, true);
  m.roles.extraRole = ['ytd-extra'];
  assert.equal(validateMapShape(m).ok, true, 'extra roles are fine');
});

test('validateMapShape: a JSON "__proto__" key is an own property and is refused as a role name', () => {
  const m = JSON.parse(JSON.stringify(MAP).replace('"roles":{', '"roles":{"__proto__":["ytd-evil"],'));
  assert.ok(Object.prototype.hasOwnProperty.call(m.roles, '__proto__'));
  assert.ok(hasError(m, /__proto__/, /letters and digits/));
  assert.equal(Object.prototype.hasOwnProperty.call({}, 'ytd-evil'), false);
});

test('validateMapShape caps a flood of errors and never throws on hostile objects', () => {
  const flood = clone();
  for (const k of Object.keys(flood.roles)) flood.roles[k] = ['a >'];
  const r = validateMapShape(flood);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length <= 60 && r.errors.length > 30, `${r.errors.length} errors`);

  const getter = {};
  Object.defineProperty(getter, 'roles', { enumerable: true, get() { throw new Error('boom'); } });
  const a = validateMapShape(getter);
  assert.equal(a.ok, false);
  assert.ok(a.errors.some((e) => /could not be read/.test(e.message)), 'the throwing getter is reported');

  const proxy = new Proxy({}, { get() { throw new Error('boom'); }, has() { throw new Error('boom'); }, ownKeys() { throw new Error('boom'); } });
  assert.equal(validateMapShape(proxy).ok, false);

  const cyclic = clone();
  cyclic.self = cyclic;
  cyclic.roles.loop = cyclic.roles;
  assert.doesNotThrow(() => validateMapShape(cyclic));
  assert.equal(validateMapShape(cyclic).ok, false, 'a role whose value is an object is not a selector list');
});

// ---- roleCss ---------------------------------------------------------------------------------------------------------------------

test('roleCss joins the role selectors with ", " in map order', () => {
  assert.equal(roleCss(MAP, 'richItem'), MAP.roles.richItem.join(', '));
  assert.equal(roleCss(MAP, 'homeGrid'), 'ytd-browse[page-subtype="home"] ytd-rich-grid-renderer, ytd-two-column-browse-results-renderer[page-subtype="home"] ytd-rich-grid-renderer');
  for (const role of REQUIRED_ROLES) {
    const css = roleCss(MAP, role);
    assert.ok(css.length > 0, role);
    assert.equal(splitSelectorList(css).length, MAP.roles[role].length, `${role}: one member per entry`);
  }
});

test('roleCss returns "" for a missing role, a bad role argument or a broken map, and never throws', () => {
  for (const role of ['noSuchRole', '', undefined, null, 5, {}, [], 'constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.equal(roleCss(MAP, role), '', String(role));
  for (const map of [undefined, null, 0, 'x', [], {}, { roles: null }, { roles: [] }, { roles: { app: 'ytd-app' } }, { roles: { app: {} } }]) assert.equal(roleCss(map, 'app'), '');
  const hostile = new Proxy({}, { get() { throw new Error('boom'); } });
  assert.equal(roleCss(hostile, 'app'), '');
  const getter = { roles: { get app() { throw new Error('boom'); } } };
  assert.equal(roleCss(getter, 'app'), '');
});

test('roleCss ignores non-string and blank entries and trims the rest', () => {
  const map = { roles: { r: ['  ytd-a  ', '', '   ', 5, null, { x: 1 }, 'ytd-b'] } };
  assert.equal(roleCss(map, 'r'), 'ytd-a, ytd-b');
});

// ---- protectedCss ----------------------------------------------------------------------------------------------------------------

test('protectedCss with no group is ads + sponsor + playerControls, never the containers', () => {
  const all = protectedCss(MAP);
  assert.equal(all, [...MAP.protected.ads, ...MAP.protected.sponsor, ...MAP.protected.playerControls].join(', '));
  assert.equal(splitSelectorList(all).length, 109);
  assert.equal(protectedCss(MAP, undefined), all);
  assert.equal(protectedCss(MAP, null), all);
  for (const c of MAP.protected.containers) assert.ok(!splitSelectorList(all).includes(c) || MAP.protected.ads.includes(c) || MAP.protected.sponsor.includes(c) || MAP.protected.playerControls.includes(c), c);
});

test('protectedCss(group) returns that group alone; containers are a group of their own', () => {
  for (const g of PROTECTED_GROUPS) assert.equal(protectedCss(MAP, g), MAP.protected[g].join(', '), g);
  assert.equal(splitSelectorList(protectedCss(MAP, 'containers')).length, MAP.protected.containers.length);
});

test('protectedCss returns "" for an unknown group, a non-string group, or empty and broken maps', () => {
  for (const g of ['bogus', '', 'ADS', 'roles', 'constructor', 5, {}, [], true]) assert.equal(protectedCss(MAP, g), '', String(g));
  for (const map of [undefined, null, 'x', [], {}, { protected: null }, { protected: [] }, { protected: { ads: 'x' } }, { protected: { ads: [] , sponsor: [], playerControls: [] } }]) {
    assert.equal(protectedCss(map), '');
    assert.equal(protectedCss(map, 'ads'), '');
  }
  assert.equal(protectedCss({ protected: { ads: ['a'], sponsor: [], playerControls: ['c'] } }), 'a, c', 'empty groups simply contribute nothing');
});

// ---- splitSelectorList ----------------------------------------------------------------------------------------------------------

test('splitSelectorList splits on top-level commas only', () => {
  assert.deepEqual(splitSelectorList('a, b:is(c, d), [x="a,b"], e'), ['a', 'b:is(c, d)', '[x="a,b"]', 'e']);
  assert.deepEqual(splitSelectorList('a:not(b,c)>d,e'), ['a:not(b,c)>d', 'e']);
  assert.deepEqual(splitSelectorList("[x='a,b'],y"), ["[x='a,b']", 'y']);
  assert.deepEqual(splitSelectorList('a\\,b, c'), ['a\\,b', 'c'], 'an escaped comma is part of the name');
  assert.deepEqual(splitSelectorList(' a ,, b , '), ['a', 'b'], 'empty members are dropped');
  assert.deepEqual(splitSelectorList('single'), ['single']);
  assert.deepEqual(splitSelectorList(''), []);
  for (const bad of [undefined, null, 5, {}, [], ['a,b']]) assert.deepEqual(splitSelectorList(bad), []);
  assert.deepEqual(splitSelectorList('a), b'), ['a)', 'b'], 'stray closers do not underflow the depth');
});

// ---- safeHide -------------------------------------------------------------------------------------------------------------------

test('safeHide appends :not(:has(<every protected ad>)) to a selector', () => {
  assert.equal(safeHide(MAP, 'ytd-rich-item-renderer'), `ytd-rich-item-renderer${GUARD}`);
  assert.equal(safeHide(MAP, '  #contents  '), `#contents${GUARD}`);
  assert.equal(safeHide(MAP, 'html[cd-calm-hideShorts] ytd-rich-item-renderer > #content'), `html[cd-calm-hideShorts] ytd-rich-item-renderer > #content${GUARD}`);
  assert.ok(safeHide(MAP, 'x').includes(ADS[ADS.length - 1]), 'the last protected ad is in the guard too');
  for (const ad of ADS) assert.ok(safeHide(MAP, 'x').includes(ad), ad);
});

test('safeHide guards a selector list member by member, without splitting inside :is(), :not() or attribute strings', () => {
  const out = safeHide(MAP, 'ytd-rich-item-renderer, ytd-video-renderer ,#contents');
  assert.deepEqual(splitSelectorList(out).map((m) => m.replace(GUARD, '')), ['ytd-rich-item-renderer', 'ytd-video-renderer', '#contents']);
  assert.equal(out.split(GUARD).length - 1, 3, 'one guard per member');
  const tricky = safeHide(MAP, ':is(ytd-rich-item-renderer, #contents), a[href="/a,b"]');
  assert.equal(splitSelectorList(tricky).length, 2);
  assert.ok(splitSelectorList(tricky)[0].startsWith(':is(ytd-rich-item-renderer, #contents)') && splitSelectorList(tricky)[0].endsWith(GUARD));
  assert.ok(splitSelectorList(tricky)[1].startsWith('a[href="/a,b"]') && splitSelectorList(tricky)[1].endsWith(GUARD));
});

test('safeHide keeps a trailing pseudo-element last', () => {
  for (const [sel, tail] of [['a.b::after', '::after'], ['a.b::before', '::before'], ['a.b:before', ':before'], ['a.b:AFTER', ':AFTER'], ['a.b::first-line', '::first-line'],
    ['a.b:hover::after', '::after'], ['a.b::part(x)', '::part(x)']]) {
    assert.equal(safeHide(MAP, sel), `${sel.slice(0, sel.lastIndexOf(tail))}${GUARD}${tail}`, sel);
  }
  assert.equal(safeHide(MAP, 'a:hover'), `a:hover${GUARD}`);
  assert.equal(safeHide(MAP, 'a::after b'), `a::after b${GUARD}`, 'a pseudo-element before a combinator is not trailing');
});

test('safeHide is idempotent', () => {
  for (const sel of ['ytd-rich-item-renderer', 'a, b', 'a.b::after', ':is(a, b) > c']) {
    const once = safeHide(MAP, sel);
    assert.equal(safeHide(MAP, once), once, sel);
  }
});

test('safeHide leaves the selector unchanged when the map has no usable ads, and returns "" for junk selectors', () => {
  const noAds = [{}, { protected: {} }, { protected: { ads: [] } }, { protected: { ads: 'x' } }, { protected: { ads: [5, null, ''] } }, null, undefined, 'map', []];
  for (const map of noAds) {
    assert.equal(safeHide(map, 'ytd-rich-item-renderer'), 'ytd-rich-item-renderer');
    assert.equal(safeHide(map, 'a, b'), 'a, b', 'unchanged, spacing included');
  }
  const emptyGroups = { ...clone(), protected: { ads: [], sponsor: [], playerControls: [], containers: [] } };
  assert.equal(safeHide(emptyGroups, 'ytd-rich-item-renderer'), 'ytd-rich-item-renderer');
  for (const sel of [undefined, null, 5, {}, [], ['a'], '', '   ', ',', ' , ,']) assert.equal(safeHide(MAP, sel), '', String(sel));
});

test('safeHide never lets a hostile map entry break out of the guard', () => {
  const map = { protected: { ads: ['ytd-ad-slot-renderer', 'x}body{display:none', 'a;b', 'c)', '(d', 'e/*', '*/f', '"open', 'g\nh', '<!--', '.ytp-ad-module'] } };
  assert.equal(safeHide(map, 'ytd-x'), '', 'an entry that cannot sit in the guard is dropped: fail closed, no rule (never a weaker guard)');
  const clean = { protected: { ads: ['ytd-ad-slot-renderer', '.ytp-ad-module'] } };
  assert.equal(safeHide(clean, 'ytd-x'), 'ytd-x:not(:has(ytd-ad-slot-renderer, .ytp-ad-module))');
  const allBad = { protected: { ads: ['x}', 'y;'] } };
  assert.equal(safeHide(allBad, 'ytd-x'), '', 'with nothing safe to put in the guard there is no rule at all');
  const hostile = new Proxy({}, { get() { throw new Error('boom'); } });
  assert.equal(safeHide(hostile, 'ytd-x'), 'ytd-x');
});

test('safeHide output is accepted by the css-validator for every role, and the bare selector is refused where an ad can sit inside', () => {
  for (const role of Object.keys(MAP.roles)) {
    const guarded = `${safeHide(MAP, roleCss(MAP, role))}{display:none !important}`;
    const r = validateCss(guarded, CTX);
    assert.equal(r.ok, true, `${role}: ${JSON.stringify(r.errors[0])}`);
  }
  for (const container of ['ytd-rich-item-renderer', '#contents', 'ytd-watch-flexy', '#movie_player', 'ytd-engagement-panel-section-list-renderer']) {
    assert.equal(validateCss(`${container}{display:none}`, CTX).ok, false, `${container} unguarded`);
    assert.equal(validateCss(`${safeHide(MAP, container)}{display:none}`, CTX).ok, true, `${container} guarded`);
  }
  // A guard built from only some of the ads is not enough.
  assert.equal(validateCss(`ytd-rich-item-renderer:not(:has(${ADS.slice(1).join(',')})){display:none}`, CTX).ok, false);
});

test('safeHide on a map with empty protected groups produces CSS the validator still refuses for containers', () => {
  const emptyGroups = { ...clone(), protected: { ads: [], sponsor: [], playerControls: [], containers: [] } };
  const unguarded = safeHide(emptyGroups, 'ytd-rich-item-renderer');
  assert.equal(unguarded, 'ytd-rich-item-renderer');
  assert.equal(validateCss(`${unguarded}{display:none}`, CTX).ok, false, 'with the real protected list in the validator, an unguarded container hide is refused');
  assert.equal(validateMapShape(emptyGroups).ok, false, 'and the map itself is reported broken');
});

// ---- the guard on real (jsdom) pages with ads ------------------------------------------------------------------------------

const adsCss = protectedCss(MAP, 'ads');

test('jsdom home page: safeHide keeps the ad item out while matching every ordinary tile', () => {
  const { document, meta } = createPage('home', { tiles: 6, ads: true });
  assert.ok(meta.ads >= 1, 'the page carries ads (a feed ad and the masthead slot)');
  const rich = roleCss(MAP, 'richItem');
  const all = [...document.querySelectorAll(rich)];
  // The role also matches ytd-browse itself ([rendered-from-rich-grid]), which holds the ad too, so compute the holders instead of assuming one.
  const holders = all.filter((el) => el.querySelector(adsCss) || el.matches(adsCss));
  assert.ok(holders.some((el) => el.tagName === 'YTD-RICH-ITEM-RENDERER'), 'the ad feed item is among the elements that hold an ad');
  assert.ok(holders.length < all.length, 'ordinary tiles exist');
  const hidden = new Set(document.querySelectorAll(safeHide(MAP, rich)));
  for (const el of all) assert.equal(hidden.has(el), !holders.includes(el), `${el.tagName.toLowerCase()}: matched exactly when it holds no ad`);
  for (const el of hidden) assert.equal(el.querySelector(adsCss), null, 'no matched element holds an ad');
  assert.equal([...hidden].filter((el) => el.tagName === 'YTD-RICH-ITEM-RENDERER').length, 6, 'all six ordinary tiles are matched');
});

test('jsdom home page with several ads: every ad item is matched out, and so is every ancestor of an ad', () => {
  const { document } = createPage('home', { tiles: 8, ads: 3 });
  const hidden = new Set(document.querySelectorAll(safeHide(MAP, 'ytd-rich-item-renderer, #contents, #content, ytd-rich-grid-renderer, ytd-browse')));
  for (const ad of document.querySelectorAll(adsCss)) {
    for (let el = ad; el; el = el.parentElement) assert.ok(!hidden.has(el), `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} holds or is an ad`);
  }
  assert.ok(hidden.size > 0, 'ordinary content is still matched');
});

test('jsdom: for every container in the map and every page kind, safeHide never matches an element that holds or is an ad', () => {
  for (const kind of ['home', 'watch', 'search', 'channel', 'subscriptions']) {
    const { document, meta } = createPage(kind, { tiles: 5, ads: true });
    assert.ok(meta.ads >= 1, `${kind} has ads`);
    let guardedMatches = 0;
    let unguardedHoldingAds = 0;
    for (const sel of MAP.protected.containers) {
      for (const el of document.querySelectorAll(safeHide(MAP, sel))) {
        guardedMatches++;
        assert.ok(!el.matches(adsCss) && el.querySelector(adsCss) === null, `${kind}: ${sel} matched ${el.tagName.toLowerCase()} that holds an ad`);
      }
      for (const el of document.querySelectorAll(sel)) if (el.querySelector(adsCss)) unguardedHoldingAds++;
    }
    assert.ok(guardedMatches > 0, `${kind}: the guard still lets ordinary containers through`);
    assert.ok(unguardedHoldingAds > 0, `${kind}: without the guard the same selectors would have matched elements that hold ads`);
  }
});

test('jsdom: the empty masthead-ad wrapper does not make the guard fail open (it is in the ads list, so its container is excluded)', () => {
  const { document } = createPage('home', { tiles: 4, ads: true });
  const wrapper = document.querySelector('#masthead-ad');
  assert.ok(wrapper, 'the page has the masthead ad slot wrapper');
  const holder = wrapper.closest('ytd-rich-section-renderer, #contents, ytd-rich-grid-renderer, ytd-browse');
  assert.ok(holder);
  assert.equal(holder.matches(safeHide(MAP, holder.tagName.toLowerCase())), false, 'the element that contains the wrapper is excluded');
});

// ---- parseEnvelopePayload --------------------------------------------------------------------------------------------------

const envelope = (map, extra = {}) => ({ payload: JSON.stringify(map), sig: 'AAAA', kid: 'k1', ...extra });

test('parseEnvelopePayload returns the map inside an object or a JSON-string envelope', () => {
  assert.deepEqual(parseEnvelopePayload(envelope(MAP)), MAP);
  assert.deepEqual(parseEnvelopePayload(JSON.stringify(envelope(MAP))), MAP);
  assert.deepEqual(parseEnvelopePayload({ payload: JSON.stringify(MAP) }), MAP, 'sig and kid are not its business');
});

test('parseEnvelopePayload returns null for junk input, never throws', () => {
  const junk = [undefined, null, 0, 1, true, false, '', 'junk', '{', '[]', 'null', '123', '"str"', '{"payload":5}', '{"payload":null}', '{}', [], [envelope(MAP)], () => envelope(MAP),
    Symbol('x'), 10n, new Date(), {}, { payload: '' }, { payload: 'not json' }, { payload: '[]' }, { payload: 'null' }, { payload: '5' }, { payload: '"x"' }, { payload: {} },
    { payload: JSON.stringify(MAP).slice(0, 200) }, { payload: [JSON.stringify(MAP)] }, { payload: 42 }, { Payload: JSON.stringify(MAP) }];
  for (const j of junk) {
    let out = 'unset';
    assert.doesNotThrow(() => { out = parseEnvelopePayload(j); }, String(j));
    assert.equal(out, null, String(typeof j === 'function' ? 'function' : typeof j === 'symbol' ? 'symbol' : typeof j === 'bigint' ? 'bigint' : JSON.stringify(j)));
  }
});

test('parseEnvelopePayload returns null when the payload parses but is not a healthy map', () => {
  for (const mutate of [(m) => { m.schema = 2; }, (m) => { delete m.roles.richItem; }, (m) => { m.protected.ads = []; }, (m) => { m.roles = null; }]) {
    const m = clone();
    mutate(m);
    assert.equal(parseEnvelopePayload(envelope(m)), null);
    assert.equal(parseEnvelopePayload(JSON.stringify(envelope(m))), null);
  }
  assert.equal(parseEnvelopePayload(envelope({})), null);
  assert.equal(parseEnvelopePayload(envelope([])), null);
});

test('parseEnvelopePayload refuses oversize input without parsing it', () => {
  const big = 'x'.repeat(1_000_001);
  assert.equal(parseEnvelopePayload({ payload: big }), null);
  assert.equal(parseEnvelopePayload(big), null);
  assert.equal(parseEnvelopePayload(JSON.stringify({ payload: big })), null);
  const padded = clone();
  padded.roles.padding = Array.from({ length: 64 }, () => `ytd-${'x'.repeat(900)}`);
  for (let i = 0; i < 20; i++) padded.roles[`padding${i}`] = padded.roles.padding;
  const text = JSON.stringify(padded);
  assert.ok(text.length > 1_000_000, 'the padded map is over the limit');
  assert.equal(parseEnvelopePayload({ payload: text }), null);
});

test('parseEnvelopePayload survives hostile envelopes (throwing getters, proxies) and a "__proto__" payload', () => {
  const getter = {};
  Object.defineProperty(getter, 'payload', { enumerable: true, get() { throw new Error('boom'); } });
  assert.equal(parseEnvelopePayload(getter), null);
  const proxy = new Proxy({}, { get() { throw new Error('boom'); }, getPrototypeOf() { throw new Error('boom'); } });
  assert.equal(parseEnvelopePayload(proxy), null);
  assert.equal(parseEnvelopePayload({ payload: '{"__proto__":{"polluted":true},"schema":1}' }), null);
  assert.equal({}.polluted, undefined, 'no prototype pollution');
});

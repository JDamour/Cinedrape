// Tests for src/content/health.js (owner: selectors agent).
//
// Real selector map, real fixtures, real selectors.js. What is proven:
//   1. Healthy pages of every kind report nothing for any feature; unknown / mis-scoped input is harmless.
//   2. Renamed YouTube markup (opts.rename) breaks exactly the features that need the renamed roles, with exactly those roles,
//      and leaves every healthy feature alone. Fallback selectors keep a role alive.
//   3. watch(): roles that appear late are never reported; roles still missing at the deadline are, once; supersede, dispose,
//      hidden tabs, page-type changes, attribute-only appearance, real timers.
//   4. record(): layouts can report their own failure; unknown features and roles are refused.
//   5. Counters stay anonymous (closed vocabulary: map role names + built-in theme ids) and nothing here can reach a network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPage, navigateTo } from '../helpers/dom.js';
import { createSelectors } from '../../src/content/selectors.js';
import { createHealth } from '../../src/content/health.js';
import { ALL_THEME_IDS, ATTR, FEATURES } from '../../src/shared/constants.js';

const MAP = JSON.parse(readFileSync(new URL('../../src/data/selector-map.source.json', import.meta.url), 'utf8'));
const SOURCE = readFileSync(new URL('../../src/content/health.js', import.meta.url), 'utf8');

const open = [];
function page(kind, opts = {}) {
  const p = createPage(kind, { tiles: 3, ...opts });
  open.push(p);
  return p;
}
after(() => { for (const p of open) p.window.close(); });

const tick = () => new Promise((resolve) => setImmediate(resolve)); // lets jsdom deliver MutationObserver records
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Deterministic stand-in for setTimeout/clearTimeout, injected through createHealth({timers}). */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map();
  const delays = [];
  const cleared = [];
  return {
    setTimeout(fn, ms) { const id = nextId++; delays.push(ms); tasks.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { cleared.push(id); tasks.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, task] of tasks) if (task.at <= end && (!next || task.at < next[1].at)) next = [id, task];
        if (!next) break;
        now = next[1].at;
        tasks.delete(next[0]);
        next[1].fn();
      }
      now = end;
    },
    get pending() { return tasks.size; },
    delays,
    cleared,
  };
}

/** A page, real selectors on it, real health with a fake clock, and a log of everything onChange was told. */
function setup(kind, pageOpts = {}, healthOpts = {}) {
  const p = page(kind, pageOpts);
  const selectors = createSelectors(MAP, p.document);
  const clock = fakeClock();
  const changes = [];
  // The role checks are what these tests are about: the readability sentinel (section 11) is off here and has its own tests.
  const health = createHealth({ doc: p.document, selectors, map: MAP, onChange: (r) => changes.push(r), timers: clock, readability: false, ...healthOpts });
  return { p, document: p.document, selectors, clock, changes, health };
}

const pair = (feature, ...missingRoles) => ({ feature, missingRoles });
const broken = (...entries) => ({ ok: false, broken: entries });
const OK = { ok: true, broken: [] };

/** Detach an element and give back a function that puts it exactly where it was. */
function detach(el) {
  const parent = el.parentNode;
  const next = el.nextSibling;
  el.remove();
  return () => parent.insertBefore(el, next);
}

/** The comments role has two shapes on a watch page (the comments element and the teaser inside the metadata): remove both. */
const COMMENTS = ['ytd-comments#comments', '#comment-teaser'];
function detachMany(document, selectorsToRemove) {
  const restores = selectorsToRemove.flatMap((s) => [...document.querySelectorAll(s)].map(detach));
  return () => restores.reverse().forEach((fn) => fn());
}

// ---- 1. healthy pages and harmless input ---------------------------------------------------------------------------

test('createHealth exposes exactly evaluate/watch/record/counters (+ the sentinel verdict accessors); no flush, nothing that sends', () => {
  const { health } = setup('home');
  assert.deepEqual(Object.keys(health).sort(), ['counters', 'evaluate', 'isUnreadable', 'record', 'seedUnreadable', 'watch']);
  assert.throws(() => createHealth(), TypeError);
  assert.throws(() => createHealth({}), TypeError);
  assert.throws(() => createHealth({ doc: page('home').document, selectors: {} }), TypeError);
  assert.throws(() => createHealth({ selectors: { has: 1 } }), TypeError);
});

test('every real page kind is healthy for every feature, with both home tile shapes and the empty-state home', () => {
  const variants = [
    ['home', {}, 'home'], ['home', { tileStyle: 'home' }, 'home'], ['home', { tiles: 0 }, 'home'], ['home', { shorts: true, ads: 2 }, 'home'],
    ['watch', {}, 'watch'], ['watch', { ads: 2 }, 'watch'], ['search', {}, 'search'], ['channel', {}, 'channel'], ['subscriptions', {}, 'subscriptions'],
    ['history', {}, 'history'], ['playlist', {}, 'playlist'],
  ];
  for (const [kind, opts, pageType] of variants) {
    const { health } = setup(kind, opts);
    assert.deepEqual(health.evaluate(pageType, FEATURES), OK, `${kind} ${JSON.stringify(opts)}`);
    // Page types the shell knows nothing special about only ask for the shell.
    for (const other of ['shorts', 'other']) assert.deepEqual(health.evaluate(other, FEATURES), OK, `${kind} as ${other}`);
  }
});

test('features are scoped to the page: home roles are not required on a watch page and the hidden watch skeleton is not required on home', () => {
  const home = setup('home');
  // Break everything the watch page needs. On the home page that must not matter.
  assert.deepEqual(home.health.evaluate('home', ['layout-watch', 'calm-hideComments', 'calm-hideEndScreens', 'calm-hideViewCounts']), OK);
  const watch = setup('watch');
  assert.deepEqual(watch.health.evaluate('watch', ['layout-home', 'density', 'calm-hideHomeRecs']), OK, 'no homeBrowse on a watch page is fine');
  // The page type, not the DOM, decides: asking about watch features on a home DOM reports what is truly missing.
  assert.deepEqual(home.health.evaluate('watch', ['layout-watch']),
    broken(pair('layout-watch', 'watchFlexy', 'watchPlayer', 'watchPlayerContainer', 'watchPrimary', 'watchSecondary')));
});

test('unknown features, unknown page types and junk lists evaluate to "nothing to check", not to an error', () => {
  const { health } = setup('home');
  for (const features of [undefined, null, 'theme', 42, {}, [], [null, 42, {}, ['theme']], ['not-a-feature'], ['__proto__', 'constructor', 'hasOwnProperty']]) {
    assert.deepEqual(health.evaluate('home', features), OK, JSON.stringify(features));
  }
  for (const pageType of ['nope', '', undefined, null, 5, {}, '__proto__', 'constructor']) {
    assert.deepEqual(health.evaluate(pageType, FEATURES), OK, String(pageType));
  }
  assert.deepEqual(health.evaluate('home', ['theme', 'theme', 42, null]), OK, 'duplicates collapse');
});

// ---- 2. renamed markup: exactly the broken features ----------------------------------------------------------------

const RENAMES = [
  { name: 'ytd-app renamed (home)', kind: 'home', rename: ['ytd-app'], expect: [pair('theme', 'app')] },
  { name: 'ytd-app renamed (watch)', kind: 'watch', rename: ['ytd-app'], expect: [pair('theme', 'app')] },
  { name: 'ytd-app renamed (search)', kind: 'search', rename: ['ytd-app'], expect: [pair('theme', 'app')] },
  { name: 'ytd-app renamed (channel)', kind: 'channel', rename: ['ytd-app'], expect: [pair('theme', 'app')] },
  { name: 'page manager: tag AND id renamed', kind: 'home', rename: ['ytd-page-manager', '#page-manager'], expect: [pair('theme', 'pageManager')] },
  { name: 'page manager: only the tag renamed, the #page-manager fallback keeps it alive', kind: 'home', rename: ['ytd-page-manager'], expect: [] },
  { name: 'page-subtype attribute renamed: the three features that need the home browse element, nothing else', kind: 'home', rename: ['[page-subtype]'],
    expect: [pair('layout-home', 'homeBrowse', 'homeGrid', 'homeGridContents'), pair('density', 'homeBrowse', 'homeGrid', 'homeGridContents'), pair('calm-hideHomeRecs', 'homeBrowse')] },
  { name: 'same, with the real home tile shape', kind: 'home', opts: { tileStyle: 'home' }, rename: ['[page-subtype]'],
    expect: [pair('layout-home', 'homeBrowse', 'homeGrid', 'homeGridContents'), pair('density', 'homeBrowse', 'homeGrid', 'homeGridContents'), pair('calm-hideHomeRecs', 'homeBrowse')] },
  { name: 'same, on the empty-state home page', kind: 'home', opts: { tiles: 0 }, rename: ['[page-subtype]'],
    expect: [pair('layout-home', 'homeBrowse', 'homeGrid', 'homeGridContents'), pair('density', 'homeBrowse', 'homeGrid', 'homeGridContents'), pair('calm-hideHomeRecs', 'homeBrowse')] },
  { name: 'app AND page-subtype: four features, the healthy calm-hideShorts is left out', kind: 'home', rename: ['ytd-app', '[page-subtype]'],
    expect: [pair('theme', 'app'), pair('layout-home', 'homeBrowse', 'homeGrid', 'homeGridContents'), pair('density', 'homeBrowse', 'homeGrid', 'homeGridContents'), pair('calm-hideHomeRecs', 'homeBrowse')] },
  { name: 'guide: first selector renamed, the ytd-guide-renderer fallback still matches', kind: 'home', rename: ['tp-yt-app-drawer'], expect: [] },
  { name: 'guide: both selectors renamed', kind: 'home', rename: ['tp-yt-app-drawer', 'ytd-guide-renderer'], expect: [pair('calm-hideShorts', 'guide')] },
  { name: 'end screens: all three shapes renamed is NOT an alarm (the elements are legitimately absent on most healthy pages; the hide rule is CSS-only and fails safe)', kind: 'watch', rename: ['.ytp-ce-element', '.ytp-endscreen-content', '.ytp-ce-shadow'], expect: [] },
  { name: 'end screens: one shape renamed, the others carry the role', kind: 'watch', rename: ['.ytp-ce-element'], expect: [] },
  { name: 'comments: tag, id and the teaser fallback renamed', kind: 'watch', rename: ['ytd-comments', '#comments', '#comment-teaser'], expect: [pair('calm-hideComments', 'comments')] },
  { name: 'comments: only the id renamed, the tag selector still matches', kind: 'watch', rename: ['#comments'], expect: [] },
  { name: 'watch flexy renamed: two of five roles survive through fallbacks, three do not', kind: 'watch', rename: ['ytd-watch-flexy'],
    expect: [pair('layout-watch', 'watchPlayerContainer', 'watchPrimary', 'watchSecondary')] },
  { name: '#primary id renamed: one role', kind: 'watch', rename: [['#primary', 'primary-x']], expect: [pair('layout-watch', 'watchPrimary')] },
  { name: '#secondary id renamed: one role', kind: 'watch', rename: [['#secondary', 'secondary-x']], expect: [pair('layout-watch', 'watchSecondary')] },
  { name: 'view counts: the watch info text and every tile host renamed', kind: 'watch', rename: ['ytd-watch-info-text', '.ytLockupViewModelHost'], expect: [pair('calm-hideViewCounts', 'viewCounts')] },
  { name: 'view counts: only the watch info text renamed, related tiles still carry the role', kind: 'watch', rename: ['ytd-watch-info-text'], expect: [] },
  { name: 'two unrelated breakages on one page: both, in feature order', kind: 'watch', rename: ['ytd-app', 'ytd-comments', '#comments', '#comment-teaser'],
    expect: [pair('theme', 'app'), pair('calm-hideComments', 'comments')] },
  { name: 'a role no feature requires (chips) can vanish without a verdict', kind: 'search', rename: ['yt-chip-cloud-renderer'], expect: [] },
  { name: 'tiles vanish (videoTile is never required): nothing breaks', kind: 'home', rename: ['yt-lockup-view-model', 'ytd-rich-item-renderer'], expect: [] },
];

for (const c of RENAMES) {
  test(`rename: ${c.name}`, () => {
    const { p, health } = setup(c.kind, { ...(c.opts || {}), rename: c.rename });
    assert.ok(p.renamed > 0, 'the fixture really contained what the test renames');
    const result = health.evaluate(c.kind, FEATURES);
    assert.deepEqual(result, { ok: c.expect.length === 0, broken: c.expect });
    // Features outside the broken set are reported healthy when asked about on their own.
    const brokenNames = new Set(c.expect.map((e) => e.feature));
    for (const feature of FEATURES) {
      if (brokenNames.has(feature)) continue;
      assert.deepEqual(health.evaluate(c.kind, [feature]), OK, `${feature} must stay healthy`);
    }
    // Only active features are judged: a broken feature that is switched off is not reported.
    const active = FEATURES.filter((f) => !brokenNames.has(f));
    assert.deepEqual(health.evaluate(c.kind, active), OK);
  });
}

test('every feature in map.requires goes red when the elements of its required roles are really gone (no feature is inert)', () => {
  const where = { theme: 'home', 'layout-home': 'home', 'layout-watch': 'watch', density: 'home', 'calm-hideShorts': 'home', 'calm-hideHomeRecs': 'home',
    'calm-hideComments': 'watch', 'calm-hideEndScreens': 'watch', 'calm-hideViewCounts': 'watch' };
  assert.deepEqual(Object.keys(MAP.requires).sort(), [...FEATURES].sort(), 'the map describes exactly the contract features');
  for (const feature of FEATURES) {
    const kind = where[feature];
    const p = page(kind);
    const sel = createSelectors(MAP, p.document);
    const health = createHealth({ doc: p.document, selectors: sel, map: MAP });
    const needed = MAP.requires[feature].filter((r) => MAP.pageRoles[kind].includes(r));
    assert.ok(needed.length > 0, `${feature} requires something on ${kind}`);
    for (const role of needed) assert.equal(sel.has(role), true, `${feature}: ${role} exists on a healthy ${kind} page`);
    assert.deepEqual(health.evaluate(kind, [feature]), OK);
    // find/findAll return one selector shape at a time, so keep removing until every shape of every needed role is gone.
    for (let guard = 0; guard < 30 && needed.some((r) => sel.has(r)); guard++) {
      for (const role of needed) for (const el of sel.findAll(role)) el.remove();
    }
    assert.ok(needed.every((r) => !sel.has(r)), `${feature}: the roles are really gone`);
    assert.deepEqual(health.evaluate(kind, [feature]), broken(pair(feature, ...needed)), feature);
  }
});

test('a hot-swapped map changes what is required immediately (health reads the live map from selectors.map())', () => {
  const { p, selectors, health } = setup('home');
  assert.deepEqual(health.evaluate('home', ['calm-hideHomeRecs']), OK);
  const next = JSON.parse(JSON.stringify(MAP));
  next.mapVersion = '2026.10.08.1';
  next.requires['calm-hideHomeRecs'] = ['homeBrowse', 'watchFlexy']; // pretend the new map wants a role the home page lacks
  next.pageRoles.home = [...next.pageRoles.home, 'watchFlexy'];
  p.document.querySelectorAll('ytd-watch-flexy').forEach((el) => el.remove());
  assert.equal(selectors.setMap(next), true);
  assert.deepEqual(health.evaluate('home', ['calm-hideHomeRecs']), broken(pair('calm-hideHomeRecs', 'watchFlexy')));
  assert.equal(selectors.setMap(MAP), true);
  assert.deepEqual(health.evaluate('home', ['calm-hideHomeRecs']), OK);
});

test('selectors without map() fall back to the map option; no map at all means nothing is required', () => {
  const p = page('home');
  const has = (role) => role === 'app';
  const withMap = createHealth({ doc: p.document, selectors: { has }, map: MAP });
  assert.deepEqual(withMap.evaluate('home', ['theme', 'layout-home']), broken(pair('theme', 'pageManager'), pair('layout-home', 'homeBrowse', 'homeGrid', 'homeGridContents')));
  const noMap = createHealth({ doc: p.document, selectors: { has } });
  assert.deepEqual(noMap.evaluate('home', FEATURES), OK);
  const weird = createHealth({ doc: p.document, selectors: { has, map: () => null }, map: { requires: { theme: 'app' }, pageRoles: { home: 5 } } });
  assert.deepEqual(weird.evaluate('home', ['theme']), OK, 'non-array requires/pageRoles are ignored, not trusted');
  const proto = createHealth({ doc: p.document, selectors: { has: () => false, map: () => ({ requires: {}, pageRoles: {} }) } });
  assert.deepEqual(proto.evaluate('home', ['constructor', 'toString']), OK);
});

test('a selectors.has() that throws counts as "missing" and never escapes', () => {
  const p = page('home');
  const health = createHealth({ doc: p.document, selectors: { has() { throw new Error('page script broke querySelector'); }, map: () => MAP } });
  let result;
  assert.doesNotThrow(() => { result = health.evaluate('home', ['theme']); });
  assert.deepEqual(result, broken(pair('theme', 'app', 'pageManager')));
});

// ---- 3. watch(): roles that appear late ----------------------------------------------------------------------------

test('watch: a healthy page costs nothing: no observer, no timer, no callback, no count', () => {
  const created = [];
  class SpyObserver { constructor() { created.push(this); } observe() {} disconnect() {} }
  const { health, clock, changes } = setup('watch', {}, { MutationObserver: SpyObserver });
  const dispose = health.watch('watch', FEATURES);
  assert.equal(created.length, 0);
  assert.equal(clock.pending, 0);
  assert.deepEqual(changes, []);
  assert.deepEqual(health.counters().roles, {});
  assert.doesNotThrow(() => { dispose(); dispose(); });
});

test('watch: a role that appears before the deadline is never reported (observer path ends the wait early)', async () => {
  const { document, health, clock, changes } = setup('watch');
  const putBack = detachMany(document, COMMENTS);
  health.watch('watch', ['theme', 'calm-hideComments'], { timeoutMs: 6000 });
  assert.equal(clock.pending, 1);
  assert.deepEqual(clock.delays, [6000], 'one timer, the requested length');
  clock.advance(3000);
  await tick();
  assert.deepEqual(changes, [], 'nothing is claimed while the clock is running');
  putBack();
  await tick();
  assert.equal(clock.pending, 2, 'the deadline, plus one coalesced lookup for the change');
  assert.deepEqual(clock.delays, [6000, 250]);
  clock.advance(250);
  assert.equal(clock.pending, 0, 'everything is there: both timers are gone, the wait is over');
  clock.advance(60000);
  assert.deepEqual(changes, [], 'no verdict, ever');
  assert.deepEqual(health.counters().roles, {});
  assert.deepEqual(health.evaluate('watch', FEATURES), OK);
});

test('watch: a role still missing at exactly timeoutMs is reported once, counted once, and the page is left alone', async () => {
  const { document, health, clock, changes } = setup('watch');
  const before = document.documentElement.outerHTML;
  detachMany(document, COMMENTS);
  const expectedHtml = document.documentElement.outerHTML;
  health.watch('watch', FEATURES, { timeoutMs: 6000 });
  clock.advance(5999);
  assert.deepEqual(changes, []);
  clock.advance(1);
  assert.deepEqual(changes, [broken(pair('calm-hideComments', 'comments'))]);
  assert.deepEqual(health.counters().roles, { comments: 1 });
  clock.advance(120000);
  await tick();
  assert.equal(changes.length, 1, 'the verdict is delivered once');
  assert.equal(document.documentElement.outerHTML, expectedHtml, 'health never touches the page');
  assert.notEqual(before, expectedHtml);
  assert.equal(clock.pending, 0);
});

test('watch: two features, one role arrives late and one never: only the one that never came is reported', async () => {
  const { document, health, clock, changes } = setup('watch');
  detachMany(document, COMMENTS);
  const putBackSecondary = detach(document.querySelector('#secondary'));
  health.watch('watch', ['layout-watch', 'calm-hideComments'], { timeoutMs: 6000 });
  clock.advance(3000);
  putBackSecondary();
  await tick();
  clock.advance(250);
  assert.deepEqual(changes, [], 'still waiting on comments');
  assert.equal(clock.pending, 1, 'only the deadline is left');
  clock.advance(2750);
  assert.deepEqual(changes, [broken(pair('calm-hideComments', 'comments'))]);
  assert.deepEqual(health.counters().roles, { comments: 1 }, 'the role that came in time is not counted');
});

test('watch: a role that is still reachable through a fallback selector is not listed, only the truly missing ones are', () => {
  const { document, health, clock, changes } = setup('watch');
  detach(document.querySelector('#secondary'));
  // The outer container holds the player: watchPlayer goes with it, but watchPlayerContainer has two more shapes (#player, #player-container-inner).
  detach(document.querySelector('#player-container-outer'));
  health.watch('watch', ['layout-watch'], { timeoutMs: 1000 });
  clock.advance(1000);
  assert.deepEqual(changes, [broken(pair('layout-watch', 'watchPlayer', 'watchSecondary'))]);
  assert.deepEqual(health.counters().roles, { watchPlayer: 1, watchSecondary: 1 });
});

test('watch: attribute-only changes count (ytd-browse is reused across pages and only page-subtype changes)', async () => {
  const { document, health, clock, changes } = setup('home');
  const carriers = [...document.querySelectorAll('[page-subtype]')]; // homeBrowse has two shapes: ytd-browse and its two-column child
  assert.ok(carriers.length >= 2);
  carriers.forEach((el) => el.setAttribute('page-subtype', 'channels')); // not home yet
  health.watch('home', ['layout-home', 'density'], { timeoutMs: 6000 });
  assert.equal(clock.pending, 1);
  carriers.forEach((el) => el.setAttribute('page-subtype', 'home'));
  await tick();
  clock.advance(250);
  assert.equal(clock.pending, 0, 'the observer saw the attribute and ended the wait');
  clock.advance(10000);
  assert.deepEqual(changes, []);
});

test('watch: the default timeout is 6000 ms; 0 judges at once; junk falls back to the default; huge values are capped', () => {
  const run = (timeoutArg) => {
    const { document, health, clock, changes } = setup('watch');
    detachMany(document, COMMENTS);
    health.watch('watch', ['calm-hideComments'], timeoutArg);
    return { clock, changes };
  };
  assert.deepEqual(run(undefined).clock.delays, [6000]);
  assert.deepEqual(run({}).clock.delays, [6000]);
  assert.deepEqual(run({ timeoutMs: 2500 }).clock.delays, [2500]);
  for (const junk of [-1, NaN, Infinity, 'soon', null, {}]) assert.deepEqual(run({ timeoutMs: junk }).clock.delays, [6000], String(junk));
  assert.deepEqual(run({ timeoutMs: 1e9 }).clock.delays, [120000], 'capped');
  const instant = run({ timeoutMs: 0 });
  assert.deepEqual(instant.clock.delays, [], 'no timer at all');
  assert.deepEqual(instant.changes, [broken(pair('calm-hideComments', 'comments'))]);
});

test('watch: the same verdict is not repeated, a changed verdict is, and a healed page announces ok:true', async () => {
  const { document, health, clock, changes } = setup('watch');
  const restoreComments = detachMany(document, COMMENTS);
  health.watch('watch', ['calm-hideComments', 'layout-watch'], { timeoutMs: 1000 });
  clock.advance(1000);
  assert.equal(changes.length, 1);
  // Same page, same features, same breakage: no flicker, no second callback (and nothing in between that says "ok").
  health.watch('watch', ['calm-hideComments', 'layout-watch'], { timeoutMs: 1000 });
  clock.advance(1000);
  assert.equal(changes.length, 1);
  assert.deepEqual(health.counters().roles, { comments: 2 }, 'but the second settle is counted as a second settle');
  // A second feature breaks.
  detach(document.querySelector('#secondary'));
  health.watch('watch', ['calm-hideComments', 'layout-watch'], { timeoutMs: 1000 });
  clock.advance(1000);
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[1], broken(pair('calm-hideComments', 'comments'), pair('layout-watch', 'watchSecondary')), 'in the order the features were passed');
  // YouTube fixes the markup; the next watch heals.
  restoreComments();
  health.watch('watch', ['calm-hideComments', 'layout-watch'], { timeoutMs: 1000 });
  assert.equal(changes.length, 3, 'the healed feature is announced at once, before any timer');
  assert.deepEqual(changes[2], broken(pair('layout-watch', 'watchSecondary')));
  clock.advance(1000);
  assert.equal(changes.length, 3);
});

test('watch: a verdict does not follow the user to a page where the feature is not judged', async () => {
  const { p, health, clock, changes } = setup('home', { rename: ['[page-subtype]'] });
  health.watch('home', ['layout-home', 'density'], { timeoutMs: 1000 });
  clock.advance(1000);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].broken.map((b) => b.feature), ['layout-home', 'density']);
  navigateTo(p, 'watch', { tiles: 2 });
  health.watch('watch', ['layout-home', 'layout-watch', 'density'], { timeoutMs: 1000 });
  assert.deepEqual(changes[1], OK, 'layout-home / density are not judged on a watch page: healed picture at once');
  assert.equal(changes.length, 2);
  clock.advance(5000);
  assert.equal(changes.length, 2);
});

test('watch: a feature that is broken on every page keeps its verdict across navigation (no on/off flicker), until the markup returns', () => {
  const { p, document, health, clock, changes } = setup('home', { rename: ['tp-yt-app-drawer', 'ytd-guide-renderer'] });
  health.watch('home', ['calm-hideShorts'], { timeoutMs: 1000 });
  clock.advance(1000);
  assert.deepEqual(changes, [broken(pair('calm-hideShorts', 'guide'))]);
  for (const kind of ['search', 'watch', 'home']) {
    navigateTo(p, kind, { tiles: 2 });
    health.watch(kind, ['calm-hideShorts'], { timeoutMs: 1000 });
    clock.advance(1000);
  }
  assert.equal(changes.length, 1, 'three more settle windows, no "ok" in between, no repeat');
  assert.deepEqual(health.counters().roles, { guide: 4 }, 'each page settle is counted');
  const guide = document.createElement('tp-yt-app-drawer');
  guide.id = 'guide';
  document.querySelector('ytd-app #content').append(guide);
  navigateTo(p, 'search', { tiles: 2 });
  health.watch('search', ['calm-hideShorts'], { timeoutMs: 1000 });
  assert.deepEqual(changes[1], OK);
});

test('watch: the deadline looks again: a role that was fine at the start and vanished during the window is reported with the missing ones', () => {
  const { document, health, clock, changes } = setup('watch');
  detachMany(document, COMMENTS);
  health.watch('watch', ['calm-hideComments', 'layout-watch'], { timeoutMs: 6000 });
  clock.advance(2000);
  detach(document.querySelector('#secondary')); // YouTube re-rendered the column and lost it
  clock.advance(3999);
  assert.deepEqual(changes, []);
  clock.advance(1);
  assert.deepEqual(changes, [broken(pair('calm-hideComments', 'comments'), pair('layout-watch', 'watchSecondary'))]);
  assert.deepEqual(health.counters().roles, { comments: 1, watchSecondary: 1 });
});

test('watch: a storm of DOM mutations costs one lookup per 250 ms, not one per mutation', async () => {
  const { document, selectors, health, clock } = setup('watch');
  detachMany(document, COMMENTS);
  let lookups = 0;
  const realHas = selectors.has;
  selectors.has = (...args) => { lookups++; return realHas(...args); };
  const dispose = health.watch('watch', ['calm-hideComments'], { timeoutMs: 6000 });
  lookups = 0;
  for (let i = 0; i < 300; i++) {
    document.body.append(document.createElement('div'));
    if (i % 25 === 0) await tick(); // several separate mutation batches, as on a busy page
  }
  await tick();
  assert.equal(lookups, 0, 'nothing is looked up per mutation');
  assert.equal(clock.pending, 2);
  clock.advance(249);
  assert.equal(lookups, 0);
  clock.advance(1);
  assert.equal(lookups, 1, 'one lookup of the one pending role');
  document.body.append(document.createElement('div'));
  await tick();
  clock.advance(250);
  assert.equal(lookups, 2);
  // dispose cancels a lookup that is already scheduled
  document.body.append(document.createElement('div'));
  await tick();
  assert.equal(clock.pending, 2);
  dispose();
  assert.equal(clock.pending, 0, 'both timers cleared');
  clock.advance(10000);
  assert.equal(lookups, 2);
});

test('a role named by requires but without selectors still breaks its feature, but is never counted (the vocabulary is the roles table)', () => {
  const { selectors, health, clock, changes } = setup('home');
  const next = JSON.parse(JSON.stringify(MAP));
  next.requires.theme = ['app', 'ghostRole'];
  next.pageRoles.home.push('ghostRole');
  selectors.setMap(next);
  health.watch('home', ['theme'], { timeoutMs: 100 });
  clock.advance(100);
  assert.deepEqual(changes, [broken(pair('theme', 'ghostRole'))]);
  assert.deepEqual(health.counters().roles, {});
});

test('watch: a newer watch() supersedes the older one (only one timer lives, the stale page never reports)', async () => {
  const { p, health, clock, changes } = setup('home', { rename: ['[page-subtype]'] });
  health.watch('home', ['layout-home'], { timeoutMs: 6000 });
  assert.equal(clock.pending, 1);
  clock.advance(2000);
  navigateTo(p, 'search', { tiles: 2 });
  health.watch('search', ['theme'], { timeoutMs: 6000 });
  assert.equal(clock.pending, 0, 'the old timer was cleared, and search is healthy so no new one was needed');
  clock.advance(60000);
  assert.deepEqual(changes, [], 'the home verdict never arrived');
  // Two pending at different times: only the last decides.
  const q = setup('watch');
  detachMany(q.document, COMMENTS);
  detach(q.document.querySelector('#secondary'));
  q.health.watch('watch', ['calm-hideComments'], { timeoutMs: 6000 });
  q.clock.advance(4000);
  q.health.watch('watch', ['layout-watch'], { timeoutMs: 6000 });
  assert.equal(q.clock.pending, 1);
  q.clock.advance(5999);
  assert.deepEqual(q.changes, []);
  q.clock.advance(1);
  assert.deepEqual(q.changes, [broken(pair('layout-watch', 'watchSecondary'))]);
  assert.deepEqual(q.health.counters().roles, { watchSecondary: 1 }, 'the superseded check counted nothing');
});

test('watch: dispose cancels the timer and the observer, is idempotent, and silences the verdict', async () => {
  const created = [];
  class SpyObserver {
    constructor(cb) { this.cb = cb; this.observing = false; this.disconnects = 0; created.push(this); }
    observe(target, options) { this.observing = true; this.target = target; this.options = options; }
    disconnect() { this.observing = false; this.disconnects++; }
  }
  const { document, health, clock, changes } = setup('watch', {}, { MutationObserver: SpyObserver });
  detachMany(document, COMMENTS);
  const dispose = health.watch('watch', ['calm-hideComments'], { timeoutMs: 6000 });
  assert.equal(created.length, 1);
  assert.equal(created[0].observing, true);
  assert.equal(created[0].target, document.documentElement);
  assert.deepEqual(created[0].options, { childList: true, subtree: true, attributes: true, attributeFilter: ['page-subtype', 'is-watch-page', 'video-id'] },
    'attributes are filtered: YouTube mutates class and style constantly');
  dispose();
  dispose();
  assert.equal(created[0].observing, false);
  assert.equal(clock.pending, 0);
  assert.equal(clock.cleared.length, 1);
  clock.advance(60000);
  assert.deepEqual(changes, []);
  assert.deepEqual(health.counters().roles, {});

  // Without dispose the observer is released at the verdict.
  const again = setup('watch', {}, { MutationObserver: SpyObserver });
  detachMany(again.document, COMMENTS);
  again.health.watch('watch', ['calm-hideComments'], { timeoutMs: 100 });
  const observer = created[created.length - 1];
  assert.equal(observer.observing, true);
  again.clock.advance(100);
  assert.equal(observer.observing, false, 'verdict delivered: observer disconnected');
  assert.equal(again.changes.length, 1);
});

test('watch: a hidden tab does not get judged until it is visible again, then gets the full timeout', async () => {
  const { document, health, clock, changes } = setup('watch');
  let visibility = 'hidden';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  detachMany(document, COMMENTS);
  health.watch('watch', ['calm-hideComments'], { timeoutMs: 6000 });
  clock.advance(60000);
  assert.deepEqual(changes, [], 'a background tab may simply not have rendered yet');
  assert.equal(clock.pending, 0, 'and it does not poll while it waits');
  visibility = 'visible';
  document.dispatchEvent(new document.defaultView.Event('visibilitychange'));
  assert.equal(clock.pending, 1);
  clock.advance(5999);
  assert.deepEqual(changes, []);
  clock.advance(1);
  assert.deepEqual(changes, [broken(pair('calm-hideComments', 'comments'))]);
  // Appearing while hidden ends the wait too.
  const h2 = setup('watch');
  visibility = 'hidden';
  Object.defineProperty(h2.document, 'visibilityState', { configurable: true, get: () => visibility });
  const back = detachMany(h2.document, COMMENTS);
  h2.health.watch('watch', ['calm-hideComments'], { timeoutMs: 1000 });
  h2.clock.advance(1000);
  back();
  await tick();
  h2.clock.advance(250);
  visibility = 'visible';
  h2.document.dispatchEvent(new h2.document.defaultView.Event('visibilitychange'));
  assert.equal(h2.clock.pending, 0, 'nothing left to wait for');
  assert.deepEqual(h2.changes, []);
});

test('watch with real timers and the real MutationObserver (generous margins: this must not flake on a loaded machine)', async () => {
  const waitFor = async (condition, ms = 5000) => {
    const end = Date.now() + ms;
    while (!condition() && Date.now() < end) await sleep(10);
  };
  const p = page('watch');
  const selectors = createSelectors(MAP, p.document);
  const changes = [];
  const health = createHealth({ doc: p.document, selectors, map: MAP, onChange: (r) => changes.push(r) }); // no injected timers

  // The role is back long before the deadline: no verdict, even after the deadline has passed.
  const putBack = detachMany(p.document, COMMENTS);
  const started = Date.now();
  health.watch('watch', ['calm-hideComments'], { timeoutMs: 600 });
  putBack();
  await sleep(800);
  assert.ok(Date.now() - started >= 600, 'the deadline really passed');
  assert.deepEqual(changes, [], 'the role appeared in time');

  // The role never comes back: exactly one verdict, delivered by the real timer after the real deadline.
  detachMany(p.document, COMMENTS);
  const t0 = Date.now();
  health.watch('watch', ['calm-hideComments'], { timeoutMs: 150 });
  assert.deepEqual(changes, [], 'never synchronously');
  await waitFor(() => changes.length > 0);
  assert.deepEqual(changes, [broken(pair('calm-hideComments', 'comments'))]);
  assert.ok(Date.now() - t0 >= 140, 'and not before the deadline');
  await sleep(300);
  assert.equal(changes.length, 1);
});

test('re-entrancy: onChange may call watch(), record() or evaluate() without corrupting the state', () => {
  const p = page('watch');
  const selectors = createSelectors(MAP, p.document);
  const clock = fakeClock();
  const seen = [];
  let health;
  health = createHealth({
    doc: p.document, selectors, map: MAP, timers: clock, readability: false,
    onChange: (r) => {
      seen.push(r);
      if (seen.length === 1) {
        health.evaluate('watch', FEATURES);
        health.watch('watch', ['theme'], { timeoutMs: 1000 }); // the engine re-arms on its own verdict
      }
    },
  });
  detachMany(p.document, COMMENTS);
  health.watch('watch', ['calm-hideComments'], { timeoutMs: 100 });
  clock.advance(100);
  assert.equal(seen.length, 2, 'the verdict, then the healed picture from the re-armed watch');
  assert.deepEqual(seen[0], broken(pair('calm-hideComments', 'comments')));
  assert.deepEqual(seen[1], OK);
  assert.equal(clock.pending, 0);
});

test('a throwing onChange never breaks watch(), record() or the timer callback, and the next change still arrives', () => {
  const p = page('watch');
  const selectors = createSelectors(MAP, p.document);
  const clock = fakeClock();
  const reported = [];
  p.window.reportError = (err) => reported.push(err.message);
  let calls = 0;
  const health = createHealth({ doc: p.document, selectors, map: MAP, timers: clock, onChange: () => { calls++; throw new Error(`listener bug ${calls}`); } });
  assert.doesNotThrow(() => health.record('layout-watch', ['watchPrimary']));
  assert.doesNotThrow(() => health.record('calm-hideComments', ['comments']));
  detach(p.document.querySelector('#secondary'));
  health.watch('watch', ['layout-watch'], { timeoutMs: 10 });
  assert.doesNotThrow(() => clock.advance(10));
  assert.ok(calls >= 3);
  assert.equal(reported.length, calls, 'each failure was surfaced, none swallowed silently');
});

// ---- 4. record() -----------------------------------------------------------------------------------------------------

test('record: a layout can report its own failure; it shows up in evaluate, onChange and the counters, and watch() resets it', () => {
  const { health, clock, changes } = setup('home');
  assert.equal(health.record('layout-home', ['homeGrid']), true);
  assert.deepEqual(changes, [broken(pair('layout-home', 'homeGrid'))]);
  assert.deepEqual(health.evaluate('home', FEATURES), broken(pair('layout-home', 'homeGrid')), 'the page markup is fine, the layout said it failed');
  assert.deepEqual(health.counters().roles, { homeGrid: 1 });
  // Again: nothing new to say.
  health.record('layout-home', 'homeGrid');
  assert.equal(changes.length, 1);
  assert.deepEqual(health.counters().roles, { homeGrid: 1 }, 'not double counted within one page');
  // A second reason merges into the same feature.
  health.record('layout-home', ['richItem']);
  assert.deepEqual(changes[1], broken(pair('layout-home', 'homeGrid', 'richItem')));
  // A report with no role (e.g. "no tile could be mounted") is still a broken feature.
  health.record('density', []);
  assert.deepEqual(changes[2], broken(pair('layout-home', 'homeGrid', 'richItem'), pair('density')));
  // The next page check starts from the page, not from the last report.
  health.watch('home', FEATURES, { timeoutMs: 1000 });
  assert.deepEqual(health.evaluate('home', FEATURES), OK);
  assert.deepEqual(changes[3], OK, 'and the healed picture is announced');
  clock.advance(5000);
  assert.equal(changes.length, 4);
});

test('record: unknown features, unknown roles and hostile values are refused or dropped, never stored', () => {
  const { health, changes } = setup('watch');
  for (const feature of ['not-a-feature', '', undefined, null, 5, {}, [], '__proto__', 'constructor', 'toString', 'layout-home\n', 'LAYOUT-HOME', 'https://www.youtube.com/watch?v=BzpdP2APcIM']) {
    assert.equal(health.record(feature, ['watchPrimary']), false, String(feature));
  }
  assert.deepEqual(changes, []);
  assert.deepEqual(health.counters().roles, {});
  // Known feature, mixed roles: only vocabulary survives.
  assert.equal(health.record('layout-watch', ['watchPrimary', 'BzpdP2APcIM', 'Destination Wild: Rwanda', 'nature documentary', '__proto__', 'constructor', 42, null, {}, ['watchSecondary'], 'https://youtube.com/watch?v=x']), true);
  assert.deepEqual(changes, [broken(pair('layout-watch', 'watchPrimary'))]);
  assert.deepEqual(health.counters().roles, { watchPrimary: 1 });
  assert.equal(health.record('layout-watch', undefined), true, 'no roles given is allowed');
  assert.equal(health.record('layout-watch', { 0: 'watchSecondary', length: 1 }), true, 'but array-likes are not roles');
  assert.deepEqual(health.counters().roles, { watchPrimary: 1 });
});

test('record: a feature that only a newer map knows about is accepted once the live map requires it', () => {
  const { selectors, health, changes } = setup('home');
  assert.equal(health.record('layout-future', ['homeGrid']), false);
  const next = JSON.parse(JSON.stringify(MAP));
  next.requires['layout-future'] = ['homeGrid'];
  selectors.setMap(next);
  assert.equal(health.record('layout-future', ['homeGrid']), true);
  assert.deepEqual(changes, [broken(pair('layout-future', 'homeGrid'))]);
});

// ---- 5. counters stay anonymous; no network ------------------------------------------------------------------------

test('counters are a snapshot of role counts and a built-in theme id, nothing else; reading them changes nothing', () => {
  const { document, health, clock } = setup('home');
  assert.deepEqual(health.counters(), { roles: {}, themeId: null });
  document.documentElement.setAttribute(ATTR.theme, 'cinema');
  health.record('layout-home', ['homeGrid']);
  health.record('density', ['homeBrowse']);
  const first = health.counters();
  assert.deepEqual(first, { roles: { homeBrowse: 1, homeGrid: 1 }, themeId: 'cinema' });
  first.roles.homeGrid = 999;
  first.roles.injected = 1;
  first.themeId = 'hacked';
  assert.deepEqual(health.counters(), { roles: { homeBrowse: 1, homeGrid: 1 }, themeId: 'cinema' }, 'the caller got a copy');
  assert.deepEqual(Object.keys(health.counters().roles), ['homeBrowse', 'homeGrid'], 'stable, sorted order');
  clock.advance(1000);
});

test('theme id: only the built-in ids are ever reported; whatever a page script writes into cd-theme is not', () => {
  const { document, health } = setup('home');
  const html = document.documentElement;
  for (const id of ALL_THEME_IDS) {
    html.setAttribute(ATTR.theme, id);
    assert.equal(health.counters().themeId, id);
  }
  for (const evil of ['BzpdP2APcIM', 'bzpdp2apcim', 'destination-wild-rwanda', 'https://www.youtube.com/watch?v=BzpdP2APcIM', 'nature documentary', 'my-private-theme',
    'cinema ', ' cinema', 'Cinema', 'cinema\n', '', '__proto__', 'a'.repeat(5000), '<script>alert(1)</script>']) {
    html.setAttribute(ATTR.theme, evil);
    assert.equal(health.counters().themeId, null, JSON.stringify(evil));
  }
  html.removeAttribute(ATTR.theme);
  assert.equal(health.counters().themeId, null);
});

test('anonymity: after a full breakage scenario on a page full of ids, titles, urls and search terms, none of them is anywhere in the counters', async () => {
  const forbidden = ['BzpdP2APcIM', 'Destination', 'Rwanda', 'Wild', 'nature', 'documentary', 'youtube', 'http', 'watch?v', 'NatGeo', 'National', 'PLeCPQ', 'search_query', 'CDtile'];
  const results = [];
  for (const [kind, opts, rename, features] of [
    ['watch', {}, ['ytd-app', '.ytp-ce-element', '.ytp-endscreen-content', '.ytp-ce-shadow', '#comments', 'ytd-comments', '#comment-teaser'], FEATURES],
    ['search', { url: '/results?search_query=nature+documentary' }, ['ytd-app'], FEATURES],
    ['home', { tileStyle: 'home' }, ['[page-subtype]'], FEATURES],
    ['playlist', {}, ['ytd-app'], FEATURES],
  ]) {
    const { document, health, clock } = setup(kind, { rename, ...opts });
    document.title = 'Destination Wild: Rwanda - YouTube';
    document.documentElement.setAttribute(ATTR.theme, 'BzpdP2APcIM');
    health.watch(kind, features, { timeoutMs: 500 });
    clock.advance(500);
    health.record('layout-home', ['homeGrid', 'BzpdP2APcIM', 'Destination Wild', 'https://www.youtube.com/watch?v=BzpdP2APcIM', 'nature documentary']);
    health.record('Destination Wild', ['BzpdP2APcIM']);
    results.push({ counters: health.counters(), verdict: health.evaluate(kind, features) });
    await tick();
  }
  const roleNames = new Set(Object.keys(MAP.roles));
  for (const { counters, verdict } of results) {
    const json = JSON.stringify([counters, verdict]);
    for (const word of forbidden) assert.ok(!json.includes(word), `"${word}" leaked into ${json}`);
    assert.deepEqual(Object.keys(counters).sort(), ['roles', 'themeId']);
    assert.equal(counters.themeId, null);
    for (const [role, count] of Object.entries(counters.roles)) {
      assert.ok(roleNames.has(role), `${role} is not a map role`);
      assert.ok(Number.isInteger(count) && count >= 1);
    }
    for (const entry of verdict.broken) {
      assert.ok(FEATURES.includes(entry.feature));
      assert.ok(entry.missingRoles.every((r) => roleNames.has(r)));
    }
  }
  assert.ok(results.some((r) => Object.keys(r.counters.roles).length > 0), 'the scenario really counted something');
});

test('no network code path: nothing in the module, and a full scenario touches no fetch / XHR / beacon / socket / image / worker / storage', async () => {
  const code = SOURCE.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts|Worker|Image|navigator|localStorage|sessionStorage|indexedDB|chrome|postMessage|telemetry)\b/);
  assert.doesNotMatch(code, /\beval\s*\(|new Function|\bimport\s*\(/);
  assert.doesNotMatch(code, /\b(document|window)\./, 'the document is injected');
  assert.deepEqual(code.match(/^import .*$/gm), [
    "import { ALL_THEME_IDS, ATTR, FEATURES } from '../shared/constants.js';",
    "import { contrastRatio, parseColor } from '../shared/contrast.js';",
  ], 'its only imports are the constants and the pure contrast maths (the readability sentinel)');

  const { p, health, clock } = setup('watch', { rename: ['ytd-app', '#comments', 'ytd-comments', '#comment-teaser'] });
  const hits = [];
  const trap = (host, name, label) => {
    const original = host[name];
    host[name] = function trapped() { hits.push(label); throw new Error(`network access: ${label}`); };
    return () => { if (original === undefined) delete host[name]; else host[name] = original; };
  };
  const undo = [
    trap(globalThis, 'fetch', 'globalThis.fetch'), trap(p.window, 'fetch', 'window.fetch'), trap(p.window, 'XMLHttpRequest', 'XMLHttpRequest'),
    trap(p.window, 'WebSocket', 'WebSocket'), trap(p.window, 'EventSource', 'EventSource'), trap(p.window, 'Worker', 'Worker'),
    trap(p.window.navigator, 'sendBeacon', 'sendBeacon'), trap(p.window, 'Image', 'Image'),
  ];
  try {
    health.watch('watch', FEATURES, { timeoutMs: 100 });
    clock.advance(100);
    health.record('layout-watch', ['watchPrimary']);
    health.counters();
    health.evaluate('watch', FEATURES);
    await tick();
  } finally {
    undo.reverse().forEach((fn) => fn());
  }
  assert.deepEqual(hits, []);
});

test('source hygiene: no eval, no ambient globals; timers only through the injected clock or the document window', () => {
  const code = SOURCE.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /\bsetInterval\b/, 'a single deadline timer, never polling');
  assert.doesNotMatch(code, /\brequestAnimationFrame\b/);
  assert.match(code, /\bsetTimeout\b/);
});

// ---- 11. readability sentinel (a themed page that is unreadable although every role is present) -------------------------------

import { measureReadability, READABLE_MIN_RATIO } from '../../src/content/health.js';

/** A page with real selectors where the theme is "applied" (attributes) and the text/background colours are literal CSS. */
function themedPage(kind, css, pageOpts = {}) {
  const p = page(kind, { tiles: 4, ...pageOpts });
  const doc = p.document;
  doc.documentElement.setAttribute('cd-theme', 'cinema');
  const style = doc.createElement('style');
  style.textContent = css;
  doc.head.append(style);
  return { p, doc };
}
const OK_CSS = 'html{background-color:#0f0f0f} a.ytLockupMetadataViewModelTitle,a#video-title,input[name=search_query],h1{color:#f1f1f1}';
// Every role is present; only the colours are wrong, the failure class that the role check cannot see (BASELINE.md: 1.02-1.12:1).
const BAD_CSS = 'html{background-color:#0f0f0f} a.ytLockupMetadataViewModelTitle,a#video-title,input[name=search_query],h1{color:#161616}';

function sentinelSetup(kind, css, healthOpts = {}, pageOpts = {}) {
  const { p, doc } = themedPage(kind, css, pageOpts);
  const selectors = createSelectors(MAP, doc);
  const clock = fakeClock();
  const changes = [];
  const settled = [];
  const health = createHealth({
    doc, selectors, map: MAP, onChange: (r) => changes.push(r), onSettled: (r) => settled.push(r), timers: clock, ...healthOpts,
  });
  return { p, doc, selectors, clock, changes, settled, health };
}

test('measureReadability: title, search box and watch title are sampled against the effective background', () => {
  const { p, doc } = themedPage('watch', OK_CSS);
  const r = measureReadability({ doc, selectors: createSelectors(MAP, doc), pageType: 'watch' });
  assert.ok(r.checked >= 3, `samples: ${JSON.stringify(r.samples)}`);
  assert.deepEqual(r.low, []);
  assert.ok(r.samples.every((s) => s.ratio > 10), JSON.stringify(r.samples));
  const ids = r.samples.map((s) => s.id);
  assert.ok(ids.includes('tile') || ids.includes('watch'), ids.join());
  p.close?.();
});

test('measureReadability: dark-on-dark is low; translucent layers are composited; a background image or unreadable colour is skipped, not judged', () => {
  const bad = themedPage('home', BAD_CSS);
  const low = measureReadability({ doc: bad.doc, selectors: createSelectors(MAP, bad.doc), pageType: 'home' });
  assert.ok(low.checked >= 2 && low.low.length === low.checked, JSON.stringify(low));
  assert.ok(low.low.every((s) => s.ratio < READABLE_MIN_RATIO));

  // Light text over a translucent black layer over a white page is readable only through the composite: 0.9 black => dark enough.
  const layered = themedPage('home', 'html{background-color:#ffffff} ytd-app{background-color:rgba(0,0,0,.9)} a.ytLockupMetadataViewModelTitle,a#video-title,input[name=search_query]{color:#f1f1f1}');
  const comp = measureReadability({ doc: layered.doc, selectors: createSelectors(MAP, layered.doc), pageType: 'home' });
  assert.ok(comp.checked >= 2 && comp.low.length === 0, JSON.stringify(comp));

  // Same unreadable colours but over a picture: not judged at all.
  const image = themedPage('home', BAD_CSS + ' ytd-app{background-image:url(data:image/png;base64,AAAA)}');
  const img = measureReadability({ doc: image.doc, selectors: createSelectors(MAP, image.doc), pageType: 'home' });
  assert.equal(img.checked, 0);
  // An unresolved var() (jsdom does not resolve them; a renamed variable in Chrome resolves to the initial value) is not a sample.
  const vars = themedPage('home', 'a.ytLockupMetadataViewModelTitle,a#video-title,input[name=search_query]{color:var(--cd-renamed-away)}');
  assert.equal(measureReadability({ doc: vars.doc, selectors: createSelectors(MAP, vars.doc), pageType: 'home' }).checked, 0);
});

test('measureReadability: hidden nodes are not samples (a watch skeleton that YouTube keeps hidden)', () => {
  const shown = themedPage('watch', OK_CSS);
  assert.ok(measureReadability({ doc: shown.doc, selectors: createSelectors(MAP, shown.doc), pageType: 'watch' }).samples.some((s) => s.id === 'watch'));
  const hidden = themedPage('watch', OK_CSS + ' ytd-watch-flexy{display:none}');
  const r = measureReadability({ doc: hidden.doc, selectors: createSelectors(MAP, hidden.doc), pageType: 'watch' });
  assert.equal(r.samples.some((s) => s.id === 'watch' || s.id === 'tile'), false, JSON.stringify(r.samples));
});

test('sentinel: unreadable themed page -> theme reported broken after the settle time and a confirming second look, then settled', () => {
  const { clock, changes, settled, health } = sentinelSetup('home', BAD_CSS);
  health.watch('home', ['theme'], { timeoutMs: 6000 });
  assert.equal(changes.length, 0, 'every role is present: nothing yet');
  clock.advance(5999);
  assert.equal(health.isUnreadable(), false);
  clock.advance(1);            // first bad reading: not believed yet
  assert.equal(health.isUnreadable(), false);
  assert.deepEqual(changes, []);
  clock.advance(2500);         // confirmed
  assert.equal(health.isUnreadable(), true);
  assert.deepEqual(changes, [broken(pair('theme'))]);
  assert.deepEqual(settled.at(-1), broken(pair('theme')));
  assert.deepEqual(health.evaluate('home', ['theme']), broken(pair('theme')));
});

test('sentinel: a readable page, fewer than two samples, or a theme that is not applied never raise anything', () => {
  const ok = sentinelSetup('home', OK_CSS);
  ok.health.watch('home', ['theme'], { timeoutMs: 100 });
  ok.clock.advance(10000);
  assert.equal(ok.health.isUnreadable(), false);
  assert.deepEqual(ok.changes, []);

  // One sample only (no search box, one tile): the page may simply not have rendered.
  const few = sentinelSetup('home', BAD_CSS, {}, { tiles: 1 });
  few.doc.querySelectorAll('input[name="search_query"], input#search').forEach((n) => n.remove());
  few.health.watch('home', ['theme'], { timeoutMs: 100 });
  few.clock.advance(60000);
  assert.equal(few.health.isUnreadable(), false);
  assert.deepEqual(few.changes, []);

  // The theme is off (cd-off-theme): nothing themed to judge, so nothing is said.
  const off = sentinelSetup('home', BAD_CSS);
  off.doc.documentElement.setAttribute('cd-off-theme', '');
  off.health.watch('home', ['theme'], { timeoutMs: 100 });
  off.clock.advance(60000);
  assert.deepEqual(off.changes, []);
});

test('sentinel: the verdict is sticky while the theme is off, heals on a good measurement, and is dropped for another theme or map', () => {
  const s = sentinelSetup('home', BAD_CSS);
  s.health.watch('home', ['theme'], { timeoutMs: 100 });
  s.clock.advance(100 + 2500);
  assert.equal(s.health.isUnreadable(), true);

  // The engine switches the theme off: the next settle does not re-measure and the verdict stands (no flapping).
  s.doc.documentElement.setAttribute('cd-off-theme', '');
  s.health.watch('home', ['theme'], { timeoutMs: 100 });
  s.clock.advance(60000);
  assert.equal(s.health.isUnreadable(), true);
  assert.deepEqual(s.settled.at(-1), broken(pair('theme')));

  // Another theme under the same map: the verdict was about the first theme.
  s.doc.documentElement.setAttribute('cd-theme', 'minimal');
  assert.equal(s.health.isUnreadable(), false);
  assert.deepEqual(s.health.evaluate('home', ['theme']), OK);

  // Back on the first theme, theme applied again, and the page is now readable: the next measurement heals it.
  s.doc.documentElement.setAttribute('cd-theme', 'cinema');
  s.doc.documentElement.removeAttribute('cd-off-theme');
  assert.equal(s.health.isUnreadable(), true, 'same theme and map: the verdict is back until measured');
  s.doc.head.querySelector('style').textContent = OK_CSS;
  s.health.watch('home', ['theme'], { timeoutMs: 100 });
  s.clock.advance(100);
  assert.equal(s.health.isUnreadable(), false);
  assert.equal(s.changes.at(-1).ok, true, 'healed picture announced');
});

test('sentinel: a verdict seeded from an earlier load keeps the theme off from the first settle, and a different map ignores it', () => {
  const s = sentinelSetup('home', OK_CSS);
  s.health.seedUnreadable({ themeId: 'cinema', mapVersion: MAP.mapVersion });
  assert.deepEqual(s.health.evaluate('home', ['theme']), broken(pair('theme')));
  s.health.watch('home', ['theme'], { timeoutMs: 100 });
  assert.deepEqual(s.settled.at(-1), broken(pair('theme')), 'settled with the standing verdict, not healthy');
  const other = sentinelSetup('home', OK_CSS);
  other.health.seedUnreadable({ themeId: 'cinema', mapVersion: '1999.01.01.1' });
  assert.deepEqual(other.health.evaluate('home', ['theme']), OK);
  other.health.seedUnreadable(null);
  assert.equal(other.health.isUnreadable(), false);
});

test('sentinel: a hidden tab is not judged until it is visible', () => {
  const s = sentinelSetup('home', BAD_CSS);
  Object.defineProperty(s.doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
  s.health.watch('home', ['theme'], { timeoutMs: 100 });
  s.clock.advance(60000);
  assert.equal(s.health.isUnreadable(), false);
  Object.defineProperty(s.doc, 'visibilityState', { configurable: true, get: () => 'visible' });
  s.doc.dispatchEvent(new s.doc.defaultView.Event('visibilitychange'));
  s.clock.advance(3000 + 2500);
  assert.equal(s.health.isUnreadable(), true);
});

test('onSettled is called for every finished page, changed or not, and never from record()', () => {
  const s = setup('home', {}, { onSettled: undefined });
  const seen = [];
  const h = createHealth({ doc: s.document, selectors: s.selectors, map: MAP, timers: s.clock, readability: false, onSettled: (r) => seen.push(r) });
  h.watch('home', FEATURES);
  assert.deepEqual(seen, [OK], 'a healthy page settles at once');
  h.watch('home', FEATURES);
  assert.equal(seen.length, 2, 'asked again: told again, though nothing changed');
  h.record('layout-home', ['homeGrid']);
  assert.equal(seen.length, 2, 'a layout report is a change, not a settle');
});

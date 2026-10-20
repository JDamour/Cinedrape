import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_THEME_IDS, CALM_KEYS, DEFAULT_SETTINGS, FEATURES, FREE_CALM_KEYS, FREE_THEME_IDS,
} from '../../src/shared/constants.js';
import {
  allowedCalmKeys, canSetDensity, computeEffectiveConfig, isFeatureAllowed, isPro, isThemeAllowed,
} from '../../src/shared/entitlements.js';

// Tiny local stand-ins for the launch themes: ids/tiers per the contract, layouts chosen so every
// field of the EffectiveConfig is distinguishable from the defaults.
const LAYOUTS = {
  cinema: { home: 'hero-rows', watch: 'cinema', density: 3 },
  minimal: { home: 'grid', watch: 'default', density: 2 },
  classic: { home: 'rows', watch: 'default', density: 1 },
  primetime: { home: 'rows', watch: 'cinema', density: 4 },
  studio: { home: 'grid', watch: 'focus', density: 5 },
  arcade: { home: 'grid', watch: 'default', density: 5 },
  oled: { home: 'hero-rows', watch: 'cinema', density: 3 },
  frost: { home: 'grid', watch: 'default', density: 3 },
  mocha: { home: 'rows', watch: 'cinema', density: 3 },
  'midnight-city': { home: 'hero-rows', watch: 'cinema', density: 3 },
  ember: { home: 'grid', watch: 'default', density: 2 },
  paper: { home: 'grid', watch: 'focus', density: 4 },
  matcha: { home: 'rows', watch: 'focus', density: 3 },
  sunset: { home: 'hero-rows', watch: 'default', density: 3 },
  terminal: { home: 'grid', watch: 'default', density: 1 },
  imax: { home: 'hero-rows', watch: 'cinema', density: 5 },
};
const theme = (id, extra = {}) => ({
  schema: 1, id, name: id, author: 'test', version: '1.0.0',
  tier: FREE_THEME_IDS.includes(id) ? 'free' : 'pro',
  tokens: { color: {}, type: {}, shape: {} },
  layout: { ...LAYOUTS[id] }, calm: {}, css: '', ...extra,
});
const THEMES = ALL_THEME_IDS.map((id) => theme(id));

const FREE = { plan: 'free', status: 'none' };
const PRO = { plan: 'pro', status: 'active' };
const GRACE = { plan: 'pro', status: 'grace' };
const EXPIRED = { plan: 'pro', status: 'expired' };

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}
const settingsWith = (over) => ({ ...structuredClone(DEFAULT_SETTINGS), ...over });
const compute = (settings, licenceState, extra = {}) => computeEffectiveConfig({ settings, licenceState, themes: THEMES, ...extra });

// ---- isPro ----------------------------------------------------------------------------------

test('isPro: plan must be pro AND status active or grace', () => {
  const table = [
    [{ plan: 'pro', status: 'active' }, true],
    [{ plan: 'pro', status: 'grace' }, true],
    [{ plan: 'pro', status: 'expired' }, false],
    [{ plan: 'pro', status: 'none' }, false],
    [{ plan: 'free', status: 'active' }, false],
    [{ plan: 'free', status: 'grace' }, false],
    [{ plan: 'free', status: 'none' }, false],
    [{ plan: 'free', status: 'expired' }, false],
    [{ plan: 'pro' }, false],
    [{ status: 'active' }, false],
    [{ plan: 'PRO', status: 'active' }, false],
    [{ plan: 'pro', status: 'ACTIVE' }, false],
    [{ plan: ['pro'], status: 'active' }, false],
    [{ plan: 'pro', status: ['active'] }, false],
    [{ plan: true, status: true }, false],
    [{}, false], [null, false], [undefined, false], ['pro', false], [1, false], [true, false], [[], false],
  ];
  for (const [state, expected] of table) assert.equal(isPro(state), expected, JSON.stringify(state));
});

test('isPro reads own data properties only (prototype pollution and getters cannot grant Pro)', () => {
  const inherited = Object.create({ plan: 'pro', status: 'active' });
  assert.equal(isPro(inherited), false);
  Object.prototype.plan = 'pro'; // eslint-disable-line no-extend-native
  Object.prototype.status = 'active'; // eslint-disable-line no-extend-native
  try {
    assert.equal(isPro({}), false);
    assert.equal(isPro(FREE), false);
    assert.equal(compute(settingsWith({ themeId: 'arcade' }), {}).theme.id, 'arcade');
  } finally {
    delete Object.prototype.plan;
    delete Object.prototype.status;
  }
  const getter = { get plan() { throw new Error('getter must not run'); }, status: 'active' };
  assert.equal(isPro(getter), false);
});

// ---- isThemeAllowed -------------------------------------------------------------------------

test('isThemeAllowed: every launch theme x every licence state is allowed in free model', () => {
  const states = { free: FREE, pro: PRO, grace: GRACE, expired: EXPIRED, junk: null };
  for (const t of THEMES) {
    assert.equal(isThemeAllowed(t, states.free), true, `${t.id} / free`);
    assert.equal(isThemeAllowed(t, states.junk), true, `${t.id} / junk`);
    assert.equal(isThemeAllowed(t, states.expired), true, `${t.id} / expired pro`);
    assert.equal(isThemeAllowed(t, states.pro), true, `${t.id} / pro`);
    assert.equal(isThemeAllowed(t, states.grace), true, `${t.id} / grace`);
  }
  assert.deepEqual(THEMES.filter((t) => isThemeAllowed(t, FREE)).map((t) => t.id), ALL_THEME_IDS);
});

test('isThemeAllowed fails closed on a missing, unknown or contradictory tier', () => {
  for (const state of [FREE, PRO]) {
    for (const bad of [null, undefined, 5, 'cinema', [], {}, { id: 'x' }, { id: 'x', tier: 'enterprise' }, { id: 'x', tier: 'FREE' },
      { id: 'x', tier: ['free'] }, { id: 'x', tier: true }]) {
      assert.equal(isThemeAllowed(bad, state), false, JSON.stringify(bad));
    }
  }
  assert.equal(isThemeAllowed({ id: 'mine', tier: 'free' }, FREE), true);
  assert.equal(isThemeAllowed({ id: 'mine', tier: 'pro' }, FREE), true);
  assert.equal(isThemeAllowed({ id: 'mine', tier: 'pro' }, GRACE), true);
});

test('isThemeAllowed ignores inherited tier/id', () => {
  const sneaky = Object.create({ tier: 'free', id: 'cinema' });
  assert.equal(isThemeAllowed(sneaky, PRO), false);
});

// ---- density / calm / features --------------------------------------------------------------

test('canSetDensity is available to all users in free model', () => {
  const table = [[FREE, true], [PRO, true], [GRACE, true], [EXPIRED, true], [null, true], [undefined, true], [{}, true], ['pro', true]];
  for (const [state, expected] of table) assert.equal(canSetDensity(state), expected, JSON.stringify(state));
});

test('allowedCalmKeys: all users get all CALM_KEYS in free model', () => {
  for (const state of [FREE, EXPIRED, null, undefined, {}, 'pro', PRO, GRACE]) assert.deepEqual(allowedCalmKeys(state), CALM_KEYS, JSON.stringify(state));
  // callers may mutate the result without corrupting the constants or later calls
  allowedCalmKeys(FREE).push('hideViewCounts');
  allowedCalmKeys(PRO).length = 0;
  assert.equal(allowedCalmKeys(FREE).length, 6);
  assert.equal(allowedCalmKeys(PRO).length, 6);
});

test('isFeatureAllowed: every FEATURE is allowed for all users in free model', () => {
  for (const f of FEATURES) {
    assert.equal(isFeatureAllowed(f, FREE), true, `${f} / free`);
    assert.equal(isFeatureAllowed(f, EXPIRED), true, `${f} / expired`);
    assert.equal(isFeatureAllowed(f, PRO), true, `${f} / pro`);
    assert.equal(isFeatureAllowed(f, GRACE), true, `${f} / grace`);
  }
  for (const bad of ['', 'calm-hideEverything', 'calm-', 'toString', '__proto__', 'constructor', null, undefined, 5, {}, ['density']]) {
    assert.equal(isFeatureAllowed(bad, PRO), false, String(bad));
  }
  assert.ok(CALM_KEYS.every((k) => FEATURES.includes(`calm-${k}`)));
});

// ---- computeEffectiveConfig -----------------------------------------------------------------

test('free user with default settings: Cinema, its own layout and density, nothing hidden', () => {
  const cfg = compute(DEFAULT_SETTINGS, FREE);
  assert.equal(cfg.theme, THEMES[0]);
  assert.deepEqual(cfg, {
    theme: THEMES[0], accent: null, animations: true, textScale: null, home: 'hero-rows', watch: 'cinema', density: 3,
    calm: { hideShorts: false, hideHomeRecs: false, hideComments: false, hideEndScreens: false, hideViewCounts: false, hideLive: false },
    disabled: [], pro: false, trial: false,
  });
  assert.deepEqual(Object.keys(cfg), ['theme', 'accent', 'animations', 'textScale', 'home', 'watch', 'density', 'calm', 'disabled', 'pro', 'trial']);
  assert.deepEqual(Object.keys(cfg.calm), CALM_KEYS);
});

test('textScale: allowed numbers are preserved for free and Pro users; invalid values fall back to null', () => {
  for (const scale of [0.9, 1, 1.1, 1.25, 1.5]) {
    assert.equal(compute({ ...DEFAULT_SETTINGS, textScale: scale }, FREE).textScale, scale);
    assert.equal(compute({ ...DEFAULT_SETTINGS, textScale: scale }, PRO).textScale, scale);
  }
  for (const bad of [null, undefined, 0, 2, -1, '1.1', {}, [], NaN]) {
    assert.equal(compute({ ...DEFAULT_SETTINGS, textScale: bad }, FREE).textScale, null);
  }
});

test('every stored theme x licence state resolves to an allowed theme, and settings are untouched', () => {
  const cases = { free: FREE, pro: PRO, grace: GRACE, expired: EXPIRED };
  for (const [label, state] of Object.entries(cases)) {
    for (const id of ALL_THEME_IDS) {
      const settings = deepFreeze(settingsWith({ themeId: id }));
      const cfg = compute(settings, state);
      const wanted = THEMES.find((t) => t.id === id);
      const expectedId = isThemeAllowed(wanted, state) ? id : 'cinema';
      assert.equal(cfg.theme.id, expectedId, `${id} / ${label}`);
      assert.equal(settings.themeId, id, 'stored choice is never rewritten');
      assert.equal(cfg.home, LAYOUTS[expectedId].home);
      assert.equal(cfg.watch, LAYOUTS[expectedId].watch);
    }
  }
});

test('theme selection: arcade is allowed for all licence states in free model', () => {
  const settings = settingsWith({ themeId: 'arcade' });
  const before = JSON.stringify(settings);
  assert.equal(compute(settings, PRO).theme.id, 'arcade');
  assert.equal(compute(settings, EXPIRED).theme.id, 'arcade');
  assert.equal(compute(settings, FREE).theme.id, 'arcade');
  assert.equal(compute(settings, GRACE).theme.id, 'arcade');
  assert.equal(JSON.stringify(settings), before);
});

test('density: user override wins for all users, defaults to theme value when null', () => {
  for (const id of ALL_THEME_IDS) {
    const themeDensity = LAYOUTS[id].density;
    assert.equal(compute(settingsWith({ themeId: id, density: null }), FREE).density, themeDensity, `free ${id} no override`);
    assert.equal(compute(settingsWith({ themeId: id, density: null }), PRO).density, themeDensity, `pro ${id} no override`);
    for (const stored of [1, 2, 3, 4, 5]) {
      assert.equal(compute(settingsWith({ themeId: id, density: stored }), FREE).density, stored, `free ${id} override ${stored}`);
      assert.equal(compute(settingsWith({ themeId: id, density: stored }), PRO).density, stored, `pro ${id} override ${stored}`);
      assert.equal(compute(settingsWith({ themeId: id, density: stored }), GRACE).density, stored);
      assert.equal(compute(settingsWith({ themeId: id, density: stored }), EXPIRED).density, stored);
    }
  }
});

test('density: junk overrides are ignored even for Pro', () => {
  for (const junk of [0, 6, -1, 2.5, 3.0000001, '4', '', NaN, Infinity, -Infinity, true, false, [], [3], {}, { v: 3 }, 10n, () => 3, undefined]) {
    const cfg = compute(settingsWith({ themeId: 'minimal', density: junk }), PRO);
    assert.equal(cfg.density, 2, `override ${String(junk)} falls back to the theme's 2`);
  }
  assert.equal(compute(settingsWith({ themeId: 'minimal', density: 3.0 }), PRO).density, 3);
});

test('density: a theme with a broken density still yields 1..5', () => {
  for (const junk of [undefined, null, 0, 9, 2.5, '3', NaN]) {
    const t = theme('cinema', { layout: { home: 'grid', watch: 'default', density: junk } });
    const cfg = computeEffectiveConfig({ settings: DEFAULT_SETTINGS, licenceState: FREE, themes: [t] });
    assert.equal(cfg.density, 3);
  }
});

test('calm: all calm keys are unlocked for all users in free model', () => {
  for (const key of CALM_KEYS) {
    const on = settingsWith({ calm: { ...DEFAULT_SETTINGS.calm, [key]: true } });
    const freeCfg = compute(on, FREE);
    const proCfg = compute(on, PRO);
    assert.equal(freeCfg.calm[key], true, `free ${key}`);
    assert.equal(proCfg.calm[key], true, `pro ${key}`);
    assert.equal(compute(on, GRACE).calm[key], true, `grace ${key}`);
    assert.equal(compute(on, EXPIRED).calm[key], true, `expired ${key}`);
    // toggles are independent: exactly one key is on
    assert.deepEqual(CALM_KEYS.filter((k) => proCfg.calm[k]), [key]);
    // and switched off it stays off for everyone
    const off = settingsWith({ calm: { ...DEFAULT_SETTINGS.calm, [key]: false } });
    for (const s of [FREE, PRO]) assert.equal(compute(off, s).calm[key], false);
  }
});

test('calm: users with everything stored on keep all 6 toggles in free model', () => {
  const all = settingsWith({ calm: Object.fromEntries(CALM_KEYS.map((k) => [k, true])) });
  assert.deepEqual(compute(all, FREE).calm, Object.fromEntries(CALM_KEYS.map((k) => [k, true])));
  assert.deepEqual(compute(all, PRO).calm, Object.fromEntries(CALM_KEYS.map((k) => [k, true])));
  assert.equal(all.calm.hideViewCounts, true);
});

test('calm: a theme default applies only where the user has not set a boolean', () => {
  const quiet = theme('cinema', { calm: { hideShorts: true, hideComments: true, hideViewCounts: true } });
  const run = (calm, state) => computeEffectiveConfig({ settings: { ...DEFAULT_SETTINGS, calm }, licenceState: state, themes: [quiet] }).calm;
  assert.deepEqual(run({}, PRO), { hideShorts: true, hideHomeRecs: false, hideComments: true, hideEndScreens: false, hideViewCounts: true, hideLive: false });
  assert.deepEqual(run({}, FREE), { hideShorts: true, hideHomeRecs: false, hideComments: true, hideEndScreens: false, hideViewCounts: true, hideLive: false });
  assert.equal(run({ hideShorts: false }, PRO).hideShorts, false, 'an explicit off beats the theme default');
  assert.equal(run({ hideComments: false }, PRO).hideComments, false);
  assert.equal(run({ hideViewCounts: false }, PRO).hideViewCounts, false);
  for (const junk of ['yes', 1, 0, null, [], {}, undefined]) {
    assert.equal(run({ hideShorts: junk }, PRO).hideShorts, true, `junk ${JSON.stringify(junk)} defers to the theme`);
  }
});

test('calm: junk calm objects behave like no calm settings', () => {
  for (const junk of [undefined, null, 'all', 5, true, [], [true, true], () => 1]) {
    const cfg = compute({ ...DEFAULT_SETTINGS, calm: junk }, PRO);
    assert.deepEqual(cfg.calm, Object.fromEntries(CALM_KEYS.map((k) => [k, false])), String(junk));
  }
  // truthy non-booleans do not switch anything on
  const cfg = compute({ ...DEFAULT_SETTINGS, calm: { hideShorts: 1, hideHomeRecs: 'true', hideComments: {}, hideEndScreens: [], hideViewCounts: 'yes' } }, PRO);
  assert.ok(CALM_KEYS.every((k) => cfg.calm[k] === false));
});

test('junk settings fall back to DEFAULT_SETTINGS behaviour and never throw', () => {
  const baseline = compute(DEFAULT_SETTINGS, FREE);
  const junkSettings = [
    undefined, null, 'settings', 42, true, [], [DEFAULT_SETTINGS], () => DEFAULT_SETTINGS, {},
    { themeId: 42 }, { themeId: null }, { themeId: {} }, { themeId: ['arcade'] }, { themeId: '' }, { themeId: 'nope' },
    { themeId: 'constructor' }, { themeId: '__proto__' }, { themeId: 'toString' },
    { accent: 42 }, { accent: {} }, { accent: [] }, { accent: 'red' }, { accent: 'var(--x)' }, { accent: 'url(javascript:alert(1))' },
    { animations: 'false' }, { animations: 0 }, { animations: null }, { animations: [] },
    { density: 'x' }, { calm: 'x' }, { schema: 'banana' }, { telemetryOptIn: {} },
  ];
  for (const s of junkSettings) {
    let cfg;
    assert.doesNotThrow(() => { cfg = compute(s, FREE); }, JSON.stringify(s));
    assert.deepEqual(cfg, baseline, `junk settings ${typeof s === 'function' ? 'fn' : JSON.stringify(s)}`);
  }
});

test('settings inherited from a prototype are ignored', () => {
  const inherited = Object.create({ themeId: 'arcade', density: 5, animations: false, accent: '#ff0000', calm: { hideComments: true } });
  const cfg = compute(inherited, PRO);
  assert.equal(cfg.theme.id, 'cinema');
  assert.equal(cfg.density, 3);
  assert.equal(cfg.animations, true);
  assert.equal(cfg.accent, null);
  assert.equal(cfg.calm.hideComments, false);
});

test('animations: only a real boolean overrides the default', () => {
  assert.equal(compute(settingsWith({ animations: false }), FREE).animations, false);
  assert.equal(compute(settingsWith({ animations: true }), FREE).animations, true);
  assert.equal(compute(settingsWith({ animations: false }), PRO).animations, false, 'animations are not tier-gated');
});

test('accent: normalised to #rrggbb or dropped; not tier-gated', () => {
  const table = [
    ['#ff0000', '#ff0000'], ['#FF0000', '#ff0000'], ['#f00', '#ff0000'], ['#E8B04A', '#e8b04a'],
    ['rgb(255, 0, 0)', '#ff0000'], ['rgb(255 0 0 / 100%)', '#ff0000'], ['hsl(120 100% 50%)', '#00ff00'],
    ['  #abcdef  ', '#abcdef'], ['#ff000080', null], ['rgba(255,0,0,0.5)', null], ['#ffffffff', '#ffffff'],
    ['red', null], ['', null], ['#ff', null], ['#gggggg', null], ['var(--accent)', null], ['#fff;color:red', null],
    ['url(javascript:alert(1))', null], ['x'.repeat(10000), null], [0xff0000, null], [null, null], [undefined, null], [{}, null],
  ];
  for (const [input, expected] of table) {
    for (const state of [FREE, PRO]) {
      assert.equal(compute(settingsWith({ accent: input }), state).accent, expected, `${String(input).slice(0, 30)} / ${state.plan}`);
    }
  }
});

test('themes list: junk is tolerated and fallbacks are ordered', () => {
  const s = settingsWith({ themeId: 'arcade' });
  for (const junk of [undefined, null, 'themes', 5, {}, { cinema: THEMES[0] }]) {
    const cfg = computeEffectiveConfig({ settings: s, licenceState: PRO, themes: junk });
    assert.equal(cfg.theme, null, `themes=${JSON.stringify(junk)}`);
    assert.equal(cfg.home, 'grid');
    assert.equal(cfg.watch, 'default');
    assert.equal(cfg.density, 3);
    assert.equal(cfg.pro, true);
  }
  assert.equal(computeEffectiveConfig({ settings: s, licenceState: PRO, themes: [null, 5, 'x', [], THEMES[5]] }).theme, THEMES[5], 'junk entries are skipped');
  // stored theme unknown + cinema missing -> first allowed theme in the list
  const noCinema = THEMES.filter((t) => t.id !== 'cinema');
  assert.equal(computeEffectiveConfig({ settings: settingsWith({ themeId: 'ghost' }), licenceState: FREE, themes: noCinema }).theme.id, 'minimal');
  assert.equal(computeEffectiveConfig({ settings: settingsWith({ themeId: 'arcade' }), licenceState: FREE, themes: noCinema }).theme.id, 'arcade');
  assert.equal(computeEffectiveConfig({ settings: settingsWith({ themeId: 'arcade' }), licenceState: PRO, themes: noCinema }).theme.id, 'arcade');
  // invalid tier themes only: nothing usable, and that is reported as null
  assert.equal(computeEffectiveConfig({ settings: s, licenceState: FREE, themes: [{ id: 'bad1', tier: 'invalid' }, { id: 'bad2', tier: 'unknown' }] }).theme, null);
  // duplicate ids: the first one wins
  const dup = [theme('cinema', { name: 'first' }), theme('cinema', { name: 'second' })];
  assert.equal(computeEffectiveConfig({ settings: DEFAULT_SETTINGS, licenceState: FREE, themes: dup }).theme.name, 'first');
});

test('theme layout values outside the allowed menu fall back to the first option', () => {
  const t = theme('cinema', { layout: { home: 'carousel', watch: 'imax', density: 3 } });
  const cfg = computeEffectiveConfig({ settings: DEFAULT_SETTINGS, licenceState: PRO, themes: [t] });
  assert.equal(cfg.home, 'grid');
  assert.equal(cfg.watch, 'default');
  const none = computeEffectiveConfig({ settings: DEFAULT_SETTINGS, licenceState: PRO, themes: [{ id: 'cinema', tier: 'free' }] });
  assert.equal(none.home, 'grid');
  assert.equal(none.density, 3);
});

test('disabled passes through filtered to known FEATURES, de-duplicated', () => {
  const cfg = compute(DEFAULT_SETTINGS, PRO, { disabled: ['layout-home', 'calm-hideShorts', 'layout-home', 'bogus', 5, null, '__proto__'] });
  assert.deepEqual(cfg.disabled, ['layout-home', 'calm-hideShorts']);
  for (const junk of [undefined, null, 'layout-home', 5, {}]) assert.deepEqual(compute(DEFAULT_SETTINGS, PRO, { disabled: junk }).disabled, []);
  const input = ['density'];
  const out = compute(DEFAULT_SETTINGS, PRO, { disabled: input }).disabled;
  out.push('theme');
  assert.deepEqual(input, ['density'], 'result does not alias the caller array');
});

test('pure: frozen inputs are accepted, nothing is mutated, results are independent', () => {
  const settings = deepFreeze(settingsWith({ themeId: 'arcade', density: 4, accent: '#ABCDEF', calm: { ...DEFAULT_SETTINGS.calm, hideComments: true } }));
  const themes = deepFreeze(ALL_THEME_IDS.map((id) => theme(id, { calm: { hideViewCounts: true } })));
  const licence = deepFreeze({ ...PRO });
  const a = computeEffectiveConfig({ settings, licenceState: licence, themes });
  const b = computeEffectiveConfig({ settings, licenceState: licence, themes });
  assert.deepEqual(a, b);
  a.calm.hideShorts = true;
  a.disabled.push('density');
  assert.equal(b.calm.hideShorts, false);
  assert.deepEqual(b.disabled, []);
  assert.deepEqual(computeEffectiveConfig({ settings, licenceState: licence, themes }).calm, {
    // the stored calm object lists every key explicitly, so the theme's hideViewCounts default is shadowed
    hideShorts: false, hideHomeRecs: false, hideComments: true, hideEndScreens: false, hideViewCounts: false, hideLive: false,
  });
});

test('computeEffectiveConfig tolerates being called with nothing', () => {
  const cfg = computeEffectiveConfig();
  assert.equal(cfg.theme, null);
  assert.equal(cfg.pro, false);
  assert.doesNotThrow(() => computeEffectiveConfig(undefined));
  assert.doesNotThrow(() => computeEffectiveConfig({}));
  assert.doesNotThrow(() => computeEffectiveConfig(null));
  assert.doesNotThrow(() => computeEffectiveConfig('settings'));
  assert.equal(computeEffectiveConfig({ themes: THEMES }).theme, THEMES[0]);
});

test('full tier x feature matrix on a realistic stored profile', () => {
  const profile = settingsWith({
    themeId: 'primetime', density: 5, accent: '#33aaff', animations: false,
    calm: { hideShorts: true, hideHomeRecs: true, hideComments: true, hideEndScreens: true, hideViewCounts: true, hideLive: true },
  });
  const free = compute(profile, FREE);
  assert.deepEqual([free.theme.id, free.density, free.pro], ['primetime', 5, false]);
  assert.deepEqual(CALM_KEYS.filter((k) => free.calm[k]), CALM_KEYS);
  assert.equal(free.accent, '#33aaff', 'accent is a free quick setting');
  assert.equal(free.animations, false);
  const pro = compute(profile, PRO);
  assert.deepEqual([pro.theme.id, pro.density, pro.pro], ['primetime', 5, true]);
  assert.deepEqual(CALM_KEYS.filter((k) => pro.calm[k]), CALM_KEYS);
  assert.equal(pro.home, 'rows');
  assert.equal(pro.watch, 'cinema');
});

test('PRO-1: mix and match layout overrides are available to all users', () => {
  // Cinema theme defaults: { home: 'hero-rows', watch: 'cinema', density: 3 }
  const override = settingsWith({ layout: { home: 'grid', watch: 'focus' } });

  // Free user gets stored layout overrides
  const free = compute(override, FREE);
  assert.equal(free.home, 'grid', 'free user gets home override');
  assert.equal(free.watch, 'focus', 'free user gets watch override');
  assert.equal(free.pro, false);

  // Pro user gets stored layout overrides
  const pro = compute(override, PRO);
  assert.equal(pro.home, 'grid', 'pro user gets home override');
  assert.equal(pro.watch, 'focus', 'pro user gets watch override');
  assert.equal(pro.pro, true);

  // Trial user gets stored layout overrides with pro=false
  const trial = compute(override, FREE, { trial: true });
  assert.equal(trial.home, 'grid', 'trial user gets home override');
  assert.equal(trial.watch, 'focus', 'trial user gets watch override');
  assert.equal(trial.pro, false, 'trial user pro flag stays false');

  // Null override falls back to theme layout
  const partial = settingsWith({ layout: { home: 'rows', watch: null } });
  const proPartial = compute(partial, PRO);
  assert.equal(proPartial.home, 'rows');
  assert.equal(proPartial.watch, 'cinema', 'null watch falls back to theme default');

  // Junk override values fall back to theme layout
  const junk = settingsWith({ layout: { home: 'invalid-home', watch: 'invalid-watch' } });
  const proJunk = compute(junk, PRO);
  assert.equal(proJunk.home, 'hero-rows');
  assert.equal(proJunk.watch, 'cinema');
});

test('PRO-0: trial mode preserves feature availability while passing trial flag', () => {
  const profile = settingsWith({
    themeId: 'primetime',
    layout: { home: 'grid', watch: 'focus' },
    density: 5,
    accent: '#33aaff',
    animations: false,
    calm: {
      hideShorts: true,
      hideHomeRecs: true,
      hideComments: true,
      hideEndScreens: true,
      hideViewCounts: true,
      hideLive: true,
    },
  });

  const free = compute(profile, FREE, { trial: false });
  assert.equal(free.theme.id, 'primetime');
  assert.equal(free.home, 'grid');
  assert.equal(free.watch, 'focus');
  assert.equal(free.density, 5);
  assert.deepEqual(CALM_KEYS.filter((k) => free.calm[k]), CALM_KEYS);
  assert.equal(free.pro, false);
  assert.equal(free.trial, false);

  const trial = compute(profile, FREE, { trial: true });
  assert.equal(trial.theme.id, 'primetime');
  assert.equal(trial.home, 'grid');
  assert.equal(trial.watch, 'focus');
  assert.equal(trial.density, 5);
  assert.deepEqual(CALM_KEYS.filter((k) => trial.calm[k]), CALM_KEYS);
  assert.equal(trial.pro, false);
  assert.equal(trial.trial, true);
});


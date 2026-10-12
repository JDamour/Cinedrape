import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CALM_KEYS, LAYOUT_HOME, LAYOUT_WATCH, LIMITS } from '../../src/shared/constants.js';
import {
  FONT_STACKS, LATEST_SCHEMA, migrateTheme, utf8ByteLength, validateTheme,
} from '../../src/shared/theme-schema.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_MAP = JSON.parse(readFileSync(join(ROOT, 'src/data/selector-map.source.json'), 'utf8'));

// The example from the spec's "Theme format" section. One value differs from the spec text: border is #656572 (the shipped Cinema value) where the
// spec shows #26262f. #26262f is 1.4:1 on the background, below the 3:1 every theme needs (spec: WCAG AA), and validateTheme now refuses it.
const SPEC_EXAMPLE = {
  schema: 1,
  id: 'cinema',
  name: 'Cinema',
  author: 'Cinedrape',
  version: '1.0.0',
  tier: 'free',
  tokens: {
    color: { bg: '#0b0b0f', surface: '#16161d', text: '#f2f2f5', muted: '#9a9aa8', accent: '#e8b04a', border: '#656572' },
    type: { family: 'Inter', baseSize: 14, headingWeight: 700 },
    shape: { radius: 10, shadow: true, spacing: 3 },
  },
  layout: { home: 'hero-rows', watch: 'cinema', density: 3 },
  calm: { hideShorts: false, hideComments: false },
  css: '.cd-hero h1 { letter-spacing: -0.02em; }',
};
const spec = () => structuredClone(SPEC_EXAMPLE);

/** Clone of the spec example with `path` (dotted) replaced; value `undefined` deletes the key. */
function mut(path, value, base = spec()) {
  const keys = path.split('.');
  let o = base;
  for (const k of keys.slice(0, -1)) o = o[k];
  const last = keys[keys.length - 1];
  if (value === undefined) delete o[last];
  else o[last] = value;
  return base;
}
const paths = (list) => list.map((e) => e.path);
const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
};

/** The only complaint is at `path`. */
function assertOnly(res, path, msg) {
  assert.equal(res.ok, false, msg);
  assert.equal(res.theme, null, msg);
  assert.deepEqual(paths(res.errors), [path], `${msg || ''} ${JSON.stringify(res.errors)}`);
}
function assertValid(res, msg) {
  assert.equal(res.ok, true, `${msg || ''} ${JSON.stringify(res.errors)}`);
  assert.deepEqual(res.errors, [], msg);
  assert.ok(res.theme, msg);
}

// ---- the happy path ---------------------------------------------------------------------------

test('the spec example validates and normalises to exactly the documented shape', () => {
  const res = validateTheme(spec());
  assertValid(res);
  assert.deepEqual(res.warnings, []);
  assert.deepEqual(res.theme, SPEC_EXAMPLE);
  assert.deepEqual(Object.keys(res), ['ok', 'errors', 'warnings', 'theme', 'cssValidated']);
  assert.deepEqual(Object.keys(res.theme), ['schema', 'id', 'name', 'author', 'version', 'tier', 'tokens', 'layout', 'calm', 'css']);
  assert.deepEqual(Object.keys(res.theme.tokens), ['color', 'type', 'shape']);
  assert.equal(res.cssValidated, false, 'no selector map -> CSS was not validated, and the result says so');
});

test('optional parts get the documented defaults', () => {
  const minimal = {
    schema: 1, id: 'plain', name: 'Plain', author: 'Me', version: '0.1', tier: 'pro',
    tokens: {
      color: { bg: '#000', surface: '#111', text: '#fff', muted: '#bbb', accent: '#0af', border: '#888' },
      type: { family: 'System', baseSize: 16, headingWeight: 400 },
    },
  };
  const res = validateTheme(minimal);
  assertValid(res);
  assert.deepEqual(res.theme.tokens.shape, { radius: 12, shadow: false, spacing: 3 });
  assert.deepEqual(res.theme.layout, { home: 'grid', watch: 'default', density: 3 });
  assert.deepEqual(res.theme.calm, {});
  assert.equal(res.theme.css, '');
  assert.equal(res.theme.tier, 'pro');
});

test('partially given optional objects are filled key by key', () => {
  const res = validateTheme(mut('tokens.shape', { radius: 4 }, mut('layout', { watch: 'focus' })));
  assertValid(res);
  assert.deepEqual(res.theme.tokens.shape, { radius: 4, shadow: false, spacing: 3 });
  assert.deepEqual(res.theme.layout, { home: 'grid', watch: 'focus', density: 3 });
  assertValid(validateTheme(mut('tokens.shape', {}, mut('layout', {}, mut('calm', {})))));
});

test('calm keeps only the keys the theme set (no false-filling)', () => {
  assert.deepEqual(validateTheme(mut('calm', { hideShorts: true })).theme.calm, { hideShorts: true });
  assert.deepEqual(validateTheme(mut('calm', {})).theme.calm, {});
  const all = Object.fromEntries(CALM_KEYS.map((k, i) => [k, i % 2 === 0]));
  assert.deepEqual(validateTheme(mut('calm', all)).theme.calm, all);
});

test('validation never mutates the input and the output shares nothing with it', () => {
  const input = deepFreeze(spec());
  const res = validateTheme(input);
  assertValid(res);
  assert.deepEqual(input, SPEC_EXAMPLE);
  assert.notEqual(res.theme, input);
  for (const k of ['tokens', 'layout', 'calm']) assert.notEqual(res.theme[k], input[k], k);
  for (const k of ['color', 'type', 'shape']) assert.notEqual(res.theme.tokens[k], input.tokens[k], k);
  res.theme.tokens.color.bg = '#123456';
  res.theme.calm.hideShorts = true;
  assert.equal(input.tokens.color.bg, '#0b0b0f');
  assert.equal(input.calm.hideShorts, false);
  // two calls give independent objects
  assert.notEqual(validateTheme(spec()).theme.tokens.color, validateTheme(spec()).theme.tokens.color);
});

test('a theme survives a JSON round trip unchanged (what storage and import will do)', () => {
  const once = validateTheme(JSON.parse(JSON.stringify(spec()))).theme;
  const twice = validateTheme(JSON.parse(JSON.stringify(once))).theme;
  assert.deepEqual(twice, once);
  assert.deepEqual(validateTheme(once).theme, once, 'normalising a normalised theme is the identity');
});

// ---- FONT_STACKS --------------------------------------------------------------------------------

test('FONT_STACKS: the six keys, all with system fallbacks, nothing downloadable, safe to put in a CSS variable', () => {
  assert.deepEqual(Object.keys(FONT_STACKS), ['Inter', 'System', 'Serif', 'Mono', 'Rounded', 'Condensed']);
  assert.ok(Object.isFrozen(FONT_STACKS));
  assert.equal(FONT_STACKS.Serif, "Georgia, 'Times New Roman', serif");
  assert.match(FONT_STACKS.Inter, /^Inter, system-ui, /);
  for (const [key, stack] of Object.entries(FONT_STACKS)) {
    assert.match(stack, /^[A-Za-z0-9 ,'-]+$/, `${key}: only letters, digits, space, comma, quote, hyphen`);
    assert.match(stack, /(?:sans-serif|serif|monospace)$/, `${key} ends in a generic family`);
    assert.doesNotMatch(stack, /url|@import|http|;|\{|\}|\(|\)|\\/i, key);
    assert.equal((stack.match(/'/g) || []).length % 2, 0, `${key}: quotes balance`);
    assert.ok(stack.split(',').length >= 3, `${key}: has fallbacks`);
  }
  assert.ok(/system-ui/.test(FONT_STACKS.System));
  assert.ok(/monospace/.test(FONT_STACKS.Mono));
});

test('every FONT_STACKS key is an accepted family and nothing else is', () => {
  for (const family of Object.keys(FONT_STACKS)) assertValid(validateTheme(mut('tokens.type.family', family)), family);
  for (const bad of ['Comic Sans', 'inter', 'INTER', 'Inter ', 'Inter, serif', 'serif', 'Georgia', '', 'toString', 'constructor', 'hasOwnProperty',
    '__proto__', 'valueOf', "Inter'; } body { display: none; /*", 'url(x)', 5, null, true, ['Inter'], {}]) {
    assertOnly(validateTheme(mut('tokens.type.family', bad)), 'tokens.type.family', String(bad));
  }
});

// ---- structure: not an object, wrong containers -------------------------------------------------

test('input that is not a plain object is refused at the root without throwing', () => {
  class Thing { constructor() { this.schema = 1; } }
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const inputs = [
    undefined, null, 0, 42, NaN, 'theme', JSON.stringify(spec()), true, [], [spec()], () => spec(), Symbol('t'), 10n,
    new Map(Object.entries(spec())), new Date(), /x/, new Set(), new Thing(), Object.create(spec()), revoked.proxy, new Number(1), new String('x'),
  ];
  for (const input of inputs) {
    let res;
    assert.doesNotThrow(() => { res = validateTheme(input); }, String(typeof input));
    assert.equal(res.ok, false);
    assert.equal(res.theme, null);
    assert.equal(res.errors.length, 1, JSON.stringify(res.errors));
    assert.equal(res.errors[0].path, '');
    assert.equal(typeof res.errors[0].message, 'string');
  }
});

test('hostile proxies cannot make validation throw', () => {
  const traps = ['ownKeys', 'get', 'getOwnPropertyDescriptor', 'getPrototypeOf'];
  for (const trap of traps) {
    const proxy = new Proxy(spec(), { [trap]() { throw new Error('boom'); } });
    let res;
    assert.doesNotThrow(() => { res = validateTheme(proxy); }, trap);
    assert.equal(res.ok, false, trap);
    assert.equal(res.theme, null);
    assert.ok(res.errors.length >= 1);
  }
});

test('null-prototype objects (JSON-ish data built by other code) are accepted', () => {
  const nullProto = (o) => Object.assign(Object.create(null), o);
  const t = nullProto({ ...spec(), tokens: nullProto({ color: nullProto(spec().tokens.color), type: nullProto(spec().tokens.type) }) });
  assertValid(validateTheme(t));
});

test('objects from another realm are accepted (iframe, vm context, jsdom with scripts)', () => {
  const foreign = vm.runInNewContext(`(${JSON.stringify(spec())})`);
  assert.notEqual(Object.getPrototypeOf(foreign), Object.prototype, 'sanity: really another realm');
  assert.notEqual(Object.getPrototypeOf(foreign.tokens), Object.prototype);
  assertValid(validateTheme(foreign));
  assert.deepEqual(validateTheme(foreign).theme, SPEC_EXAMPLE);
  // a foreign array is still not an object
  assertOnly(validateTheme(mut('tokens', vm.runInNewContext('[]'))), 'tokens');
  assertOnly(validateTheme(vm.runInNewContext('[]')), '');
});

test('arrays and scalars where objects are expected are errors at that exact path, with no cascade', () => {
  const containers = ['tokens', 'tokens.color', 'tokens.type', 'tokens.shape', 'layout', 'calm'];
  for (const path of containers) {
    for (const bad of [[], [1], 'x', 5, true, null, () => 1]) {
      assertOnly(validateTheme(mut(path, bad)), path, `${path} = ${JSON.stringify(bad)}`);
    }
  }
});

test('missing required pieces are reported once, at the highest missing path', () => {
  assertOnly(validateTheme(mut('tokens', undefined)), 'tokens');
  assertOnly(validateTheme(mut('tokens.color', undefined)), 'tokens.color');
  assertOnly(validateTheme(mut('tokens.type', undefined)), 'tokens.type');
  for (const k of ['id', 'name', 'author', 'version', 'tier']) assertOnly(validateTheme(mut(k, undefined)), k);
  for (const k of ['bg', 'surface', 'text', 'muted', 'accent', 'border']) assertOnly(validateTheme(mut(`tokens.color.${k}`, undefined)), `tokens.color.${k}`);
  for (const k of ['family', 'baseSize', 'headingWeight']) assertOnly(validateTheme(mut(`tokens.type.${k}`, undefined)), `tokens.type.${k}`);
  assertOnly(validateTheme(mut('schema', undefined)), 'schema');
  assertValid(validateTheme(mut('tokens.shape', undefined)));
  assertValid(validateTheme(mut('layout', undefined)));
  assertValid(validateTheme(mut('calm', undefined)));
  assertValid(validateTheme(mut('css', undefined)));
});

test('all problems are reported together, each at its own path', () => {
  const t = spec();
  t.id = 'Not A Slug';
  t.tier = 'gold';
  t.tokens.color.accent = 'red';
  t.tokens.type.baseSize = 99;
  t.tokens.shape.spacing = 9;
  t.layout.home = 'wall';
  t.calm.hideShorts = 'yes';
  t.css = 42;
  const res = validateTheme(t);
  assert.equal(res.ok, false);
  assert.deepEqual(paths(res.errors).sort(), [
    'calm.hideShorts', 'css', 'id', 'layout.home', 'tier', 'tokens.color.accent', 'tokens.shape.spacing', 'tokens.type.baseSize',
  ]);
  for (const e of res.errors) assert.ok(e.message.length > 0 && e.message.length < 200, e.message);
});

// ---- identity fields ---------------------------------------------------------------------------

test('id must be a slug [a-z0-9-]{2,40}', () => {
  for (const ok of ['ab', 'cinema', 'a'.repeat(40), 'my-theme-2', '0-9', 'x1']) assertValid(validateTheme(mut('id', ok)), ok);
  for (const bad of ['a', '', 'a'.repeat(41), 'A', 'Cinema', 'has space', 'under_score', 'dot.dot', 'slash/slash', 'café', 'cinema\n', ' cinema', 'cinema ', '<b>', 'a;b', '../x',
    '__proto__', 'constructor', 'prototype', 123, null, true, ['cinema'], {}, 'a'.repeat(100000)]) {
    assertOnly(validateTheme(mut('id', bad)), 'id', String(bad).slice(0, 30));
  }
});

test('name and author: non-empty trimmed text, at most 64 characters, no control or direction-override characters', () => {
  for (const key of ['name', 'author']) {
    assert.equal(validateTheme(mut(key, '  Padded  ')).theme[key], 'Padded');
    assertValid(validateTheme(mut(key, 'x'.repeat(64))));
    assertValid(validateTheme(mut(key, 'シネマ \u{1F3AC}')));
    for (const bad of ['', '   ', '\t\n', 'x'.repeat(65), 'two\nlines', 'tab\there', 'nul\u0000', 'del\u007f', 'c1\u0085', 'rtl‮exe', 'iso⁦x', 'lrm‎', 5, null, true, ['a'], {}, 'x'.repeat(10 ** 6)]) {
      assertOnly(validateTheme(mut(key, bad)), key, `${key}=${String(bad).slice(0, 20)}`);
    }
  }
});

test('names carrying markup are kept as text (consumers must use textContent), never executed or rewritten', () => {
  const res = validateTheme(mut('name', '<img src=x onerror=alert(1)>'));
  assertValid(res);
  assert.equal(res.theme.name, '<img src=x onerror=alert(1)>');
});

test('version looks like semver: MAJOR.MINOR[.PATCH][-pre][+build]', () => {
  for (const ok of ['1.0.0', '0.1', '12.34.56', '1.0.0-beta.1', '2.0.0+build.5', '1.2.3-rc1+sha.abc', '999999.999999.999999']) assertValid(validateTheme(mut('version', ok)), ok);
  for (const bad of ['1', '1.', '.1', '1.0.0.0', 'v1.0.0', '1.0.0 ', ' 1.0.0', '', '1.x', 'a.b.c', '1.0.0-', '1.0.0+', '1.0.0-b a d', '1.0.0;', '-1.0.0', '1.0.0\n', 1, 1.5, null, ['1.0.0'],
    '1.0.0-' + 'a'.repeat(40), '1234567.0.0']) {
    assertOnly(validateTheme(mut('version', bad)), 'version', String(bad));
  }
});

test('tier is exactly free or pro', () => {
  assert.equal(validateTheme(mut('tier', 'pro')).theme.tier, 'pro');
  for (const bad of ['', 'Free', 'PRO', 'premium', 'free ', 'enterprise', 0, 1, null, true, ['pro'], {}]) assertOnly(validateTheme(mut('tier', bad)), 'tier', String(bad));
});

// ---- colours -----------------------------------------------------------------------------------

const COLOR_KEYS = ['bg', 'surface', 'text', 'muted', 'accent', 'border'];

test('colours: hex 3/6/8 digits, rgb(a) and hsl(a) are accepted, kept as written (trimmed)', () => {
  const good = ['#fff', '#FFF', '#0b0b0f', '#0B0B0F', '#0b0b0f80', '#FFFFFFFF', 'rgb(0,0,0)', 'rgb(0 0 0)', 'RGB(0, 0, 0)', 'rgba(0, 0, 0, 0.5)', 'rgba(0,0,0,.5)',
    'rgb(0 0 0 / 50%)', 'rgb(100% 0% 0%)', 'hsl(210, 50%, 40%)', 'hsl(210 50% 40% / .5)', 'hsla(0.5turn, 100%, 50%, 1)', 'hsl(180deg 100% 50%)', '  #fff  ', '\n#fff\t'];
  // This is about SYNTAX. Whether the colour reads on the others is the contrast rule's business (see "contrast is enforced"): so the only
  // thing asserted for every colour and key is that there is no syntax complaint at that path; when the theme is otherwise valid the value
  // must also come back exactly as written.
  let valid = 0;
  for (const c of good) {
    for (const key of COLOR_KEYS) {
      const res = validateTheme(mut(`tokens.color.${key}`, c));
      const syntax = res.errors.filter((e) => e.path === `tokens.color.${key}` && /^Must be a colour/.test(e.message));
      assert.deepEqual(syntax, [], `${key} = ${JSON.stringify(c)}`);
      if (res.ok) {
        valid++;
        assert.equal(res.theme.tokens.color[key], c.trim(), 'value is preserved, not rewritten');
      }
    }
  }
  assert.ok(valid > 40, `only ${valid} of the colour/key combinations were valid themes`);
});

test('colours: names, var(), url(), expressions, CSS injection and malformed values are errors', () => {
  const bad = [
    'red', 'Red', 'transparent', 'currentcolor', 'currentColor', 'inherit', 'initial', 'unset', 'revert', 'none', 'white', 'rebeccapurple',
    'var(--bg)', 'var(--bg, #fff)', 'url(x.png)', 'url(data:image/png;base64,AAAA)', 'expression(alert(1))', 'calc(1)', 'color-mix(in srgb, red, blue)', 'lab(50% 0 0)', 'color(srgb 1 0 0)', 'light-dark(#fff, #000)',
    '', ' ', '#', '#f', '#ff', '#ffff', '#fffff', '#fffffff', '#fffffffff', '#ggg', 'fff', '0b0b0f', '# fff',
    'rgb(0,0)', 'rgb(0,0,0,0,0)', 'rgb(256,0,0)', 'rgb(-1,0,0)', 'rgb(0,0,0,2)', 'rgb(50%, 0, 0)', 'rgb(NaN,0,0)', 'rgb(Infinity,0,0)', 'rgb(1e2,0,0)', 'hsl(0, 0, 0)', 'hsl(0, 101%, 50%)', 'rgb(var(--r),0,0)',
    '#fff;', '#fff; color: red', '#fff}', '#fff } body { display: none', '#fff !important', '#fff/**/', '/**/#fff', 'rgb(0,0,0);}', 'rgb(0,0,0) url(x)', '#fff\n;', '#fff\\', '\\#fff',
    '#fff ', ' #fff', '#fff\u0000', '＃fff', 'ﬀ',
    'x'.repeat(65), '#' + 'f'.repeat(10 ** 6), 'rgb(' + '1 '.repeat(100000) + ')',
    null, true, false, 0, 255, NaN, Infinity, {}, [], ['#fff'], () => '#fff', { r: 0, g: 0, b: 0 }, 10n,
  ];
  for (const key of COLOR_KEYS) {
    for (const c of bad) assertOnly(validateTheme(mut(`tokens.color.${key}`, c)), `tokens.color.${key}`, JSON.stringify(typeof c === 'string' ? c.slice(0, 40) : String(c)));
  }
});

test('colour errors explain what is allowed', () => {
  const res = validateTheme(mut('tokens.color.bg', 'red'));
  assert.match(res.errors[0].message, /#rgb/);
  assert.match(res.errors[0].message, /rgba?\(\)/);
  assert.match(res.errors[0].message, /hsla?\(\)/);
});

test('unknown colour keys are warnings and are dropped', () => {
  const t = mut('tokens.color.accentText', '#000');
  const res = validateTheme(t);
  assertValid(res);
  assert.deepEqual(paths(res.warnings), ['tokens.color.accentText']);
  assert.deepEqual(Object.keys(res.theme.tokens.color), COLOR_KEYS);
});

// ---- numbers -----------------------------------------------------------------------------------

test('numeric ranges: boundaries, integers, multiples, non-finite and non-number values', () => {
  const table = [
    // path, valid values, invalid values
    ['tokens.type.baseSize', [12, 14, 14.5, 20, 12.0001, 19.9999], [11.99, 11, 0, -0, -12, 20.01, 21, 1e9, '14', '', null, true, [14], {}, new Number(14), NaN, Infinity, -Infinity, 10n]],
    ['tokens.type.headingWeight', [100, 400, 700, 900], [0, 50, 99, 150, 450, 700.5, 800.0001, 901, 1000, -100, '700', null, true, NaN, Infinity, 1e21]],
    ['tokens.shape.radius', [0, 4, 10.5, 12, 32, 31.999], [-0.01, -1, 32.01, 33, 1e9, '10', '', null, false, [10], NaN, Infinity, -Infinity]],
    ['tokens.shape.spacing', [1, 2, 3, 4, 5], [0, 6, -1, 2.5, 3.0000001, 4.9999, '3', null, true, [3], NaN, Infinity, 1e9]],
    ['layout.density', [1, 2, 3, 4, 5], [0, 6, -1, 2.5, 3.0000001, '3', null, false, [3], NaN, Infinity, -Infinity]],
  ];
  for (const [path, good, bad] of table) {
    for (const v of good) assertValid(validateTheme(mut(path, v)), `${path} = ${v}`);
    for (const v of bad) assertOnly(validateTheme(mut(path, v)), path, `${path} = ${String(v)}`);
  }
});

test('negative zero is normalised to zero', () => {
  const res = validateTheme(mut('tokens.shape.radius', -0));
  assertValid(res);
  assert.ok(Object.is(res.theme.tokens.shape.radius, 0));
});

test('shadow must be a real boolean', () => {
  assert.equal(validateTheme(mut('tokens.shape.shadow', false)).theme.tokens.shape.shadow, false);
  for (const bad of ['true', 'false', 1, 0, null, [], {}, 'yes']) assertOnly(validateTheme(mut('tokens.shape.shadow', bad)), 'tokens.shape.shadow', String(bad));
});

test('layout menus accept exactly the constants', () => {
  for (const v of LAYOUT_HOME) assert.equal(validateTheme(mut('layout.home', v)).theme.layout.home, v);
  for (const v of LAYOUT_WATCH) assert.equal(validateTheme(mut('layout.watch', v)).theme.layout.watch, v);
  for (const bad of ['carousel', 'Grid', 'hero_rows', '', ' grid', 'cinema ', 'focus', null, 1, ['grid'], {}, 'toString']) assertOnly(validateTheme(mut('layout.home', bad)), 'layout.home', String(bad));
  for (const bad of ['theatre', 'Default', 'grid', '', null, 1, ['focus'], 'constructor']) assertOnly(validateTheme(mut('layout.watch', bad)), 'layout.watch', String(bad));
});

test('calm: booleans for known keys; unknown keys warn and are dropped; non-booleans are errors', () => {
  for (const key of CALM_KEYS) {
    for (const bad of ['true', 1, 0, null, [], {}, 'yes']) assertOnly(validateTheme(mut('calm', { [key]: bad })), `calm.${key}`, `${key}=${bad}`);
  }
  const res = validateTheme(mut('calm', { hideShorts: true, hideSidebar: true, constructorLike: 1 }));
  assertValid(res);
  assert.deepEqual(res.theme.calm, { hideShorts: true });
  assert.deepEqual(paths(res.warnings), ['calm.hideSidebar', 'calm.constructorLike']);
});

// ---- unknown keys ------------------------------------------------------------------------------

test('unknown top-level and nested keys are warnings with their path and never reach the normalised theme', () => {
  const t = spec();
  t.foo = { bar: 1 };
  t.extends = 'cinema';
  t.tokens.extra = 1;
  t.tokens.color.accentHover = '#fff';
  t.tokens.type.letterSpacing = 0.1;
  t.tokens.shape.blur = 4;
  t.layout.sidebar = 'left';
  t.calm.hideSidebar = true;
  const res = validateTheme(t);
  assertValid(res);
  assert.deepEqual(paths(res.warnings).sort(), [
    'calm.hideSidebar', 'extends', 'foo', 'layout.sidebar', 'tokens.color.accentHover', 'tokens.extra', 'tokens.shape.blur', 'tokens.type.letterSpacing',
  ]);
  assert.deepEqual(res.theme, SPEC_EXAMPLE);
  const json = JSON.stringify(res.theme);
  for (const needle of ['foo', 'extends', 'sidebar', 'blur', 'letterSpacing', 'accentHover', 'extra']) assert.ok(!json.includes(needle), needle);
  for (const w of res.warnings) assert.equal(typeof w.message, 'string');
});

test('unknown keys are never traversed (cycles, getters and huge values under them are harmless)', () => {
  const cyc = { n: 1 };
  cyc.self = cyc;
  const t = spec();
  t.cyc = cyc;
  t.big = 'x'.repeat(2 * 10 ** 6);
  Object.defineProperty(t, 'trap', { enumerable: true, configurable: true, get() { throw new Error('getter ran'); } });
  const res = validateTheme(t);
  assert.equal(res.ok, false, 'a getter anywhere is refused');
  assert.deepEqual(paths(res.errors), ['trap']);
  delete t.trap;
  const ok = validateTheme(t);
  assertValid(ok);
  assert.deepEqual(paths(ok.warnings).sort(), ['big', 'cyc']);
});

test('warnings and errors are capped so a hostile file cannot flood the UI', () => {
  const t = spec();
  for (let i = 0; i < 150; i++) t[`junk${i}`] = i;
  const res = validateTheme(t);
  assertValid(res);
  assert.equal(res.warnings.length, 51);
  assert.equal(res.warnings[50].path, '');
  assert.match(res.warnings[50].message, /Too many/);

  const bad = { schema: 1 };
  for (let i = 0; i < 150; i++) bad[`k${i}`] = i;
  const r2 = validateTheme(bad);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.length <= 51);
  assert.ok(r2.warnings.length <= 51);

  const many = {};
  for (let i = 0; i < 5000; i++) many[`k${i}`] = i;
  const r3 = validateTheme({ ...spec(), tokens: many });
  assertOnly(r3, 'tokens');
  assert.match(r3.errors[0].message, /too many keys/i);
});

// ---- prototype pollution -----------------------------------------------------------------------

test('__proto__ / constructor / prototype keys are refused at every level and pollute nothing', () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  const levels = ['', 'tokens', 'tokens.color', 'tokens.type', 'tokens.shape', 'layout', 'calm'];
  for (const level of levels) {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const payload = key === '__proto__' ? '{"polluted":"yes"}' : '{"prototype":{"polluted":"yes"}}';
      const base = JSON.stringify(spec());
      const doc = JSON.parse(base);
      let target = doc;
      for (const k of level ? level.split('.') : []) target = target[k];
      // JSON.parse (unlike assignment) creates a real own "__proto__" key
      const parsed = JSON.parse(`{"${key}": ${payload}}`);
      Object.defineProperty(target, key, { value: parsed[key], enumerable: true, configurable: true, writable: true });
      const res = validateTheme(doc);
      assert.equal(res.ok, false, `${level || 'root'}.${key}`);
      assert.equal(res.theme, null);
      assert.ok(paths(res.errors).includes(level ? `${level}.${key}` : key), `${level || 'root'}.${key}: ${JSON.stringify(res.errors)}`);
      assert.equal({}.polluted, undefined, 'Object.prototype was not touched');
    }
  }
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
});

test('the classic JSON.parse payloads are refused and the output never has own __proto__/constructor keys', () => {
  const docs = [
    `{"__proto__": {"isAdmin": true}, "schema": 1}`,
    `{"constructor": {"prototype": {"isAdmin": true}}, "schema": 1}`,
    JSON.stringify(spec()).replace('"tokens":', '"__proto__":{"isAdmin":true},"tokens":'),
    JSON.stringify(spec()).replace('"color":{', '"color":{"__proto__":{"isAdmin":true},'),
  ];
  for (const doc of docs) {
    const res = validateTheme(JSON.parse(doc));
    assert.equal(res.ok, false, doc.slice(0, 60));
    assert.equal({}.isAdmin, undefined);
    assert.equal(res.theme, null);
  }
  const ok = validateTheme(spec()).theme;
  for (const o of [ok, ok.tokens, ok.tokens.color, ok.tokens.type, ok.tokens.shape, ok.layout, ok.calm]) {
    assert.equal(Object.getPrototypeOf(o), Object.prototype);
    for (const k of ['__proto__', 'constructor', 'prototype']) assert.ok(!Object.hasOwn(o, k), k);
  }
});

test('values inherited from a polluted Object.prototype do not satisfy required fields', () => {
  const polluted = { tier: 'free', id: 'cinema', bg: '#000', family: 'Inter', css: 'a{}', schema: 1, tokens: spec().tokens };
  for (const [k, v] of Object.entries(polluted)) Object.defineProperty(Object.prototype, k, { value: v, configurable: true, writable: true, enumerable: false });
  try {
    const t = spec();
    delete t.tier; delete t.id; delete t.tokens.color.bg; delete t.tokens.type.family; delete t.css;
    const res = validateTheme(t);
    assert.equal(res.ok, false);
    assert.deepEqual(paths(res.errors).sort(), ['id', 'tier', 'tokens.color.bg', 'tokens.type.family']);
    // and optional fields are not conjured from the prototype either
    const t2 = spec();
    delete t2.css;
    assert.equal(validateTheme(t2).theme.css, '');
    const noSchema = spec();
    delete noSchema.schema;
    assertOnly(validateTheme(noSchema), 'schema');
  } finally {
    for (const k of Object.keys(polluted)) delete Object.prototype[k];
  }
});

test('accessor properties are refused without running them', () => {
  let ran = false;
  const t = spec();
  Object.defineProperty(t, 'tier', { enumerable: true, get() { ran = true; return 'free'; } });
  const res = validateTheme(t);
  assert.equal(res.ok, false);
  assert.equal(ran, false, 'getter must not run');
  assert.deepEqual(paths(res.errors), ['tier']);
  const nested = spec();
  Object.defineProperty(nested.tokens.color, 'bg', { enumerable: true, get() { ran = true; return '#000'; } });
  assertOnly(validateTheme(nested), 'tokens.color.bg');
  assert.equal(ran, false);
  const s = { get schema() { ran = true; return 1; } };
  const m = migrateTheme(s);
  assert.equal(m.ok, false);
  assert.equal(ran, false);
});

// ---- migration ---------------------------------------------------------------------------------

test('LATEST_SCHEMA is 1 and migration of v1 is the identity', () => {
  assert.equal(LATEST_SCHEMA, 1);
  const input = spec();
  const res = migrateTheme(input);
  assert.equal(res.ok, true);
  assert.equal(res.theme, input, 'same object: nothing to migrate');
  assert.deepEqual(res.errors, []);
  assert.deepEqual(input, SPEC_EXAMPLE);
});

test('a missing schema is an error at path "schema"', () => {
  const t = mut('schema', undefined);
  for (const res of [migrateTheme(t), validateTheme(t)]) {
    assert.equal(res.ok, false);
    assert.deepEqual(paths(res.errors), ['schema']);
    assert.match(res.errors[0].message, /schema/i);
  }
  assert.equal(migrateTheme(t).theme, null);
});

test('a schema newer than this version says it was made for a newer version of Cinedrape, and nothing else', () => {
  for (const schema of [2, 3, 99, 2 ** 31, Number.MAX_SAFE_INTEGER, 1e21]) {
    for (const res of [migrateTheme({ schema }), validateTheme({ schema }), validateTheme({ ...spec(), schema }), validateTheme({ schema, anything: ['at', 'all'], tokens: 5 })]) {
      assert.equal(res.ok, false, String(schema));
      assert.equal(res.errors.length, 1, 'no cascade of errors about a shape this version does not know');
      assert.equal(res.errors[0].path, 'schema');
      assert.match(res.errors[0].message, /made for a newer version of Cinedrape/);
      assert.equal(res.theme, null);
    }
  }
});

test('an invalid schema value is an error, but not the "newer version" one', () => {
  for (const schema of [0, -1, 1.5, 0.5, '1', '', null, true, false, NaN, Infinity, -Infinity, [], [1], {}, 1n]) {
    const res = validateTheme(mut('schema', schema));
    assertOnly(res, 'schema', String(schema));
    assert.doesNotMatch(res.errors[0].message, /newer version/);
  }
});

test('migrateTheme never throws and refuses non-objects at the root', () => {
  for (const input of [undefined, null, 5, 'x', [], [{ schema: 1 }], new Map(), () => 1, new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('x'); } })]) {
    let res;
    assert.doesNotThrow(() => { res = migrateTheme(input); });
    assert.equal(res.ok, false);
    assert.deepEqual(paths(res.errors), ['']);
  }
});

test('the normalised theme reports the latest schema', () => {
  assert.equal(validateTheme(spec()).theme.schema, LATEST_SCHEMA);
});

// ---- css: size ---------------------------------------------------------------------------------

test('utf8ByteLength matches TextEncoder, including surrogate pairs and lone surrogates', () => {
  const enc = new TextEncoder();
  const samples = ['', 'a', 'abc', 'é', '€', '\u{1F3AC}', 'a\u{1F3AC}b', '\ud800', '\udc00', 'x\ud800', '\ud800x', '\udc00\ud800', '\ud83c', '\u{10FFFF}', '\u0000\u007f\u0080߿ࠀ￿'];
  let seed = 5;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed; };
  for (let i = 0; i < 300; i++) {
    let s = '';
    for (let j = 0; j < 40; j++) s += String.fromCharCode(rnd() % 4 === 0 ? 0xd800 + (rnd() % 0x800) : rnd() % 0x10000);
    samples.push(s);
  }
  for (const s of samples) assert.equal(utf8ByteLength(s), enc.encode(s).length, JSON.stringify(s));
});

test('css is limited to LIMITS.cssMaxBytes of UTF-8, counted in bytes not characters', () => {
  const max = LIMITS.cssMaxBytes;
  assert.equal(max, 20480);
  const cases = [
    ['ascii at the limit', 'a'.repeat(max), true],
    ['ascii one over', 'a'.repeat(max + 1), false],
    ['2-byte chars at the limit', 'é'.repeat(max / 2), true],
    ['2-byte chars one char over', 'é'.repeat(max / 2 + 1), false],
    ['3-byte chars: 6826 = 20478 bytes', '€'.repeat(6826), true],
    ['3-byte chars: 6827 = 20481 bytes', '€'.repeat(6827), false],
    ['4-byte emoji at the limit', '\u{1F3AC}'.repeat(max / 4), true],
    ['4-byte emoji one over', '\u{1F3AC}'.repeat(max / 4 + 1), false],
    ['lone surrogates count 3 bytes each', '\ud800'.repeat(6827), false],
    ['empty', '', true],
  ];
  for (const [label, css, ok] of cases) {
    const res = validateTheme(mut('css', css));
    if (ok) {
      assertValid(res, label);
      assert.equal(res.theme.css, css, label);
    } else {
      assertOnly(res, 'css', label);
      assert.match(res.errors[0].message, /20480 bytes/);
    }
  }
  assertOnly(validateTheme(mut('css', 'a'.repeat(2 * 10 ** 7))), 'css', 'huge');
});

test('css must be a string', () => {
  for (const bad of [0, 1, null, true, [], ['a{}'], {}, () => '', 10n]) assertOnly(validateTheme(mut('css', bad)), 'css', String(bad));
});

test('without a selector map the CSS is kept as written but flagged unvalidated', () => {
  const css = '.cd-hero h1 { letter-spacing: -0.02em; }\n@import url(http://evil.example/x.css);';
  const res = validateTheme(mut('css', css));
  assertValid(res);
  assert.equal(res.theme.css, css, 'schema alone does not judge CSS rules');
  assert.equal(res.cssValidated, false);
});

// ---- css: delegation to the validator (injected fakes keep this file independent) ---------------

const fakeTools = (impl) => {
  const calls = [];
  return {
    calls,
    tools: {
      buildAllowList: (map) => { calls.push(['allow', map]); return { fake: 'allow-list' }; },
      validateCss: (css, ctx) => { calls.push(['validate', css, ctx]); return impl(css, ctx); },
    },
  };
};

test('with a selector map the CSS goes to the validator with an allow-list and the protected selectors', () => {
  const { tools, calls } = fakeTools(() => ({ ok: true, errors: [] }));
  const res = validateTheme(spec(), { selectorMap: REAL_MAP, cssValidator: tools });
  assertValid(res);
  assert.equal(res.cssValidated, true);
  assert.deepEqual(calls.map((c) => c[0]), ['allow', 'validate']);
  assert.equal(calls[0][1], REAL_MAP);
  assert.equal(calls[1][1], SPEC_EXAMPLE.css);
  const ctx = calls[1][2];
  assert.deepEqual(ctx.allowList, { fake: 'allow-list' });
  const expected = [...REAL_MAP.protected.ads, ...REAL_MAP.protected.sponsor, ...REAL_MAP.protected.playerControls];
  assert.deepEqual(ctx.protectedSelectors, expected, 'ads + sponsor + player controls, from the real map');
  assert.ok(ctx.protectedSelectors.includes('.ytp-paid-content-overlay'));
  assert.ok(ctx.protectedSelectors.includes('#masthead-ad'));
  assert.ok(ctx.protectedSelectors.includes('.ytp-chrome-bottom'));
});

test('validator errors surface at path "css" with their line and column, and the message names the line', () => {
  const { tools } = fakeTools(() => ({
    ok: false,
    errors: [{ line: 3, column: 5, message: '@import is not allowed' }, { line: 12, column: 1, message: 'selector not in the map' }],
  }));
  const res = validateTheme(mut('css', 'a {}\n\n@import "x";\n'), { selectorMap: REAL_MAP, cssValidator: tools });
  assert.equal(res.ok, false);
  assert.equal(res.theme, null);
  assert.equal(res.cssValidated, true);
  assert.deepEqual(res.errors, [
    { path: 'css', message: 'Line 3: @import is not allowed', line: 3, column: 5 },
    { path: 'css', message: 'Line 12: selector not in the map', line: 12, column: 1 },
  ]);
});

test('validator problems without a usable line still become errors', () => {
  const run = (errors) => validateTheme(mut('css', 'a {}'), {
    selectorMap: REAL_MAP,
    cssValidator: fakeTools(() => ({ ok: false, errors })).tools,
  });
  const res = run([{ message: 'no position' }, { line: 0, message: 'zero' }, { line: 1.5, message: 'frac' }, { line: '4', message: 'string' }, null, 'junk', {}]);
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 7);
  assert.ok(res.errors.every((e) => e.path === 'css' && e.line === undefined && !('line' in e)));
  assert.equal(res.errors[0].message, 'no position');
  assert.ok(res.errors.every((e) => typeof e.message === 'string' && e.message.length));
  for (const errors of [[], undefined, null, 'x']) {
    const r = run(errors);
    assert.equal(r.ok, false, 'ok:false with no details is still a refusal');
    assert.deepEqual(paths(r.errors), ['css']);
  }
});

test('the validator fails closed: crashes, bad return values and unusable maps refuse the theme', () => {
  const css = mut('css', 'a {}');
  const throwing = { buildAllowList: () => ({}), validateCss: () => { throw new Error('boom'); } };
  const badMap = { buildAllowList: () => { throw new TypeError('not a map'); }, validateCss: () => ({ ok: true, errors: [] }) };
  assertOnly(validateTheme(css, { selectorMap: REAL_MAP, cssValidator: throwing }), 'css', 'validator throws');
  assertOnly(validateTheme(css, { selectorMap: {}, cssValidator: badMap }), 'css', 'allow-list throws');
  for (const ret of [undefined, null, 'ok', 0, true]) {
    const tools = fakeTools(() => ret).tools;
    assertOnly(validateTheme(css, { selectorMap: REAL_MAP, cssValidator: tools }), 'css', `returned ${String(ret)}`);
  }
  // ok must be exactly true: truthy lookalikes do not pass
  for (const ok of [1, 'true', {}, [], undefined]) {
    const tools = fakeTools(() => ({ ok, errors: [] })).tools;
    assert.equal(validateTheme(css, { selectorMap: REAL_MAP, cssValidator: tools }).ok, false, String(ok));
  }
});

test('empty css skips the validator but still counts as validated; absent map skips it and does not', () => {
  const { tools, calls } = fakeTools(() => ({ ok: true, errors: [] }));
  const empty = validateTheme(mut('css', ''), { selectorMap: REAL_MAP, cssValidator: tools });
  assertValid(empty);
  assert.equal(empty.cssValidated, true);
  const none = validateTheme(mut('css', undefined), { selectorMap: REAL_MAP, cssValidator: tools });
  assertValid(none);
  assert.equal(none.cssValidated, true);
  assert.equal(calls.length, 0, 'nothing to validate');
  for (const selectorMap of [undefined, null]) {
    const r = validateTheme(spec(), { selectorMap, cssValidator: tools });
    assertValid(r);
    assert.equal(r.cssValidated, false);
  }
  assert.equal(validateTheme(spec(), undefined).cssValidated, false);
  assert.equal(validateTheme(spec(), null).cssValidated, false);
  assert.equal(validateTheme(spec(), 'map').cssValidated, false);
  assert.equal(calls.length, 0);
});

test('CSS errors are reported alongside schema errors in one pass; oversize CSS never reaches the validator', () => {
  const { tools, calls } = fakeTools(() => ({ ok: false, errors: [{ line: 1, column: 1, message: 'bad' }] }));
  const t = mut('tier', 'gold', mut('css', 'x{}'));
  const res = validateTheme(t, { selectorMap: REAL_MAP, cssValidator: tools });
  assert.deepEqual(paths(res.errors).sort(), ['css', 'tier']);
  calls.length = 0;
  const big = validateTheme(mut('css', 'a'.repeat(LIMITS.cssMaxBytes + 1)), { selectorMap: REAL_MAP, cssValidator: tools });
  assertOnly(big, 'css');
  assert.equal(calls.length, 0);
});

test('a flood of CSS errors is capped', () => {
  const errors = Array.from({ length: 500 }, (_, i) => ({ line: i + 1, column: 1, message: 'bad' }));
  const { tools } = fakeTools(() => ({ ok: false, errors }));
  const res = validateTheme(spec(), { selectorMap: REAL_MAP, cssValidator: tools });
  assert.equal(res.errors.length, 51);
  assert.equal(res.errors[0].line, 1);
});

// ---- css: the real validator (written by another module; this is the integration seam) ---------

test('integration: the real CSS validator accepts the spec example CSS and refuses a bad rule with its line', () => {
  const good = validateTheme(spec(), { selectorMap: REAL_MAP });
  assertValid(good, 'spec example CSS must pass the real validator');
  assert.equal(good.cssValidated, true);

  const bad = validateTheme(mut('css', '.cd-hero { color: red; }\n\n@import url("https://evil.example/x.css");\n.cd-row { gap: 4px; }'), { selectorMap: REAL_MAP });
  assert.equal(bad.ok, false);
  assert.equal(bad.theme, null);
  const cssErrors = bad.errors.filter((e) => e.path === 'css');
  assert.ok(cssErrors.length >= 1, JSON.stringify(bad.errors));
  assert.ok(cssErrors.some((e) => e.line === 3), `an error names line 3: ${JSON.stringify(cssErrors)}`);
  assert.ok(cssErrors.every((e) => /^Line \d+: /.test(e.message)), JSON.stringify(cssErrors));
});

test('integration: theme CSS that hides an ad or the player controls is refused (contract §6)', () => {
  for (const css of [
    '#masthead-ad { display: none; }',
    '.ytp-paid-content-overlay { visibility: hidden; }',
    '.ytp-chrome-bottom { opacity: 0; }',
    'ytd-ad-slot-renderer { height: 0; }',
  ]) {
    const res = validateTheme(mut('css', css), { selectorMap: REAL_MAP });
    assert.equal(res.ok, false, css);
    assert.ok(res.errors.some((e) => e.path === 'css' && e.line === 1), `${css}: ${JSON.stringify(res.errors)}`);
  }
});

// ---- performance guards ------------------------------------------------------------------------

test('hostile huge or pathological strings are rejected quickly (no catastrophic regex or scan)', () => {
  const started = performance.now();
  const huge = 'a'.repeat(5 * 10 ** 6);
  const t = spec();
  t.name = huge;
  t.author = huge;
  t.id = huge;
  t.version = huge;
  t.tokens.color.bg = huge;
  t.tokens.color.text = `rgb(${'1 '.repeat(500000)})`;
  t.tokens.color.muted = `#${'f'.repeat(500000)}`;
  t.css = huge;
  const res = validateTheme(t);
  assert.equal(res.ok, false);
  assert.deepEqual(paths(res.errors).sort(), ['author', 'css', 'id', 'name', 'tokens.color.bg', 'tokens.color.muted', 'tokens.color.text', 'version']);
  assert.ok(performance.now() - started < 1500, `took ${performance.now() - started} ms`);
});

// ---- contrast is enforced (ad-safety review finding 4) ------------------------------------------------------------------------------
// The theme's colours become --cd-text / --cd-muted / --cd-bg and are bridged onto YouTube's own text and background variables, so a
// theme whose text equals its background would make ad titles and the "Sponsored" label unreadable without a single line of CSS.

test('contrast is enforced: text, muted and bg are opaque, text/muted/bg and accent/border/bg meet WCAG AA, accent reads on the surface', () => {
  const bg = SPEC_EXAMPLE.tokens.color.bg;
  assertOnly(validateTheme(mut('tokens.color.text', bg)), 'tokens.color.text', 'text == bg');
  assertOnly(validateTheme(mut('tokens.color.muted', bg)), 'tokens.color.muted', 'muted == bg');
  assertOnly(validateTheme(mut('tokens.color.border', bg)), 'tokens.color.border', 'border == bg');
  assertOnly(validateTheme(mut('tokens.color.accent', bg)), 'tokens.color.accent', 'accent == bg');
  assertOnly(validateTheme(mut('tokens.color.text', '#00000000')), 'tokens.color.text', 'transparent text');
  assertOnly(validateTheme(mut('tokens.color.text', 'rgba(242,242,245,0.5)')), 'tokens.color.text', 'half transparent text');
  assertOnly(validateTheme(mut('tokens.color.muted', 'hsla(240,10%,70%,0.9)')), 'tokens.color.muted', 'translucent muted');
  const translucent = validateTheme(mut('tokens.color.bg', '#0b0b0f80'));   // other pairs fail too, over a white or a black canvas
  assert.equal(translucent.ok, false);
  assert.ok(translucent.errors.some((e) => e.path === 'tokens.color.bg' && /fully opaque/.test(e.message)));
  // a light theme with light text, a dark one with dark text
  const light = mut('tokens.color.bg', '#ffffff');
  assert.equal(validateTheme(light).ok, false);
  const r = validateTheme(mut('tokens.color.text', '#6b6b72'));
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /Contrast of text on bg|Contrast of text on surface/);
  assert.match(r.errors[0].message, /at least 4\.5:1/);
  // the boundaries: 4.5 passes, a hair below does not
  const edge = (hex) => validateTheme(mut('tokens.color.muted', hex)).ok;
  assert.equal(edge('#9a9aa8'), true);
  assert.equal(edge('#33333c'), false);
  // accent must also read on the card surface (3:1)
  const t = mut('tokens.color.surface', '#e8b04a');
  assert.equal(validateTheme(t).ok, false);
  assert.ok(validateTheme(t).errors.some((e) => e.path === 'tokens.color.accent' || e.path === 'tokens.color.text' || e.path === 'tokens.color.muted'));
});

test('contrast is enforced independently of the css: a theme with no css at all is still refused', () => {
  const t = spec();
  t.css = '';
  t.tokens.color.text = t.tokens.color.bg;
  const res = validateTheme(t, { selectorMap: REAL_MAP });
  assert.equal(res.ok, false);
  assert.equal(res.theme, null);
  assert.ok(res.errors.some((e) => e.path === 'tokens.color.text'));
});

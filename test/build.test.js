import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GZIP_BUDGET_BYTES, codeMask, findForbidden, main } from '../build.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- forbidden-construct scanner ----------------------------------------------------------------

const kinds = (src) => findForbidden(src).violations.map((v) => v.kind);

test('scanner flags eval( and new Function in code', () => {
  assert.deepEqual(kinds('var r = eval("1+1");'), ['eval(']);
  assert.deepEqual(kinds('window.eval (x)'), ['eval(']);
  assert.deepEqual(kinds('var f = new Function("a", "return a");'), ['new Function']);
  assert.deepEqual(kinds('var f = Function("return this")();'), ['Function(']);
  assert.deepEqual(kinds('a=1;eval(b)'), ['eval(']);
});

test('scanner flags indirect eval that is not written as eval(', () => {
  assert.deepEqual(kinds('var r = (0, eval)("1+1");'), ['eval (indirect)']);
  assert.deepEqual(kinds('var r=(0,eval)("1")'), ['eval (indirect)']);
  assert.deepEqual(kinds('var e = eval; e("1");'), ['eval (indirect)']);
  assert.deepEqual(kinds('setTimeout(eval, 0)'), ['eval (indirect)']);
  assert.deepEqual(kinds('var s = "(0, eval)(x)"; // (0, eval)(y)\nvar r = /(0,eval)/;'), []);
});

test('scanner does not flag look-alike identifiers', () => {
  assert.deepEqual(kinds('retrieval(1); evaluate(2); myeval(3); $eval(4); x.reeval(5);'), []);
  assert.deepEqual(kinds('class FunctionX {} new FunctionX(); typeof Function === "function";'), []);
});

test('scanner ignores matches inside strings, comments, template text and regexes', () => {
  const src = [
    'var a = "do not eval(x)";',
    "var b = 'new Function';",
    '// eval(1)',
    '/* new Function("x") */',
    'var c = `text eval(1) text`;',
    'var d = /eval\\(/;',
  ].join('\n');
  const { violations, ignored, lexerReliable } = findForbidden(src);
  assert.equal(lexerReliable, true);
  assert.deepEqual(violations, []);
  assert.equal(ignored.length, 6);      // the regex literal /eval\(/ also trips the bare-`eval` pattern
});

test('scanner still flags code inside template substitutions', () => {
  assert.deepEqual(kinds('var s = `a ${eval("1")} b`;'), ['eval(']);
  assert.deepEqual(kinds('var s = `a ${`b ${eval(1)}`} c`;'), ['eval(']);
  assert.deepEqual(kinds('var s = `eval( ${x} eval(`;'), []);
});

test('lexer stays in sync across regex literals containing quotes, and division', () => {
  assert.deepEqual(kinds('if (/["\']/.test(a)) eval(b);'), ['eval(']);
  assert.deepEqual(kinds('var q = a / b; var r = c / d; eval(e);'), ['eval(']);
  assert.deepEqual(kinds('x = y / 2; s = "eval("; eval(1);').length, 1);
  assert.deepEqual(kinds('var re = /[/"]/g; eval(1);'), ['eval(']);
  assert.deepEqual(kinds('var n = i++ / 2; eval(1);'), ['eval(']);
  assert.deepEqual(kinds('return /x/.test(y) ? eval(1) : 0'), ['eval(']);
});

test('unreliable lexing falls back to counting every raw match', () => {
  const src = 'var s = "unterminated eval(1)\n';
  const result = findForbidden(src);
  assert.equal(result.lexerReliable, false);
  assert.equal(result.violations.length, 1);
  assert.equal(codeMask('foo(').reliable, false);
});

test('scanner reports 1-based line numbers', () => {
  const v = findForbidden('a();\nb();\n  eval(c);\n').violations[0];
  assert.equal(v.line, 3);
});

test('lexer is reliable on a real esbuild-minified bundle', async () => {
  const { build } = await import('esbuild');
  const entry = join(REPO, 'build.mjs');
  const out = await build({
    entryPoints: [entry], bundle: true, minify: true, write: false, platform: 'node', format: 'esm',
    external: ['esbuild'], logLevel: 'silent',
  });
  const result = findForbidden(out.outputFiles[0].text);
  assert.equal(result.lexerReliable, true);
  assert.deepEqual(result.violations.map((v) => v.snippet), []);
});

// ---- build.mjs end to end against throwaway projects -------------------------------------------

function makeProject(files = {}, { complete = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cinedrape-build-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.2.3' }));
  cpSync(join(REPO, 'manifest.json'), join(dir, 'manifest.json'));
  cpSync(join(REPO, 'icons'), join(dir, 'icons'), { recursive: true });
  const base = complete ? {
    'src/content/index.js': 'window.__cd = 1;',
    'src/background/service-worker.js': 'self.__sw = 1;',
    'src/popup/popup.js': 'window.__popup = 1;',
    'src/popup/popup.html': '<!doctype html><title>x</title>',
    'src/popup/popup.css': 'body{margin:0}',
    'src/data/selector-map.signed.json': '{"payload":"{}","sig":"","kid":"k"}',
  } : {};
  for (const [path, content] of Object.entries({ ...base, ...files })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

async function runBuild(dir, argv = []) {
  const out = [];
  const errs = [];
  const code = await main(argv, {}, { root: dir, log: (s) => out.push(s), logError: (s) => errs.push(s) });
  return { code, out: out.join('\n'), errs: errs.join('\n') };
}

const withProject = async (files, opts, fn) => {
  const dir = makeProject(files, opts);
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('budget constant matches the contract (150 KB gzipped)', () => {
  assert.equal(GZIP_BUDGET_BYTES, 150 * 1024);
});

test('a complete project builds in strict mode and produces every artifact', async () => {
  await withProject({}, {}, async (dir) => {
    const r = await runBuild(dir, ['--strict']);
    assert.equal(r.code, 0, r.errs);
    for (const f of ['content.js', 'service-worker.js', 'popup/popup.js', 'popup/popup.html', 'popup/popup.css',
      'data/selector-map.json', 'manifest.json', 'icons/icon-16.png', 'icons/icon-128.png']) {
      assert.ok(existsSync(join(dir, 'dist', f)), `dist/${f}`);
    }
    assert.match(r.out, /content\.js gzip: \d+ bytes/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'dist/manifest.json'), 'utf8')).version, '1.2.3');
    assert.match(readFileSync(join(dir, 'dist/content.js'), 'utf8'), /^\(\(\)=>\{|^\(function/, 'content script is an IIFE');
  });
});

test('missing entry points are SKIPped normally and fatal under --strict', async () => {
  await withProject({}, { complete: false }, async (dir) => {
    const normal = await runBuild(dir);
    assert.equal(normal.code, 0, normal.errs);
    assert.match(normal.out, /SKIP content\.js \(not written yet\)/);
    assert.match(normal.out, /SKIP popup\/popup\.html \(not written yet\)/);
    assert.match(normal.out, /Build OK with \d+ SKIP/);

    const strict = await runBuild(dir, ['--strict']);
    assert.equal(strict.code, 1);
    assert.match(strict.errs, /missing entry point src\/content\/index\.js/);
  });
});

test('__DEV__ is false and its code stripped in production, true with --dev', async () => {
  const content = [
    'if (__DEV__) { window.__marker = "DEV_ONLY_MARKER"; }',
    'window.__flag = typeof __DEV__ !== "undefined" && __DEV__;',
  ].join('\n');
  await withProject({ 'src/content/index.js': content }, {}, async (dir) => {
    assert.equal((await runBuild(dir)).code, 0);
    const prod = readFileSync(join(dir, 'dist/content.js'), 'utf8');
    assert.ok(!prod.includes('DEV_ONLY_MARKER'));
    assert.ok(!prod.includes('__DEV__'));
    assert.equal(JSON.parse(readFileSync(join(dir, 'dist/manifest.json'), 'utf8')).version_name, undefined);

    assert.equal((await runBuild(dir, ['--dev'])).code, 0);
    const dev = readFileSync(join(dir, 'dist/content.js'), 'utf8');
    assert.ok(dev.includes('DEV_ONLY_MARKER'));
    assert.equal(JSON.parse(readFileSync(join(dir, 'dist/manifest.json'), 'utf8')).version_name, '1.2.3-dev');

    const viaEnv = [];
    const code = await main([], { CINEDRAPE_DEV: '1' }, { root: dir, log: (s) => viaEnv.push(s), logError: () => {} });
    assert.equal(code, 0);
    assert.ok(readFileSync(join(dir, 'dist/content.js'), 'utf8').includes('DEV_ONLY_MARKER'));
  });
});

test('JSON imports are bundled', async () => {
  await withProject({
    'src/data/thing.json': '{"name":"from-json"}',
    'src/content/index.js': 'import thing from "../data/thing.json"; window.__n = thing.name;',
  }, {}, async (dir) => {
    assert.equal((await runBuild(dir)).code, 0);
    assert.match(readFileSync(join(dir, 'dist/content.js'), 'utf8'), /from-json/);
  });
});

test('build fails when shipped code calls eval or new Function', async () => {
  for (const [src, kind] of [
    ['window.x = eval("1+1");', 'eval('],
    ['window.x = new Function("return 1")();', 'new Function'],
  ]) {
    await withProject({ 'src/content/index.js': src }, {}, async (dir) => {
      const r = await runBuild(dir);
      assert.equal(r.code, 1, r.out);
      assert.match(r.errs, /BUILD FAILED/);
      assert.ok(r.errs.includes(`forbidden "${kind}"`), r.errs);
      assert.match(r.errs, /dist\/content\.js:\d+/);
    });
  }
  await withProject({ 'src/popup/popup.js': 'window.x = eval("1");' }, {}, async (dir) => {
    const r = await runBuild(dir);
    assert.equal(r.code, 1);
    assert.match(r.errs, /dist\/popup\/popup\.js/);
  });
});

test('eval( that only appears inside a string literal is reported but allowed', async () => {
  await withProject({ 'src/content/index.js': 'window.msg = "never call eval(x) or new Function here";' }, {}, async (dir) => {
    const r = await runBuild(dir);
    assert.equal(r.code, 0, r.errs);
    assert.match(r.out, /only inside a string\/comment, ignored/);
    assert.match(r.out, /2 string-only match/);
  });
});

test('content.js over 150 KB gzipped fails the build; just under passes', async () => {
  const over = randomBytes(170_000).toString('base64');
  await withProject({ 'src/content/index.js': `window.__blob = "${over}";` }, {}, async (dir) => {
    const r = await runBuild(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /OVER BUDGET/);
    assert.match(r.errs, /over the 153600 byte budget/);
  });
  const under = randomBytes(60_000).toString('base64');
  await withProject({ 'src/content/index.js': `window.__blob = "${under}";` }, {}, async (dir) => {
    const r = await runBuild(dir);
    assert.equal(r.code, 0, r.errs);
    assert.match(r.out, /content\.js gzip: \d+ bytes .* OK/);
  });
});

test('esbuild errors fail the build with a readable message instead of throwing', async () => {
  await withProject({ 'src/content/index.js': 'import "./not-written-yet.js";' }, {}, async (dir) => {
    const r = await runBuild(dir);
    assert.equal(r.code, 1);
    assert.match(r.errs, /esbuild failed for src\/content\/index\.js/);
    assert.match(r.errs, /not-written-yet/);
  });
});

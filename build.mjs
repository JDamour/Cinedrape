// Cinedrape build: esbuild JS API -> dist/. See docs/ARCHITECTURE.md §5.
//
//   node build.mjs            normal build; missing entry points / optional inputs are SKIPped
//   node build.mjs --strict   anything missing fails the build
//   node build.mjs --dev      defines __DEV__ = true (also CINEDRAPE_DEV=1); unminified popup + worker
//
// Source code should read the flag as `typeof __DEV__ !== 'undefined' && __DEV__` so that the same
// module still imports under node:test, where nothing defines it.
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const GZIP_BUDGET_BYTES = 150 * 1024;

// ---------------------------------------------------------------------------
// Forbidden-construct scan (no eval, no new Function in anything we ship)
// ---------------------------------------------------------------------------

const FORBIDDEN = [
  { name: 'eval(', re: /(?<![\w$])eval\s*\(/g },
  { name: 'new Function', re: /new\s+Function(?![\w$])/g },
  { name: 'Function(', re: /(?<![\w$.])(?<!new\s+)Function\s*\(/g },
  // A bare `eval` that is not directly called: `(0, eval)(x)` (what esbuild emits for indirect eval), `var e = eval`.
  { name: 'eval (indirect)', re: /(?<![\w$.])eval(?![\w$])(?!\s*\()/g },
];

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do',
  'else', 'yield', 'await',
]);

/**
 * Lexes JavaScript just far enough to know which characters are executable code, as opposed to
 * part of a string, template text, comment or regex literal. Returns `reliable: false` when the
 * lexer ended in an inconsistent state (unterminated token, unbalanced brackets), in which case
 * the caller must not trust the mask.
 * @param {string} src
 * @returns {{ code: Uint8Array, reliable: boolean }}
 */
export function codeMask(src) {
  const n = src.length;
  const code = new Uint8Array(n);
  const brackets = [];            // stack of '(' '[' '{' and 'T' for template-expression openers
  let i = 0;
  let prev = null;                // {kind:'id'|'num'|'punct'|'str'|'regex'|'post', value}
  let reliable = true;

  const mark = (from, to) => { for (let k = from; k < to; k++) code[k] = 1; };
  const isIdStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$'
    || c.charCodeAt(0) > 127;
  const isIdPart = (c) => isIdStart(c) || (c >= '0' && c <= '9');

  // Reads template text starting after a backtick or after the closing brace of `${...}`.
  // Returns true if a `${` was hit (code resumes), false if the template closed.
  const readTemplateText = () => {
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i++; return false; }
      if (c === '$' && src[i + 1] === '{') { i += 2; brackets.push('T'); return true; }
      i++;
    }
    reliable = false;
    return false;
  };

  while (i < n) {
    const c = src[i];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      mark(i, i + 1); i++; continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) { reliable = false; break; }
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') i++;
        else if (src[i] === '\n') { reliable = false; break; }
        i++;
      }
      if (i >= n) { reliable = false; break; }
      i++;
      prev = { kind: 'str' };
      continue;
    }
    if (c === '`') {
      i++;
      if (readTemplateText()) prev = { kind: 'punct', value: '${' };
      else prev = { kind: 'str' };
      continue;
    }
    if (c === '/') {
      const regexAllowed = prev === null
        || (prev.kind === 'punct' && prev.value !== ')' && prev.value !== ']' && prev.value !== '}')
        || (prev.kind === 'id' && REGEX_PRECEDING_KEYWORDS.has(prev.value));
      if (regexAllowed) {
        i++;
        let inClass = false;
        while (i < n) {
          const r = src[i];
          if (r === '\\') { i += 2; continue; }
          if (r === '\n') { reliable = false; break; }
          if (r === '[') inClass = true;
          else if (r === ']') inClass = false;
          else if (r === '/' && !inClass) break;
          i++;
        }
        if (i >= n) { reliable = false; break; }
        i++;
        while (i < n && isIdPart(src[i])) i++;      // flags
        prev = { kind: 'regex' };
        continue;
      }
      mark(i, i + 1); i++;
      prev = { kind: 'punct', value: '/' };
      continue;
    }
    if (isIdStart(c)) {
      const start = i;
      while (i < n && isIdPart(src[i])) i++;
      mark(start, i);
      prev = { kind: 'id', value: src.slice(start, i) };
      continue;
    }
    if (c >= '0' && c <= '9') {
      const start = i;
      while (i < n && /[\w.]/.test(src[i])) {
        // 1e+5 / 0x1f: keep an exponent sign with its number
        if ((src[i] === 'e' || src[i] === 'E') && (src[i + 1] === '+' || src[i + 1] === '-')
          && !(src[start] === '0' && (src[start + 1] === 'x' || src[start + 1] === 'X'))) i++;
        i++;
      }
      mark(start, i);
      prev = { kind: 'num' };
      continue;
    }

    // punctuation
    mark(i, i + 1);
    if (c === '(' || c === '[' || c === '{') {
      brackets.push(c);
      prev = { kind: 'punct', value: c };
      i++;
      continue;
    }
    if (c === ')' || c === ']') {
      const open = brackets.pop();
      if (open !== (c === ')' ? '(' : '[')) { reliable = false; break; }
      prev = { kind: 'punct', value: c };
      i++;
      continue;
    }
    if (c === '}') {
      const open = brackets.pop();
      if (open === 'T') {            // end of ${ ... } inside a template literal
        i++;
        if (readTemplateText()) prev = { kind: 'punct', value: '${' };
        else prev = { kind: 'str' };
        continue;
      }
      if (open !== '{') { reliable = false; break; }
      prev = { kind: 'punct', value: '}' };
      i++;
      continue;
    }
    if ((c === '+' || c === '-') && src[i + 1] === c) {
      mark(i + 1, i + 2);
      prev = { kind: 'post' };       // x++ / 2 is a division
      i += 2;
      continue;
    }
    prev = { kind: 'punct', value: c };
    i++;
  }
  if (brackets.length) reliable = false;
  return { code, reliable };
}

/**
 * Finds eval( / new Function in JavaScript source. Matches inside string literals, template text,
 * comments or regex literals are ignored when the lexer is reliable; otherwise every raw match
 * counts.
 * @param {string} src
 * @returns {{ violations: {kind:string, index:number, line:number, snippet:string}[],
 *             ignored: {kind:string, index:number, line:number, snippet:string}[],
 *             lexerReliable: boolean }}
 */
export function findForbidden(src) {
  const { code, reliable } = codeMask(src);
  const violations = [];
  const ignored = [];
  for (const { name, re } of FORBIDDEN) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const index = m.index;
      const line = src.slice(0, index).split('\n').length;
      const snippet = src.slice(Math.max(0, index - 30), index + 40).replace(/\s+/g, ' ');
      const hit = { kind: name, index, line, snippet };
      const inCode = code[index] === 1;
      if (inCode || !reliable) violations.push(hit);
      else ignored.push(hit);
    }
  }
  violations.sort((a, b) => a.index - b.index);
  ignored.sort((a, b) => a.index - b.index);
  return { violations, ignored, lexerReliable: reliable };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const fmtKB = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/**
 * @param {string[]} [argv]   flags: --strict, --dev, --out dist-<name>
 * @param {Record<string, string|undefined>} [env]
 * @param {{ root?: string, log?: (s: string) => void, logError?: (s: string) => void }} [io]
 *        `root` is the project directory to build (tests pass a throwaway one).
 * @returns {Promise<number>} process exit code
 */
export async function main(argv = process.argv.slice(2), env = process.env, io = {}) {
  const { root = ROOT, log = console.log, logError = console.error } = io;
  // --out dist-<name> builds into a sibling directory so parallel runs (e2e agents) never clobber each other's dist/.
  // The name is restricted to dist or dist-<name>: this directory is deleted and recreated on every build.
  const outAt = argv.indexOf('--out');
  const outName = outAt >= 0 ? String(argv[outAt + 1] ?? '') : 'dist';
  if (!/^dist(-[a-z0-9]+)*$/.test(outName)) {
    logError(`--out must be "dist" or "dist-<name>" (lowercase letters and digits), got "${outName}"`);
    return 2;
  }
  const dist = join(root, outName);
  const rel = (p) => relative(root, p).split(sep).join('/');
  const strict = argv.includes('--strict');
  const dev = argv.includes('--dev') || env.CINEDRAPE_DEV === '1';
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  /** @type {{name:string, status:'ok'|'SKIP'|'FAIL', bytes?:number, gzip?:number, note?:string}[]} */
  const rows = [];
  const failures = [];
  const fail = (msg) => { failures.push(msg); };

  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  const common = {
    bundle: true,
    platform: 'browser',
    target: 'chrome105',
    loader: { '.json': 'json' },
    define: { __DEV__: String(dev) },
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'silent',
    absWorkingDir: root,
  };

  const entries = [
    { name: 'content.js', entry: 'src/content/index.js', out: `${outName}/content.js`, format: 'iife', minify: true },
    { name: 'service-worker.js', entry: 'src/background/service-worker.js', out: `${outName}/service-worker.js`, format: 'esm', minify: !dev },
    { name: 'popup/popup.js', entry: 'src/popup/popup.js', out: `${outName}/popup/popup.js`, format: 'iife', minify: !dev },
    { name: 'editor/editor.js', entry: 'src/editor/editor.js', out: `${outName}/editor/editor.js`, format: 'iife', minify: !dev },
  ];

  // Bundle the entries concurrently, then report in a fixed order.
  const results = await Promise.all(entries.map(async (e) => {
    if (!existsSync(join(root, e.entry))) return { e, skipped: true };
    try {
      await build({
        ...common,
        entryPoints: [e.entry],
        outfile: e.out,
        format: e.format,
        minify: e.minify,
      });
      return { e };
    } catch (error) {
      return { e, error };
    }
  }));
  for (const { e, skipped, error } of results) {
    if (skipped) {
      rows.push({ name: e.name, status: 'SKIP', note: 'not written yet' });
      log(`SKIP ${e.name} (not written yet)`);
      if (strict && !e.optional) fail(`missing entry point ${e.entry}`);
    } else if (error) {
      const msgs = (error.errors || []).map((x) => {
        const loc = x.location ? `${x.location.file}:${x.location.line}:${x.location.column}: ` : '';
        return `${loc}${x.text}`;
      });
      rows.push({ name: e.name, status: 'FAIL', note: 'esbuild error' });
      fail(`esbuild failed for ${e.entry}:\n    ${msgs.join('\n    ') || error.message}`);
    } else {
      const bytes = readFileSync(join(root, e.out));
      rows.push({ name: e.name, status: 'ok', bytes: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length });
    }
  }

  // manifest.json (required): inject the package version
  const manifestPath = join(root, 'manifest.json');
  if (!existsSync(manifestPath)) {
    rows.push({ name: 'manifest.json', status: 'FAIL', note: 'missing' });
    fail('manifest.json is missing');
  } else {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.version = pkg.version;
    if (dev) manifest.version_name = `${pkg.version}-dev`;
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(join(dist, 'manifest.json'), text);
    rows.push({ name: 'manifest.json', status: 'ok', bytes: Buffer.byteLength(text), note: `v${manifest.version}${dev ? ' (dev)' : ''}` });
  }

  // plain copies
  const copies = [
    { name: 'popup/popup.html', from: 'src/popup/popup.html', to: 'popup/popup.html' },
    { name: 'popup/popup.css', from: 'src/popup/popup.css', to: 'popup/popup.css' },
    { name: 'data/selector-map.json', from: 'src/data/selector-map.signed.json', to: 'data/selector-map.json' },
    { name: 'editor/editor.html', from: 'src/editor/editor.html', to: 'editor/editor.html' },
    { name: 'editor/editor.css', from: 'src/editor/editor.css', to: 'editor/editor.css' },
  ];
  for (const c of copies) {
    const from = join(root, c.from);
    if (!existsSync(from)) {
      rows.push({ name: c.name, status: 'SKIP', note: 'not written yet' });
      log(`SKIP ${c.name} (not written yet)`);
      if (strict && !c.optional) fail(`missing input ${c.from}`);
      continue;
    }
    mkdirSync(dirname(join(dist, c.to)), { recursive: true });
    cpSync(from, join(dist, c.to));
    rows.push({ name: c.name, status: 'ok', bytes: statSync(from).size });
  }

  // icons/
  const iconsDir = join(root, 'icons');
  const pngs = existsSync(iconsDir) ? readdirSync(iconsDir).filter((f) => f.endsWith('.png')) : [];
  if (!pngs.length) {
    rows.push({ name: 'icons/*.png', status: 'SKIP', note: 'not written yet' });
    log('SKIP icons/ (not written yet)');
    if (strict) fail('icons/ has no PNG files');
  } else {
    mkdirSync(join(dist, 'icons'), { recursive: true });
    let total = 0;
    for (const f of pngs) {
      cpSync(join(iconsDir, f), join(dist, 'icons', f));
      total += statSync(join(iconsDir, f)).size;
    }
    rows.push({ name: 'icons/*.png', status: 'ok', bytes: total, note: `${pngs.length} files` });
  }

  // Every file the manifest points at must exist in dist/.
  const manifestOut = join(dist, 'manifest.json');
  if (existsSync(manifestOut)) {
    const m = JSON.parse(readFileSync(manifestOut, 'utf8'));
    const refs = new Set([
      m.action?.default_popup,
      m.background?.service_worker,
      ...Object.values(m.icons || {}),
      ...Object.values(m.action?.default_icon || {}),
      ...(m.content_scripts || []).flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
    ].filter(Boolean));
    const missing = [...refs].filter((r) => !existsSync(join(dist, r)));
    if (missing.length && strict) fail(`manifest references files missing from dist/: ${missing.join(', ')}`);
    else if (missing.length) log(`note: manifest references not built yet: ${missing.join(', ')}`);
  }

  // ---- enforcement -------------------------------------------------------
  const content = rows.find((r) => r.name === 'content.js');
  if (content?.status === 'ok') {
    const ok = content.gzip <= GZIP_BUDGET_BYTES;
    log(`content.js gzip: ${content.gzip} bytes (${fmtKB(content.gzip)}) / budget ${GZIP_BUDGET_BYTES} bytes (${fmtKB(GZIP_BUDGET_BYTES)}) ${ok ? 'OK' : 'OVER BUDGET'}`);
    if (!ok) fail(`dist/content.js gzip is ${content.gzip} bytes, over the ${GZIP_BUDGET_BYTES} byte budget`);
  } else {
    log('content.js gzip: n/a (content.js not built)');
  }

  let scanned = 0;
  let ignoredTotal = 0;
  for (const file of walk(dist).filter((f) => f.endsWith('.js'))) {
    scanned++;
    const { violations, ignored, lexerReliable } = findForbidden(readFileSync(file, 'utf8'));
    for (const v of violations) {
      fail(`${rel(file)}:${v.line}: forbidden "${v.kind}" in code: ...${v.snippet}...`);
    }
    if (!lexerReliable) log(`note: ${rel(file)}: JS lexer lost sync, counted every raw match (no string-literal exemption)`);
    ignoredTotal += ignored.length;
    for (const g of ignored) log(`note: ${rel(file)}:${g.line}: "${g.kind}" only inside a string/comment, ignored: ...${g.snippet}...`);
  }
  log(`forbidden-construct scan: ${scanned} .js file(s), ${ignoredTotal} string-only match(es) ignored`);

  // ---- summary -----------------------------------------------------------
  const w = Math.max(...rows.map((r) => r.name.length), 8);
  const flags = [dev && 'dev', strict && 'strict'].filter(Boolean);
  log(`\nCinedrape build${flags.length ? ` (${flags.join(', ')})` : ''}`);
  log(`${'artifact'.padEnd(w)}  ${'status'.padEnd(6)}  ${'size'.padStart(9)}  ${'gzip'.padStart(9)}  note`);
  for (const r of rows) {
    log([
      r.name.padEnd(w),
      r.status.padEnd(6),
      (r.bytes != null ? fmtKB(r.bytes) : '-').padStart(9),
      (r.gzip != null ? fmtKB(r.gzip) : '-').padStart(9),
      r.note || '',
    ].join('  ').trimEnd());
  }

  if (failures.length) {
    logError(`\nBUILD FAILED (${failures.length} problem${failures.length === 1 ? '' : 's'}):`);
    for (const f of failures) logError(`  - ${f}`);
    return 1;
  }
  const skipped = rows.filter((r) => r.status === 'SKIP').length;
  log(`\nBuild OK${skipped ? ` with ${skipped} SKIP(s)` : ''}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

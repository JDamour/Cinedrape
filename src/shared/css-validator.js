// CSS validator for theme CSS (ARCHITECTURE.md section 4 "shared/css-validator.js", section 6).
//
//   validateCss(css, {allowList, protectedSelectors}) -> {ok, errors:[{line, column, message, text, code}]}
//   buildAllowList(map)                               -> allow-list built from the selector map (classes/ids/tags/attributes + protected model)
//
// Pure, dependency free, never throws, terminates on any input. It has its own CSS Syntax Level 3 tokenizer and parser and it is
// STRICT: any construct a browser would silently repair or drop (unterminated string/comment/block, bad url, stray bracket,
// nested rules, a comment inside a property name, ...) is an error. Rejecting instead of repairing means the validator and the
// browser can never disagree about what a stylesheet says, which is what the ad-safety rules below rely on.
//
// What a rule is judged on:
//   * syntax and blocked constructs: @import/@font-face/@namespace/@charset/@property/unknown at-rules, expression(), behavior,
//     -moz-binding, javascript:, url() other than data:image/(png|jpeg|webp|svg+xml) or (chrome|moz)-extension://, long content.
//   * selectors: every class/id/tag/attribute must be cd- prefixed or in the allow-list; html/body/:root/* only with a cd- anchor.
//   * ad safety (the part that matters most): declarations that can hide, collapse, move off screen, fade, obscure or make
//     unclickable an element ("hide") or that can cover other content ("overlay") are refused when the rule can reach an ad, a
//     sponsorship label, a player control, or a container that can hold one (unless it carries the :not(:has(<ads>)) guard).
//     Everything is checked after decoding CSS escapes, ignoring case and vendor prefixes, inside @media/@supports, through
//     var() indirection and through @keyframes.
//
// Assumption worth knowing: YouTube's DOM never carries cd- prefixed classes, ids or tag names, so a selector anchored on one
// (".cd-card img") can only reach Cinedrape's own elements. cd- ATTRIBUTES do not count: Cinedrape sets [cd-source] on YouTube
// tiles.
import { CD_PREFIX, LIMITS } from './constants.js';

const MAX_ERRORS = 50;
const MAX_BRACKET_DEPTH = 48;
const MAX_BLOCK_DEPTH = 8;
const MAX_SELECTOR_DEPTH = 6;
const MAX_SELECTOR_CHARS = 1000;
const MAX_ALTERNATIVES = 400;
const MAX_VARIANTS = 24;
const MAX_VAR_DEPTH = 24;
const MAX_ALLOW_SELECTORS = 6000;
const MAX_MAP_SELECTOR_CHARS = 4000;
const ALLOW_KIND = 'cinedrape-allow-list';
const EXT_VAR = 'cd-external-var';   // stands in for a var() the stylesheet cannot influence

// ---- small helpers ------------------------------------------------------------------------------------------------------

/** ASCII-only lower casing: CSS is ASCII case-insensitive, so U+212A (Kelvin) must not become "k". */
const lc = (s) => (/[A-Z]/.test(s) ? s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)) : s);
const stripVendor = (s) => (s.charCodeAt(0) === 45 ? s.replace(/^-(?:webkit|moz|ms|o|khtml|epub)-/, '') : s);
const stripCtl = (s) => (/[\u0000-\u001f\u007f]/.test(s) ? s.replace(/[\u0000-\u001f\u007f]/g, '') : s);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const strList = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []);

const isNewline = (c) => c === 10 || c === 13 || c === 12;
const isWsCode = (c) => c === 32 || c === 9 || isNewline(c);
const isDigit = (c) => c >= 48 && c <= 57;
const isHex = (c) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isNameStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 128;
const isNameChar = (c) => isNameStart(c) || isDigit(c) || c === 45;
const isNonPrintable = (c) => (c >= 0 && c <= 8) || c === 11 || (c >= 14 && c <= 31) || c === 127;

// ---- tokenizer (CSS Syntax Level 3) -------------------------------------------------------------------------------------
// Token: {t, s, e, v?, u?, id?}. t is one of ws ident function at hash string url bad-url delim number percentage dimension
// : ; , [ ] ( ) { } cdo cdc. Comments produce no token. `report(offset, message, code)` records an error; tokenizing continues.

const SINGLE = { 40: '(', 41: ')', 91: '[', 93: ']', 123: '{', 125: '}', 44: ',', 58: ':', 59: ';' };

function tokenize(src, report) {
  const n = src.length;
  const toks = [];
  const code = (k) => src.charCodeAt(k);
  const validEscape = (k) => code(k) === 92 && k + 1 < n && !isNewline(code(k + 1));
  const startsIdent = (k) => {
    const a = code(k);
    if (a === 45) {
      const b = code(k + 1);
      return isNameStart(b) || b === 45 || validEscape(k + 1);
    }
    return isNameStart(a) || (a === 92 && validEscape(k));
  };
  const startsNumber = (k) => {
    const a = code(k);
    if (a === 43 || a === 45) {
      const b = code(k + 1);
      return isDigit(b) || (b === 46 && isDigit(code(k + 2)));
    }
    if (a === 46) return isDigit(code(k + 1));
    return isDigit(a);
  };

  let lastCh = '';
  function consumeEscape(k) {
    k++;
    if (isHex(code(k))) {
      let j = k;
      while (j < n && j - k < 6 && isHex(code(j))) j++;
      let cp = parseInt(src.slice(k, j), 16);
      if (code(j) === 13 && code(j + 1) === 10) j += 2;
      else if (isWsCode(code(j))) j++;
      if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) cp = 0xfffd;
      lastCh = String.fromCodePoint(cp);
      return j;
    }
    lastCh = String.fromCodePoint(src.codePointAt(k));
    return k + lastCh.length;
  }

  let lastName = '';
  function consumeName(k) {
    let out = '';
    let from = k;
    while (k < n) {
      const c = code(k);
      if (isNameChar(c)) { k++; continue; }
      if (c === 92 && validEscape(k)) {
        out += src.slice(from, k);
        k = consumeEscape(k);
        out += lastCh;
        from = k;
        continue;
      }
      break;
    }
    lastName = out ? out + src.slice(from, k) : src.slice(from, k);
    return k;
  }


  function consumeString(k, quote) {
    const s = k;
    k++;
    let out = '';
    let from = k;
    for (;;) {
      if (k >= n) {
        out += src.slice(from, k);
        report(s, 'Unterminated string', 'syntax');
        toks.push({ t: 'string', s, e: n, v: out });
        return n;
      }
      const c = code(k);
      if (c === quote) {
        out += src.slice(from, k);
        toks.push({ t: 'string', s, e: k + 1, v: out });
        return k + 1;
      }
      if (isNewline(c)) {
        out += src.slice(from, k);
        report(s, 'Unterminated string (a line break inside quotes)', 'syntax');
        toks.push({ t: 'string', s, e: k, v: out });
        return k;
      }
      if (c === 92) {
        out += src.slice(from, k);
        if (k + 1 >= n) { k++; from = k; continue; }
        const d = code(k + 1);
        if (isNewline(d)) { k += d === 13 && code(k + 2) === 10 ? 3 : 2; from = k; continue; }
        k = consumeEscape(k);
        out += lastCh;
        from = k;
        continue;
      }
      k++;
    }
  }

  function consumeUrl(k, s) {
    let j = k;
    while (isWsCode(code(j))) j++;
    let out = '';
    let from = j;
    let bad = false;
    for (;;) {
      if (j >= n) { report(s, 'Unterminated url()', 'syntax'); toks.push({ t: 'bad-url', s, e: n }); return n; }
      const d = code(j);
      if (d === 41) { out += src.slice(from, j); toks.push({ t: 'url', s, e: j + 1, v: out }); return j + 1; }
      if (isWsCode(d)) {
        out += src.slice(from, j);
        while (isWsCode(code(j))) j++;
        if (code(j) === 41 || j >= n) continue;
        bad = true;
        break;
      }
      if (d === 34 || d === 39 || d === 40 || isNonPrintable(d)) { bad = true; break; }
      if (d === 92) {
        if (!validEscape(j)) { bad = true; break; }
        out += src.slice(from, j);
        j = consumeEscape(j);
        out += lastCh;
        from = j;
        continue;
      }
      j++;
    }
    if (bad) {
      report(s, 'Malformed url()', 'url');
      while (j < n && code(j) !== 41) j += code(j) === 92 && validEscape(j) ? 2 : 1;
      j = Math.min(n, j + 1);
      toks.push({ t: 'bad-url', s, e: j });
    }
    return j;
  }

  function consumeIdentLike(k) {
    const s = k;
    const nk = consumeName(k);
    const name = lastName;
    if (code(nk) === 40) {
      if (lc(name) === 'url') {
        let j = nk + 1;
        while (isWsCode(code(j))) j++;
        if (code(j) !== 34 && code(j) !== 39) return consumeUrl(nk + 1, s);
      }
      toks.push({ t: 'function', s, e: nk + 1, v: name });
      return nk + 1;
    }
    toks.push({ t: 'ident', s, e: nk, v: name });
    return nk;
  }

  function consumeNumeric(k) {
    const s = k;
    let j = k;
    if (code(j) === 43 || code(j) === 45) j++;
    while (isDigit(code(j))) j++;
    if (code(j) === 46 && isDigit(code(j + 1))) { j++; while (isDigit(code(j))) j++; }
    const x = code(j);
    if (x === 69 || x === 101) {
      const y = code(j + 1);
      if (isDigit(y) || ((y === 43 || y === 45) && isDigit(code(j + 2)))) { j += 2; while (isDigit(code(j))) j++; }
    }
    const v = Number(src.slice(k, j));
    if (startsIdent(j)) {
      const nj = consumeName(j);
      toks.push({ t: 'dimension', s, e: nj, v, u: lastName });
      return nj;
    }
    if (code(j) === 37) { toks.push({ t: 'percentage', s, e: j + 1, v }); return j + 1; }
    toks.push({ t: 'number', s, e: j, v });
    return j;
  }

  let i = 0;
  while (i < n) {
    const c = code(i);
    const s = i;
    if (c === 47 && code(i + 1) === 42) {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) { report(s, 'Unterminated comment', 'syntax'); break; }
      i = end + 2;
      continue;
    }
    if (isWsCode(c)) {
      while (i < n && isWsCode(code(i))) i++;
      toks.push({ t: 'ws', s, e: i });
      continue;
    }
    if (c === 34 || c === 39) { i = consumeString(i, c); continue; }
    if (c === 35) {
      if (isNameChar(code(i + 1)) || validEscape(i + 1)) {
        const isId = startsIdent(i + 1);
        const ni = consumeName(i + 1);
        toks.push({ t: 'hash', s, e: ni, v: lastName, id: isId });
        i = ni;
      } else { toks.push({ t: 'delim', s, e: i + 1, v: '#' }); i++; }
      continue;
    }
    const single = SINGLE[c];
    if (single) { toks.push({ t: single, s, e: i + 1 }); i++; continue; }
    if (c === 43 || c === 46) {
      if (startsNumber(i)) i = consumeNumeric(i);
      else { toks.push({ t: 'delim', s, e: i + 1, v: String.fromCharCode(c) }); i++; }
      continue;
    }
    if (c === 45) {
      if (startsNumber(i)) i = consumeNumeric(i);
      else if (code(i + 1) === 45 && code(i + 2) === 62) { toks.push({ t: 'cdc', s, e: i + 3 }); i += 3; }
      else if (startsIdent(i)) i = consumeIdentLike(i);
      else { toks.push({ t: 'delim', s, e: i + 1, v: '-' }); i++; }
      continue;
    }
    if (c === 60) {
      if (code(i + 1) === 33 && code(i + 2) === 45 && code(i + 3) === 45) { toks.push({ t: 'cdo', s, e: i + 4 }); i += 4; }
      else { toks.push({ t: 'delim', s, e: i + 1, v: '<' }); i++; }
      continue;
    }
    if (c === 64) {
      if (startsIdent(i + 1)) {
        const ni = consumeName(i + 1);
        toks.push({ t: 'at', s, e: ni, v: lastName });
        i = ni;
      } else { toks.push({ t: 'delim', s, e: i + 1, v: '@' }); i++; }
      continue;
    }
    if (c === 92) {
      if (validEscape(i)) { i = consumeIdentLike(i); continue; }
      report(s, 'Invalid escape sequence', 'syntax');
      toks.push({ t: 'delim', s, e: i + 1, v: '\\' });
      i++;
      continue;
    }
    if (isDigit(c)) { i = consumeNumeric(i); continue; }
    if (isNameStart(c)) { i = consumeIdentLike(i); continue; }
    const ch = src[i];
    toks.push({ t: 'delim', s, e: i + 1, v: ch });
    i++;
  }
  return toks;
}

const isOpen = (t) => t === '(' || t === 'function' || t === '[' || t === '{';
const CLOSER = { '(': ')', function: ')', '[': ']', '{': '}' };

/** Pairs every bracket with its partner (match[i] = partner index). Returns null (after reporting) on any imbalance. */
function matchBrackets(toks, report) {
  const match = new Int32Array(toks.length).fill(-1);
  const stack = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].t;
    if (isOpen(t)) {
      if (stack.length >= MAX_BRACKET_DEPTH) { report(toks[i].s, `Brackets nested deeper than ${MAX_BRACKET_DEPTH} levels`, 'syntax'); return null; }
      stack.push(i);
    } else if (t === ')' || t === ']' || t === '}') {
      if (!stack.length) { report(toks[i].s, `Unexpected '${t}'`, 'syntax'); return null; }
      const open = stack.pop();
      const want = CLOSER[toks[open].t];
      // A ')' or ']' directly inside a block (no paren/bracket open) is simply stray, not a mismatched pair.
      if (want === '}' && t !== '}') { report(toks[i].s, `Unexpected '${t}'`, 'syntax'); return null; }
      if (want !== t) { report(toks[i].s, `Expected '${want}' but found '${t}'`, 'syntax'); return null; }
      match[open] = i;
      match[i] = open;
    }
  }
  if (stack.length) {
    const open = stack[stack.length - 1];
    report(toks[open].s, `Unclosed '${toks[open].t === 'function' ? '(' : toks[open].t}'`, 'syntax');
    return null;
  }
  return match;
}

// ---- selector parser ----------------------------------------------------------------------------------------------------
// AST: Complex {compounds:[Compound], s, e}; Compound {comb:''|' '|'>'|'+'|'~', simples:[Simple], s, e};
// Simple {k:'type'|'univ'|'class'|'id'|'attr'|'pseudo', s, ...}. Anything the parser does not understand is an error.

const IS_LIKE = /* @__PURE__ */ new Set(['is', 'where', 'matches', 'any', '-webkit-any', '-moz-any']);
const SELECTOR_FN = /* @__PURE__ */ new Set(['not', 'is', 'where', 'matches', 'any', '-webkit-any', '-moz-any', 'host', 'host-context',
  'slotted', 'cue', 'cue-region', 'current', 'past', 'future']);
const NTH_FN = /* @__PURE__ */ new Set(['nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type', 'nth-col', 'nth-last-col']);
const LEGACY_ELEMENTS = /* @__PURE__ */ new Set(['before', 'after', 'first-line', 'first-letter']);
const ARG_OK = /* @__PURE__ */ new Set(['ws', 'ident', 'number', 'dimension', 'percentage', 'string', ',']);

function parseSelectorList(P, lo, hi, depth, relative) {
  const { toks, match } = P;
  if (depth > MAX_SELECTOR_DEPTH) {
    P.report(toks[lo] ? toks[lo].s : 0, `Selectors nested more than ${MAX_SELECTOR_DEPTH} levels deep are not allowed`, 'selector');
    return null;
  }
  const list = [];
  let ok = true;
  let seg = lo;
  for (let j = lo; j <= hi; j++) {
    if (j === hi || toks[j].t === ',') {
      const cx = parseComplex(P, seg, j, depth, relative);
      if (cx) list.push(cx); else ok = false;
      seg = j + 1;
    } else if (isOpen(toks[j].t)) j = match[j];
  }
  return ok ? list : null;
}

function parseComplex(P, lo, hi, depth, relative) {
  const { toks } = P;
  let i = lo;
  while (i < hi && toks[i].t === 'ws') i++;
  let end = hi;
  while (end > i && toks[end - 1].t === 'ws') end--;
  if (i >= end) {
    P.report(toks[lo] ? toks[lo].s : (toks.length ? toks[toks.length - 1].e : 0), 'Empty selector', 'selector');
    return null;
  }
  const first = toks[i];
  let comb = '';
  const isComb = (tk) => tk.t === 'delim' && (tk.v === '>' || tk.v === '+' || tk.v === '~');
  if (isComb(first)) {
    if (!relative) { P.report(first.s, 'A selector cannot start with a combinator', 'selector'); return null; }
    comb = first.v;
    i++;
    while (i < end && toks[i].t === 'ws') i++;
    if (i >= end) { P.report(first.s, 'A combinator needs a selector after it', 'selector'); return null; }
  }
  const compounds = [];
  for (;;) {
    const cp = parseCompound(P, i, end, depth);
    if (!cp) return null;
    cp.comb = comb;
    compounds.push(cp);
    i = cp.next;
    let sawWs = false;
    while (i < end && toks[i].t === 'ws') { sawWs = true; i++; }
    if (i >= end) break;
    const tk = toks[i];
    if (isComb(tk)) {
      comb = tk.v;
      i++;
      while (i < end && toks[i].t === 'ws') i++;
      if (i >= end) { P.report(tk.s, 'A combinator needs a selector after it', 'selector'); return null; }
    } else if (sawWs) comb = ' ';
    else { P.report(tk.s, 'Unexpected token in selector', 'selector'); return null; }
  }
  return { compounds, s: first.s, e: toks[end - 1].e };
}

function parseCompound(P, lo, hi, depth) {
  const { toks } = P;
  const simples = [];
  let i = lo;
  let sawElement = false;
  const bad = (off, msg) => { P.report(off, msg, 'selector'); return null; };
  while (i < hi) {
    const tk = toks[i];
    if (tk.t === 'ws' || tk.t === ',') break;
    if (tk.t === 'delim' && (tk.v === '>' || tk.v === '+' || tk.v === '~')) break;
    const startOfCompound = simples.length === 0;
    if (tk.t === 'ident') {
      if (!startOfCompound) return bad(tk.s, `Unexpected identifier "${tk.v}" in selector`);
      simples.push({ k: 'type', s: tk.s, name: tk.v, lname: lc(tk.v) });
      i++;
    } else if (tk.t === 'delim' && tk.v === '*') {
      if (!startOfCompound) return bad(tk.s, 'Unexpected "*" in selector');
      simples.push({ k: 'univ', s: tk.s });
      i++;
    } else if (tk.t === 'delim' && tk.v === '.') {
      const nm = toks[i + 1];
      if (!nm || i + 1 >= hi || nm.t !== 'ident') return bad(tk.s, 'Expected a class name after "."');
      if (sawElement) return bad(tk.s, 'Nothing but pseudo-classes may follow a pseudo-element');
      simples.push({ k: 'class', s: tk.s, name: nm.v, lname: lc(nm.v) });
      i += 2;
    } else if (tk.t === 'hash') {
      if (!tk.id) return bad(tk.s, `"#${tk.v}" is not a valid id selector`);
      if (sawElement) return bad(tk.s, 'Nothing but pseudo-classes may follow a pseudo-element');
      simples.push({ k: 'id', s: tk.s, name: tk.v, lname: lc(tk.v) });
      i++;
    } else if (tk.t === '[') {
      if (sawElement) return bad(tk.s, 'Nothing but pseudo-classes may follow a pseudo-element');
      const at = parseAttr(P, i);
      if (!at) return null;
      simples.push(at.node);
      i = at.next;
    } else if (tk.t === ':') {
      const ps = parsePseudo(P, i, hi, depth);
      if (!ps) return null;
      if (ps.node.el) sawElement = true;
      simples.push(ps.node);
      i = ps.next;
    } else if (tk.t === 'delim' && tk.v === '|') {
      return bad(tk.s, 'Namespace selectors are not supported');
    } else if (tk.t === 'delim' && tk.v === '&') {
      return bad(tk.s, 'The nesting selector "&" is not supported');
    } else {
      return bad(tk.s, `Unexpected ${describeToken(tk)} in selector`);
    }
  }
  if (!simples.length) return bad(toks[lo] ? toks[lo].s : 0, 'Empty selector');
  return { comb: '', simples, s: toks[lo].s, e: toks[i - 1].e, next: i };
}

function describeToken(tk) {
  switch (tk.t) {
    case 'delim': return `"${tk.v}"`;
    case 'string': return 'a string';
    case 'number': case 'dimension': case 'percentage': return 'a number';
    case 'function': return `"${tk.v}("`;
    case 'at': return `"@${tk.v}"`;
    default: return `"${tk.t}"`;
  }
}

function parseAttr(P, i) {
  const { toks, match } = P;
  const open = toks[i];
  const close = match[i];
  let j = i + 1;
  const skip = () => { while (j < close && toks[j].t === 'ws') j++; };
  const bad = (off, msg) => { P.report(off, msg, 'selector'); return null; };
  skip();
  const nm = toks[j];
  if (j >= close || nm.t !== 'ident') {
    if (j < close && nm.t === 'delim' && (nm.v === '*' || nm.v === '|')) return bad(nm.s, 'Namespace selectors are not supported');
    return bad(open.s, 'Expected an attribute name inside [ ]');
  }
  const node = { k: 'attr', s: open.s, name: nm.v, lname: lc(nm.v), op: '', value: '', flag: '' };
  j++;
  skip();
  if (j >= close) return { node, next: close + 1 };
  const a = toks[j];
  if (a.t !== 'delim') return bad(a.s, 'Expected an attribute operator');
  if (a.v === '|' && toks[j + 1] && j + 1 < close && toks[j + 1].t !== 'delim') return bad(a.s, 'Namespace selectors are not supported');
  if (a.v === '=') { node.op = '='; j++; } else if ('~|^$*'.includes(a.v) && toks[j + 1] && toks[j + 1].t === 'delim' && toks[j + 1].v === '=' && toks[j + 1].s === a.e) {
    node.op = `${a.v}=`;
    j += 2;
  } else return bad(a.s, 'Unknown attribute operator');
  skip();
  const val = toks[j];
  if (j >= close || (val.t !== 'ident' && val.t !== 'string')) return bad(open.s, 'Expected an identifier or a string after the attribute operator');
  node.value = val.v;
  j++;
  skip();
  if (j < close) {
    const fl = toks[j];
    if (fl.t !== 'ident' || !/^[is]$/i.test(fl.v)) return bad(fl.s, 'Unexpected token in attribute selector');
    node.flag = lc(fl.v);
    j++;
    skip();
    if (j < close) return bad(toks[j].s, 'Unexpected token in attribute selector');
  }
  return { node, next: close + 1 };
}

/** Argument tokens of an An+B pseudo-class or a simple functional pseudo: only idents, numbers, strings, commas, + - * /. */
function checkPlainArgs(P, lo, hi, allowOps) {
  for (let k = lo; k < hi; k++) {
    const tk = P.toks[k];
    if (ARG_OK.has(tk.t)) continue;
    if (tk.t === 'delim' && (allowOps ? '+-*/'.includes(tk.v) : '+-'.includes(tk.v))) continue;
    P.report(tk.s, `Unsupported argument ${describeToken(tk)} in pseudo-class`, 'selector');
    return false;
  }
  return true;
}

function parsePseudo(P, i, hi, depth) {
  const { toks, match } = P;
  const start = toks[i];
  let j = i + 1;
  let el = false;
  if (j < hi && toks[j].t === ':') { el = true; j++; }
  const nt = toks[j];
  const bad = (off, msg) => { P.report(off, msg, 'selector'); return null; };
  if (j >= hi || !nt) return bad(start.s, 'Expected a pseudo-class or pseudo-element name after ":"');
  if (nt.t === 'ident') {
    const name = lc(nt.v);
    return { node: { k: 'pseudo', s: start.s, name, el: el || LEGACY_ELEMENTS.has(name), fn: false, list: null }, next: j + 1 };
  }
  if (nt.t !== 'function') return bad(nt.s, 'Expected a pseudo-class or pseudo-element name after ":"');
  const name = lc(nt.v);
  const close = match[j];
  const node = { k: 'pseudo', s: start.s, name, el, fn: true, list: null, anb: '' };
  if (name === 'has' && !el) {
    node.list = parseSelectorList(P, j + 1, close, depth + 1, true);
  } else if (SELECTOR_FN.has(name)) {
    node.list = parseSelectorList(P, j + 1, close, depth + 1, false);
  } else if ((name === 'nth-child' || name === 'nth-last-child') && !el) {
    let of = -1;
    for (let k = j + 1; k < close; k++) {
      if (toks[k].t === 'ident' && lc(toks[k].v) === 'of') { of = k; break; }
      if (isOpen(toks[k].t)) k = match[k];
    }
    const anbEnd = of < 0 ? close : of;
    if (!checkPlainArgs(P, j + 1, anbEnd, false)) return null;
    node.anb = anbText(toks, j + 1, anbEnd);
    if (of >= 0) {
      node.list = parseSelectorList(P, of + 1, close, depth + 1, false);
      if (!node.list) return null;
    }
  } else if (NTH_FN.has(name) && !el) {
    if (!checkPlainArgs(P, j + 1, close, false)) return null;
    node.anb = anbText(toks, j + 1, close);
  } else if (el || name === 'lang' || name === 'dir' || name === 'state') {
    if (!checkPlainArgs(P, j + 1, close, true)) return null;
    node.anb = anbText(toks, j + 1, close);
  } else {
    return bad(nt.s, `The pseudo-class :${name}() is not supported`);
  }
  if ((SELECTOR_FN.has(name) || (name === 'has' && !el)) && !node.list) return null;
  return { node, next: close + 1 };
}

function anbText(toks, lo, hi) {
  let out = '';
  for (let k = lo; k < hi; k++) {
    const tk = toks[k];
    if (tk.t === 'ws') continue;
    out += tk.t === 'delim' ? tk.v : tk.t === 'dimension' ? `${tk.v}${lc(tk.u)}` : tk.t === 'number' || tk.t === 'percentage' ? `${tk.v}${tk.t === 'percentage' ? '%' : ''}` : lc(String(tk.v));
  }
  return out;
}

/** Parses a standalone selector string (map entries, protected lists). `list` is null when there was any error. */
export function parseSelectorString(text) {
  const errors = [];
  const report = (off, message) => { if (errors.length < 10) errors.push({ off, message }); };
  if (typeof text !== 'string') return { list: null, errors: [{ off: 0, message: 'Selector must be a string' }] };
  const toks = tokenize(text, report);
  const match = matchBrackets(toks, report);
  if (!match) return { list: null, errors };
  const list = parseSelectorList({ toks, match, report }, 0, toks.length, 0, false);
  return { list: errors.length ? null : list, errors };
}

// ---- selector model helpers ---------------------------------------------------------------------------------------------

const canonSimple = (s) => {
  switch (s.k) {
    case 'type': return s.lname;
    case 'univ': return '*';
    case 'class': return `.${s.name}`;
    case 'id': return `#${s.name}`;
    case 'attr': return `[${s.lname}${s.op}${s.op ? JSON.stringify(s.value) : ''}${s.flag ? ` ${s.flag}` : ''}]`;
    default: {
      if (!s.fn) return `:${s.el ? ':' : ''}${s.name}`;
      const inner = s.list ? s.list.map(canonComplex).join(',') : '';
      return `:${s.el ? ':' : ''}${s.name}(${s.anb ? `${s.anb}${s.list ? ' of ' : ''}` : ''}${inner})`;
    }
  }
};
const canonCompound = (cp) => cp.simples.map(canonSimple).join('');
function canonComplex(cx) {
  let out = '';
  for (let k = 0; k < cx.compounds.length; k++) {
    const cp = cx.compounds[k];
    if (k === 0) out += cp.comb ? `${cp.comb} ` : '';
    else out += cp.comb === ' ' ? ' ' : ` ${cp.comb} `;
    out += canonCompound(cp);
  }
  return out;
}

/** Visits every compound of a complex selector, including those inside pseudo-class arguments. neg = inside an odd number of :not(). */
function eachCompound(cx, fn, neg = false) {
  for (const cp of cx.compounds) {
    fn(cp, neg);
    for (const s of cp.simples) {
      if (s.k === 'pseudo' && s.list) {
        const inner = s.name === 'not' ? !neg : neg;
        for (const m of s.list) eachCompound(m, fn, inner);
      }
    }
  }
}

/** Rightmost compound of every member of a selector list, descending through :is()-like pseudo-classes handled by callers. */
const subjectOf = (cx) => cx.compounds[cx.compounds.length - 1];

// ---- protected model and allow-list -------------------------------------------------------------------------------------
// The model answers "can this selector reach an ad / sponsor label / player control / container that can hold one?" from the
// selector map's protected groups, split into simple selectors.

function newModel() {
  return {
    tags: new Set(), classes: new Set(), ids: new Set(),
    attr: new Map(),          // attribute name -> canonical values of protected elements (class/id included)
    attrAny: new Set(),       // protected selectors that only require the attribute to exist
    adsCanon: new Set(),      // canonical text of every protected.ads selector (the guard must list them all)
    allCanon: new Set(),      // canonical text of every protected selector (used to not count them against the length limit)
    containerTags: new Set(), containerIds: new Set(),
  };
}

function addCanon(model, name, value) {
  let set = model.attr.get(name);
  if (!set) { set = new Set(); model.attr.set(name, set); }
  set.add(value);
}

function addProtected(model, s) {
  switch (s.k) {
    case 'type': model.tags.add(s.lname); break;
    case 'class': model.classes.add(lc(s.name)); addCanon(model, 'class', lc(s.name)); break;
    case 'id': model.ids.add(lc(s.name)); addCanon(model, 'id', lc(s.name)); break;
    case 'attr':
      if (s.op === '') { model.attrAny.add(s.lname); addCanon(model, s.lname, ''); } else addCanon(model, s.lname, lc(s.value));
      break;
    default:
  }
}

/** groups: {ads, sponsor, playerControls, containers} (arrays of selector strings). extra: flat list of further protected selectors. */
function buildModel(groups, extra) {
  const model = newModel();
  const eat = (text, isAds) => {
    if (text.length > MAX_MAP_SELECTOR_CHARS) return;
    const r = parseSelectorString(text);
    if (!r.list) return;
    for (const cx of r.list) {
      const canon = canonComplex(cx);
      model.allCanon.add(canon);
      if (isAds) model.adsCanon.add(canon);
      // In "tag[attr]" / "tag.class" the tag alone is not protected (it is a container that merely can hold the ad), only the narrowed match is.
      eachCompound(cx, (cp, neg) => {
        if (neg) return;
        const narrowed = cp.simples.some((s) => s.k === 'class' || s.k === 'id' || s.k === 'attr');
        for (const s of cp.simples) if (!(narrowed && s.k === 'type')) addProtected(model, s);
      });
    }
  };
  for (const sel of strList(groups.ads)) eat(sel, true);
  for (const sel of strList(groups.sponsor)) eat(sel, false);
  for (const sel of strList(groups.playerControls)) eat(sel, false);
  for (const sel of strList(extra)) eat(sel, model.adsCanon.size === 0);
  for (const sel of strList(groups.containers)) {
    if (sel.length > MAX_MAP_SELECTOR_CHARS) continue;
    const r = parseSelectorString(sel);
    if (!r.list) continue;
    for (const cx of r.list) {
      for (const s of subjectOf(cx).simples) {
        if (s.k === 'type') model.containerTags.add(s.lname);
        else if (s.k === 'id') model.containerIds.add(lc(s.name));
      }
    }
  }
  return model;
}

/**
 * Allow-list for validateCss, built from the selector map: every simple selector of every role, protected and tileFields entry.
 * Never throws; a missing or broken map yields an allow-list that permits only cd- names.
 * @param {object} map
 * @returns {{kind:string, classes:Set<string>, ids:Set<string>, tags:Set<string>, attributes:Set<string>, protected:object}}
 */
export function buildAllowList(map) {
  const classes = new Set();
  const ids = new Set();
  const tags = new Set();
  const attributes = new Set();
  const groups = { ads: [], sponsor: [], playerControls: [], containers: [] };
  let budget = MAX_ALLOW_SELECTORS;
  const collect = (text) => {
    if (budget-- <= 0 || typeof text !== 'string' || text.length > MAX_MAP_SELECTOR_CHARS) return;
    const r = parseSelectorString(text);
    if (!r.list) return;
    for (const cx of r.list) {
      eachCompound(cx, (cp) => {
        for (const s of cp.simples) {
          if (s.k === 'class') classes.add(s.name);
          else if (s.k === 'id') ids.add(s.name);
          else if (s.k === 'type') tags.add(s.lname);
          else if (s.k === 'attr') attributes.add(s.lname);
        }
      });
    }
  };
  try {
    const m = isObj(map) ? map : {};
    for (const section of ['roles', 'tileFields']) {
      const sec = isObj(m[section]) ? m[section] : {};
      for (const key of Object.keys(sec)) for (const sel of strList(sec[key])) collect(sel);
    }
    const prot = isObj(m.protected) ? m.protected : {};
    for (const key of Object.keys(groups)) {
      groups[key] = strList(prot[key]).filter((s) => s.length <= MAX_MAP_SELECTOR_CHARS);
      for (const sel of groups[key]) collect(sel);
    }
  } catch { /* a hostile map object (throwing getters) leaves whatever was collected so far */ }
  const known = new Set();
  for (const key of ['ads', 'sponsor', 'playerControls']) for (const sel of groups[key]) known.add(sel.trim());
  const out = { kind: ALLOW_KIND, classes, ids, tags, attributes, protected: groups };
  Object.defineProperty(out, 'model', { value: buildModel(groups, []), enumerable: false });
  Object.defineProperty(out, 'known', { value: known, enumerable: false });
  return Object.freeze(out);
}

/** Accepts our own allow-list, or something list-like (sets/arrays of names or selector strings); anything else = cd- only. */
function normaliseAllow(input) {
  if (isObj(input) && input.kind === ALLOW_KIND && input.model) return input;
  const classes = new Set();
  const ids = new Set();
  const tags = new Set();
  const attributes = new Set();
  const names = (v) => (v instanceof Set ? [...v] : Array.isArray(v) ? v : []);
  try {
    if (input instanceof Set || Array.isArray(input)) {
      return buildAllowList({ roles: { all: names(input).filter((s) => typeof s === 'string').slice(0, MAX_ALLOW_SELECTORS) } });
    }
    if (isObj(input)) {
      for (const c of names(input.classes)) if (typeof c === 'string') classes.add(c.replace(/^\./, ''));
      for (const c of names(input.ids)) if (typeof c === 'string') ids.add(c.replace(/^#/, ''));
      for (const c of names(input.tags)) if (typeof c === 'string') tags.add(lc(c));
      for (const c of names(input.attributes || input.attrs)) if (typeof c === 'string') attributes.add(lc(c.replace(/^\[|\]$/g, '')));
    }
  } catch { /* fall through with what we have */ }
  const out = { kind: ALLOW_KIND, classes, ids, tags, attributes, protected: { ads: [], sponsor: [], playerControls: [], containers: [] } };
  Object.defineProperty(out, 'model', { value: newModel(), enumerable: false });
  Object.defineProperty(out, 'known', { value: new Set(), enumerable: false });
  return out;
}

// ---- reachability checks ------------------------------------------------------------------------------------------------

function attrMatches(op, v, c) {
  switch (op) {
    case '=': return c === v || ` ${c} `.includes(` ${v} `) || ` ${v} `.includes(` ${c} `);
    case '~=': return v !== '' && !/\s/.test(v) && c.split(/\s+/).includes(v);
    case '|=': return c === v || c.startsWith(`${v}-`);
    case '^=': return v !== '' && (c.startsWith(v) || (c !== '' && v.startsWith(c)));
    case '$=': return v !== '' && (c.endsWith(v) || (c !== '' && v.endsWith(c)));
    case '*=': return v !== '' && (c.includes(v) || (c !== '' && v.includes(c)));
    default: return false;
  }
}

/** Does this user attribute selector match the canonical form of some protected element? ([class*=ad] matches ytp-ad-module.) */
function attrReaches(u, model) {
  const canon = model.attr.get(u.lname);
  if (!canon) return false;
  if (model.attrAny.has(u.lname) || u.op === '') return true;
  const v = lc(u.value);
  for (const c of canon) if (attrMatches(u.op, v, c)) return true;
  return false;
}

function findProtectedInCompound(cp, model) {
  for (let i = 0; i < cp.simples.length; i++) {
    const s = cp.simples[i];
    switch (s.k) {
      case 'univ': return '*';
      case 'type':
        if (!s.lname.startsWith(CD_PREFIX) && model.tags.has(s.lname)) return s.name;
        break;
      case 'class':
        if (!s.lname.startsWith(CD_PREFIX) && model.classes.has(s.lname)) return `.${s.name}`;
        break;
      case 'id':
        if (!s.lname.startsWith(CD_PREFIX) && model.ids.has(s.lname)) return `#${s.name}`;
        break;
      case 'attr':
        if (!s.lname.startsWith(CD_PREFIX) && attrReaches(s, model)) return `[${s.name}${s.op}${s.op ? JSON.stringify(s.value) : ''}]`;
        break;
    }
  }
  return null;
}

function findProtectedInComplex(cx, model, neg) {
  for (let i = 0; i < cx.compounds.length; i++) {
    const cp = cx.compounds[i];
    if (!neg) {
      const hit = findProtectedInCompound(cp, model);
      if (hit) return hit;
    }
    for (let j = 0; j < cp.simples.length; j++) {
      const s = cp.simples[j];
      if (s.k === 'pseudo' && s.list) {
        const inner = s.name === 'not' ? !neg : neg;
        for (let k = 0; k < s.list.length; k++) {
          const hit = findProtectedInComplex(s.list[k], model, inner);
          if (hit) return hit;
        }
      }
    }
  }
  return null;
}

/** First simple selector of the (positive parts of the) complex selector that can reach a protected element, or null. */
function findProtectedRef(cx, model) {
  let found = findProtectedInComplex(cx, model, false);
  // What gets hidden is the subject. A subject that names nothing (":hover", ":not(.cd-a)") is every element, ads included.
  if (!found && !restricted(subjectOf(cx))) found = 'an unrestricted selector (it matches every element)';
  return found;
}

/** Does the compound name a tag, class, id or attribute (directly, or through an :is()-like list whose every member does)? */
function restricted(cp) {
  for (const s of cp.simples) {
    if (s.k === 'type' || s.k === 'class' || s.k === 'id' || s.k === 'attr') return true;
    if (s.k === 'pseudo' && IS_LIKE.has(s.name) && s.list && s.list.length && s.list.every((m) => restricted(subjectOf(m)))) return true;
  }
  return false;
}

/** html, body or :root (with any classes/attributes on it): the page root is never Cinedrape's own element. */
function isRootish(cp) {
  for (const s of cp.simples) {
    if (s.k === 'type' && (s.lname === 'html' || s.lname === 'body')) return true;
    if (s.k === 'pseudo' && s.name === 'root' && !s.fn) return true;
  }
  return false;
}

/** The set of canonical selectors a compound's :not(:has(...)) guards cover. */
function guardCover(simples) {
  const out = new Set();
  for (const s of simples) {
    if (s.k !== 'pseudo' || s.name !== 'not' || !s.list || s.list.length !== 1) continue;
    const cx = s.list[0];
    if (cx.compounds.length !== 1 || cx.compounds[0].simples.length !== 1) continue;
    const h = cx.compounds[0].simples[0];
    if (h.k === 'pseudo' && h.name === 'has' && h.list) for (const m of h.list) out.add(canonComplex(m));
  }
  return out;
}

const covers = (cover, adsCanon) => {
  if (adsCanon.size === 0) return false;
  for (const a of adsCanon) if (!cover.has(a)) return false;
  return true;
};

/**
 * Could the subject (rightmost compound) match an element that holds an ad (a protected.containers element or any generic element)
 * without carrying the full :not(:has(<protected ads>)) guard? Alternatives inside :is()/:where() are expanded.
 * @returns {boolean}
 */
function subjectNeedsGuard(cx, model) {
  const state = { budget: MAX_ALTERNATIVES };
  const alt = (simples, base) => {
    if (state.budget-- <= 0) return true;
    const info = { tag: base.tag, ids: base.ids.slice(), cover: new Set(base.cover), own: base.own, root: base.root || isRootish({ simples }), pending: base.pending.slice() };
    for (const s of simples) {
      if (s.k === 'type') {
        if (info.tag && info.tag !== s.lname) return false;
        info.tag = s.lname;
        if (s.lname.startsWith(CD_PREFIX)) info.own = true;
      } else if (s.k === 'id') {
        info.ids.push(s.name);
        if (s.name.startsWith(CD_PREFIX)) info.own = true;
      } else if (s.k === 'class') {
        if (s.name.startsWith(CD_PREFIX)) info.own = true;
      } else if (s.k === 'pseudo' && IS_LIKE.has(s.name) && s.list) info.pending.push(s.list);
    }
    for (const c of guardCover(simples)) info.cover.add(c);
    if (info.root) info.own = false;   // html.cd-x is still the page root, a cd- class on it does not make it ours
    if (info.own || covers(info.cover, model.adsCanon)) return false;
    if (info.pending.length) {
      const list = info.pending.pop();
      for (const m of list) if (alt(subjectOf(m).simples, info)) return true;
      return false;
    }
    const idHit = info.ids.some((id) => model.containerIds.has(lc(id)));
    if (info.tag && info.tag.includes('-')) return model.containerTags.has(info.tag) || idHit;
    if (info.ids.length) return idHit;
    return true;
  };
  return alt(subjectOf(cx).simples, { tag: '', ids: [], cover: new Set(), own: false, root: false, pending: [] });
}

/** Does any alternative of the subject target html/body/:root (hiding it hides the whole page)? */
function subjectIsRoot(cx) {
  let root = false;
  const visit = (simples) => {
    for (const s of simples) {
      if ((s.k === 'type' && (s.lname === 'html' || s.lname === 'body')) || (s.k === 'pseudo' && s.name === 'root')) root = true;
      if (s.k === 'pseudo' && IS_LIKE.has(s.name) && s.list) for (const m of s.list) visit(subjectOf(m).simples);
    }
  };
  visit(subjectOf(cx).simples);
  return root;
}

// ---- declaration classification -----------------------------------------------------------------------------------------
// classifyDecl() says whether one declaration can make an element invisible, collapsed, off screen, faded, obscured or
// unclickable ("hide") or can paint over other content ("overlay"). It works on decoded tokens, so d\isplay, \64isplay,
// DISPLAY, -webkit-clip-path and !important are all seen for what they are; it resolves var() through custom properties declared
// in the same stylesheet (plus var() fallbacks); anything it cannot evaluate in a sensitive property counts as hiding.

const H = (why) => ({ kind: 'hide', why });
const O = (why) => ({ kind: 'overlay', why });
const WIDE = /* @__PURE__ */ new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer', EXT_VAR]);

const NOOP = () => {};
const NODES_CACHE = new Map();
const MAX_NODES_CACHE = 4000;

/** Component values of a value string, whitespace dropped: id/num/pct/dim/str/hash/url/comma/delim/fn{name,args}/paren/blk. */
function buildNodes(text) {
  if (NODES_CACHE.has(text)) return NODES_CACHE.get(text);
  const toks = tokenize(text, NOOP);
  const match = matchBrackets(toks, NOOP);
  if (!match) {
    if (NODES_CACHE.size >= MAX_NODES_CACHE) NODES_CACHE.clear();
    NODES_CACHE.set(text, null);
    return null;
  }
  const conv = (lo, hi) => {
    const out = [];
    for (let i = lo; i < hi; i++) {
      const tk = toks[i];
      switch (tk.t) {
        case 'ws': break;
        case 'ident': out.push({ k: 'id', v: stripCtl(lc(tk.v)) }); break;
        case 'number': out.push({ k: 'num', v: tk.v }); break;
        case 'percentage': out.push({ k: 'pct', v: tk.v }); break;
        case 'dimension': out.push({ k: 'dim', v: tk.v, u: lc(tk.u) }); break;
        case 'string': out.push({ k: 'str', v: tk.v }); break;
        case 'hash': out.push({ k: 'hash', v: tk.v }); break;
        case 'url': out.push({ k: 'url', v: tk.v }); break;
        case ',': out.push({ k: 'comma' }); break;
        case 'delim': out.push({ k: 'delim', v: tk.v }); break;
        case 'function': {
          const close = match[i];
          out.push({ k: 'fn', name: stripVendor(stripCtl(lc(tk.v))), args: conv(i + 1, close) });
          i = close;
          break;
        }
        case '(': case '[': case '{': {
          const close = match[i];
          out.push({ k: tk.t === '(' ? 'paren' : 'blk', items: conv(i + 1, close) });
          i = close;
          break;
        }
        default: out.push({ k: 'other', v: tk.t });
      }
    }
    return out;
  };
  const res = conv(0, toks.length);
  if (NODES_CACHE.size >= MAX_NODES_CACHE) NODES_CACHE.clear();
  NODES_CACHE.set(text, res);
  return res;
}

const hasVar = (nodes) => nodes.some((n) => (n.k === 'fn' && (n.name === 'var' || hasVar(n.args))) || ((n.k === 'paren' || n.k === 'blk') && hasVar(n.items)));

/** All texts a value can take once var() is substituted (declared custom properties, fallbacks, or an inert stand-in). */
function expandVars(text, cc, depth, out) {
  const noop = () => {};
  const toks = tokenize(text, noop);
  const match = matchBrackets(toks, noop);
  if (!match) { out.push(text); return out.length <= MAX_VARIANTS; }
  let at = -1;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].t === 'function' && stripVendor(stripCtl(lc(toks[i].v))) === 'var') { at = i; break; }
  }
  if (at < 0) { out.push(text); return out.length <= MAX_VARIANTS; }
  const close = match[at];
  let k = at + 1;
  while (k < close && toks[k].t === 'ws') k++;
  const name = toks[k] && toks[k].t === 'ident' ? toks[k].v : null;
  let fallback = null;
  for (let j = k + 1; j < close; j++) {
    if (toks[j].t === ',') { fallback = text.slice(toks[j].e, toks[close].s); break; }
    if (isOpen(toks[j].t)) j = match[j];
  }
  const before = text.slice(0, toks[at].s);
  const after = text.slice(toks[close].e);
  const cands = [];
  // A chain or cycle deeper than the cap cannot be resolved; the caller treats that like too many combinations (conservative).
  if (depth >= MAX_VAR_DEPTH) return false;
  const declared = name && cc.custom.get(name);
  if (declared) for (const v of declared) cands.push(v);
  if (fallback !== null) cands.push(fallback);
  if (!cands.length) cands.push(EXT_VAR);
  for (const c of cands) if (!expandVars(`${before} ${c} ${after}`, cc, depth + 1, out)) return false;
  return true;
}

// ---- lengths -------------------------------------------------------------------------------------------------------------
// A length is {px, pct, vp, num}: px = absolute + font relative (1em = 16px), pct = percentages, vp = viewport/container units,
// num = non-null for a plain number. calc(), min(), max(), clamp() are evaluated into one or more such forms.

const ABS_UNITS = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };
const FONT_UNITS = /* @__PURE__ */ new Set(['em', 'rem', 'ex', 'rex', 'ch', 'rch', 'cap', 'rcap', 'ic', 'ric', 'lh', 'rlh']);
const VIEW_UNIT_RE = /^(?:[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max))$/;
const ANGLE_UNITS = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };
const form = (px = 0, pct = 0, vp = 0, num = null) => ({ px, pct, vp, num });

function evalLen(nd, depth = 0) {
  if (depth > 12) return null;
  switch (nd.k) {
    case 'num': return [form(0, 0, 0, nd.v)];
    case 'pct': return [form(0, nd.v)];
    case 'dim': {
      if (own(ABS_UNITS, nd.u)) return [form(nd.v * ABS_UNITS[nd.u])];
      if (FONT_UNITS.has(nd.u)) return [form(nd.v * 16)];
      if (VIEW_UNIT_RE.test(nd.u)) return [form(0, 0, nd.v)];
      return null;
    }
    case 'paren': return evalExpr(nd.items, depth + 1);
    case 'fn': {
      if (nd.name === 'calc' || nd.name === 'moz-calc') return evalExpr(nd.args, depth + 1);
      if (nd.name === 'min' || nd.name === 'max' || nd.name === 'clamp') {
        const out = [];
        let part = [];
        const flush = () => {
          const r = evalExpr(part, depth + 1);
          part = [];
          if (!r) return false;
          out.push(...r);
          return true;
        };
        for (const a of nd.args) {
          if (a.k === 'comma') { if (!flush()) return null; } else part.push(a);
        }
        if (!flush()) return null;
        return out.length > 32 ? null : out;
      }
      return null;
    }
    default: return null;
  }
}

function combine(A, B, op) {
  const out = [];
  for (const a of A) {
    for (const b of B) {
      if (op === '+' || op === '-') {
        const sg = op === '+' ? 1 : -1;
        if ((a.num === null) !== (b.num === null)) { if (!(a.num === 0 || b.num === 0)) return null; }
        out.push(form(a.px + sg * b.px, a.pct + sg * b.pct, a.vp + sg * b.vp, a.num !== null && b.num !== null ? a.num + sg * b.num : null));
      } else if (op === '*') {
        if (a.num === null && b.num === null) return null;
        const f = a.num !== null ? a.num : b.num;
        const t = a.num !== null ? b : a;
        out.push(form(t.px * f, t.pct * f, t.vp * f, t.num === null ? null : t.num * f));
      } else {
        if (b.num === null || b.num === 0) return null;
        out.push(form(a.px / b.num, a.pct / b.num, a.vp / b.num, a.num === null ? null : a.num / b.num));
      }
    }
  }
  return out.length > 32 ? null : out;
}

/** Evaluates the items of a calc()-like expression: + - * / with precedence and parentheses. Null when not understood. */
function evalExpr(items, depth) {
  if (!items || !items.length) return null;
  if (items.length === 1) return evalLen(items[0], depth + 1);
  if (items.length === 3 && items[1].k === 'delim') {
    const o = items[1].v;
    if (o === '+' || o === '-' || o === '*' || o === '/') {
      const a = evalLen(items[0], depth + 1);
      if (!a) return null;
      const b = evalLen(items[2], depth + 1);
      return b ? combine(a, b, o) : null;
    }
  }
  let pos = 0;
  function factor() {
    const nd = items[pos++];
    return nd ? evalLen(nd, depth + 1) : null;
  }
  function term() {
    let acc = factor();
    while (acc && pos < items.length) {
      const p = items[pos];
      if (p.k !== 'delim' || (p.v !== '*' && p.v !== '/')) break;
      pos++;
      const rhs = factor();
      acc = rhs ? combine(acc, rhs, p.v) : null;
    }
    return acc;
  }
  function sum() {
    let acc = term();
    while (acc && pos < items.length) {
      const p = items[pos];
      if (p.k !== 'delim' || (p.v !== '+' && p.v !== '-')) break;
      pos++;
      const rhs = term();
      acc = rhs ? combine(acc, rhs, p.v) : null;
    }
    return acc;
  }
  const r = sum();
  return r && pos === items.length ? r : null;
}

const isCollapsed = (f) => f.num === 0 || (f.num === null && f.px <= 1 && f.pct <= 0.1 && f.vp <= 0.1);
const reach = (f) => f.px + f.pct * 2 + f.vp * 10;   // how far a length moves things, in px (50% counts as 100px, 10vw as 100px)
const isFarAway = (f) => f.num === null && Math.abs(reach(f)) >= 1000;
const isTinyMax = (f) => f.num === 0 || (f.num === null && f.px <= 24 && f.pct <= 1 && f.vp <= 1);   // a max-* of a few px is a collapse too
const isTinyFont = (f) => f.num === 0 || (f.num === null && f.px + f.pct * 0.16 + f.vp * 10 <= 3);
const numValue = (nd) => {
  if (nd.k === 'num') return nd.v;
  if (nd.k === 'pct') return nd.v / 100;
  const r = evalLen(nd);
  if (r && r.length && r.every((f) => f.num !== null)) return r;
  return null;
};
const angleDeg = (nd) => (nd.k === 'dim' && own(ANGLE_UNITS, nd.u) ? nd.v * ANGLE_UNITS[nd.u] : nd.k === 'num' && nd.v === 0 ? 0 : null);
const edgeOn = (deg) => Math.abs((((deg % 180) + 180) % 180) - 90) < 1;
const args = (fn) => {
  const out = [[]];
  for (const a of fn.args) { if (a.k === 'comma') out.push([]); else out[out.length - 1].push(a); }
  return out.filter((x) => x.length);
};

// ---- handlers ------------------------------------------------------------------------------------------------------------

const idIn = (nodes, set) => nodes.find((n) => n.k === 'id' && set.has(n.v));
const isKeywordOnly = (nodes, ...words) => nodes.length === 1 && nodes[0].k === 'id' && (WIDE.has(nodes[0].v) || words.includes(nodes[0].v));

function lowAlpha(nd) {
  switch (nd.k) {
    case 'id': return nd.v === 'transparent';
    case 'hash':
      if (nd.v.length === 4) return parseInt(nd.v[3] + nd.v[3], 16) / 255 < 0.1;
      if (nd.v.length === 8) return parseInt(nd.v.slice(6), 16) / 255 < 0.1;
      return false;
    case 'fn': {
      if (nd.name === 'color-mix' || nd.name === 'light-dark') return nd.args.some((a) => a.k !== 'comma' && lowAlpha(a));
      if (!/^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)$/.test(nd.name)) return false;
      const slash = nd.args.findIndex((a) => a.k === 'delim' && a.v === '/');
      let alpha;
      if (slash >= 0) alpha = nd.args[slash + 1];
      else {
        const parts = args(nd);
        if (parts.length === 4) alpha = parts[3][0];
      }
      if (alpha === undefined) return false;
      if (alpha.k === 'num') return alpha.v < 0.1;
      if (alpha.k === 'pct') return alpha.v / 100 < 0.1;
      if (alpha.k === 'id') return alpha.v === 'none';
      const r = evalLen(alpha);
      if (r && r.every((f) => f.num !== null)) return r.some((f) => f.num < 0.1);
      return alpha.k === 'fn';
    }
    default: return false;
  }
}

const SCALE_FNS = /* @__PURE__ */ new Set(['scale', 'scale3d', 'scalex', 'scaley', 'scalez']);
const TRANSLATE_FNS = /* @__PURE__ */ new Set(['translate', 'translate3d', 'translatex', 'translatey', 'translatez']);

function scaleFinding(vals, what) {
  for (const v of vals) {
    const a = Math.abs(v);
    if (a < 0.25) return H('shrinks the element to (almost) nothing');
  }
  for (const v of vals) if (Math.abs(v) >= 5) return O('enlarges the element over its neighbours');
  return null;
}

function scaleValues(argNodes) {
  const vals = [];
  for (const nd of argNodes) {
    if (nd.k === 'comma' || nd.k === 'delim') continue;
    const r = numValue(nd);
    if (r === null) { if (nd.k === 'id') continue; return null; }
    if (Array.isArray(r)) vals.push(...r.map((f) => f.num)); else vals.push(r);
  }
  return vals;
}

function transformFinding(nodes) {
  for (const nd of nodes) {
    if (nd.k !== 'fn') continue;
    const name = nd.name;
    if (SCALE_FNS.has(name)) {
      const vals = scaleValues(nd.args);
      if (vals === null) return H(`uses ${name}() in a way that could not be evaluated`);
      const f = scaleFinding(vals, `${name}()`);
      if (f) return f;
    } else if (TRANSLATE_FNS.has(name)) {
      for (const nd2 of nd.args) {
        if (nd2.k === 'comma') continue;
        const r = evalLen(nd2);
        if (r && r.some(isFarAway)) return H('moves the element far off screen');
        if (r && r.some((x) => x.num === null && Math.abs(reach(x)) >= 160)) return O('moves the element far enough to land on top of other content');
      }
    } else if (name === 'matrix' || name === 'matrix3d') {
      const v = nd.args.filter((a) => a.k !== 'comma').map((a) => (a.k === 'num' ? a.v : NaN));
      if (name === 'matrix' && v.length === 6 && !v.some(Number.isNaN)) {
        if (Math.abs(v[0] * v[3] - v[1] * v[2]) < 0.01) return H('collapses the element (matrix)');
        if (Math.abs(v[4]) >= 1000 || Math.abs(v[5]) >= 1000) return H('moves the element far off screen');
      } else if (name === 'matrix3d' && v.length === 16 && !v.some(Number.isNaN)) {
        if (Math.abs(v[0]) < 0.1 || Math.abs(v[5]) < 0.1) return H('collapses the element (matrix3d)');
        if (Math.abs(v[12]) >= 1000 || Math.abs(v[13]) >= 1000) return H('moves the element far off screen');
      } else if (nd.args.some((a) => a.k === 'fn')) return H(`uses ${name}() in a way that could not be evaluated`);
    } else if (name === 'rotatex' || name === 'rotatey' || name === 'skewx' || name === 'skewy' || name === 'skew') {
      for (const nd2 of nd.args) { const d = angleDeg(nd2); if (d !== null && edgeOn(d)) return H('turns the element edge-on'); }
    } else if (name === 'rotate3d') {
      const a = nd.args.filter((x) => x.k !== 'comma');
      const d = a[3] ? angleDeg(a[3]) : null;
      const axisZ = a.length >= 3 && a[0].k === 'num' && a[1].k === 'num' && a[0].v === 0 && a[1].v === 0;
      if (d !== null && !axisZ && edgeOn(d)) return H('turns the element edge-on');
    }
  }
  return null;
}

function filterFinding(nodes) {
  for (const nd of nodes) {
    if (nd.k === 'id') { if (nd.v === 'none' || WIDE.has(nd.v)) continue; return H('uses a filter keyword that is not understood'); }
    if (nd.k !== 'fn') return H('uses a filter value that is not understood');
    const a = args(nd);
    const first = a.length ? a[0][0] : null;
    const amount = first ? (first.k === 'num' ? first.v : first.k === 'pct' ? first.v / 100 : NaN) : 1;
    switch (nd.name) {
      case 'opacity': if (!(amount >= 1)) return H('fades the element (filter: opacity)'); break;
      case 'blur': {
        const r = first ? evalLen(first) : null;
        if (first && !(r && r.every((f) => f.num === 0 || (f.num === null && f.px <= 1 && f.pct === 0 && f.vp === 0)))) return H('obscures the element (filter: blur)');
        break;
      }
      case 'brightness': if (!(amount >= 0.3 && amount <= 3)) return H('washes the element out (filter: brightness)'); break;
      case 'contrast': if (!(amount >= 0.2)) return H('flattens the element (filter: contrast)'); break;
      case 'grayscale': case 'sepia': case 'invert': case 'saturate': case 'hue-rotate': case 'drop-shadow': break;
      default: return H(`uses the filter ${nd.name}(), which is not understood`);
    }
  }
  return null;
}

function clipPathFinding(nodes) {
  if (isKeywordOnly(nodes, 'none')) return null;
  if (nodes.length === 1 && nodes[0].k === 'fn' && nodes[0].name === 'inset') {
    const round = nodes[0].args.findIndex((a) => a.k === 'id' && a.v === 'round');
    const edges = round >= 0 ? nodes[0].args.slice(0, round) : nodes[0].args;
    if (edges.length && edges.every((e) => { const r = evalLen(e); return r && r.every((f) => (f.num === 0 || f.num === null) && f.px <= 0 && f.pct <= 0 && f.vp <= 0 && f.px >= 0 && f.pct >= 0); })) return null;
  }
  return H('can clip the element away');
}

function clipFinding(nodes) {
  if (isKeywordOnly(nodes, 'auto')) return null;
  if (nodes.length === 1 && nodes[0].k === 'fn' && nodes[0].name === 'rect' && nodes[0].args.every((a) => a.k === 'comma' || (a.k === 'id' && a.v === 'auto'))) return null;
  return H('can clip the element away');
}

function fontSizeFinding(nd) {
  if (!nd || nd.k === 'id') return null;
  const r = evalLen(nd);
  return r && r.some(isTinyFont) ? H('makes text invisible (font-size of about zero)') : null;
}

function fontFinding(nodes) {
  for (const nd of nodes) {
    if (nd.k === 'delim' && nd.v === '/') break;
    if (nd.k === 'dim' || nd.k === 'pct' || nd.k === 'fn' || (nd.k === 'num' && nd.v === 0)) return fontSizeFinding(nd);
  }
  return null;
}

function flexFinding(nodes) {
  if (!nodes.length || nodes[0].k === 'id') return null;
  const nums = nodes.filter((n) => n.k === 'num');
  const lens = nodes.filter((n) => n.k === 'dim' || n.k === 'pct' || n.k === 'fn');
  const grow = nums.length ? nums[0].v : 1;
  let collapsed;
  if (lens.length) { const r = evalLen(lens[0]); collapsed = !!r && r.some(isCollapsed); } else collapsed = nums.length === 3 ? nums[2].v === 0 : true;
  return grow === 0 && collapsed ? H('collapses the element (flex: 0 0 0)') : null;
}

function trackFinding(nodes) {
  const zero = (nd) => {
    if (nd.k === 'fn') {
      if (nd.name === 'minmax') {
        const a = args(nd);
        return a[1] ? a[1].some((x) => zero(x)) : false;
      }
      if (nd.name === 'repeat') {
        const a = args(nd);
        return a.slice(1).some((part) => part.some((x) => zero(x)));
      }
      if (nd.name === 'fit-content') return nd.args.some((x) => zero(x));
      return false;
    }
    if (nd.k === 'dim' || nd.k === 'pct' || nd.k === 'num') { const r = evalLen(nd); return !!r && r.some(isCollapsed); }
    return false;
  };
  return nodes.some((nd) => zero(nd)) ? H('collapses the items in a zero-size grid track') : null;
}

function shadowFinding(nodes, what) {
  const big = (nd) => {
    if (nd.k === 'fn' && nd.name !== 'calc' && nd.name !== 'min' && nd.name !== 'max' && nd.name !== 'clamp') return nd.args.some(big);
    if (nd.k === 'dim' || nd.k === 'fn' || nd.k === 'paren') { const r = evalLen(nd); return !!r && r.some(isFarAway); }
    return false;
  };
  return nodes.some(big) ? O('is large enough to paint over other content') : null;
}

function animationFinding(prop, nodes, cc) {
  const KEYWORDS = new Set(['none', 'normal', 'reverse', 'alternate', 'alternate-reverse', 'forwards', 'backwards', 'both', 'infinite',
    'running', 'paused', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'step-start', 'step-end', ...WIDE]);
  const names = [];
  for (const nd of nodes) {
    if (nd.k === 'str') names.push(nd.v);
    else if (nd.k === 'id' && (prop === 'animation-name' ? nd.v !== 'none' : !KEYWORDS.has(nd.v))) names.push(nd.v);
  }
  for (const name of names) {
    if (name === EXT_VAR) continue;
    if (cc.kf.has(name)) { if (cc.kf.get(name)) return H(`runs the animation "${name}", which hides or fades the element`); continue; }
    if (!name.startsWith(CD_PREFIX)) return H(`runs the animation "${name}", which is defined outside the theme and could hide the element`);
  }
  return null;
}

function colorFinding(nodes) {
  return nodes.some((n) => lowAlpha(n)) ? H('makes text or icons transparent') : null;
}

const SIZE_PROPS = /* @__PURE__ */ new Set(['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'inline-size', 'block-size',
  'min-inline-size', 'min-block-size', 'max-inline-size', 'max-block-size']);
const OFFSET_RE = /* @__PURE__ */ new RegExp('^(?:left|right|top|bottom|inset(?:-(?:block|inline)(?:-(?:start|end))?)?'
  + '|(?:margin|padding|scroll-margin|scroll-padding)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?'
  + '|text-indent|translate|object-position|background-position(?:-[xy])?|letter-spacing|word-spacing'
  + '|(?:grid-)?(?:row-|column-)?gap|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?-width|outline-offset)$');
const PULL_RE = /^(?:left|right|top|bottom|inset.*|margin.*)$/;   // offsets that can drag an element over its neighbours
const MASK_RE = /^mask(?:-image|-border|-border-source)?$/;
const OPACITY_PROPS = /* @__PURE__ */ new Set(['opacity', 'fill-opacity', 'stroke-opacity', 'flood-opacity', 'stop-opacity']);
const COLOR_PROPS = /* @__PURE__ */ new Set(['color', 'text-fill-color', 'fill', 'stroke']);
const SHADOW_PROPS = /* @__PURE__ */ new Set(['box-shadow', 'outline', 'outline-width']);
const TRACK_PROPS = /* @__PURE__ */ new Set(['grid-template-columns', 'grid-template-rows', 'grid-auto-columns', 'grid-auto-rows']);

const SWITCH_PROPS = /* @__PURE__ */ new Set(['all', 'display', 'visibility', 'content-visibility', 'pointer-events', 'contain', 'clip', 'clip-path',
  'filter', 'backdrop-filter', 'font-size', 'font', 'font-size-adjust', 'zoom', 'flex', 'transform', 'scale', 'rotate', 'position', 'z-index',
  'mix-blend-mode', 'content', 'animation', 'animation-name']);
const relevantProp = (p) => SWITCH_PROPS.has(p) || OPACITY_PROPS.has(p) || SIZE_PROPS.has(p) || COLOR_PROPS.has(p) || SHADOW_PROPS.has(p)
  || TRACK_PROPS.has(p) || OFFSET_RE.test(p) || MASK_RE.test(p);

/** One declaration -> null | {kind:'hide'|'overlay', why}. `prop` is lower case without a vendor prefix. */
function classifyNodes(prop, nodes, cc) {
  if (!nodes.length) return null;
  if (prop === 'all') return H('resets every property, including the ones that keep an element visible');
  if (isKeywordOnly(nodes) && prop !== 'content') return null;
  if (OPACITY_PROPS.has(prop)) {
    const nd = nodes[0];
    if (nd.k === 'id') return null;
    const v = numValue(nd);
    if (v === null) return H('has a value that could not be evaluated');
    const min = Array.isArray(v) ? Math.min(...v.map((f) => f.num)) : v;
    return min < 1 ? H('fades the element (opacity below 1)') : null;
  }
  if (SIZE_PROPS.has(prop)) {
    if (prop.startsWith('min-')) return null;   // a minimum can only make a box bigger; 0 is the initial value
    const collapsed = prop.startsWith('max-') ? isTinyMax : isCollapsed;
    for (const nd of nodes) { if (nd.k === 'id') continue; const r = evalLen(nd); if (r && r.some(collapsed)) return H('collapses the element (zero size)'); }
    return null;
  }
  if (OFFSET_RE.test(prop)) {
    const pulls = PULL_RE.test(prop);
    for (const nd of nodes) {
      const r = nd.k === 'id' || nd.k === 'comma' || nd.k === 'delim' ? null : evalLen(nd);
      if (!r) continue;
      if (r.some(isFarAway)) return H('pushes the element or its content far off screen');
      if (pulls && r.some((x) => x.num === null && reach(x) <= -100)) return O('pulls the element over its neighbours');
      if (prop === 'translate' && r.some((x) => x.num === null && Math.abs(reach(x)) >= 160)) return O('moves the element far enough to land on top of other content');
    }
    return null;
  }
  if (MASK_RE.test(prop)) return isKeywordOnly(nodes, 'none') ? null : H('can hide parts of the element (mask)');
  if (COLOR_PROPS.has(prop)) return colorFinding(nodes);
  if (SHADOW_PROPS.has(prop)) return shadowFinding(nodes, prop);
  if (TRACK_PROPS.has(prop)) return trackFinding(nodes);
  switch (prop) {
    case 'display': {
      const nd = idIn(nodes, new Set(['none', 'contents', 'table-column', 'table-column-group']));
      return nd ? H("removes the element's box") : null;
    }
    case 'visibility': {
      const nd = idIn(nodes, new Set(['hidden', 'collapse']));
      return nd ? H('hides the element') : null;
    }
    case 'content-visibility': return idIn(nodes, new Set(['hidden'])) ? H('hides the element') : null;
    case 'pointer-events': return idIn(nodes, new Set(['none'])) ? H('makes the element unclickable') : null;
    case 'contain': return idIn(nodes, new Set(['size', 'inline-size', 'strict'])) ? H('collapses the element (contain: size)') : null;
    case 'clip': return clipFinding(nodes);
    case 'clip-path': return clipPathFinding(nodes);
    case 'filter': case 'backdrop-filter': return filterFinding(nodes);
    case 'font-size': return fontSizeFinding(nodes[0]);
    case 'font': return fontFinding(nodes);
    case 'font-size-adjust': return nodes[0].k === 'num' && nodes[0].v === 0 ? H('makes text invisible') : null;
    case 'zoom': {
      if (nodes[0].k === 'id') return null;
      const v = numValue(nodes[0]);
      if (v === null) return H('has a value that could not be evaluated');
      return (Array.isArray(v) ? Math.min(...v.map((f) => f.num)) : v) <= 0.05 ? H('hides the element (zoom of about zero)') : null;
    }
    case 'flex': return flexFinding(nodes);
    case 'transform': return transformFinding(nodes);
    case 'scale': {
      const vals = scaleValues(nodes);
      return vals === null ? H('has a value that could not be evaluated') : scaleFinding(vals, 'scale');
    }
    case 'rotate': {
      const axis = nodes.find((n) => n.k === 'id' && (n.v === 'x' || n.v === 'y'));
      const ang = nodes.map(angleDeg).find((d) => d !== null);
      return axis && ang !== undefined && edgeOn(ang) ? H('turns the element edge-on') : null;
    }
    case 'position': return idIn(nodes, new Set(['fixed', 'absolute'])) ? O('can place the element over other content') : null;
    case 'z-index': {
      if (nodes[0].k === 'id') return null;
      const v = numValue(nodes[0]);
      if (v === null) return O('has a value that could not be evaluated');
      const n = Array.isArray(v) ? v.map((f) => f.num) : [v];
      if (n.some((x) => x <= -1)) return H('can put the element behind the page');
      return n.some((x) => x >= 1) ? O('can raise the element over other content') : null;
    }
    case 'mix-blend-mode': return idIn(nodes, new Set(['normal'])) ? null : H('can make the element unreadable');
    case 'content': return nodes.some((n) => n.k === 'url' || (n.k === 'fn' && /^(?:url|image-set|(?:repeating-)?(?:linear|radial|conic)-gradient)$/.test(n.name)))
      ? H('replaces what the element shows with an image') : null;
    case 'animation': case 'animation-name': return animationFinding(prop, nodes, cc);
    default: return null;
  }
}

/**
 * @param {{custom: boolean, prop: string, text: string}} d
 * @param {{custom: Map<string,string[]>, kf: Map<string,boolean>}} cc
 */
function classifyDecl(d, cc) {
  if (d.custom || !relevantProp(d.prop)) return null;
  const cacheKey = cc?.classifyCache && `${d.prop}\0${d.text}`;
  if (cacheKey && cc.classifyCache.has(cacheKey)) return cc.classifyCache.get(cacheKey);
  const nodes = d.nodes || (d.nodes = buildNodes(d.text));
  if (!nodes) {
    const res = H('has a value that could not be understood');
    if (cacheKey) cc.classifyCache.set(cacheKey, res);
    return res;
  }
  const needsVar = d.hasVar !== undefined ? d.hasVar : (d.hasVar = hasVar(nodes));
  if (!needsVar) {
    const res = classifyNodes(d.prop, nodes, cc);
    if (cacheKey) cc.classifyCache.set(cacheKey, res);
    return res;
  }
  const texts = [];
  if (!expandVars(d.text, cc, 0, texts)) {
    const res = H('uses too many var() combinations to check');
    if (cacheKey) cc.classifyCache.set(cacheKey, res);
    return res;
  }
  for (const t of texts) {
    const nd = t === d.text ? nodes : buildNodes(t);
    if (!nd) {
      const res = H('has a value that could not be understood');
      if (cacheKey) cc.classifyCache.set(cacheKey, res);
      return res;
    }
    const f = classifyNodes(d.prop, nd, cc);
    if (f) {
      if (cacheKey) cc.classifyCache.set(cacheKey, f);
      return f;
    }
  }
  if (cacheKey) cc.classifyCache.set(cacheKey, null);
  return null;
}

/**
 * Introspection for tests and tools: does `property: value` hide or cover things? Returns null or a reason string.
 * @param {string} property @param {string} value
 */
export function describeHiding(property, value) {
  try {
    const name = stripCtl(lc(String(property).replace(/\/\*[\s\S]*?\*\//g, '')));
    const tokens = tokenize(name, () => {});
    const ident = tokens.filter((t) => t.t === 'ident').map((t) => stripCtl(lc(t.v))).join('');
    const prop = stripVendor(ident || name);
    const found = classifyDecl({ custom: false, prop, text: String(value).replace(/!\s*important\s*$/i, '') }, { custom: new Map(), kf: new Map() });
    return found ? found.why : null;
  } catch {
    return 'could not be checked';
  }
}

// ---- blocked constructs: urls, functions, strings -----------------------------------------------------------------------

const RESOURCE_FNS = /* @__PURE__ */ new Set(['image-set', 'image', 'src', 'cross-fade', 'paint', 'element']);
const SCRIPT_URL_RE = /(?:java|vb)script:/i;
const BIDI_RE = /[‪-‮⁦-⁩]/;

const shorten = (s, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}...` : s);
const safeChr = (cp) => (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '?');

function scanSvg(text) {
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  let x = text
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => safeChr(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => safeChr(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos);/gi, (_, n) => ENT[n.toLowerCase()]);
  if (x.includes('\\')) return 'backslash escapes are not allowed inside an SVG image';
  x = x.replace(/xmlns(?::[\w-]+)?\s*=\s*(["'])http:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink)\1/gi, '');
  if (/<\s*(?:script|foreignobject|iframe|object|embed|animate|set|handler|listener)\b/i.test(x) || /<!\s*(?:doctype|entity)/i.test(x) || /<\?xml-stylesheet/i.test(x) || /@import/i.test(x)) {
    return 'this SVG contains scripts, external entities or other active content';
  }
  if (/\bon[a-z]+\s*=/i.test(x)) return 'this SVG contains an event handler attribute';
  if (/(?:^|[^\w:])(?:https?|ftp|file|wss?|data|blob|javascript):/i.test(x) || /["'(\s=]\/\/[\w.-]/.test(x)) {
    return 'this SVG refers to an external resource (http, https, ...)';
  }
  for (const m of x.matchAll(/(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const v = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!v.startsWith('#')) return 'this SVG has an href that does not point at a #fragment';
  }
  for (const m of x.matchAll(/url\(\s*(['"]?)\s*([^)'"]*)/gi)) {
    if (!m[2].trim().startsWith('#')) return 'this SVG has a url() that does not point at a #fragment';
  }
  return null;
}

function svgViolation(payload, header) {
  const why = (m) => `An SVG data: image must be self-contained: ${m}`;
  let text;
  if (/;base64$/i.test(header)) {
    if (typeof atob !== 'function') return why('base64 SVGs cannot be checked in this environment');
    try { text = atob(payload.replace(/[\u0000- ]+/g, '')); } catch { return why('the base64 data is not valid'); }
  } else {
    try { text = decodeURIComponent(payload); } catch { text = payload; }
    const raw = scanSvg(payload);
    if (raw) return why(raw);
  }
  const bad = scanSvg(text);
  return bad ? why(bad) : null;
}

/** Null when `raw` (the value of a url()) is allowed, else the reason. Allowed: data:image/(png|jpeg|webp|svg+xml) and (chrome|moz)-extension://. */
function urlViolation(raw) {
  const trimmed = raw.replace(/^[\u0000- ]+/, '');
  const comma = trimmed.indexOf(',');
  const header = (comma < 0 ? trimmed : trimmed.slice(0, comma)).replace(/[\u0000- \u007f]+/g, '');
  const m = /^data:image\/(png|jpeg|webp|svg\+xml)((?:;[^;,]*)*)$/i.exec(header);
  if (m && comma >= 0) return m[1].toLowerCase() === 'svg+xml' ? svgViolation(trimmed.slice(comma + 1), m[2]) : null;
  const flat = trimmed.replace(/[\u0000- \u007f]+/g, '');
  if (/^(?:chrome|moz)-extension:\/\//i.test(flat)) return null;
  return `url() may only point at data:image/png|jpeg|webp|svg+xml, chrome-extension:// or moz-extension:// (found "${shorten(flat, 40)}")`;
}

/** Reports every blocked construct in toks[lo, hi): bad urls, expression(), image functions that fetch, javascript:, bidi tricks. */
function checkTokens(S, lo, hi) {
  const { toks } = S;
  let found = 0;
  const report = (...a) => { found++; S.report(...a); };
  for (let i = lo; i < hi; i++) {
    const tk = toks[i];
    switch (tk.t) {
      case 'url': {
        const bad = urlViolation(tk.v);
        if (bad) report(tk.s, bad, 'url');
        break;
      }
      case 'function': {
        const name = stripVendor(stripCtl(lc(tk.v)));
        if (name === 'url') {
          let j = i + 1;
          while (j < hi && toks[j].t === 'ws') j++;
          const arg = toks[j];
          if (arg && arg.t === 'string') {
            const bad = urlViolation(arg.v);
            if (bad) report(tk.s, bad, 'url');
          } else report(tk.s, 'url() needs a quoted string or a plain url', 'url');
        } else if (name === 'expression') report(tk.s, 'expression() is not allowed', 'expression');
        else if (RESOURCE_FNS.has(name)) report(tk.s, `${name}() is not allowed; use url("data:image/...") for images`, 'url');
        else if (name === 'attr') {
          for (let j = i + 1; j < S.match[i]; j++) {
            const a = toks[j];
            if ((a.t === 'ident' && lc(a.v) === 'url') || (a.t === 'function' && lc(a.v) === 'type')) { report(tk.s, 'attr() may not load urls', 'url'); break; }
          }
        }
        break;
      }
      case 'ident': {
        const len = tk.v.length;
        if (len === 6 || len === 8 || len === 10) {
          const c0 = tk.v.charCodeAt(0) | 32;
          if (c0 === 101 || c0 === 112 || c0 === 106 || c0 === 118) {
            const v = stripCtl(lc(tk.v));
            if (v === 'expression') report(tk.s, 'expression() is not allowed', 'expression');
            else if (v === 'progid') report(tk.s, 'progid: filters are not allowed', 'expression');
            else if (v === 'javascript' || v === 'vbscript') {
              let j = i + 1;
              while (j < hi && toks[j].t === 'ws') j++;
              if (j < hi && toks[j].t === ':') report(tk.s, `${v}: is not allowed`, 'javascript');
            }
          }
        }
        break;
      }
      case 'string':
        if (SCRIPT_URL_RE.test(tk.v.replace(/[\u0000- \u007f]+/g, ''))) report(tk.s, 'javascript: is not allowed', 'javascript');
        break;
      case '{': report(tk.s, 'Unexpected "{" in a value', 'syntax'); break;
      default:
    }
  }
  return found;
}

/** content and custom properties are the only way to get free text onto the page, so cap how much text they can carry. */
function checkStringLength(S, lo, hi, off, what) {
  const { toks, report } = S;
  let total = 0;
  for (let k = lo; k < hi; k++) {
    if (toks[k].t !== 'string') continue;
    let p = k - 1;
    while (p >= lo && toks[p].t === 'ws') p--;
    if (p >= lo && toks[p].t === 'function' && lc(toks[p].v) === 'url') continue;
    total += Array.from(toks[k].v).length;
  }
  if (total > LIMITS.contentMaxChars) report(off, `${what} carries ${total} characters of text; the limit is ${LIMITS.contentMaxChars}`, 'content');
}

// ---- stylesheet parser --------------------------------------------------------------------------------------------------

const GROUP_AT_RULES = /* @__PURE__ */ new Set(['media', 'supports', 'container', 'starting-style']);

function skipPrelude(S, i, hi) {
  const { toks, match } = S;
  let j = i;
  while (j < hi) {
    const t = toks[j].t;
    if (t === ';' || t === '{') break;
    j = t === '(' || t === 'function' || t === '[' || t === '{' ? match[j] + 1 : j + 1;
  }
  return j;
}

function parseStylesheet(S, lo, hi, level) {
  const { toks, report } = S;
  let i = lo;
  while (i < hi) {
    const tk = toks[i];
    if (tk.t === 'ws') { i++; continue; }
    if (tk.t === 'cdo' || tk.t === 'cdc') { report(tk.s, `"${tk.t === 'cdo' ? '<!--' : '-->'}" is not allowed`, 'syntax'); i++; continue; }
    if (tk.t === ';') { report(tk.s, 'Unexpected ";"', 'syntax'); i++; continue; }
    i = tk.t === 'at' ? parseAtRule(S, i, hi, level) : parseQualifiedRule(S, i, hi);
  }
}

function parseAtRule(S, i, hi, level) {
  const { toks, match, report } = S;
  const tk = toks[i];
  const base = stripCtl(lc(tk.v));
  const j = skipPrelude(S, i + 1, hi);
  const hasBlock = j < hi && toks[j].t === '{';
  const blockEnd = hasBlock ? match[j] : -1;
  const next = hasBlock ? blockEnd + 1 : (j < hi ? j + 1 : hi);
  if (/^(?:-(?:webkit|moz|o|ms)-)?keyframes$/.test(base)) {
    checkTokens(S, i + 1, j);
    const named = toks.slice(i + 1, j).filter((t) => t.t !== 'ws');
    if (named.length !== 1 || (named[0].t !== 'ident' && named[0].t !== 'string')) {
      report(tk.s, '@keyframes needs exactly one name', 'keyframes');
    } else if (!named[0].v.startsWith(CD_PREFIX)) {
      report(named[0].s, `@keyframes names must start with "${CD_PREFIX}" (found "${shorten(named[0].v, 30)}")`, 'keyframes');
    }
    if (!hasBlock) report(tk.s, '@keyframes needs a { } block', 'syntax');
    else if (level + 1 >= MAX_BLOCK_DEPTH) report(tk.s, 'At-rules are nested too deeply', 'syntax');
    else if (named.length === 1 && (named[0].t === 'ident' || named[0].t === 'string')) parseKeyframes(S, j + 1, blockEnd, named[0].v);
  } else if (GROUP_AT_RULES.has(base) || base === 'layer') {
    checkTokens(S, i + 1, j);
    if (!hasBlock) {
      if (base !== 'layer') report(tk.s, `@${base} needs a { } block`, 'syntax');
    } else if (level + 1 >= MAX_BLOCK_DEPTH) report(tk.s, 'At-rules are nested too deeply', 'syntax');
    else parseStylesheet(S, j + 1, blockEnd, level + 1);
  } else {
    report(tk.s, `@${base} is not allowed`, 'at-rule');
  }
  return next;
}

function parseKeyframes(S, lo, hi, name) {
  const { toks, match, report } = S;
  let entry = S.keyframes.get(name);
  if (!entry) { entry = { decls: [] }; S.keyframes.set(name, entry); }
  let i = lo;
  while (i < hi) {
    if (toks[i].t === 'ws') { i++; continue; }
    const j = skipPrelude(S, i, hi);
    if (j >= hi || toks[j].t !== '{') { report(toks[i].s, 'Expected "{" after the keyframe selector', 'syntax'); return; }
    for (let k = i; k < j; k++) {
      const t = toks[k];
      const ok = t.t === 'ws' || t.t === ',' || t.t === 'percentage' || (t.t === 'ident' && /^(?:from|to)$/i.test(t.v));
      if (!ok) { report(t.s, 'A keyframe selector must be from, to or a percentage', 'keyframes'); break; }
    }
    parseDeclarations(S, j + 1, match[j], entry);
    i = match[j] + 1;
  }
}

function parseQualifiedRule(S, i, hi) {
  const { toks, match, report } = S;
  const j = skipPrelude(S, i, hi);
  if (j >= hi || toks[j].t !== '{') {
    report(toks[i].s, 'Expected "{" after the selector', 'syntax');
    return j < hi ? j + 1 : hi;
  }
  const blockEnd = match[j];
  const sels = parseSelectorList(S, i, j, 0, false);
  const rec = { sels, decls: [], off: toks[i].s, end: toks[blockEnd].e };
  S.rules.push(rec);
  parseDeclarations(S, j + 1, blockEnd, rec);
  return blockEnd + 1;
}

function parseDeclarations(S, lo, hi, rec) {
  const { toks, match, report } = S;
  let i = lo;
  while (i < hi) {
    const tk = toks[i];
    if (tk.t === 'ws' || tk.t === ';') { i++; continue; }
    const end = skipPrelude(S, i, hi);
    if (tk.t === 'at') {
      report(tk.s, `Nested rules such as @${stripCtl(lc(tk.v))} are not supported inside a rule`, 'syntax');
      i = end < hi && toks[end].t === '{' ? match[end] + 1 : end + 1;
      continue;
    }
    if (end < hi && toks[end].t === '{') {
      report(tk.s, 'Nested rules are not supported; write each rule on its own', 'syntax');
      i = match[end] + 1;
      continue;
    }
    parseDeclaration(S, i, end, rec);
    i = end + 1;
  }
}

function parseDeclaration(S, lo, hi, rec) {
  const { toks, report } = S;
  let a = lo;
  while (a < hi && toks[a].t === 'ws') a++;
  const nameTok = toks[a];
  if (nameTok.t !== 'ident') {
    report(nameTok.s, 'Expected a property name', 'syntax');
    checkTokens(S, a, hi);
    return;
  }
  let b = a + 1;
  while (b < hi && toks[b].t === 'ws') b++;
  if (b < hi && toks[b].t === ':') { addDeclaration(S, rec, nameTok.v, nameTok.s, b + 1, hi); return; }
  // "dis/**/play: none": a comment or escape splits the name. A browser drops it; we refuse it, and still judge it as "display".
  let c = a;
  let joined = '';
  while (c < hi && (toks[c].t === 'ident' || toks[c].t === 'ws')) { if (toks[c].t === 'ident') joined += toks[c].v; c++; }
  if (c < hi && toks[c].t === ':') {
    report(nameTok.s, 'A comment or whitespace is splitting this property name', 'syntax');
    addDeclaration(S, rec, joined, nameTok.s, c + 1, hi);
  } else {
    report(nameTok.s, `Expected ":" after the property name "${shorten(nameTok.v, 30)}"`, 'syntax');
    checkTokens(S, a, hi);
  }
}

function addDeclaration(S, rec, rawName, off, vlo, vhi) {
  const { toks, report, src } = S;
  while (vlo < vhi && toks[vlo].t === 'ws') vlo++;
  while (vhi > vlo && toks[vhi - 1].t === 'ws') vhi--;
  if (vhi - vlo >= 2 && toks[vhi - 1].t === 'ident' && lc(toks[vhi - 1].v) === 'important') {
    let m = vhi - 2;
    while (m >= vlo && toks[m].t === 'ws') m--;
    if (m >= vlo && toks[m].t === 'delim' && toks[m].v === '!') {
      vhi = m;
      while (vhi > vlo && toks[vhi - 1].t === 'ws') vhi--;
    }
  }
  for (let k = vlo; k < vhi; k++) {
    if (toks[k].t === 'delim' && toks[k].v === '!') report(toks[k].s, 'Unexpected "!" (only a trailing !important is allowed)', 'syntax');
  }
  const custom = rawName.startsWith('--');
  const lraw = stripCtl(lc(rawName));
  const prop = custom ? rawName : stripVendor(lraw);
  if (!custom && prop === 'position') rec.hasPos = true;
  if (!custom && (prop === 'behavior' || (lraw.startsWith('-moz-') && prop === 'binding'))) report(off, `${shorten(lraw, 30)} is not allowed`, 'blocked-property');
  if (vlo >= vhi && !custom) report(off, `"${shorten(rawName, 30)}" has no value`, 'syntax');
  const blocked = checkTokens(S, vlo, vhi) > 0;   // already refused for what it is: the allow-list does not say it again
  if (custom) checkStringLength(S, vlo, vhi, off, `The custom property "${shorten(rawName, 30)}"`);
  else if (prop === 'content') checkStringLength(S, vlo, vhi, off, 'The content value');
  const text = vlo < vhi ? src.slice(toks[vlo].s, toks[vhi - 1].e) : '';
  if (custom) {
    const list = S.custom.get(rawName);
    if (!list) S.custom.set(rawName, [text]);
    else if (list.length < 8) list.push(text);
    else if (list.length === 8) list.push(EXT_VAR);   // more declarations than can be tracked: whatever uses it cannot be judged
  }
  rec.decls.push({
    prop, custom, off, text, blocked,
    get display() {
      return this._d || (this._d = shorten(`${rawName.trim()}: ${text}`.replace(/\s+/g, ' '), 70));
    },
    get declKey() {
      return this._dk || (this._dk = `${prop}\0${text}`);
    }
  });
}

// ---- allow-list profile: what a theme may do ------------------------------------------------------------------------------
// The deny-list classifier above answers "does this declaration hide something?" and can never be complete: CSS has too many ways to
// move, shrink, clip, cover or fade a box (rotateY(180deg) + backface-visibility, zoom, env(), round(), keyframed sizes, ...). For
// theme CSS the question is turned around. A declaration is accepted only when its PROPERTY is on a short list for the kind of
// element it styles and its VALUE is fully understood and inside a bound; everything else is refused (fail closed), so a CSS
// feature nobody has heard of yet cannot be a bypass.
//
//   foreign    the rightmost compound is not a cd- element (a YouTube element, html, a pseudo-element of one): colours, borders,
//              radius, small shadows, text styling and transitions of those. No geometry, display, visibility, opacity, transform,
//              filter, clip, mask, overflow, position, z-index or font-size. Colours are theme tokens (var(--cd-*)) only.
//   container  Cinedrape's boxes that sit in the page flow next to the ad-bearing feed (.cd-home .cd-rows .cd-row .cd-hero .cd-notice):
//              colours, typography, radius, bounded shadow, bounded padding and margin. No size, position, display, transform.
//   part       every other cd- element: the same plus layout inside the box, with every length bounded so that a part cannot push the
//              feed away or paint over it. position:absolute only on the parts that are absolute in the engine's own CSS.
// Custom properties: only --cd-t-<name> (and --cd-heading-font with a font from a short list). Values of those are judged where used.

const THEME_VAR_RE = /^--cd-t-[a-z0-9-]+$/;
const HEADING_FONT_VAR = '--cd-heading-font';
const INK_TOKENS = /* @__PURE__ */ new Set(['--cd-text', '--cd-muted', '--cd-accent', '--cd-accent-text']);
const PAINT_TOKENS = /* @__PURE__ */ new Set(['--cd-bg', '--cd-surface', '--cd-menu', '--cd-accent', '--cd-accent-hover', '--cd-hover',
  '--cd-active', '--cd-scrim']);   // backgrounds (var(--cd-border) is for lines, never for a surface)
const ICON_TOKENS = /* @__PURE__ */ new Set(['--cd-text', '--cd-muted', '--cd-accent']);   // fill/stroke: only colours that read on the page background
// var() names that stay symbolic while a value is judged: the engine writes them from validated tokens and a theme cannot declare them.
const KEEP_VARS = /* @__PURE__ */ new Set([...INK_TOKENS, ...PAINT_TOKENS, '--cd-border', '--cd-shadow', '--cd-font-family', HEADING_FONT_VAR, '--cd-duration']);
// Numeric engine variables are judged at their lowest and highest value (ranges come from the schema and the density table).
const RANGE_VARS = Object.freeze({
  '--cd-radius': ['0px', '32px'], '--cd-space': ['2px', '12px'], '--cd-gap': ['8px', '26px'], '--cd-card-min': ['150px', '260px'],
  '--cd-row-gap': ['16px', '48px'], '--cd-row-visible': ['4', '8'], '--cd-font-size': ['12px', '20px'], '--cd-font-scale': ['0.85', '1.45'],
  '--cd-heading-weight': ['100', '900'],
});
const MAX_PROFILE_VARIANTS = 64;
const MAX_EXPANDED_CHARS = 2000;
const EXPAND_BUDGET = 400;   // calls of expandThemeVars for one declaration

const CONTAINER_NAMES = /* @__PURE__ */ new Set(['cd-home', 'cd-rows', 'cd-row', 'cd-hero', 'cd-notice']);
const POSITIONED_NAMES = /* @__PURE__ */ new Set(['cd-hero', 'cd-row', 'cd-hero-link', 'cd-hero-media', 'cd-card-thumb']);   // position:relative in the engine
const ABSOLUTE_NAMES = /* @__PURE__ */ new Set(['cd-hero-body', 'cd-card-duration', 'cd-row-prev', 'cd-row-next']);     // position:absolute in the engine
const GENERIC_TAGS = /* @__PURE__ */ new Set(['a', 'img', 'span', 'div', 'p', 'button', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'svg', 'path', 'picture',
  'ul', 'ol', 'li', 'b', 'i', 'em', 'strong', 'small', 'time', 'label', 'figure', 'figcaption', 'header', 'footer', 'section', 'article', 'nav']);

const WIDE_KW = /* @__PURE__ */ new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);
const COLOR_FNS = /* @__PURE__ */ new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark']);
const GENERIC_FAMILIES = /* @__PURE__ */ new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace',
  'ui-rounded', '-apple-system', 'blinkmacsystemfont']);
const SAFE_FONTS = /* @__PURE__ */ new Set([...GENERIC_FAMILIES, 'inter', 'georgia', 'times new roman', 'times', 'arial', 'helvetica', 'helvetica neue',
  'verdana', 'tahoma', 'trebuchet ms', 'courier new', 'courier', 'segoe ui', 'roboto', 'roboto condensed', 'arial narrow', 'cambria', 'palatino',
  'palatino linotype', 'garamond', 'book antiqua', 'baskerville', 'gill sans', 'calibri', 'candara', 'consolas', 'menlo', 'sfmono-regular',
  'sf mono', 'liberation mono', 'franklin gothic medium', 'helvetica neue condensed', 'sf pro rounded', 'hiragino maru gothic pron',
  'quicksand', 'nunito', 'optima', 'avenir', 'lucida grande', 'lucida sans', 'impact', 'rockwell', 'didot', 'bodoni mt']);

const nodeText = (nd) => (nd.k === 'id' ? nd.v : nd.k === 'num' ? String(nd.v) : nd.k === 'dim' ? `${nd.v}${nd.u}` : nd.k === 'pct' ? `${nd.v}%`
  : nd.k === 'fn' ? `${nd.name}()` : nd.k === 'str' ? 'a string' : nd.k === 'hash' ? `#${nd.v}` : nd.k === 'url' ? 'url()' : nd.k);
const kwSet = (s) => new Set(s.split(' '));
const SIZE_KW = /* @__PURE__ */ kwSet('auto none min-content max-content fit-content stretch');
const NO_KW = /* @__PURE__ */ new Set();
const fmtN = (n) => (Number.isFinite(n) ? String(Math.round(n * 100) / 100) : String(n));

const noopReport = () => {};

/**
 * All texts a value can take once var() is substituted, for the allow-list. Engine tokens listed in KEEP_VARS stay as var();
 * a numeric engine variable becomes its lowest and highest value; a theme variable becomes each value it was declared with; anything
 * else (YouTube's own variables, undeclared names) becomes an inert stand-in that no property accepts. One name takes one value
 * across the whole declaration. Returns false when there are too many combinations (the caller refuses).
 */
function expandThemeVars(text, cc, depth, out) {
  // Substituting a value that holds var() twice doubles the text at every level of a chain or a cycle: bound size and work.
  if (text.length > MAX_EXPANDED_CHARS || --cc.budget < 0) return false;
  const toks = tokenize(text, noopReport);
  const match = matchBrackets(toks, noopReport);
  if (!match) { out.push(text); return out.length <= MAX_PROFILE_VARIANTS; }
  let name = null;
  const spans = [];
  const nameAt = (i) => {
    let k = i + 1;
    while (k < match[i] && toks[k].t === 'ws') k++;
    return k < match[i] && toks[k].t === 'ident' ? toks[k].v : '';
  };
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].t !== 'function' || stripVendor(stripCtl(lc(toks[i].v))) !== 'var') continue;
    const nm = nameAt(i);
    if (KEEP_VARS.has(nm)) continue;
    if (name === null) name = nm;
    if (nm === name) spans.push(i);
  }
  if (name === null) { out.push(text); return out.length <= MAX_PROFILE_VARIANTS; }
  if (depth >= MAX_VAR_DEPTH) return false;
  const fallbackOf = (i) => {
    const close = match[i];
    for (let j = i + 1; j < close; j++) {
      if (toks[j].t === ',') return text.slice(toks[j].e, toks[close].s);
      if (isOpen(toks[j].t)) j = match[j];
    }
    return null;
  };
  const rebuild = (pick) => {
    let res = '';
    let at = 0;
    for (const i of spans) {
      if (toks[i].s < at) continue;   // nested inside a span already replaced
      res += `${text.slice(at, toks[i].s)} ${pick(i)} `;
      at = toks[match[i]].e;
    }
    return res + text.slice(at);
  };
  const values = [];
  const declared = name ? cc.custom.get(name) : null;
  if (declared) values.push(...declared);
  const isRange = !!name && Object.prototype.hasOwnProperty.call(RANGE_VARS, name);
  if (isRange) values.push(...RANGE_VARS[name]);
  const variants = values.map((v) => rebuild(() => v));
  if (!isRange && !THEME_VAR_RE.test(name)) {
    variants.push(rebuild(() => EXT_VAR));   // YouTube's own variable, or an unknown one: its value cannot be bounded, so no property accepts it
  } else if (spans.every((i) => fallbackOf(i) !== null)) {
    variants.push(rebuild((i) => fallbackOf(i)));   // not set at all: the fallbacks apply (without one the declaration is simply void)
  }
  for (const v of variants) if (!expandThemeVars(v, cc, depth + 1, out)) return false;
  return true;
}

// ---- value checks (each returns null or a short reason) --------------------------------------------------------------------

/** Bounds for a length. px/pct/vp are [lo, hi]; pct and vp default to "not allowed". num = range of a plain number (0 is always fine). */
const cap = (px, pct = null, vp = null, kw = NO_KW, num = null) => ({ px, pct, vp, kw, num });
const NEG = -Infinity;

function lengthIssue(nd, c) {
  if (nd.k === 'id') return c.kw.has(nd.v) || WIDE_KW.has(nd.v) ? null : `"${nodeText(nd)}" is not an allowed value here`;
  if (nd.k === 'dim') {
    const factor = ABS_UNITS[nd.u];
    if (factor !== undefined) {
      const px = nd.v * factor;
      if (px < c.px[0] || px > c.px[1]) return `${fmtN(px)}px is outside the allowed range (${fmtN(c.px[0])} to ${fmtN(c.px[1])}px)`;
      return null;
    }
  } else if (nd.k === 'num') {
    if (c.num ? nd.v >= c.num[0] && nd.v <= c.num[1] : nd.v === 0) return null;
    return c.num ? `${nd.v} is outside ${c.num[0]} to ${c.num[1]}` : 'a number without a unit is not a length';
  } else if (nd.k === 'pct') {
    if (!c.pct || nd.v < c.pct[0] || nd.v > c.pct[1]) return `${fmtN(nd.v)}% is outside the allowed range`;
    return null;
  }
  if (nd.k !== 'num' && nd.k !== 'dim' && nd.k !== 'pct' && nd.k !== 'fn' && nd.k !== 'paren') return `${nodeText(nd)} is not a length`;
  const r = evalLen(nd);
  if (!r || !r.length) return `${nodeText(nd)} could not be evaluated`;
  for (const f of r) {
    if (f.num !== null) {
      if (c.num ? f.num >= c.num[0] && f.num <= c.num[1] : f.num === 0) continue;
      return c.num ? `${f.num} is outside ${c.num[0]} to ${c.num[1]}` : 'a number without a unit is not a length';
    }
    if (f.px < c.px[0] || f.px > c.px[1]) return `${fmtN(f.px)}px is outside the allowed range (${fmtN(c.px[0])} to ${fmtN(c.px[1])}px)`;
    if (f.pct !== 0 && (!c.pct || f.pct < c.pct[0] || f.pct > c.pct[1])) return `${fmtN(f.pct)}% is outside the allowed range`;
    if (f.vp !== 0 && (!c.vp || f.vp < c.vp[0] || f.vp > c.vp[1])) return `${fmtN(f.vp)}vw/vh is outside the allowed range`;
  }
  return null;
}

/** Every top-level node must be a length within `c`, at most `max` of them. */
function lengthsIssue(nodes, c, max = 4) {
  if (!nodes.length || nodes.length > max) return 'has the wrong number of values';
  for (const nd of nodes) {
    if (nd.k === 'comma' || nd.k === 'delim') return 'has a value that is not understood';
    const why = lengthIssue(nd, c);
    if (why) return why;
  }
  return null;
}

function numberIssue(nd, lo, hi) {
  let vals = null;
  if (nd.k === 'num') vals = [nd.v];
  else if (nd.k === 'pct') vals = [nd.v / 100];
  else if (nd.k === 'fn' || nd.k === 'paren') {
    const r = evalLen(nd);
    if (r && r.length && r.every((f) => f.num !== null)) vals = r.map((f) => f.num);
  }
  if (!vals) return `${nodeText(nd)} is not a number`;
  return vals.every((v) => v >= lo && v <= hi) ? null : `${vals.find((v) => v < lo || v > hi)} is outside ${lo} to ${hi}`;
}

function keywordsIssue(nodes, set, max = 1) {
  if (!nodes.length || nodes.length > max) return 'has the wrong number of values';
  for (const nd of nodes) if (!(nd.k === 'id' && (set.has(nd.v) || WIDE_KW.has(nd.v)))) return `"${nodeText(nd)}" is not an allowed value here`;
  return null;
}

const isTokenVar = (nd, set) => nd.k === 'fn' && nd.name === 'var' && nd.args.length && nd.args[0].k === 'id' && set.has(nd.args[0].v);
const varName = (nd) => (nd.k === 'fn' && nd.name === 'var' && nd.args.length && nd.args[0].k === 'id' ? nd.args[0].v : null);

/** One colour node. mode: 'ink' (text), 'paint' (backgrounds), 'edge' (borders, outlines, icons), 'shadow' (any colour; it only paints a bounded shadow). */
function colourIssue(nd, mode, c) {
  const foreign = c.profile === 'foreign';
  switch (nd.k) {
    case 'id':
      if (WIDE_KW.has(nd.v)) return null;
      if (nd.v === 'currentcolor') return mode === 'paint' ? 'a background cannot be currentcolor (the text would vanish)' : null;
      if (nd.v === 'transparent') return mode === 'ink' && foreign ? 'text cannot be transparent' : null;
      if (nd.v === 'none' && c.prop && /^(?:fill|stroke)$/.test(c.prop)) return null;
      if (mode === 'shadow' || !foreign) return /^[a-z]+$/.test(nd.v) ? null : `"${nd.v}" is not a colour`;
      return `"${nd.v}" is a literal colour; YouTube elements may only use the theme colours (var(--cd-text), var(--cd-bg), ...)`;
    case 'hash':
      return foreign && mode !== 'shadow' ? 'YouTube elements may only use the theme colours (var(--cd-text), var(--cd-bg), ...), not a literal colour' : null;
    case 'fn': {
      if (nd.name === 'var') {
        const name = varName(nd);
        if (name === null) return 'var() needs a --cd-* colour name';
        // A keyframe has no rule around it to pair an accent background with its label colour.
        if (c.keyframes && (mode === 'ink' || mode === 'paint') && (ACCENT_BG.has(name) || name === '--cd-accent-text')) return `var(${name}) cannot be animated: it is only readable together with its partner colour in one rule`;
        const okSet = mode === 'ink' ? INK_TOKENS : mode === 'paint' ? PAINT_TOKENS : mode === 'icon' ? ICON_TOKENS : null;
        const known = okSet ? okSet.has(name) || (mode === 'paint' && c.decoration && name === '--cd-border') : INK_TOKENS.has(name) || PAINT_TOKENS.has(name) || name === '--cd-border';
        if (!known) {
          return `var(${name}) is not a colour token that is allowed here (${mode === 'ink' ? '--cd-text, --cd-muted, --cd-accent, --cd-accent-text'
            : mode === 'icon' ? '--cd-text, --cd-muted, --cd-accent' : mode === 'paint' ? '--cd-bg, --cd-surface, --cd-menu, --cd-accent, --cd-hover, ...' : 'the --cd-* theme colours'})`;
        }
        if (c.rule) {
          if (mode === 'ink' && /^(?:color|text-fill-color)$/.test(c.prop)) c.rule.ink.add(name);
          if (mode === 'paint' && /^background(?:-color|-image)?$/.test(c.prop)) c.rule.paint.add(name);
        }
        const comma = nd.args.findIndex((a) => a.k === 'comma');
        if (comma >= 0) {
          const rest = nd.args.slice(comma + 1);
          for (const a of rest) { const why = colourIssue(a, mode, { ...c, rule: null }); if (why) return why; }
        }
        return null;
      }
      if (COLOR_FNS.has(nd.name)) {
        return foreign && mode !== 'shadow' ? 'YouTube elements may only use the theme colours (var(--cd-text), var(--cd-bg), ...), not a literal colour' : null;
      }
      return `${nd.name}() is not a colour`;
    }
    default: return `${nodeText(nd)} is not a colour`;
  }
}

function coloursIssue(nodes, mode, c, max = 4) {
  if (!nodes.length || nodes.length > max) return 'has the wrong number of values';
  for (const nd of nodes) { const why = colourIssue(nd, mode, c); if (why) return why; }
  return null;
}

const GRADIENT_RE = /^(?:repeating-)?(?:linear|radial|conic)-gradient$/;
const GRADIENT_KW = /* @__PURE__ */ kwSet('to left right top bottom center circle ellipse closest-side farthest-side closest-corner farthest-corner at in '
  + 'srgb srgb-linear oklab oklch hsl hwb lab lch shorter longer increasing decreasing from');
const BG_KW = /* @__PURE__ */ kwSet('none transparent repeat no-repeat repeat-x repeat-y space round left right top bottom center cover contain auto '
  + 'scroll local border-box padding-box content-box');

function gradientIssue(fn, c) {
  let layer = 0;
  for (const nd of fn.args) {
    if (nd.k === 'comma') { layer = 0; continue; }
    layer++;
    if (layer > 8) return 'gradient has too many parts';
    if (nd.k === 'num' || nd.k === 'pct' || nd.k === 'dim') continue;
    if (nd.k === 'delim' && nd.v === '/') continue;
    if (nd.k === 'id' && GRADIENT_KW.has(nd.v)) continue;
    const why = nd.k === 'id' && nd.v === 'transparent' ? null : colourIssue(nd, 'paint', { ...c, rule: c.rule });
    if (why) return why;
  }
  return null;
}

function backgroundIssue(nodes, c) {
  let layers = 1;
  for (const nd of nodes) {
    if (nd.k === 'comma') { if (++layers > 4) return 'has too many layers'; continue; }
    if (nd.k === 'id') {
      if (WIDE_KW.has(nd.v) || nd.v === 'none' || nd.v === 'transparent') continue;
      if (c.profile !== 'foreign' && BG_KW.has(nd.v)) continue;
      const why = colourIssue(nd, 'paint', c);
      if (why) return why;
      continue;
    }
    if (nd.k === 'fn' && GRADIENT_RE.test(nd.name)) { const why = gradientIssue(nd, c); if (why) return why; continue; }
    if (nd.k === 'url') { if (c.profile === 'foreign') return 'YouTube elements cannot get a background image'; continue; }
    if (nd.k === 'fn' && nd.name === 'url') { if (c.profile === 'foreign') return 'YouTube elements cannot get a background image'; continue; }
    if (c.profile !== 'foreign' && (nd.k === 'dim' || nd.k === 'pct' || nd.k === 'num' || (nd.k === 'delim' && nd.v === '/'))) {
      if (nd.k === 'delim') continue;
      const why = lengthIssue(nd, cap([-4096, 4096], [-200, 400], NONE_VP()));
      if (why) return why;
      continue;
    }
    const why = colourIssue(nd, 'paint', c);
    if (why) return why;
  }
  return null;
}
function NONE_VP() { return [0, 0]; }

/** box-shadow / text-shadow: bounded offsets, blur and spread. var(--cd-shadow) is the engine's own token. */
function shadowIssue(nodes, c, text) {
  if (nodes.length === 1 && nodes[0].k === 'id' && (nodes[0].v === 'none' || WIDE_KW.has(nodes[0].v))) return null;
  if (nodes.length === 1 && varName(nodes[0]) === '--cd-shadow') return null;
  const foreign = c.profile === 'foreign';
  const off = foreign ? 16 : 32;
  const blur = foreign ? 40 : 64;
  const spread = foreign ? 4 : 8;
  const layers = [[]];
  for (const nd of nodes) { if (nd.k === 'comma') layers.push([]); else layers[layers.length - 1].push(nd); }
  if (layers.length > 4) return 'has too many shadow layers';
  for (const layer of layers) {
    if (!layer.length) return 'has an empty shadow layer';
    const lens = [];
    let colours = 0;
    for (const nd of layer) {
      if (nd.k === 'id' && nd.v === 'inset' && !text) {
        if (c.protectedRef) return 'an inset shadow paints over the content of an ad, a sponsorship label or a control';
        continue;
      }
      if (nd.k === 'dim' || nd.k === 'num' || nd.k === 'paren' || (nd.k === 'fn' && !COLOR_FNS.has(nd.name) && nd.name !== 'var')) { lens.push(nd); continue; }
      colours++;
      const why = colourIssue(nd, 'shadow', c);
      if (why) return why;
    }
    if (colours > 1) return 'has more than one colour in a shadow layer';
    if (lens.length < 2 || lens.length > (text ? 3 : 4)) return 'has the wrong number of lengths in a shadow';
    const limits = [off, off, blur, c.protectedRef ? 0 : spread];
    for (let k = 0; k < lens.length; k++) {
      const why = lengthIssue(lens[k], cap(k === 2 ? [0, limits[2]] : [-limits[k], limits[k]]));
      if (why) return `shadow ${why}`;
    }
  }
  return null;
}

const BORDER_STYLES = /* @__PURE__ */ kwSet('none hidden solid dashed dotted double');
const BORDER_WIDTH_KW = /* @__PURE__ */ kwSet('thin medium');

function borderWidthCap(c) {
  if (c.protectedRef) return cap([0, 2]);   // border-box: a thick frame would eat the content of a small badge
  return cap(c.profile === 'part' && !c.abs ? [0, 8] : [0, 4], null, null, BORDER_WIDTH_KW);
}

function borderIssue(nodes, c) {
  let widths = 0;
  for (const nd of nodes) {
    if (nd.k === 'id' && (BORDER_STYLES.has(nd.v) || WIDE_KW.has(nd.v))) continue;
    if (nd.k === 'id' && BORDER_WIDTH_KW.has(nd.v)) { widths++; continue; }
    if (nd.k === 'dim' || nd.k === 'num' || nd.k === 'paren' || (nd.k === 'fn' && nd.name !== 'var' && !COLOR_FNS.has(nd.name))) {
      widths++;
      const why = lengthIssue(nd, borderWidthCap(c));
      if (why) return `border width ${why}`;
      continue;
    }
    const why = colourIssue(nd, 'edge', c);
    if (why) return why;
  }
  return widths > 1 ? 'has more than one border width' : null;
}

function fontFamilyIssue(nodes, c) {
  if (nodes.length === 1 && nodes[0].k === 'id' && WIDE_KW.has(nodes[0].v)) return null;
  if (nodes.length === 1 && nodes[0].k === 'fn') {
    const n = varName(nodes[0]);
    if (n === '--cd-font-family' || n === HEADING_FONT_VAR) {
      const comma = nodes[0].args.findIndex((a) => a.k === 'comma');
      if (comma < 0) return null;
      return fontFamilyIssue(nodes[0].args.slice(comma + 1), c);
    }
    return 'needs var(--cd-font-family) or var(--cd-heading-font)';
  }
  if (c.profile === 'foreign') return 'YouTube elements may only use var(--cd-font-family) or var(--cd-heading-font)';
  return fontListIssue(nodes);
}

/** A comma separated family list made only of names from SAFE_FONTS (system fonts; nothing is downloaded). */
function fontListIssue(nodes) {
  let words = [];
  const flush = () => {
    if (!words.length) return 'has an empty font name';
    const name = words.join(' ');
    words = [];
    return SAFE_FONTS.has(name) ? null : `the font "${shorten(name, 30)}" is not in the list of system fonts a theme may name`;
  };
  for (const nd of nodes) {
    if (nd.k === 'comma') { const why = flush(); if (why) return why; } else if (nd.k === 'id') words.push(nd.v);
    else if (nd.k === 'str') words.push(lc(nd.v));
    else return `${nodeText(nd)} is not a font name`;
  }
  return flush();
}

const TIME_UNITS = { s: 1000, ms: 1 };
function timeIssue(nd, maxMs) {
  if (nd.k === 'num' && nd.v === 0) return null;
  if (nd.k === 'fn' && varName(nd) === '--cd-duration') return null;
  if (nd.k === 'dim' && Object.prototype.hasOwnProperty.call(TIME_UNITS, nd.u)) {
    return nd.v * TIME_UNITS[nd.u] <= maxMs ? null : `${nodeText(nd)} is longer than ${maxMs} ms`;
  }
  return `${nodeText(nd)} is not a time`;
}

const EASING_KW = /* @__PURE__ */ kwSet('ease ease-in ease-out ease-in-out linear step-start step-end');
const TRANSITION_FOREIGN = /* @__PURE__ */ kwSet('color background-color border-color border-top-color border-right-color border-bottom-color '
  + 'border-left-color outline-color box-shadow text-shadow text-decoration-color fill stroke caret-color accent-color border-radius');
const TRANSITION_PART = /* @__PURE__ */ new Set([...TRANSITION_FOREIGN, 'transform', 'translate', 'scale', 'rotate', 'opacity', 'filter',
  'backdrop-filter', 'background', 'outline-offset']);

function easingNode(nd) {
  return (nd.k === 'id' && EASING_KW.has(nd.v)) || (nd.k === 'fn' && (nd.name === 'cubic-bezier' || nd.name === 'steps'));
}

function transitionIssue(prop, nodes, c) {
  const props = c.profile === 'part' ? TRANSITION_PART : TRANSITION_FOREIGN;
  const layers = [[]];
  for (const nd of nodes) { if (nd.k === 'comma') layers.push([]); else layers[layers.length - 1].push(nd); }
  if (layers.length > 6) return 'has too many layers';
  for (const layer of layers) {
    let times = 0;
    for (const nd of layer) {
      if (nd.k === 'id' && (nd.v === 'none' || WIDE_KW.has(nd.v))) continue;
      if (easingNode(nd)) continue;
      if (nd.k === 'dim' || nd.k === 'num' || (nd.k === 'fn' && varName(nd) === '--cd-duration')) {
        const why = timeIssue(nd, ++times > 1 ? 500 : 1000);
        if (why) return why;
        continue;
      }
      if (nd.k === 'id' && prop !== 'transition-duration' && prop !== 'transition-delay' && prop !== 'transition-timing-function') {
        if (props.has(nd.v)) continue;
        return `transitions "${nd.v}", which is not a purely cosmetic property`;
      }
      return `"${nodeText(nd)}" is not an allowed value here`;
    }
  }
  return null;
}

const ANIM_KW = /* @__PURE__ */ kwSet('none normal reverse alternate alternate-reverse forwards backwards both infinite running paused '
  + 'ease ease-in ease-out ease-in-out linear step-start step-end');

function animationIssue(prop, nodes, c) {
  const frames = c.cc.kfProfile;
  const names = [];
  for (const nd of nodes) {
    if (nd.k === 'comma') continue;
    if (nd.k === 'str') names.push(nd.v);
    else if (nd.k === 'id') {
      if (WIDE_KW.has(nd.v)) continue;
      if (prop === 'animation-name') { if (nd.v !== 'none') names.push(nd.v); } else if (!ANIM_KW.has(nd.v)) names.push(nd.v);
    } else if (nd.k === 'dim') { const why = timeIssue(nd, 20000); if (why) return why; } else if (nd.k === 'num') continue;
    else if (easingNode(nd)) continue;
    else if (nd.k === 'fn' && varName(nd) === '--cd-duration') continue;
    else return `"${nodeText(nd)}" is not an allowed value here`;
  }
  for (const name of names) {
    const entry = frames.get(name);
    if (!entry) {
      if (c.profile === 'foreign') return `the animation "${shorten(name, 30)}" is not defined in this theme, so it is not known to be cosmetic`;
      continue;
    }
    if (c.profile === 'foreign' ? !entry.foreignOk : !entry.partOk) {
      return `the animation "${shorten(name, 30)}" changes more than colours and shadows, which is not allowed on this element`;
    }
  }
  return null;
}

function transformIssue(nodes) {
  if (nodes.length === 1 && nodes[0].k === 'id' && (nodes[0].v === 'none' || WIDE_KW.has(nodes[0].v))) return null;
  const move = cap([-24, 24], [-25, 25], [0, 0]);
  for (const nd of nodes) {
    if (nd.k !== 'fn') return `${nodeText(nd)} is not a transform`;
    const list = args(nd);
    const flat = list.map((a) => (a.length === 1 ? a[0] : null));
    if (flat.some((x) => x === null)) return `${nd.name}() has a value that is not understood`;
    switch (nd.name) {
      case 'translate': case 'translatex': case 'translatey':
        for (const a of flat) { const why = lengthIssue(a, move); if (why) return `${nd.name}() ${why}`; }
        break;
      case 'scale': case 'scalex': case 'scaley':
        for (const a of flat) { const why = numberIssue(a, 0.8, 1.25); if (why) return `${nd.name}() ${why}`; }
        break;
      case 'rotate': case 'skew': case 'skewx': case 'skewy':
        for (const a of flat) {
          const d = angleDeg(a);
          const lim = nd.name === 'rotate' ? 15 : 10;
          if (d === null || Math.abs(d) > lim) return `${nd.name}() must be an angle of at most ${lim}deg`;
        }
        break;
      default: return `${nd.name}() is not allowed (translate, scale and a small rotate are)`;
    }
  }
  return null;
}

function filterIssue(nodes, c, backdrop) {
  if (nodes.length === 1 && nodes[0].k === 'id' && (nodes[0].v === 'none' || WIDE_KW.has(nodes[0].v))) return null;
  for (const nd of nodes) {
    if (nd.k !== 'fn') return `${nodeText(nd)} is not a filter`;
    const a = args(nd);
    const first = a.length === 1 && a[0].length === 1 ? a[0][0] : null;
    switch (nd.name) {
      case 'grayscale': case 'sepia': case 'invert': { const why = first ? numberIssue(first, 0, 1) : (a.length ? 'is not understood' : null); if (why) return `${nd.name}() ${why}`; break; }
      case 'saturate': case 'brightness': case 'contrast': {
        const why = first ? numberIssue(first, 0.5, 1.5) : (a.length ? 'is not understood' : null);
        if (why) return `${nd.name}() ${why}`;
        break;
      }
      case 'hue-rotate': break;
      case 'blur': {
        if (!first) return 'blur() needs a length';
        const why = lengthIssue(first, cap([0, backdrop ? 20 : 8]));
        if (why) return `blur() ${why}`;
        break;
      }
      case 'drop-shadow': { const why = shadowIssue(nd.args, c, true); if (why) return why; break; }
      default: return `${nd.name}() is not an allowed filter`;
    }
  }
  return null;
}

function trackIssue(nodes, c) {
  const track = cap([0, 640], [0, 100], [0, 100], kwSet('auto none min-content max-content'));
  const one = (nd, depth) => {
    if (nd.k === 'id') return track.kw.has(nd.v) || WIDE_KW.has(nd.v) ? null : `"${nd.v}" is not an allowed track`;
    if (nd.k === 'dim' && nd.u === 'fr') return nd.v >= 0 && nd.v <= 12 ? null : 'a track larger than 12fr';
    if (nd.k === 'fn' && nd.name === 'minmax' && depth < 3) {
      const a = args(nd);
      if (a.length !== 2) return 'minmax() needs two values';
      for (const part of a) { if (part.length !== 1) return 'minmax() is not understood'; const why = one(part[0], depth + 1); if (why) return why; }
      return null;
    }
    if (nd.k === 'fn' && nd.name === 'repeat' && depth < 3) {
      const a = args(nd);
      if (a.length !== 2 || a[0].length !== 1) return 'repeat() is not understood';
      const n = a[0][0];
      if (!((n.k === 'num' && Number.isInteger(n.v) && n.v >= 1 && n.v <= 12) || (n.k === 'id' && (n.v === 'auto-fill' || n.v === 'auto-fit')))) return 'repeat() count must be 1 to 12, auto-fill or auto-fit';
      for (const part of a[1]) { const why = one(part, depth + 1); if (why) return why; }
      return null;
    }
    return lengthIssue(nd, track);
  };
  if (!nodes.length || nodes.length > 12) return 'has the wrong number of tracks';
  for (const nd of nodes) { const why = one(nd, 0); if (why) return why; }
  return null;
}

function flexIssue(nodes, c) {
  if (nodes.length === 1 && nodes[0].k === 'id') return keywordsIssue(nodes, kwSet('none auto initial'));
  if (nodes.length > 3) return 'has too many values';
  const sizes = c.abs ? cap([NEG, 96], [NEG, 100], [NEG, 0], SIZE_KW) : cap([NEG, 1600], [NEG, 100], [NEG, 100], SIZE_KW);
  let numbers = 0;
  for (const nd of nodes) {
    if (nd.k === 'num' && numbers < 2) { numbers++; if (nd.v < 0 || nd.v > 10) return 'flex grow/shrink must be 0 to 10'; continue; }
    const why = lengthIssue(nd, sizes);
    if (why) return why;
  }
  return null;
}

const DISPLAY_KW = /* @__PURE__ */ kwSet('block inline inline-block flex inline-flex grid inline-grid flow-root none contents -webkit-box list-item');
const POSITION_REL = /* @__PURE__ */ kwSet('static relative');
const OVERFLOW_KW = /* @__PURE__ */ kwSet('visible hidden auto scroll clip');

// ---- the property table -------------------------------------------------------------------------------------------------------
// scope: 'all' = any element, 'own' = Cinedrape elements, 'part' = Cinedrape parts (not the flow containers).

const SPEC = new Map();
const spec = (names, scope, fn) => { for (const n of names.split(' ')) SPEC.set(n, { scope, fn }); };
const ink = (mode) => (nodes, c) => coloursIssue(nodes, mode, c, c.maxColours || 1);

spec('color text-fill-color caret-color', 'all', (nodes, c) => coloursIssue(nodes, 'ink', c, 1));
spec('fill stroke', 'all', (nodes, c) => coloursIssue(nodes, 'icon', c, 1));
spec('accent-color text-decoration-color outline-color text-emphasis-color', 'all', (nodes, c) => coloursIssue(nodes, 'edge', c, 1));
spec('border-color border-top-color border-right-color border-bottom-color border-left-color border-block-color border-inline-color '
  + 'border-block-start-color border-block-end-color border-inline-start-color border-inline-end-color', 'all', (nodes, c) => coloursIssue(nodes, 'edge', c, 4));
spec('background-color', 'all', (nodes, c) => coloursIssue(nodes, 'paint', c, 1));
spec('background background-image', 'all', backgroundIssue);
spec('scrollbar-color', 'all', (nodes, c) => (nodes.length === 1 && nodes[0].k === 'id' ? keywordsIssue(nodes, kwSet('auto')) : coloursIssue(nodes, 'edge', c, 2)));
spec('color-scheme', 'all', (nodes) => keywordsIssue(nodes, kwSet('normal light dark only'), 3));

const radiusCap = (c) => (c.protectedRef ? cap([0, 12]) : c.profile === 'foreign' ? cap([0, 40], [0, 10]) : cap([0, 64], [0, 50]));
spec('border-radius border-top-left-radius border-top-right-radius border-bottom-right-radius border-bottom-left-radius '
  + 'border-start-start-radius border-start-end-radius border-end-start-radius border-end-end-radius', 'all', (nodes, c) => {
  const parts = nodes.filter((n) => !(n.k === 'delim' && n.v === '/'));
  return lengthsIssue(parts, radiusCap(c), 8);
});
spec('border border-top border-right border-bottom border-left border-block border-inline border-block-start border-block-end '
  + 'border-inline-start border-inline-end outline', 'all', borderIssue);
spec('border-width border-top-width border-right-width border-bottom-width border-left-width border-block-width border-inline-width '
  + 'outline-width', 'all', (nodes, c) => lengthsIssue(nodes, borderWidthCap(c)));
spec('border-style border-top-style border-right-style border-bottom-style border-left-style border-block-style border-inline-style '
  + 'outline-style', 'all', (nodes) => keywordsIssue(nodes, BORDER_STYLES, 4));
spec('outline-offset', 'all', (nodes, c) => lengthsIssue(nodes, c.protectedRef ? cap([0, 4]) : cap([-8, 8]), 1));
spec('box-shadow', 'all', (nodes, c) => shadowIssue(nodes, c, false));
spec('text-shadow', 'all', (nodes, c) => shadowIssue(nodes, c, true));

spec('font-family', 'all', fontFamilyIssue);
spec('font-weight', 'all', (nodes) => {
  if (nodes.length !== 1) return 'has the wrong number of values';
  const nd = nodes[0];
  if (nd.k === 'id') return keywordsIssue(nodes, kwSet('normal bold bolder lighter'));
  if (varName(nd) === '--cd-heading-weight') return null;
  return numberIssue(nd, 1, 1000);
});
spec('font-style', 'all', (nodes) => keywordsIssue(nodes, kwSet('normal italic oblique')));
spec('letter-spacing', 'all', (nodes, c) => lengthsIssue(nodes, c.protectedRef ? cap([0, 1], null, null, kwSet('normal'))
  : c.profile === 'foreign' ? cap([-1, 3], null, null, kwSet('normal')) : cap([-2, 6], null, null, kwSet('normal')), 1));
spec('text-transform', 'all', (nodes) => keywordsIssue(nodes, kwSet('none uppercase lowercase capitalize')));
spec('text-decoration', 'all', (nodes, c) => {
  for (const nd of nodes) {
    if (nd.k === 'id' && kwSet('none underline overline line-through solid double dotted dashed wavy').has(nd.v)) continue;
    if (nd.k === 'dim') { const why = lengthIssue(nd, cap([0, 4])); if (why) return why; continue; }
    const why = colourIssue(nd, 'edge', c);
    if (why) return why;
  }
  return null;
});
spec('text-decoration-line', 'all', (nodes) => keywordsIssue(nodes, kwSet('none underline overline line-through'), 3));
spec('text-decoration-style', 'all', (nodes) => keywordsIssue(nodes, kwSet('solid double dotted dashed wavy')));
spec('text-decoration-thickness', 'all', (nodes) => lengthsIssue(nodes, cap([0, 4], null, null, kwSet('auto from-font')), 1));
spec('text-underline-offset', 'all', (nodes) => lengthsIssue(nodes, cap([-4, 8], null, null, kwSet('auto')), 1));
spec('cursor', 'all', (nodes) => keywordsIssue(nodes, kwSet('auto default pointer text move grab grabbing not-allowed help wait progress crosshair zoom-in zoom-out '
  + 'copy alias context-menu cell vertical-text none'), 1));
spec('transition transition-property transition-duration transition-delay transition-timing-function', 'all', (nodes, c) => transitionIssue(c.prop, nodes, c));
spec('animation animation-name animation-duration animation-delay animation-timing-function animation-iteration-count animation-direction '
  + 'animation-fill-mode animation-play-state', 'all', (nodes, c) => animationIssue(c.prop, nodes, c));

// Cinedrape elements only ----------------------------------------------------------------------------------------------------
const KW_AUTO = /* @__PURE__ */ kwSet('auto');
const KW_NORMAL = /* @__PURE__ */ kwSet('normal');
const KW_FONT_SIZE = /* @__PURE__ */ kwSet('small medium large x-large smaller larger');
const LINE_HEIGHT_CAP = /* @__PURE__ */ cap([10, 80], [90, 300], null, KW_NORMAL, [0.9, 3]);
const GAP_CAP = /* @__PURE__ */ cap([0, 64], [0, 10], [0, 5], KW_NORMAL);
const MAX_WIDTH_CAP = /* @__PURE__ */ cap([NEG, 2400], [NEG, 100], [NEG, 100], SIZE_KW);

const PADDING_NOTICE = /* @__PURE__ */ cap([0, 24], null, null, NO_KW);
const PADDING_CONTAINER = /* @__PURE__ */ cap([0, 64], [0, 10], [0, 5], NO_KW);
const PADDING_PART = /* @__PURE__ */ cap([0, 64], [0, 25], [0, 10], NO_KW);
const paddingCap = (c) => (c.profile === 'container' ? (c.notice ? PADDING_NOTICE : PADDING_CONTAINER) : PADDING_PART);

const MARGIN_NOTICE = /* @__PURE__ */ cap([0, 24], null, null, KW_AUTO);
const MARGIN_CONTAINER = /* @__PURE__ */ cap([0, 64], [0, 10], [0, 5], KW_AUTO);
const MARGIN_PART = /* @__PURE__ */ cap([-16, 64], [0, 25], [0, 10], KW_AUTO);
const marginCap = (c) => (c.profile === 'container' ? (c.notice ? MARGIN_NOTICE : MARGIN_CONTAINER) : MARGIN_PART);

const FONT_SIZE_NOTICE = /* @__PURE__ */ cap([9, 20], [60, 300], null, KW_FONT_SIZE);
const FONT_SIZE_CONTAINER = /* @__PURE__ */ cap([9, 48], [60, 300], null, KW_FONT_SIZE);
const FONT_SIZE_PART = /* @__PURE__ */ cap([9, 64], [60, 300], null, KW_FONT_SIZE);
const fontSizeCap = (c) => (c.profile === 'container' ? (c.notice ? FONT_SIZE_NOTICE : FONT_SIZE_CONTAINER) : FONT_SIZE_PART);

spec('padding padding-top padding-right padding-bottom padding-left padding-block padding-inline padding-block-start padding-block-end '
  + 'padding-inline-start padding-inline-end', 'own', (nodes, c) => lengthsIssue(nodes, paddingCap(c)));
spec('margin margin-top margin-right margin-bottom margin-left margin-block margin-inline margin-block-start margin-block-end '
  + 'margin-inline-start margin-inline-end', 'own', (nodes, c) => lengthsIssue(nodes, marginCap(c)));
spec('gap row-gap column-gap grid-gap', 'own', (nodes, c) => lengthsIssue(nodes, GAP_CAP, 2));
spec('max-width max-inline-size', 'own', (nodes) => lengthsIssue(nodes, MAX_WIDTH_CAP, 1));
spec('font-size', 'own', (nodes, c) => lengthsIssue(nodes, fontSizeCap(c), 1));
spec('line-height', 'own', (nodes) => lengthsIssue(nodes, LINE_HEIGHT_CAP, 1));
spec('text-align', 'own', (nodes) => keywordsIssue(nodes, kwSet('left right center justify start end')));
spec('white-space', 'own', (nodes) => keywordsIssue(nodes, kwSet('normal nowrap pre pre-wrap pre-line break-spaces')));
spec('word-break', 'own', (nodes) => keywordsIssue(nodes, kwSet('normal break-all keep-all break-word')));
spec('overflow-wrap word-wrap', 'own', (nodes) => keywordsIssue(nodes, kwSet('normal break-word anywhere')));
spec('text-overflow', 'own', (nodes) => keywordsIssue(nodes, kwSet('clip ellipsis')));
spec('line-clamp', 'own', (nodes) => (nodes.length === 1 && nodes[0].k === 'id' ? keywordsIssue(nodes, kwSet('none')) : (nodes.length === 1 ? numberIssue(nodes[0], 1, 10) : 'has the wrong number of values')));
spec('box-orient', 'own', (nodes) => keywordsIssue(nodes, kwSet('vertical horizontal')));
spec('content', 'own', (nodes) => {
  if (nodes.length === 1 && nodes[0].k === 'id') return keywordsIssue(nodes, kwSet('none normal'));
  for (const nd of nodes) if (nd.k !== 'str') return 'may only be a string, none or normal';
  return null;
});

// Cinedrape parts only: layout inside the box, bounded -----------------------------------------------------------------------
const SIZE_CAP_ABS = /* @__PURE__ */ cap([NEG, 96], [NEG, 100], [NEG, 0], SIZE_KW);
const SIZE_CAP_VERT = /* @__PURE__ */ cap([NEG, 480], [NEG, 100], [NEG, 60], SIZE_KW);
const SIZE_CAP_HORIZ = /* @__PURE__ */ cap([NEG, 1600], [NEG, 100], [NEG, 100], SIZE_KW);
const sizeCap = (c, vert) => (c.abs ? SIZE_CAP_ABS : (vert ? SIZE_CAP_VERT : SIZE_CAP_HORIZ));
spec('width min-width inline-size min-inline-size', 'part', (nodes, c) => lengthsIssue(nodes, sizeCap(c, false), 1));
spec('height min-height max-height block-size min-block-size max-block-size', 'part', (nodes, c) => lengthsIssue(nodes, sizeCap(c, true), 1));
spec('flex', 'part', flexIssue);
spec('flex-grow flex-shrink', 'part', (nodes) => (nodes.length === 1 ? numberIssue(nodes[0], 0, 10) : 'has the wrong number of values'));
spec('flex-basis', 'part', (nodes, c) => lengthsIssue(nodes, sizeCap(c, false), 1));
spec('flex-direction', 'part', (nodes) => keywordsIssue(nodes, kwSet('row row-reverse column column-reverse')));
spec('flex-wrap', 'part', (nodes) => keywordsIssue(nodes, kwSet('nowrap wrap wrap-reverse')));
spec('order', 'part', (nodes) => (nodes.length === 1 && nodes[0].k === 'num' && Number.isInteger(nodes[0].v) && nodes[0].v >= -5 && nodes[0].v <= 5 ? null : 'must be a whole number from -5 to 5'));
spec('align-items align-self align-content justify-content justify-items justify-self place-items place-content', 'part',
  (nodes) => keywordsIssue(nodes, kwSet('normal stretch start end center flex-start flex-end baseline space-between space-around space-evenly safe unsafe self-start self-end left right first last'), 3));
spec('grid-template-columns grid-template-rows grid-auto-columns grid-auto-rows', 'part', trackIssue);
spec('grid-auto-flow', 'part', (nodes) => keywordsIssue(nodes, kwSet('row column dense'), 2));
spec('aspect-ratio', 'part', (nodes) => {
  for (const nd of nodes) {
    if (nd.k === 'delim' && nd.v === '/') continue;
    if (nd.k === 'id' && nd.v === 'auto') continue;
    const why = nd.k === 'num' ? numberIssue(nd, 0.2, 5) : `${nodeText(nd)} is not a ratio`;
    if (why) return why;
  }
  return nodes.length && nodes.length <= 3 ? null : 'has the wrong number of values';
});
spec('object-fit', 'part', (nodes) => keywordsIssue(nodes, kwSet('fill contain cover none scale-down')));
spec('object-position', 'part', (nodes) => lengthsIssue(nodes, cap([-64, 64], [0, 100], null, kwSet('left right top bottom center')), 2));
spec('display', 'part', (nodes) => keywordsIssue(nodes, DISPLAY_KW));
spec('visibility', 'part', (nodes) => keywordsIssue(nodes, kwSet('visible hidden')));
spec('opacity', 'part', (nodes) => (nodes.length === 1 ? numberIssue(nodes[0], 0, 1) : 'has the wrong number of values'));
spec('overflow overflow-x overflow-y', 'part', (nodes) => keywordsIssue(nodes, OVERFLOW_KW, 2));
spec('position', 'part', (nodes, c) => {
  if (nodes.length === 1 && nodes[0].k === 'id' && nodes[0].v === 'absolute') {
    return c.absoluteOk ? null : 'position:absolute is only allowed on the parts the engine already positions (.cd-hero-body, .cd-card-duration, .cd-row-prev, .cd-row-next) and on ::before/::after of .cd-hero, .cd-row and the card thumbnail';
  }
  return keywordsIssue(nodes, POSITION_REL);
});
spec('top right bottom left inset inset-block inset-inline inset-block-start inset-block-end inset-inline-start inset-inline-end', 'part',
  (nodes) => lengthsIssue(nodes, cap([-8, 48], [0, 100], NONE_VP(), kwSet('auto')), 4));
spec('z-index', 'part', (nodes) => (nodes.length === 1 && nodes[0].k === 'num' && Number.isInteger(nodes[0].v) && nodes[0].v >= 0 && nodes[0].v <= 10 ? null
  : (nodes.length === 1 && nodes[0].k === 'id' && nodes[0].v === 'auto' ? null : 'must be a whole number from 0 to 10')));
spec('transform', 'part', (nodes) => transformIssue(nodes));
spec('translate', 'part', (nodes) => lengthsIssue(nodes, cap([-24, 24], [-25, 25], NONE_VP(), kwSet('none')), 2));
spec('scale', 'part', (nodes) => {
  if (nodes.length === 1 && nodes[0].k === 'id') return keywordsIssue(nodes, kwSet('none'));
  if (nodes.length > 2) return 'has too many values';
  for (const nd of nodes) { const why = numberIssue(nd, 0.8, 1.25); if (why) return why; }
  return null;
});
spec('rotate', 'part', (nodes) => {
  if (nodes.length === 1 && nodes[0].k === 'id') return keywordsIssue(nodes, kwSet('none'));
  if (nodes.length !== 1) return 'has the wrong number of values';
  const d = angleDeg(nodes[0]);
  return d !== null && Math.abs(d) <= 15 ? null : 'must be an angle of at most 15deg';
});
spec('filter', 'part', (nodes, c) => filterIssue(nodes, c, false));
spec('backdrop-filter', 'part', (nodes, c) => filterIssue(nodes, c, true));
spec('pointer-events', 'part', (nodes) => keywordsIssue(nodes, kwSet('auto none')));
spec('user-select', 'part', (nodes) => keywordsIssue(nodes, kwSet('auto none text all')));
spec('box-sizing', 'part', (nodes) => keywordsIssue(nodes, kwSet('border-box content-box')));
spec('scrollbar-width', 'part', (nodes) => keywordsIssue(nodes, kwSet('auto thin none')));
spec('vertical-align', 'part', (nodes) => keywordsIssue(nodes, kwSet('baseline top middle bottom text-top text-bottom sub super')));

/** What kind of element does the subject compound style? Returns the profile descriptor, or a list for :is() lists. */
function compoundProfiles(cp, ownAncestor) {
  const out = [];
  let own = null;          // first cd- name (class, id or tag)
  let foreignName = false; // a non-cd- type, class or id on the same compound
  let genericTag = false;
  let pseudo = '';
  let decoration = false;
  let structural = false;
  const pending = [];
  for (const s of cp.simples) {
    if (s.k === 'class' || s.k === 'id') {
      if (s.name.startsWith(CD_PREFIX)) own = own || s.name.toLowerCase();
      else foreignName = true;
    } else if (s.k === 'type') {
      if (s.lname.startsWith(CD_PREFIX)) own = own || s.lname;
      else if (GENERIC_TAGS.has(s.lname)) genericTag = true;
      else foreignName = true;
    } else if (s.k === 'pseudo') {
      if (s.el) {
        if (s.fn) foreignName = true;   // ::part(), ::slotted(): reaches into somebody else's tree
        else if (s.name === 'before' || s.name === 'after') pseudo = s.name;
        else if (DECORATION_ELEMENTS.has(s.name)) decoration = true;
        else foreignName = true;
      } else if (IS_LIKE.has(s.name) && s.list) pending.push(s.list);
      else if (s.name === 'host' || s.name === 'host-context' || s.name === 'root') structural = true;
    }
  }
  if (isRootish(cp)) structural = true;
  if (structural || foreignName) return [{ profile: 'foreign', decoration }];
  if (own) {
    const container = CONTAINER_NAMES.has(own);
    const positioned = POSITIONED_NAMES.has(own);
    const absolute = ABSOLUTE_NAMES.has(own);
    const asPart = !container || (pseudo && positioned);
    return [{
      profile: asPart ? 'part' : 'container', notice: own === 'cd-notice', name: own, pseudo,
      absoluteOk: (absolute && !pseudo) || (!!pseudo && (positioned || absolute)),
    }];
  }
  if (pending.length) {
    for (const list of pending) for (const m of list) out.push(...complexProfiles(m, ownAncestor));
    return out.length ? out : [{ profile: 'foreign', decoration }];
  }
  if (decoration) return [{ profile: 'foreign', decoration: true }];
  // A bare generic tag, "*", an attribute or a pseudo-class: Cinedrape's own subtree only when an own element is an ancestor.
  if (ownAncestor && (genericTag || cp.simples.every((s) => s.k === 'univ' || s.k === 'pseudo' || s.k === 'attr'))) {
    return [{ profile: 'part', generic: true, pseudo, absoluteOk: false }];
  }
  return [{ profile: 'foreign', decoration }];
}


const isOwnMark = (s) => (s.k === 'class' || s.k === 'id' || s.k === 'type') && (s.k === 'type' ? s.lname : s.name).startsWith(CD_PREFIX);

/** True for a compound that names nothing of YouTube's: only a generic tag, "*", attributes and pseudo-classes. */
function isGenericCompound(cp) {
  for (const s of cp.simples) {
    if (s.k === 'class' || s.k === 'id') return false;
    if (s.k === 'type' && !GENERIC_TAGS.has(s.lname)) return false;
  }
  return true;
}

/** Profiles (one per alternative of an :is() list) of the elements a complex selector can match. */
function complexProfiles(cx) {
  let ownAncestor = false;
  // Only descendant and child links keep us inside an own subtree (a sibling combinator may land on a YouTube node), and nothing
  // that names a YouTube element may sit between the own ancestor and the subject.
  for (let k = cx.compounds.length - 1; k > 0; k--) {
    const link = cx.compounds[k].comb;
    if (link !== ' ' && link !== '>') break;
    const cp = cx.compounds[k - 1];
    if (!isRootish(cp) && cp.simples.some(isOwnMark)) { ownAncestor = true; break; }
    if (isRootish(cp) || !isGenericCompound(cp)) break;
  }
  return compoundProfiles(subjectOf(cx), ownAncestor);
}

// ---- judging a rule ------------------------------------------------------------------------------------------------------------

function customIssue(d) {
  const name = d.prop;
  if (name === HEADING_FONT_VAR) {
    const nodes = buildNodes(d.text);
    if (!nodes) return 'has a value that could not be understood';
    return fontListIssue(nodes);
  }
  if (THEME_VAR_RE.test(name)) return null;
  if (/^--y(?:t|td)(?:-|$)/i.test(name)) return `${name} belongs to YouTube; a theme may not set it (declare your own as --cd-t-<name>)`;
  if (/^--cd-/i.test(name)) return `${name} belongs to the Cinedrape engine; a theme may not set it (declare your own as --cd-t-<name>)`;
  return `custom properties in a theme must be named --cd-t-<name> (found ${shorten(name, 40)})`;
}

/** One declaration against the allow-list for the kind of element `c.profile` names. Null, or {code, why}. */
function profileFinding(d, c, cc) {
  if (d.custom) {
    const why = customIssue(d);
    return why ? { code: 'custom-property', why } : null;
  }
  const cKey = c.key || (c.key = profileContextKey(c));
  const cacheKey = cc?.profileCache && `${d.declKey}\0${cKey}`;
  if (cacheKey && cc.profileCache.has(cacheKey)) {
    const cached = cc.profileCache.get(cacheKey);
    if (cached.finding) return cached.finding;
    if (cached.ink && c.rule) for (const name of cached.ink) c.rule.ink.add(name);
    if (cached.paint && c.rule) for (const name of cached.paint) c.rule.paint.add(name);
    return null;
  }
  const what = c.profile === 'foreign' ? 'YouTube elements (a theme may restyle their colours, borders, radius, shadows and text, nothing else)'
    : c.profile === 'container' ? "Cinedrape's page-level boxes (.cd-home, .cd-rows, .cd-row, .cd-hero, .cd-notice)" : 'this Cinedrape element';
  if (c.decoration && (d.prop === 'width' || d.prop === 'height' || d.prop === 'display')) {
    // A scrollbar, selection or placeholder is decoration: it may be thinned or switched off, which hides no content.
    const nodes = d.nodes || (d.nodes = buildNodes(d.text));
    const why = !nodes ? 'has a value that could not be understood'
      : d.prop === 'display' ? keywordsIssue(nodes, kwSet('none block inline')) : lengthsIssue(nodes, cap([0, 24]), 1);
    const res = why ? { code: 'value-not-allowed', why } : null;
    if (cacheKey) cc.profileCache.set(cacheKey, { finding: res });
    return res;
  }
  if (c.protectedRef && (PROTECTED_COLOUR_PROPS.has(d.prop) || /^(?:animation|text-decoration|text-underline)/.test(d.prop))) {
    const res = { code: 'property-not-allowed', why: `${d.prop} is not allowed here: this selector reaches an ad, a sponsorship label or a player control, whose colours and text decoration a theme may not change (borders, radius and outer shadows are fine)` };
    if (cacheKey) cc.profileCache.set(cacheKey, { finding: res });
    return res;
  }
  const sp = SPEC.get(d.prop);
  if (!sp || (sp.scope === 'own' && c.profile === 'foreign') || (sp.scope === 'part' && c.profile !== 'part')) {
    const res = { code: 'property-not-allowed', why: `${d.prop} is not allowed on ${what}` };
    if (cacheKey) cc.profileCache.set(cacheKey, { finding: res });
    return res;
  }
  const nodes = d.nodes || (d.nodes = buildNodes(d.text));
  if (!nodes) {
    const res = { code: 'value-not-allowed', why: 'has a value that could not be understood' };
    if (cacheKey) cc.profileCache.set(cacheKey, { finding: res });
    return res;
  }
  const texts = [];
  const needsVar = d.hasVar !== undefined ? d.hasVar : (d.hasVar = hasVar(nodes));
  if (needsVar) {
    cc.budget = EXPAND_BUDGET;
    if (!expandThemeVars(d.text, cc, 0, texts)) {
      const res = { code: 'value-not-allowed', why: 'uses too many var() combinations to check' };
      if (cacheKey) cc.profileCache.set(cacheKey, { finding: res });
      return res;
    }
  } else texts.push(d.text);
  const cx = { ...c, prop: d.prop, cc };
  const prevInkSize = c.rule ? c.rule.ink.size : 0;
  const prevPaintSize = c.rule ? c.rule.paint.size : 0;
  for (const t of texts) {
    const nd = t === d.text ? nodes : buildNodes(t);
    if (!nd) {
      const res = { code: 'value-not-allowed', why: 'has a value that could not be understood' };
      if (cacheKey) cc.profileCache.set(cacheKey, { finding: res });
      return res;
    }
    if (!nd.length) {
      const res = { code: 'value-not-allowed', why: 'has no value' };
      if (cacheKey) cc.profileCache.set(cacheKey, { finding: res });
      return res;
    }
    const why = sp.fn(nd, cx);
    if (why) {
      const res = { code: 'value-not-allowed', why: `${why} (on ${what})` };
      if (cacheKey) cc.profileCache.set(cacheKey, { finding: res });
      return res;
    }
  }
  if (cacheKey) {
    const addedInk = c.rule && c.rule.ink.size > prevInkSize ? [...c.rule.ink] : null;
    const addedPaint = c.rule && c.rule.paint.size > prevPaintSize ? [...c.rule.paint] : null;
    cc.profileCache.set(cacheKey, { finding: null, ink: addedInk, paint: addedPaint });
  }
  return null;
}

// Colours of what the viewer must be able to read or see as an ad: restyling them with a theme colour could still make a light
// "Sponsored" label white on white, so nothing that paints text or a background may be set on a selector that reaches them.
const PROTECTED_COLOUR_PROPS = /* @__PURE__ */ new Set(['color', 'text-fill-color', 'caret-color', 'fill', 'stroke', 'background', 'background-color',
  'background-image', 'text-shadow', 'text-emphasis-color', 'color-scheme']);
const ACCENT_BG = /* @__PURE__ */ new Set(['--cd-accent', '--cd-accent-hover']);
/** Text colour against background colour inside one rule on a YouTube element: only pairs the theme tokens guarantee. */
function pairIssue(rule) {
  const bg = rule.paint;
  const ink = rule.ink;
  let onAccent = false;
  for (const b of bg) if (ACCENT_BG.has(b)) { onAccent = true; break; }
  if (onAccent && (!ink.size || !ink.has('--cd-accent-text') || ink.size > 1)) {
    return 'an accent background needs color: var(--cd-accent-text) in the same rule (other theme colours are not guaranteed to be readable on it)';
  }
  if (!onAccent && ink.has('--cd-accent-text')) return 'color: var(--cd-accent-text) is only readable on var(--cd-accent); set that background in the same rule';
  return null;
}

const profileContextKey = (c) => {
  const bit = (c.notice ? 1 : 0) | (c.decoration ? 2 : 0) | (c.protectedRef ? 4 : 0) | (c.absoluteOk ? 8 : 0) | (c.abs ? 16 : 0) | (c.keyframes ? 32 : 0);
  return `${c.profile}|${bit}`;
};

/** Applies the allow-list to every declaration of a rule, for each distinct kind of element its selectors can match. */
function checkProfile(S, rec, profiles, cc, flagged, reaches) {
  const declaresAbsolute = rec.hasPos && rec.decls.some((d) => !d.custom && d.prop === 'position' && /(?:^|[^a-z-])absolute/i.test(d.text));
  const distinctList = [];
  for (let pi = 0; pi < profiles.length; pi++) {
    const p = profiles[pi];
    const abs = declaresAbsolute || (!!p.name && ABSOLUTE_NAMES.has(p.name) && !p.pseudo);
    let found = false;
    for (let di = 0; di < distinctList.length; di++) {
      const d = distinctList[di];
      if (d.profile === p.profile && d.abs === abs && d.notice === p.notice && d.decoration === p.decoration && d.pseudo === p.pseudo && d.absoluteOk === p.absoluteOk) {
        found = true;
        break;
      }
    }
    if (!found) distinctList.push({ ...p, abs });
  }
  let done = flagged.size ? new Set(flagged) : null;
  for (const d of rec.decls) if (d.blocked) { if (!done) done = new Set(); done.add(d); }
  for (let pi = 0; pi < distinctList.length; pi++) {
    const p = distinctList[pi];
    const rule = p.profile === 'foreign' ? { ink: new Set(), paint: new Set() } : null;
    const c = { profile: p.profile, notice: !!p.notice, decoration: !!p.decoration, absoluteOk: !!p.absoluteOk, abs: p.abs, rule, protectedRef: !!reaches && !p.decoration };
    c.key = profileContextKey(c);
    for (const d of rec.decls) {
      if (done && done.has(d)) continue;
      const f = profileFinding(d, c, cc);
      if (f) {
        if (!done) done = new Set();
        done.add(d);
        S.report(d.off, `"${d.display}" ${f.why}`, f.code);
      }
    }
    if (p.profile === 'foreign') {
      const why = pairIssue(rule);
      if (why) S.report(rec.off, why, 'value-not-allowed');
    }
  }
}

// ---- rule evaluation ----------------------------------------------------------------------------------------------------

const DECORATION_ELEMENTS = /* @__PURE__ */ new Set(['-webkit-scrollbar', '-webkit-scrollbar-thumb', '-webkit-scrollbar-track',
  '-webkit-scrollbar-button', '-webkit-scrollbar-corner', '-webkit-scrollbar-track-piece', '-webkit-resizer', 'selection', '-moz-selection',
  'placeholder', '-webkit-input-placeholder', 'marker']);

/** Checks one compound; `inRoot` = it sits inside the arguments of html[cd-...]/:root[cd-...] (where any attribute is fine). Returns true for an anchored root compound. */
function checkCompound(S, cp, inRoot) {
  const { allow, report } = S;
  let anchor = false;
  let rootish = false;
  let identifies = false;
  let universal = false;
  let nonCdAttrs = null;
  const simples = cp.simples;
  for (let i = 0; i < simples.length; i++) {
    const s = simples[i];
    switch (s.k) {
      case 'class':
        identifies = true;
        if (s.name.startsWith(CD_PREFIX)) {
          anchor = true;
        } else if (!allow.classes.has(s.name)) {
          report(s.s, `".${shorten(s.name, 40)}" is not a Cinedrape class (${CD_PREFIX}...) and is not in the selector map`, 'selector-not-allowed');
        }
        break;
      case 'id':
        identifies = true;
        if (s.name.startsWith(CD_PREFIX)) {
          anchor = true;
        } else if (!allow.ids.has(s.name)) {
          report(s.s, `"#${shorten(s.name, 40)}" is not a Cinedrape id (${CD_PREFIX}...) and is not in the selector map`, 'selector-not-allowed');
        }
        break;
      case 'type':
        identifies = true;
        if (s.lname.startsWith(CD_PREFIX)) {
          anchor = true;
        } else if (s.lname === 'html' || s.lname === 'body') {
          rootish = true;
        } else if (!allow.tags.has(s.lname)) {
          report(s.s, `"${shorten(s.name, 40)}" is not a Cinedrape element (${CD_PREFIX}...) and is not in the selector map`, 'selector-not-allowed');
        }
        break;
      case 'attr':
        identifies = true;
        if (s.lname.startsWith(CD_PREFIX)) {
          anchor = true;
        } else if (!inRoot) {
          if (!nonCdAttrs) nonCdAttrs = [s];
          else nonCdAttrs.push(s);
        }
        break;
      case 'pseudo':
        if (s.name === 'root' && !s.fn) rootish = true;
        else if (s.list && IS_LIKE.has(s.name)) identifies = true;
        break;
      case 'univ':
        universal = true;
        break;
    }
  }
  if (nonCdAttrs && !(rootish && anchor)) {
    for (let i = 0; i < nonCdAttrs.length; i++) {
      const s = nonCdAttrs[i];
      if (!allow.attributes.has(s.lname)) {
        report(s.s, `"[${shorten(s.name, 40)}]" is not a Cinedrape attribute (${CD_PREFIX}...) and is not in the selector map`, 'selector-not-allowed');
      }
    }
  }
  if (rootish && !anchor) {
    report(cp.s, `"html", "body" and ":root" cannot be targeted without a ${CD_PREFIX} anchor; write html[${CD_PREFIX}theme] instead`, 'selector-bare');
  } else if (universal && !identifies && !anchor) {
    report(cp.s, 'The universal selector "*" cannot be used on its own; name the elements you mean', 'selector-bare');
  }
  return rootish && anchor;
}

function checkTree(S, cx, inRoot) {
  for (const cp of cx.compounds) {
    const rooted = checkCompound(S, cp, inRoot);
    for (const s of cp.simples) if (s.k === 'pseudo' && s.list) for (const m of s.list) checkTree(S, m, inRoot || rooted);
  }
}

function checkSelector(S, cx) {
  let len = cx.e - cx.s;
  if (len > MAX_SELECTOR_CHARS) {
    eachCompound(cx, (cp) => {
      for (const s of cp.simples) {
        if (s.k === 'pseudo' && s.list) for (const m of s.list) if (S.model.allCanon.has(canonComplex(m))) len -= m.e - m.s;
      }
    });
    if (len > MAX_SELECTOR_CHARS) S.report(cx.s, `This selector is ${len} characters long; the limit is ${MAX_SELECTOR_CHARS}`, 'selector');
  }
  checkTree(S, cx, false);
}

function evaluateRule(S, rec, cc) {
  const sels = rec.sels;
  if (!sels) { S.stats.skipped++; return; }
  S.stats.evaluated++;
  for (const cx of sels) checkSelector(S, cx);
  if (!rec.decls.length) return;
  S.stats.declarations += rec.decls.length;
  const profiles = [];
  let reaches = false;
  let needsClassify = false;
  let info = null;
  for (let si = 0; si < sels.length; si++) {
    const cx = sels[si];
    const ref = findProtectedRef(cx, S.model);
    if (ref) reaches = true;
    const mine = complexProfiles(cx);
    for (const p of mine) profiles.push(p);
    const own = mine.every((p) => p.profile !== 'foreign' || p.decoration);
    const need = !own && subjectNeedsGuard(cx, S.model);
    if (ref || need || !own) {
      needsClassify = true;
      if (!info) info = [];
      info.push({ cx, ref, own, need });
    }
  }
  const flagged = new Set();
  if (needsClassify && info) {
    for (const d of rec.decls) {
      const f = classifyDecl(d, cc);
      if (!f) continue;
      for (const x of info) {
        let msg = null;
        let code = '';
        if (f.kind === 'hide' && x.ref) {
          msg = `"${d.display}" ${f.why}, and this selector reaches ${shorten(x.ref, 50)}, which is an ad, a sponsorship label or a player control. Those must stay visible.`;
          code = 'hides-protected';
        } else if (f.kind === 'hide' && x.need) {
          const subject = shorten(canonCompound(subjectOf(x.cx)), 60);
          msg = subjectIsRoot(x.cx)
            ? `"${d.display}" ${f.why}; on "${subject}" that would hide the whole page, ads included.`
            : `"${d.display}" ${f.why}, and "${subject}" can hold an ad. End the selector with :not(:has(<the protected ads>)) (safeHide) or target a Cinedrape element (${CD_PREFIX}...).`;
          code = 'hides-container';
        } else if (f.kind === 'overlay' && (x.ref || !x.own)) {
          msg = `"${d.display}" ${f.why}. Only Cinedrape's own elements (${CD_PREFIX}...) may be positioned over or stacked above the page, because that can cover ads.`;
          code = 'covers-page';
        }
        if (msg) { S.report(d.off, msg, code); flagged.add(d); break; }
      }
    }
  }
  if (S.profile !== 'engine') checkProfile(S, rec, profiles, cc, flagged, reaches);
}

// ---- entry points -------------------------------------------------------------------------------------------------------

function lineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 10 || c === 12) starts.push(i + 1);
    else if (c === 13) {
      if (src.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    }
  }
  return starts;
}

function locate(starts, off) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= off) lo = mid; else hi = mid - 1;
  }
  return { line: lo + 1, column: off - starts[lo] + 1 };
}

function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; } else n += 3;
  }
  return n;
}

const makeError = (line, column, message, code) => ({ line, column, message, text: `Line ${line}: ${message}`, code });
const failure = (message, code = 'internal') => ({ ok: false, errors: [makeError(1, 1, message, code)] });

const EMPTY_STATS = Object.freeze({ rules: 0, evaluated: 0, skipped: 0, declarations: 0 });
const SAFETY_CODES = /* @__PURE__ */ new Set(['hides-protected', 'hides-container', 'covers-page']);
const RESERVED_SAFETY_SLOTS = 50;   // findings that matter most are still recorded after the cap has been reached

function run(css, ctx) {
  const c = isObj(ctx) ? ctx : {};
  if (typeof css !== 'string') return { ...failure('The CSS must be a string.', 'input'), stats: EMPTY_STATS };
  const maxBytes = Number.isFinite(c.maxBytes) && c.maxBytes > 0 ? c.maxBytes : LIMITS.cssMaxBytes;
  if (css.length > maxBytes * 4) return { ...failure(`The CSS is more than ${maxBytes} bytes; the limit is ${maxBytes}.`, 'size'), stats: EMPTY_STATS };
  const bytes = utf8Length(css);
  if (bytes > maxBytes) return { ...failure(`The CSS is ${bytes} bytes; the limit is ${maxBytes}.`, 'size'), stats: EMPTY_STATS };
  if (css.trim() === '') return { ok: true, errors: [], stats: EMPTY_STATS };
  const profile = c.profile === 'engine' ? 'engine' : 'theme';
  const maxErrors = c.maxErrors === Infinity ? Infinity : (Number.isFinite(c.maxErrors) && c.maxErrors >= 1 ? Math.floor(c.maxErrors) : MAX_ERRORS);

  const allow = normaliseAllow(c.allowList);
  const extra = strList(c.protectedSelectors).filter((s) => !allow.known.has(s.trim()));
  const model = extra.length ? buildModel(allow.protected, extra) : allow.model;

  let stats = EMPTY_STATS;
  const found = [];
  const seen = new Set();
  const report = (off, message, code = 'syntax') => {
    if (found.length >= maxErrors && !(SAFETY_CODES.has(code) && found.length < maxErrors + RESERVED_SAFETY_SLOTS)) return;
    const key = `${off}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ off, message, code });
  };

  const nul = css.indexOf('\u0000');
  if (nul >= 0) report(nul, 'NUL characters are not allowed', 'syntax');
  const bidi = BIDI_RE.exec(css);
  if (bidi) report(bidi.index, 'Bidirectional control characters are not allowed', 'syntax');
  const close = /<\/style/i.exec(css);
  if (close) report(close.index, '"</style" is not allowed', 'syntax');

  const toks = tokenize(css, report);
  const match = matchBrackets(toks, report);
  if (match) {
    stats = { rules: 0, evaluated: 0, skipped: 0, declarations: 0 };
    const S = { src: css, toks, match, report, rules: [], keyframes: new Map(), custom: new Map(), allow, model, profile, stats };
    parseStylesheet(S, 0, toks.length, 0);
    stats.rules = S.rules.length;
    const cc = { custom: S.custom, kf: new Map(), kfProfile: new Map(), profileCache: new Map(), classifyCache: new Map() };
    for (const [name, entry] of S.keyframes) cc.kf.set(name, entry.decls.some((d) => classifyDecl(d, cc) !== null));
    if (profile !== 'engine') {
      // A keyframes block is inert until something animates with it: what matters is whether it stays inside the allow-list for the
      // element that uses it (YouTube elements: cosmetic only; Cinedrape parts: the part list).
      for (const [name, entry] of S.keyframes) {
        const fits = (kind) => entry.decls.every((d) => !profileFinding(d, { profile: kind, notice: false, decoration: false, absoluteOk: false, abs: false, rule: null, keyframes: true }, cc));
        const verdict = { foreignOk: fits('foreign'), partOk: fits('part') };
        cc.kfProfile.set(name, verdict);
        cc.kfProfile.set(lc(name), verdict);
      }
    }
    const ruleCache = c.ruleCache;
    for (const rec of S.rules) {
      if (ruleCache && rec.end !== undefined) {
        const ruleText = S.src.slice(rec.off, rec.end);
        const cached = ruleCache.get(ruleText);
        if (cached) {
          if (cached.skipped) S.stats.skipped += cached.skipped;
          if (cached.evaluated) S.stats.evaluated += cached.evaluated;
          S.stats.declarations += cached.declarations;
          for (const item of cached.findings) {
            report(rec.off + item.relOff, item.message, item.code);
          }
          continue;
        }
        const beforeCount = found.length;
        const prevSkipped = S.stats.skipped;
        const prevEval = S.stats.evaluated;
        const prevDecls = S.stats.declarations;
        evaluateRule(S, rec, cc);
        const findings = [];
        for (let fi = beforeCount; fi < found.length; fi++) {
          findings.push({
            relOff: found[fi].off - rec.off,
            message: found[fi].message,
            code: found[fi].code,
          });
        }
        ruleCache.set(ruleText, {
          skipped: S.stats.skipped - prevSkipped,
          evaluated: S.stats.evaluated - prevEval,
          declarations: S.stats.declarations - prevDecls,
          findings,
        });
      } else {
        evaluateRule(S, rec, cc);
      }
    }
  }

  if (!found.length) return { ok: true, errors: [], stats };
  const starts = lineStarts(css);
  const errors = found
    .map((e, k) => ({ ...e, k }))
    .sort((a, b) => a.off - b.off || a.k - b.k)
    .map((e) => { const p = locate(starts, Math.min(e.off, css.length)); return makeError(p.line, p.column, e.message, e.code); });
  return { ok: errors.length === 0, errors, stats };
}

/**
 * Validates theme CSS. Never throws, always terminates. `ok` is true only when there is nothing wrong at all.
 * @param {string} css
 * @param {{allowList?: object, protectedSelectors?: string[], maxBytes?: number}} [ctx]  allowList from buildAllowList(map);
 *   protectedSelectors = flat ads + sponsor + playerControls list (also used when the allow-list carries none)
 * @returns {{ok: boolean, errors: Array<{line: number, column: number, message: string, text: string, code: string}>}}
 *   `message` is plain ("@import is not allowed"); `text` is "Line 4: @import is not allowed".
 */
export function validateCss(css, ctx) {
  try {
    const r = run(css, ctx);
    return { ok: r.ok, errors: r.errors };
  } catch {
    return failure('The CSS could not be checked.');
  }
}

/**
 * validateCss plus how much of the stylesheet was looked at: `stats` = {rules, evaluated, skipped, declarations}. A caller that
 * claims "every rule was checked" (the ad-safety scan of the whole composed stylesheet) compares rules with evaluated.
 * ctx also takes `maxErrors` (default 50; Infinity records everything; safety findings are always kept) and
 * `profile`: 'theme' (default) applies the allow-list; 'engine' skips it and keeps only the ad-safety classification, which
 * is what the scan of Cinedrape's own composed CSS uses (its rules legitimately style YouTube geometry).
 * @param {string} css
 * @param {object} [ctx]
 */
export function scanCss(css, ctx) {
  try {
    return run(css, ctx);
  } catch {
    return { ...failure('The CSS could not be checked.'), stats: EMPTY_STATS };
  }
}

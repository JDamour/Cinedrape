// Unit tests for the parts of the e2e harness that need no Chrome: the CLI, the readability audit (run in jsdom with stubbed layout),
// the gate, and the markdown. The real-browser behaviour is what `node test/e2e/run.mjs` checks (test/e2e/README.md).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EXIT, HarnessError, PAGES, parseCli } from './e2e/lib/cli.mjs';
import { AUDIT_DEFAULTS, GATE, auditPage, gateChecks } from './e2e/lib/audit.mjs';
import { buildReport, toMarkdown } from './e2e/lib/report.mjs';

const CATALOGUE = { allThemes: ['cinema', 'minimal', 'classic', 'primetime', 'studio', 'arcade'], freeThemes: ['cinema', 'minimal', 'classic'] };
const usage = (argv) => { try { parseCli(argv, CATALOGUE); } catch (err) { return err; } return null; };

describe('cli: --mode, --no-perf, --shots, --offenders', () => {
  test('light is the default; both runs light then dark; dark alone is dark', () => {
    assert.deepEqual(parseCli([], CATALOGUE).modes, ['light']);
    assert.deepEqual(parseCli(['--mode', 'both'], CATALOGUE).modes, ['light', 'dark']);
    assert.deepEqual(parseCli(['--mode', 'dark'], CATALOGUE).modes, ['dark']);
    assert.deepEqual(parseCli(['--mode=light'], CATALOGUE).modes, ['light']);
  });

  test('defaults: perf on, all shots, 15 offenders; the switches turn them off', () => {
    const d = parseCli([], CATALOGUE);
    assert.deepEqual([d.perf, d.shots, d.offenders], [true, 'all', 15]);
    const o = parseCli(['--no-perf', '--shots', 'none', '--offenders', '5'], CATALOGUE);
    assert.deepEqual([o.perf, o.shots, o.offenders], [false, 'none', 5]);
    assert.equal(parseCli(['--shots', 'view'], CATALOGUE).shots, 'view');
  });

  test('bad values are usage errors (exit 2) that name the option', () => {
    for (const [argv, re] of [[['--mode', 'sepia'], /--mode/], [['--shots', 'some'], /--shots/], [['--offenders', '0'], /--offenders/], [['--offenders', 'x'], /--offenders/], [['--offenders', '101'], /--offenders/]]) {
      const err = usage(argv);
      assert.ok(err instanceof HarnessError, argv.join(' '));
      assert.equal(err.exitCode, EXIT.USAGE);
      assert.match(err.message, re);
    }
  });
});

// ---- the audit, in jsdom -------------------------------------------------------------------------------------------------------

const RECT = { left: 10, top: 10, right: 210, bottom: 30, width: 200, height: 20, x: 10, y: 10 };

/** Runs auditPage on `body` inside a page with a ytd-page-manager. Layout is stubbed (one rect for everything, visibility by [data-hide]). */
function audit(body, { htmlStyle = 'background-color:#ffffff', cfg = {} } = {}) {
  const dom = new JSDOM(`<!doctype html><html style="${htmlStyle}"><body><ytd-page-manager>${body}</ytd-page-manager></body></html>`);
  const { window } = dom;
  const SVG_RECT = { left: 10, top: 10, right: 34, bottom: 34, width: 24, height: 24, x: 10, y: 10 };
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return this.tagName && this.tagName.toLowerCase() === 'svg' ? SVG_RECT : RECT;
  };
  window.Range.prototype.getBoundingClientRect = () => RECT;
  window.Element.prototype.checkVisibility = function checkVisibility() { return !this.closest('[data-hide]'); };
  window.document.elementsFromPoint = () => [];
  const saved = Object.fromEntries(['document', 'window', 'getComputedStyle', 'NodeFilter'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  Object.assign(globalThis, { document: window.document, window, getComputedStyle: window.getComputedStyle.bind(window), NodeFilter: window.NodeFilter });
  try {
    return auditPage({ ...AUDIT_DEFAULTS, ...cfg });
  } finally {
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
    window.close();
  }
}

describe('audit: effective background and thresholds', () => {
  test('translucent layers are composited on the way up and the walk stops at the first opaque one', () => {
    // 50% white over black = #808080; white text on it is 3.95:1: passes 3:1, fails the 4.5:1 of normal text
    const a = audit('<div style="background-color:#000000"><div style="background-color:rgba(255,255,255,0.5)"><span style="color:#ffffff">hello</span></div></div>');
    assert.equal(a.sampled, 1);
    assert.equal(a.offenders[0].bg, '#808080');
    assert.ok(a.offenders[0].ratio > 3.9 && a.offenders[0].ratio < 4.0, String(a.offenders[0].ratio));
    assert.deepEqual([a.fail3, a.failAA], [0, 1]);
    // an opaque layer hides everything behind it
    const b = audit('<div style="background-color:#000000"><div style="background-color:#ffffff"><span style="color:#000000">hello</span></div></div>');
    assert.deepEqual([b.sampled, b.failAA, b.offenders.length], [1, 0, 0]);
  });

  test('large text only needs 3:1, and below 3:1 counts in the gate figure', () => {
    // #777 on white is 4.48:1: normal text fails AA, 24px text passes
    const mid = audit('<span style="color:#777777">normal</span><span style="color:#777777;font-size:24px">large</span>');
    assert.deepEqual([mid.sampled, mid.failAA, mid.fail3], [2, 1, 0]);
    const low = audit('<span style="color:#aaaaaa;font-size:24px">large</span>');
    assert.deepEqual([low.fail3, low.failAA, low.pct3], [1, 1, 100]);
  });

  test('a background image (gradient or picture) makes the background unknown: skipped and counted, never guessed', () => {
    const a = audit('<div style="background-image:linear-gradient(red,blue)"><span style="color:#ffffff">on a gradient</span></div><span style="color:#ffffff">on the page</span>');
    assert.equal(a.skipped.bgImage, 1);
    assert.equal(a.sampled, 1);
    assert.equal(a.offenders[0].text, 'on the page');
  });

  test('hidden elements, thumbnail overlays and creator heart decorations are skipped and counted', () => {
    const a = audit(
      '<span data-hide style="color:#ffffff">hidden</span>'
      + '<ytd-thumbnail><span style="color:#ffffff">12:34</span></ytd-thumbnail>'
      + '<ytd-creator-heart-renderer><svg style="fill:#ff0000"><path d="M0 0"/></svg></ytd-creator-heart-renderer>'
      + '<span style="color:#000000">fine</span>',
    );
    assert.equal(a.sampled, 1);
    assert.equal(a.skipped.hidden, 1);
    assert.equal(a.skipped.media, 2);
    assert.equal(a.offenders.length, 0);
  });

  test('translucent text is composited on the background before the ratio is taken', () => {
    const a = audit('<span style="color:rgba(0,0,0,0.5)">grey</span>'); // 50% black on white = #808080: 3.95:1
    assert.equal(a.offenders[0].fg, '#808080');
    assert.deepEqual([a.fail3, a.failAA], [0, 1]);
  });
});

describe('audit: titles, surfaces and the gate', () => {
  test('titles are held to 4.5:1 even when large, and they are always measured', () => {
    const a = audit('<a id="video-title" style="color:#777777;font-size:28px">A title</a><span style="color:#000000">x</span>');
    assert.equal(a.titles.count, 1);
    assert.equal(a.titles.fail45, 1, '#777 on white is 4.48:1');
    assert.equal(a.failAA, 0, 'but as large text it is not an AA failure');
    const checks = gateChecks(a);
    assert.equal(checks.find((c) => c.name === 'readability-titles').ok, false);
    assert.equal(checks.find((c) => c.name === 'readability-titles').level, 'fail');
  });

  test('surfaces: html, body, ytd-app and ytd-page-manager are compared with the --cd-bg token', () => {
    const on = audit('<span style="color:#ffffff">x</span>', { htmlStyle: '--cd-bg:#0b0b0f;background-color:#0b0b0f' });
    assert.equal(on.tokenBg, '#0b0b0f');
    assert.equal(on.surfaces.html.equalsToken, true);
    assert.equal(on.surfaces['ytd-page-manager'].equalsToken, true, 'a transparent page manager shows the html colour');
    assert.equal(on.surfaces['ytd-app'], null, 'a missing element is null, not a failure');
    const off = audit('<span style="color:#ffffff">x</span>', { htmlStyle: '--cd-bg:#0b0b0f;background-color:#ffffff' });
    assert.equal(off.surfaces.html.equalsToken, false);
    const warn = gateChecks(off).find((c) => c.name === 'surfaces-bg');
    assert.deepEqual([warn.ok, warn.level], [false, 'warn']);
  });

  test('gate: 3.5% of the sampled elements below 3:1 is the line; a thin page cannot pass by having nothing to measure', () => {
    const synth = (patch) => ({ sampled: 100, pct3: 0, skipped: {}, offenders: [], surfaces: {}, tokenBg: '#000000', titles: { count: 5, fail45: 0, worst: null }, ...patch });
    const ok = (a, name) => gateChecks(a).find((c) => c.name === name).ok;
    assert.equal(GATE.maxFail3Pct, 3.5);
    assert.equal(ok(synth({ pct3: 3.5 }), 'readability-rate'), true);
    assert.equal(ok(synth({ pct3: 3.6 }), 'readability-rate'), false);
    assert.equal(ok(synth({ sampled: GATE.minSampled }), 'readability-sample'), true);
    assert.equal(ok(synth({ sampled: GATE.minSampled - 1 }), 'readability-sample'), false);
    // a page may have its own, lower minimum (logged-out home is an empty state with about 17 measurable elements)
    const opts = { minSampled: 10 };
    assert.equal(gateChecks(synth({ sampled: 17 }), opts).find((c) => c.name === 'readability-sample').ok, true);
    assert.equal(gateChecks(synth({ sampled: 9 }), opts).find((c) => c.name === 'readability-sample').ok, false);
    assert.equal(PAGES.home.minSampled, 10);
    assert.equal(PAGES.channel.minSampled, undefined, 'every other page uses the default');
    assert.equal(ok(synth({ titles: { count: 5, fail45: 1, worst: { text: 't', fg: '#fff', bg: '#fff', ratio: 1 } } }), 'readability-titles'), false);
    for (const c of gateChecks(synth({}))) assert.ok(c.ok, c.name);
  });
});

describe('report: the readability matrix', () => {
  const audit1 = (over) => ({
    sampled: 100, fail3: 0, failAA: 0, pct3: 0, pctAA: 0, text: { n: 70 }, icons: { n: 30 }, tokenBg: '#0b0b0f',
    byRegion: { masthead: { fail3: 0, n: 10 }, guide: { fail3: 0, n: 10 }, content: { fail3: 0, n: 80 } },
    skipped: { hidden: 3, media: 2, bgImage: 1 }, titles: { count: 5, fail45: 0, worst: null }, offenders: [],
    surfaces: { html: { equalsToken: true }, body: { equalsToken: true }, 'ytd-app': { equalsToken: true }, 'ytd-page-manager': { equalsToken: true } }, ...over,
  });
  const offender = { ratio: 1.12, required: 4.5, region: 'content', kind: 'text', title: true, size: '14px/500', path: 'a#video-title', text: 'A title', fg: '#f2f2f5', bg: '#ffffff', count: 7 };
  const results = [
    { theme: 'cinema', page: 'channel', mode: 'light', modeActual: 'light', audit: audit1({ fail3: 55, failAA: 56, pct3: 55, pctAA: 56, offenders: [offender], titles: { count: 5, fail45: 5, worst: offender } }), checks: [], screenshots: [] },
    { theme: 'cinema', page: 'channel', mode: 'dark', modeActual: 'dark', audit: audit1({}), checks: [], screenshots: [] },
  ];
  const meta = { extension: { name: 'x', version: '1', path: 'dist' }, chromeVersion: 'Chrome/1', headed: false, viewport: { width: 1280, height: 720 }, pro: false, startedAt: 'now', durationMs: 1000 };

  test('rows per theme and mode, the worst offender with its colours and repeat count, the mode on every row', () => {
    const md = toMarkdown(buildReport(meta, results, null));
    assert.match(md, /### Matrix \(theme x mode/);
    assert.match(md, /\| cinema \| light \| channel \| 100 \| 55 \(55%\) \| 56 \(56%\) \| 5\/5 \| channel: a#video-title "A title" #f2f2f5 on #ffffff = 1\.12:1 \(x7\) \|/);
    assert.match(md, /\| cinema \| dark \| channel \| 100 \| 0 \(0%\) \| 0 \(0%\) \| 0\/5 \| - \|/);
    assert.match(md, /\*\*cinema \/ channel \/ light\*\*/);
    assert.match(md, /1\.12:1 \(needs 4\.5\) \[content text, title, 14px\/500\] `a#video-title` "A title" #f2f2f5 on #ffffff x7/);
    assert.ok(!/\*\*cinema \/ channel \/ dark\*\*/.test(md), 'a clean row lists no offenders');
  });

  test('a row that did not get the mode it asked for says so', () => {
    const md = toMarkdown(buildReport(meta, [{ ...results[1], modeActual: 'light' }], null));
    assert.match(md, /dark \(got light\)/);
  });

  test('failures and warnings are attributed to theme/page/mode', () => {
    const r = [{ ...results[0], checks: [{ name: 'readability-rate', ok: false, level: 'fail', detail: 'x' }, { name: 'surfaces-bg', ok: false, level: 'warn', detail: 'y' }] }];
    const rep = buildReport(meta, r, null);
    assert.equal(rep.summary.failures[0].mode, 'light');
    assert.equal(rep.summary.warnings[0].mode, 'light');
    assert.match(toMarkdown(rep), /FAIL cinema\/channel\/light readability-rate/);
  });
});

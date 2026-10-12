// READABILITY AUDIT. `auditPage` runs INSIDE the YouTube page (page.evaluate), so it is serialised with
// Function.prototype.toString and must be fully self-contained: no imports, no closure variables.
//
// It samples visible text-bearing elements (and, as a separate kind, icons) of the masthead, the guide and the main content,
// computes each one's text colour against its EFFECTIVE background (ancestors' background-colors alpha-composited until the first
// opaque one) and reports the share below 3:1 and below the WCAG threshold for its size.
//
// Exclusion rules. All are counted in `skipped`; none of them hides anything, they only decide what is measured:
//   hidden    display:none, visibility:hidden, opacity:0, content-visibility skipped (Element.checkVisibility), zero-size,
//             clipped away by an overflow ancestor, or outside the first `cfg.screens` viewport heights.
//   media     text or icons inside, or geometrically over, an img/video, the player or a thumbnail: their background is user
//             content (duration/LIVE badges, Shorts captions, the player's own UI), a colour nobody can know. Also YouTube's own Lottie
//             animations (lottie-component: the like-button burst of the watch page, colours baked into the animation, invisible until played).
//   bgImage   an ancestor up to the first opaque colour paints a background-image (gradient or picture), or the text is
//             background-clip:text: the effective background is unknown, so the element is skipped rather than guessed.
//   noRegion  text outside masthead / guide / page manager (popups that are not open, YouTube's hidden templates).
// Ads and sponsorship disclosures get NO special exemption: if one is on screen it is measured like everything else.
//
// cfg: {screens, budgets:{text:{masthead,guide,content}, icon:{...}}, offenders, titleSel, mediaSel, tokenBg?}

/** The defaults the harness passes; exported so the unit-free harness and the debug scripts share one set. */
export const AUDIT_DEFAULTS = Object.freeze({
  screens: 3,
  budgets: { text: { masthead: 60, guide: 120, content: 320 }, icon: { masthead: 25, guide: 50, content: 60 } },
  offenders: 15,
  titleSel: 'a#video-title, #video-title, a.ytLockupMetadataViewModelTitle, .ytLockupMetadataViewModelTitle, .ytLockupMetadataViewModelHeadingReset, h1, h3',
  mediaSel: 'ytd-player, #movie_player, #player, video, img, ytd-thumbnail, yt-thumbnail-view-model, yt-collection-thumbnail-view-model, ytd-miniplayer, ytd-reel-video-renderer, #cinematics, lottie-component, yt-animated-action',
});

/** Gate thresholds (README.md): more than this share of sampled elements below 3:1 fails the run; so does any title below 4.5:1. */
export const GATE = Object.freeze({ maxFail3Pct: 3, titleMinRatio: 4.5, minSampled: 25 });

export function auditPage(cfg) {
  const root = document.documentElement;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxY = vh * cfg.screens;

  // ---- colour maths ----
  const cache = new Map();
  let g2d = null;
  const viaCanvas = (text) => {
    try {
      if (!g2d) { const c = document.createElement('canvas'); c.width = 1; c.height = 1; g2d = c.getContext('2d', { willReadFrequently: true }); }
      g2d.clearRect(0, 0, 1, 1);
      g2d.fillStyle = '#010203';
      g2d.fillStyle = text;
      g2d.fillRect(0, 0, 1, 1);
      const d = g2d.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    } catch (e) { return null; }
  };
  const num = (s, scale) => (String(s).endsWith('%') ? (parseFloat(s) / 100) * scale : parseFloat(s));
  const parse = (text) => {
    if (!text) return null;
    if (cache.has(text)) return cache.get(text);
    let out = null;
    let m = /^rgba?\(([^)]+)\)$/.exec(text);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean);
      if (p.length >= 3) out = { r: num(p[0], 255), g: num(p[1], 255), b: num(p[2], 255), a: p.length > 3 ? num(p[3], 1) : 1 };
    } else if ((m = /^color\(srgb\s+([^)]+)\)$/.exec(text))) {
      const p = m[1].split(/[\s/]+/).filter(Boolean);
      if (p.length >= 3) out = { r: num(p[0], 1) * 255, g: num(p[1], 1) * 255, b: num(p[2], 1) * 255, a: p.length > 3 ? num(p[3], 1) : 1 };
    } else if (text === 'transparent') out = { r: 0, g: 0, b: 0, a: 0 };
    if (!out || [out.r, out.g, out.b, out.a].some((v) => !Number.isFinite(v))) out = viaCanvas(text);
    cache.set(text, out);
    return out;
  };
  const lum = (c) => {
    const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

  // ---- effective background, memoised per element ----
  const rootScheme = getComputedStyle(root).colorScheme || '';
  const canvasBase = /\bdark\b/.test(rootScheme) && !/\blight\b/.test(rootScheme) ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  const bgMemo = new Map();
  const effBg = (el) => {
    const chain = [];
    let base = null;
    for (let n = el; n; n = n.parentElement) {
      if (bgMemo.has(n)) { base = bgMemo.get(n); break; }
      chain.push(n);
    }
    if (!base) base = { rgb: canvasBase };
    for (let i = chain.length - 1; i >= 0; i--) {
      const n = chain[i];
      const cs = getComputedStyle(n);
      const c = parse(cs.backgroundColor);
      const img = cs.backgroundImage && cs.backgroundImage !== 'none';
      let res;
      if (c && c.a >= 0.99) res = { rgb: { r: c.r, g: c.g, b: c.b, a: 1 } };
      else if (img) res = { unknown: true, by: n.tagName.toLowerCase() };
      else if (c && c.a > 0) res = base.unknown ? base : { rgb: over(c, base.rgb) };
      else res = base;
      bgMemo.set(n, res);
      base = res;
    }
    return bgMemo.get(el);
  };
  // What is really painted behind a text box is not only its ancestors: YouTube draws the masthead bar in a SIBLING layer
  // (ytd-masthead #background) beneath the content. When the element's own point is on screen and the element itself is in the
  // hit-test stack, the layers from the element down to the first opaque colour are read from document.elementsFromPoint (paint
  // order); anything else (below the fold, pointer-events:none) falls back to the ancestor walk above.
  const stackBg = (el, rect) => {
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    if (!(cx >= 0 && cx < vw && cy >= 0 && cy < vh)) return null;
    let stack;
    try { stack = document.elementsFromPoint(cx, cy); } catch (e) { return null; }
    const start = stack.indexOf(el);
    if (start < 0) return null;
    const layers = [];
    let base = null;
    for (let k = start; k < stack.length; k++) {
      const n = stack[k];
      const cs = getComputedStyle(n);
      const c = parse(cs.backgroundColor);
      if (c && c.a >= 0.99) { base = { r: c.r, g: c.g, b: c.b, a: 1 }; break; }
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return { unknown: true, by: n.tagName.toLowerCase() };
      if (c && c.a > 0) layers.push(c);
    }
    let rgb = base || canvasBase;
    for (let k = layers.length - 1; k >= 0; k--) rgb = over(layers[k], rgb);
    return { rgb };
  };
  const opMemo = new Map();
  const effOpacity = (el) => {
    if (!el) return 1;
    if (opMemo.has(el)) return opMemo.get(el);
    const v = (parseFloat(getComputedStyle(el).opacity) || 0) * effOpacity(el.parentElement);
    opMemo.set(el, v);
    return v;
  };

  // ---- geometry and visibility ----
  const visible = (el) => {
    try { return el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }); } catch (e) { /* older shape */ }
    try { return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch (e) { return true; }
  };
  const clipped = (el, r) => {
    let l = r.left; let t = r.top; let rt = r.right; let b = r.bottom;
    // <body> is skipped: its overflow propagates to the viewport (YouTube gives it overflow:scroll and a 0px height).
    for (let n = el.parentElement; n && n !== root; n = n.parentElement) {
      if (n === document.body) continue;
      const cs = getComputedStyle(n);
      const ox = cs.overflowX !== 'visible';
      const oy = cs.overflowY !== 'visible';
      if (ox || oy) {
        const pr = n.getBoundingClientRect();
        if (ox) { l = Math.max(l, pr.left); rt = Math.min(rt, pr.right); }
        if (oy) { t = Math.max(t, pr.top); b = Math.min(b, pr.bottom); }
        if (rt - l < 1 || b - t < 1) return true;
      }
      if (cs.position === 'fixed') break; // a fixed box is not clipped by the ancestors above it
    }
    return Math.min(rt, vw) - Math.max(l, 0) < 1 || Math.min(b, maxY) - Math.max(t, 0) < 1;
  };
  const media = [];
  // canvas is left out on purpose: the watch page's ambient-light canvas (#cinematics) spans the whole viewport behind the content.
  for (const m of document.querySelectorAll('img, video')) {
    const r = m.getBoundingClientRect();
    if (r.width >= 24 && r.height >= 24 && r.bottom > 0 && r.top < maxY && visible(m)) media.push(r);
  }
  const overMedia = (r) => {
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    return media.some((m) => cx > m.left && cx < m.right && cy > m.top && cy < m.bottom);
  };

  const regionOf = (el) => (el.closest('ytd-masthead, #masthead-container') ? 'masthead'
    : el.closest('tp-yt-app-drawer#guide, ytd-guide-renderer, ytd-mini-guide-renderer, #guide') ? 'guide'
      : el.closest('ytd-page-manager, #page-manager') ? 'content' : null);
  const desc = (n) => {
    let s = n.tagName.toLowerCase();
    if (n.id && /^[\w-]{1,40}$/.test(n.id)) s += '#' + n.id;
    const cl = typeof n.className === 'string' ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    if (cl.length) s += '.' + cl.join('.');
    return s.slice(0, 70);
  };
  const pathOf = (el) => {
    const parts = [desc(el)];
    let depth = 0;
    for (let n = el.parentElement; n && depth < 2 && n !== document.body; n = n.parentElement) {
      if (n.tagName.includes('-') || n.id) { parts.unshift(desc(n)); depth++; }
    }
    return parts.join(' > ');
  };

  // ---- candidates ----
  const skipped = { hidden: 0, media: 0, bgImage: 0, noRegion: 0, noColor: 0 };
  const cand = { text: { masthead: [], guide: [], content: [] }, icon: { masthead: [], guide: [], content: [] } };
  let scannedText = 0;
  const seen = new Set();
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = tw.nextNode(); node; node = tw.nextNode()) {
    if (!/\S/.test(node.data)) continue;
    const el = node.parentElement;
    if (!el || seen.has(el) || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE)$/.test(el.tagName)) continue;
    seen.add(el);
    scannedText++;
    const region = regionOf(el);
    if (!region) { skipped.noRegion++; continue; }
    if (!visible(el)) { skipped.hidden++; continue; }
    const rg = document.createRange();
    rg.selectNodeContents(node);
    const rect = rg.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || clipped(el, rect)) { skipped.hidden++; continue; }
    if (el.closest(cfg.mediaSel) || overMedia(rect)) { skipped.media++; continue; }
    cand.text[region].push({ el, rect, kind: 'text' });
  }
  for (const svg of document.querySelectorAll('svg')) {
    const region = regionOf(svg);
    if (!region) continue;
    if (!visible(svg)) { skipped.hidden++; continue; }
    const rect = svg.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10 || rect.width > 160 || rect.height > 80 || clipped(svg, rect)) { skipped.hidden++; continue; }
    if (svg.closest(cfg.mediaSel) || overMedia(rect)) { skipped.media++; continue; }
    cand.icon[region].push({ el: svg, rect, kind: 'icon' });
  }

  // Titles are always measured; the rest of each region is thinned out with an even stride down to its budget.
  const isTitle = (el) => Boolean(el.closest(cfg.titleSel));
  const pick = (list, budget) => {
    const titles = list.filter((c) => c.kind === 'text' && isTitle(c.el));
    const rest = list.filter((c) => !(c.kind === 'text' && isTitle(c.el)));
    const room = Math.max(0, budget - titles.length);
    if (rest.length <= room) return [...titles, ...rest];
    const out = [];
    for (let i = 0; i < room; i++) out.push(rest[Math.floor((i * rest.length) / room)]);
    return [...titles, ...out];
  };
  const chosen = [];
  for (const kind of ['text', 'icon']) {
    for (const region of ['masthead', 'guide', 'content']) {
      for (const c of pick(cand[kind][region], cfg.budgets[kind][region])) chosen.push({ ...c, region });
    }
  }

  // ---- measure ----
  const rows = [];
  for (const c of chosen) {
    const cs = getComputedStyle(c.el);
    let fg = null;
    let large = true;
    if (c.kind === 'text') {
      if (cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text') { skipped.bgImage++; continue; }
      fg = parse(cs.webkitTextFillColor) || parse(cs.color);
      const px = parseFloat(cs.fontSize) || 14;
      const weight = parseInt(cs.fontWeight, 10) || 400;
      large = px >= 24 || (px >= 18.66 && weight >= 700);
    } else {
      const first = c.el.querySelector('path, circle, rect, g, polygon') || c.el;
      const f = parse(getComputedStyle(first).fill);
      const fSvg = parse(getComputedStyle(c.el).fill);
      const st = parse(getComputedStyle(first).stroke);
      fg = f && f.a > 0 ? f : fSvg && fSvg.a > 0 ? fSvg : st && st.a > 0 ? st : parse(cs.color);
    }
    if (!fg) { skipped.noColor++; continue; }
    const bg = stackBg(c.el, c.rect) || effBg(c.el);
    if (!bg || bg.unknown) { skipped.bgImage++; continue; }
    const alpha = fg.a * Math.min(1, effOpacity(c.el));
    const text = over({ r: fg.r, g: fg.g, b: fg.b, a: alpha }, bg.rgb);
    const r = ratio(text, bg.rgb);
    const required = c.kind === 'icon' ? 3 : large ? 3 : 4.5;
    const title = c.kind === 'text' && isTitle(c.el);
    rows.push({
      kind: c.kind, region: c.region, ratio: Math.round(r * 100) / 100, required, title,
      fail3: r < 3, failAA: r < required, fail45: r < 4.5,
      fg: hex(text), bg: hex(bg.rgb), path: pathOf(c.el),
      text: c.kind === 'text' ? c.el.textContent.replace(/\s+/g, ' ').trim().slice(0, 40) : '(icon)',
      size: c.kind === 'text' ? `${Math.round(parseFloat(cs.fontSize) || 0)}px/${cs.fontWeight}` : `${Math.round(c.rect.width)}x${Math.round(c.rect.height)}`,
    });
  }

  const stat = (list) => {
    const n = list.length;
    const f3 = list.filter((x) => x.fail3).length;
    const fa = list.filter((x) => x.failAA).length;
    return { n, fail3: f3, failAA: fa, pct3: n ? Math.round((f3 / n) * 1000) / 10 : 0, pctAA: n ? Math.round((fa / n) * 1000) / 10 : 0 };
  };
  // The same offender repeated (every card title has one path and one colour pair) is listed once with a count.
  const groups = new Map();
  for (const x of rows.filter((r) => r.failAA)) {
    const key = `${x.path}|${x.fg}|${x.bg}`;
    const g = groups.get(key);
    if (g) { g.count++; if (x.ratio < g.ratio) { g.ratio = x.ratio; g.text = x.text; } } else groups.set(key, { ...x, count: 1 });
  }
  const offenders = [...groups.values()].sort((a, b) => a.ratio - b.ratio || b.count - a.count).slice(0, cfg.offenders);
  const titles = rows.filter((x) => x.title);
  const titleFails = titles.filter((x) => x.fail45);

  const tokenBg = cfg.tokenBg || (getComputedStyle(root).getPropertyValue('--cd-bg') || '').trim().toLowerCase();
  const surfaces = {};
  for (const name of ['html', 'body', 'ytd-app', 'ytd-page-manager']) {
    const el = document.querySelector(name);
    if (!el) { surfaces[name] = null; continue; }
    const own = parse(getComputedStyle(el).backgroundColor);
    const eff = effBg(el);
    const effHex = eff && eff.rgb ? hex(eff.rgb) : null;
    surfaces[name] = {
      bg: getComputedStyle(el).backgroundColor, effective: effHex,
      equalsToken: Boolean(tokenBg && effHex && effHex === tokenBg),
      ownEqualsToken: Boolean(tokenBg && own && own.a >= 0.99 && hex(own) === tokenBg),
    };
  }

  const all = stat(rows);
  return {
    mode: root.hasAttribute('dark') ? 'dark' : 'light', colorScheme: rootScheme, tokenBg,
    viewport: { width: vw, height: vh, screens: cfg.screens },
    scannedText, sampled: all.n, fail3: all.fail3, failAA: all.failAA, pct3: all.pct3, pctAA: all.pctAA,
    text: stat(rows.filter((x) => x.kind === 'text')), icons: stat(rows.filter((x) => x.kind === 'icon')),
    byRegion: {
      masthead: stat(rows.filter((x) => x.region === 'masthead')),
      guide: stat(rows.filter((x) => x.region === 'guide')),
      content: stat(rows.filter((x) => x.region === 'content')),
    },
    skipped,
    titles: { count: titles.length, fail45: titleFails.length, worst: titles.length ? titles.reduce((a, b) => (b.ratio < a.ratio ? b : a)) : null },
    offenders, surfaces,
  };
}

/**
 * The gate as a list of checks {name, ok, detail, level} (level 'fail' decides the exit code, 'warn' is reported only).
 * Pure, so the unit tests can run it on synthetic audit results.
 * @param {ReturnType<typeof auditPage>} a
 * @param {{minSampled?: number}} [opts]  the page's own minimum sample (logged-out home is an empty state with about 17 elements)
 */
export function gateChecks(a, { minSampled = GATE.minSampled } = {}) {
  const worst = a.offenders[0];
  const worstText = worst ? `worst: ${worst.path} "${worst.text}" ${worst.fg} on ${worst.bg} = ${worst.ratio}:1 (x${worst.count})` : 'no offenders';
  const tw = a.titles.worst;
  const offSurface = Object.entries(a.surfaces).filter(([, v]) => v && !v.equalsToken).map(([k, v]) => `${k} ${v.effective}`);
  return [
    { name: 'readability-sample', ok: a.sampled >= minSampled, level: 'fail',
      detail: `the audit measured only ${a.sampled} elements (< ${minSampled}); skipped ${JSON.stringify(a.skipped)}` },
    { name: 'readability-rate', ok: a.pct3 <= GATE.maxFail3Pct, level: 'fail',
      detail: `${a.pct3}% of ${a.sampled} sampled elements are below 3:1 (gate ${GATE.maxFail3Pct}%); ${worstText}` },
    { name: 'readability-titles', ok: a.titles.fail45 === 0, level: 'fail',
      detail: `${a.titles.fail45} of ${a.titles.count} title elements are below ${GATE.titleMinRatio}:1; worst ${tw ? `"${tw.text}" ${tw.fg} on ${tw.bg} = ${tw.ratio}:1` : 'none'}` },
    { name: 'surfaces-bg', ok: offSurface.length === 0, level: 'warn',
      detail: `effective background differs from the theme bg token ${a.tokenBg}: ${offSurface.join(', ')}` },
  ];
}

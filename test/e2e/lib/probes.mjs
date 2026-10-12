// Functions that run INSIDE the YouTube page (page.evaluate / evaluateOnNewDocument). They are serialised with
// Function.prototype.toString, so each one must be fully self-contained: no imports, no closure variables.

/** evaluateOnNewDocument: timestamps (ms since navigation start) of the first cd-theme attribute and of the style element. */
export function initScript() {
  try {
    const st = { styleSeenAt: null, styleFilledAt: null, attrSeenAt: null, styleBytesFirst: null, firstPaintCache: null };
    window.__cdE2E = st;
    try { st.firstPaintCache = window.localStorage.getItem('cd:v1:firstPaint') !== null; } catch (e) { st.firstPaintCache = null; }
    let obs = null;
    const check = () => {
      const now = performance.now();
      const root = document.documentElement;
      if (st.attrSeenAt === null && root && root.hasAttribute('cd-theme')) st.attrSeenAt = now;
      const el = document.getElementById('cinedrape-theme');
      if (el && st.styleSeenAt === null) st.styleSeenAt = now;
      if (el && st.styleFilledAt === null && (el.textContent.length > 0 || (el.sheet && el.sheet.cssRules.length > 0))) {
        st.styleFilledAt = now;
        st.styleBytesFirst = el.textContent.length;
      }
      if (obs && st.attrSeenAt !== null && st.styleFilledAt !== null) obs.disconnect();
    };
    obs = new MutationObserver(check);
    obs.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['cd-theme'] });
    check();
  } catch (e) { /* never break the page */ }
}

/** Returns {kind, detail} when the page is a consent wall, a CAPTCHA/"sorry" page or off youtube.com, else null. */
export function detectWall() {
  const host = location.hostname;
  const href = location.href;
  if (host.startsWith('consent.') || location.pathname.startsWith('/consent')) return { kind: 'consent', detail: href };
  if (document.querySelector('ytd-consent-bump-v2-lightbox, .consent-bump-v2-lightbox')) return { kind: 'consent', detail: 'consent dialog in page' };
  if (href.includes('/sorry/')) return { kind: 'captcha', detail: href };
  if (host !== 'www.youtube.com' && host !== 'youtube.com') return { kind: 'redirect', detail: href };
  return null;
}

/** One snapshot of everything we record about a settled page. */
export function probePage(titleSelectors) {
  const root = document.documentElement;
  const attrs = {};
  for (const a of root.attributes) if (a.name.startsWith('cd-') || a.name === 'dark') attrs[a.name] = a.value;

  const el = document.getElementById('cinedrape-theme');
  const style = {
    exists: Boolean(el),
    bytes: el ? new Blob([el.textContent]).size : 0,
    rules: el && el.sheet ? el.sheet.cssRules.length : 0,
    copies: document.querySelectorAll('style#cinedrape-theme').length,
    parent: el && el.parentNode ? el.parentNode.nodeName : null,
    adoptedSheets: (document.adoptedStyleSheets || []).length,
  };

  const parse = (text) => {
    const m = /rgba?\(([^)]+)\)/.exec(text || '');
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const lum = (c) => {
    const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const hi = Math.max(lum(a), lum(b)); const lo = Math.min(lum(a), lum(b)); return (hi + 0.05) / (lo + 0.05); };
  const effectiveBg = (node) => {
    const layers = [];
    for (let n = node; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 0.99) break; }
    }
    let base = { r: 255, g: 255, b: 255 };
    for (let i = layers.length - 1; i >= 0; i--) {
      const c = layers[i];
      base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) };
    }
    return base;
  };
  const pair = (node) => {
    if (!node) return null;
    const cs = getComputedStyle(node);
    return { bg: cs.backgroundColor, text: cs.color };
  };
  const colors = { html: pair(root), body: pair(document.body), app: pair(document.querySelector('ytd-app')), title: null };
  for (const sel of titleSelectors) {
    const hit = Array.from(document.querySelectorAll(sel)).find((n) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && n.textContent.trim().length > 0;
    });
    if (!hit) continue;
    const text = parse(getComputedStyle(hit).color);
    const bg = effectiveBg(hit);
    colors.title = {
      selector: sel,
      sample: hit.textContent.trim().slice(0, 40),
      text: getComputedStyle(hit).color,
      effectiveBg: hex(bg),
      contrast: text ? Math.round(ratio(text, bg) * 100) / 100 : null,
    };
    break;
  }

  const paint = {};
  for (const e of performance.getEntriesByType('paint')) paint[e.name === 'first-paint' ? 'fp' : e.name === 'first-contentful-paint' ? 'fcp' : e.name] = Math.round(e.startTime * 10) / 10;
  const t = window.__cdE2E || {};
  const r1 = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : null);
  const pe = document.querySelector('.ytp-error-content-wrap-reason, yt-player-error-message-renderer #reason');
  return {
    attrs, style, colors, paint,
    timings: { attrAt: r1(t.attrSeenAt), styleSeenAt: r1(t.styleSeenAt), styleFilledAt: r1(t.styleFilledAt), styleBytesFirst: t.styleBytesFirst, firstPaintCache: t.firstPaintCache },
    playerError: pe ? pe.textContent.trim().slice(0, 120) : null,
    ytApp: Boolean(document.querySelector('ytd-app')),
    scrollHeight: root.scrollHeight,
    url: location.href,
  };
}

/**
 * Every node matching an ad/sponsor selector is classified; a node that is not visible WITH the Cinedrape stylesheet but
 * IS visible with it disabled was hidden by the extension: that is a violation of the ad rules (ARCHITECTURE section 6).
 */
export function adCheck(selectors) {
  const describe = (n) => n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  const state = (node) => {
    for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none') return 'display:none';
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return 'visibility';
      if (parseFloat(cs.opacity) < 0.99) return 'opacity';
      if (n === node && cs.clipPath && cs.clipPath !== 'none') return 'clip-path';
    }
    const r = node.getBoundingClientRect();
    return r.width < 1 || r.height < 1 ? 'zero-size' : 'ok';
  };
  const nodes = [];
  const seen = new Set();
  for (const sel of selectors) {
    let list;
    try { list = document.querySelectorAll(sel); } catch (e) { continue; }
    for (const n of list) if (!seen.has(n)) { seen.add(n); nodes.push(n); }
    if (nodes.length > 400) break;
  }
  const withExt = nodes.map(state);
  const notOk = withExt.map((s, i) => (s === 'ok' ? -1 : i)).filter((i) => i >= 0);
  const violations = [];
  const own = document.getElementById('cinedrape-theme');
  const sheets = [];
  if (own && own.sheet) sheets.push(own.sheet);
  for (const s of document.adoptedStyleSheets || []) sheets.push(s);
  if (notOk.length && sheets.length) {
    const prior = sheets.map((s) => s.disabled);
    sheets.forEach((s) => { s.disabled = true; });
    try {
      for (const i of notOk) if (state(nodes[i]) === 'ok') violations.push({ node: describe(nodes[i]), hiddenBy: withExt[i] });
    } finally {
      sheets.forEach((s, k) => { s.disabled = prior[k]; });
    }
  }
  return { found: nodes.length, visible: withExt.filter((s) => s === 'ok').length, violationCount: violations.length, violations: violations.slice(0, 10) };
}

/** Arms a watcher for a theme switch; read the result with `await window.__cdSwitch` once the switch has been triggered. */
export function armSwitch(target, timeoutMs) {
  const root = document.documentElement;
  const sig = () => {
    const s = document.getElementById('cinedrape-theme');
    return s ? s.textContent + '|' + (s.sheet ? s.sheet.cssRules.length : -1) : null;
  };
  const before = sig();
  window.__cdSwitch = new Promise((resolve) => {
    let tAttr = null;
    let tStyle = null;
    let obs = null;
    let poll = null;
    let timer = null;
    const finish = (timedOut) => {
      if (obs) obs.disconnect();
      clearInterval(poll);
      clearTimeout(timer);
      resolve({ tAttr, tStyle, timedOut, attr: root.getAttribute('cd-theme') });
    };
    const test = () => {
      const now = Date.now();
      if (tAttr === null && root.getAttribute('cd-theme') === target) tAttr = now;
      if (tStyle === null && sig() !== before) tStyle = now;
      if (tAttr !== null && tStyle !== null) finish(false);
    };
    obs = new MutationObserver(test);
    obs.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['cd-theme'], characterData: true });
    poll = setInterval(test, 20);
    timer = setTimeout(() => { test(); finish(true); }, timeoutMs);
  });
}

/** Pauses media so screenshots and heap numbers are not influenced by playback. */
export function pauseMedia() {
  document.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch (e) { /* ignore */ } });
}

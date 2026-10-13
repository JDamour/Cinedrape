// In-page helpers for the F3/F5 run. `installHelpers` is serialised by puppeteer (evaluateOnNewDocument), so it must stay
// self-contained: no imports, no module variables, and no backslash escapes (the tooling that writes this file mangles them).
// Everything lives on window.__cdh; each method takes and returns plain JSON.
export function installHelpers() {
  if (window.__cdh) return;
  const NB = String.fromCharCode(160);
  const VIEW_RE = /^([0-9][0-9.,]*[KMBkmb]?|No) (views?|watching)$/;
  const AGE_RE = /(ago|Streamed|Premiered|Scheduled)/;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT', 'TITLE', 'BASE']);
  const S = {}; // named snapshots {all:Set, rend:Set}
  let noise = new Set();
  const LOST = {};
  let ADS = '';
  const txt = (e) => (e.textContent || '').split(NB).join(' ').replace(/ +/g, ' ').trim();
  const rendered = (e) => {
    if (!e || !e.isConnected) return false;
    if (e.getClientRects().length > 0) return true;
    try {
      if (getComputedStyle(e).display !== 'contents') return false;
    } catch { return false; }
    return e.parentElement && e.parentElement !== document.documentElement ? rendered(e.parentElement) : true;
  };
  const adish = (e) => { try { return !!ADS && (e.matches(ADS) || !!e.querySelector(ADS) || !!e.closest(ADS)); } catch { return false; } };
  const desc = (e) => {
    const cls = typeof e.className === 'string' ? e.className.trim().split(' ')[0] : '';
    return `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${cls ? '.' + cls : ''}[${txt(e).slice(0, 36)}]`;
  };
  const CONTENTS = 'ytd-browse[page-subtype="home"] ytd-rich-grid-renderer > #contents';
  const SHORTS = 'a[href^="/shorts/"], ytm-shorts-lockup-view-model-v2, ytm-shorts-lockup-view-model, ytd-reel-shelf-renderer, ytd-reel-item-renderer, ytd-rich-shelf-renderer[is-shorts]';
  const guideShorts = (e) => {
    const g = e.closest('ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer');
    return !!g && (!!g.querySelector('a[title="Shorts"], a[href="/shorts/"]') || g.getAttribute('title') === 'Shorts' || txt(g) === 'Shorts');
  };
  const leaf = (e) => e.children.length === 0;
  const NUM_RE = /^[0-9][0-9.,]*[KMBkmb]?$/;
  const ALNUM_RE = /[0-9A-Za-z]/;
  const core = (s) => s.split(' ').join('').split('•').join('').split('·').join('').split('|').join('');
  let TGT = null; // view-count targets of the current measurement (document order scan, rebuilt per public call)
  const viewTargets = () => {
    if (TGT) return TGT;
    const leaves = [];
    for (const e of document.body.querySelectorAll('*')) {
      if (SKIP.has(e.tagName) || !leaf(e)) continue;
      const t = txt(e);
      if (t) leaves.push([e, t]);
    }
    const out = new Set();
    for (let i = 0; i < leaves.length; i++) {
      const [e, t] = leaves[i];
      if (VIEW_RE.test(t)) { out.add(e); continue; }
      if (!NUM_RE.test(t)) continue;
      let j = i + 1;
      while (j < leaves.length && leaves[j][1].length <= 1 && !ALNUM_RE.test(leaves[j][1])) j += 1;
      if (j < leaves.length && AGE_RE.test(leaves[j][1]) && leaves[j][1].length < 40) out.add(e);
    }
    TGT = out;
    return out;
  };

  const ORACLE = {
    hideShorts: {
      intended: (e) => e.matches(SHORTS) || !!e.querySelector(SHORTS) || !!e.closest(SHORTS) || !!e.closest('yt-tab-shape[tab-title="Shorts"]') || guideShorts(e),
      over: (e) => (e.querySelector('a[href^="/watch"]') ? 'also holds a /watch link' : ''),
      missed: () => Array.from(document.querySelectorAll(SHORTS + ', a[title="Shorts"], yt-tab-shape[tab-title="Shorts"]')).filter((e) => rendered(e) && !e.closest('ytd-shorts')),
    },
    hideHomeRecs: {
      intended: (e) => { const c = document.querySelector(CONTENTS); return !!e.closest('.cd-home') || (!!c && c !== e && c.contains(e)); },
      over: (e) => (adish(e) ? 'ad' : ''),
      missed: () => {
        const c = document.querySelector(CONTENTS);
        const list = c ? Array.from(c.children).filter((k) => !adish(k)) : [];
        list.push(...document.querySelectorAll('.cd-home'));
        return list.filter(rendered);
      },
    },
    hideComments: {
      intended: (e) => !!e.closest('ytd-comments, #comments, #comment-teaser'),
      over: () => '',
      missed: () => Array.from(document.querySelectorAll('ytd-comments, ytd-watch-metadata #comment-teaser')).filter(rendered),
    },
    hideEndScreens: {
      intended: (e) => !!e.closest('[class*="ytp-ce-"], [class*="ytp-endscreen"]'),
      over: () => '',
      missed: () => Array.from(document.querySelectorAll('.ytp-ce-element, .ytp-endscreen-content, .ytp-ce-shadow')).filter(rendered),
    },
    hideViewCounts: {
      // Independent of the extension's selectors: a view count is the leaf text that reads "N views" / "N watching" (Shorts cells,
      // watch info line, live tiles), or a bare number ("193K") that is directly followed by the age text ("2mo ago", "Streamed 1d ago")
      // in document order. Both shapes are found from the text alone, on any page and in the Cinedrape mirror alike.
      intended: (e) => {
        const ts = viewTargets();
        for (let p = e; p; p = p.parentElement) if (ts.has(p)) return true;
        const inner = Array.from(ts).filter((x) => e.contains(x));
        if (inner.length) return core(txt(e)) === core(inner.map(txt).join(' '));
        // An empty, media-free node inside the watch info line (the legacy #view-count placeholder) has nothing to show either way.
        return txt(e) === '' && !e.querySelector('img, svg, canvas, video, iframe') && !!e.closest('ytd-watch-info-text, ytd-watch-metadata');
      },
      over: () => '',
      missed: () => Array.from(viewTargets()).filter(rendered),
    },
    hideLive: {
      intended: (e) => !!e.closest('.cd-home [cd-live], [cd-source][cd-live]'),
      over: () => '',
      missed: () => Array.from(document.querySelectorAll('.cd-home [cd-live], [cd-source][cd-live]')).filter(rendered),
    },
  };

  window.__cdh = {
    setAds(list) { ADS = list.join(','); },
    txt,
    counts() { let all = 0; let rend = 0; for (const e of document.body.querySelectorAll('*')) { if (SKIP.has(e.tagName)) continue; all += 1; if (rendered(e)) rend += 1; } return [all, rend]; },
    rendered: (sel) => Array.from(document.querySelectorAll(sel)).filter(rendered).length,
    snap(name) {
      const all = new Set();
      const rend = new Set();
      for (const e of document.body.querySelectorAll('*')) {
        if (SKIP.has(e.tagName)) continue;
        all.add(e);
        if (rendered(e)) rend.add(e);
      }
      S[name] = { all, rend };
      return { all: all.size, rend: rend.size };
    },
    /** Elements that changed rendered-state with no toggle applied: measured once per page and ignored afterwards. */
    learnNoise(name) {
      const a = S[name];
      noise = new Set();
      for (const e of a.rend) if (e.isConnected && !rendered(e)) noise.add(e);
      for (const e of a.all) if (e.isConnected && !a.rend.has(e) && rendered(e)) noise.add(e);
      return noise.size;
    },
    /** What the toggle `key` changed against snapshot `name`: hidden roots with their oracle verdicts, and what is still shown. */
    measure(key, name) {
      TGT = null;
      const a = S[name];
      const o = ORACLE[key];
      const lost = new Set();
      const gained = [];
      for (const e of a.rend) if (e.isConnected && !noise.has(e) && !rendered(e)) lost.add(e);
      for (const e of a.all) if (e.isConnected && !noise.has(e) && !a.rend.has(e) && rendered(e)) gained.push(desc(e));
      LOST[key] = lost;
      const roots = Array.from(lost).filter((e) => !(e.parentElement && lost.has(e.parentElement)));
      let intended = 0;
      const extra = [];
      for (const r of roots) {
        const why = !o.intended(r) ? 'not an intended target' : o.over(r);
        if (why) extra.push(`${desc(r)} (${why})`); else intended += 1;
      }
      const missed = o.missed().map(desc);
      return { hiddenRoots: roots.length, hiddenElements: lost.size, intended, extra: extra.slice(0, 8), extraCount: extra.length, gained: gained.slice(0, 6), gainedCount: gained.length, missed: missed.slice(0, 6), missedCount: missed.length, sample: roots.slice(0, 4).map(desc) };
    },
    missed(key) { TGT = null; return ORACLE[key].missed().map(desc); },
    /** Debug: lost roots of a toggle with the metadata row they sit in (rows list every text, hidden ones starred). */
    lostContext(key, max) {
      const row = (e) => { const r = e.closest('.ytContentMetadataViewModelMetadataRow, #metadata-line, #info, .cd-card-meta, .cd-card'); return r ? Array.from(r.querySelectorAll('span, div')).filter((x) => x.children.length === 0 && txt(x)).map((x) => txt(x).slice(0, 16) + (rendered(x) ? '' : '*')).join(' | ') : '-'; };
      return Array.from(LOST[key] || []).filter((e) => !(e.parentElement && (LOST[key] || new Set()).has(e.parentElement))).slice(0, max || 40).map((e) => desc(e).slice(0, 50) + ' <' + e.parentElement.tagName.toLowerCase() + '> row: ' + row(e));
    },
    /** Debug: still-rendered intended elements with their ancestor chain and the texts of their tile. */
    missedContext(key, max) {
      TGT = null;
      const chain = (e) => { const out = []; for (let p = e.parentElement; p && out.length < 7; p = p.parentElement) out.push(p.tagName.toLowerCase() + (typeof p.className === 'string' && p.className ? '.' + p.className.trim().split(' ')[0] : '')); return out.join('<'); };
      const tile = (e) => { const t = e.closest('yt-lockup-view-model, ytd-rich-item-renderer, ytd-video-renderer'); return t ? Array.from(t.querySelectorAll('span, div, a')).filter((x) => x.children.length === 0 && txt(x)).map((x) => txt(x).slice(0, 14)).join(' | ').slice(0, 160) : '-'; };
      return ORACLE[key].missed().slice(0, max || 10).map((e) => desc(e) + ' chain: ' + chain(e) + ' tile: ' + tile(e) + ' host: ' + ((e.closest('yt-lockup-view-model') || {}).className || '-'));
    },
    clearLost() { for (const k of Object.keys(LOST)) delete LOST[k]; },
    /** With several toggles on: is what is hidden exactly the union of what each one hid alone (against snapshot `name`)? */
    unionCheck(keys, name) {
      const a = S[name];
      const now = new Set();
      for (const e of a.rend) if (e.isConnected && !noise.has(e) && !rendered(e)) now.add(e);
      const uni = new Set();
      for (const k of keys) for (const e of LOST[k] || []) if (e.isConnected) uni.add(e);
      const onlyAll = Array.from(now).filter((e) => !uni.has(e) && !(e.parentElement && (now.has(e.parentElement) || uni.has(e.parentElement))));
      const onlyAlone = Array.from(uni).filter((e) => !now.has(e) && rendered(e) === false ? true : false).filter((e) => !(e.parentElement && uni.has(e.parentElement)));
      return { allOn: now.size, union: uni.size, onlyAllOn: onlyAll.slice(0, 5).map(desc), onlyAllOnCount: onlyAll.length, onlyAloneCount: Array.from(uni).filter((e) => !now.has(e)).length };
    },
    /** An intended element that is rendered now: used to time the moment a toggle takes effect. */
    target(key) {
      TGT = null;
      const o = ORACLE[key];
      window.__cdTarget = null;
      const list = o.missed();
      if (!list.length) return false;
      window.__cdTarget = list[0];
      return desc(list[0]);
    },
    /** Arms a watcher: resolves with the page clock (Date.now) at which html[attr] reaches the wanted state (__cdWantOn) and at which __cdTarget stops rendering. */
    effectWatch(attr, timeoutMs) {
      const root = document.documentElement;
      const name = attr.toLowerCase(); // attribute names are lower-cased on <html>, and an attributeFilter is case-sensitive
      return new Promise((resolve) => {
        const out = { tAttr: 0, tEffect: 0 };
        const t = window.__cdTarget;
        const start = Date.now();
        const mo = new MutationObserver(() => { if (!out.tAttr && root.hasAttribute(name) === window.__cdWantOn) out.tAttr = Date.now(); });
        mo.observe(root, { attributes: true, attributeFilter: [name] });
        const fin = () => { mo.disconnect(); resolve(out); };
        const loop = () => {
          if (t && !out.tEffect && !rendered(t)) out.tEffect = Date.now();
          if ((out.tAttr && (!t || out.tEffect)) || Date.now() - start > timeoutMs) fin(); else requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
        setTimeout(fin, timeoutMs + 500);
      });
    },
    datesAndViews() {
      TGT = null;
      const leaves = Array.from(document.querySelectorAll('body *')).filter((e) => !SKIP.has(e.tagName) && leaf(e) && rendered(e));
      return {
        viewsShown: Array.from(viewTargets()).filter(rendered).length,
        agesShown: leaves.filter((e) => AGE_RE.test(txt(e)) && txt(e).length < 40).length,
      };
    },
    /** Rendered state, display, visibility and opacity of every node matching `sel`. */
    probe(sel) {
      return Array.from(document.querySelectorAll(sel)).map((e) => {
        const cs = getComputedStyle(e);
        return { d: desc(e).slice(0, 60), r: rendered(e), display: cs.display, vis: cs.visibility, op: cs.opacity, w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) };
      });
    },
    setSheet(disabled) {
      const s = document.getElementById('cinedrape-theme');
      if (s) s.disabled = !!disabled;
      return !!s;
    },
  };
}

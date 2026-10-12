// Calm mode (ARCHITECTURE.md section 4 "content/calm.js", section 6).
//
// buildCalmCss(map, cfg)  static stylesheet, every rule gated on html[cd-calm-<key>], so a toggle never needs a re-inject
//                         and survives SPA navigation (the attributes live on <html>).
// applyCalmAttributes()   flips those attributes; the only DOM work calm does at runtime.
//
// Ad safety (hard rule, section 6): every hide goes through safeHide(), which appends :not(:has(<protected.ads>)) to the
// subject, so a wrapper that holds an ad (a feed row, a shelf section) is left alone. Calm adds two more narrowings on top:
// the subject must not hold a sponsorship disclosure either, and leaf subjects (links, metadata spans, Shorts cells) must not
// sit inside an ad or inside a tile that carries an ad badge (safeHide only looks downwards, an ad's own "Sponsored" text
// sits *below* the tile that a position-based selector would hit).
//
// Performance: the selector lists come from the map and several are long, so each toggle emits ONE rule with a :is() union
// and one guard instead of one guarded rule per selector (about 1.7 KB of guard each; the first-paint cache is 64 KB).
import { ATTR, CALM_KEYS } from '../shared/constants.js';
import { roleCss, safeHide, protectedCss } from '../shared/selector-map.js';

const HIDE = '{display:none !important}';
const FEATURE_PREFIX = 'calm-';

// What the selector map does not cover yet. Each entry is a class or tag seen in a real capture (test/fixtures/real) or
// one of our own cd- classes; a map role of the same purpose always wins (see roleOr), so the map owner can take them over.
const EXTRA = {
  // The channel tab strip is localised (tab-title holds the translated word), so this only helps on English YouTube.
  shortsTab: ['yt-tab-shape[tab-title="Shorts"]'],
  // The Shorts player page element (live-verified); nothing inside it is a feed item.
  shortsPlayer: 'ytd-shorts',
  // Previous/next arrows of the end-of-video wall; they are not player controls (those are .ytp-prev-button / .ytp-next-button).
  endScreenArrows: ['.ytp-endscreen-previous', '.ytp-endscreen-next'],
  // "4.4m views" under a Shorts cell. Shorts cells have no .ytContentMetadataViewModel markup, so viewCounts does not reach them.
  shortsViews: ['.shortsLockupViewModelHostOutsideMetadataSubhead'],
  // Direct children of the home grid that are not tiles: shelves and the old row wrapper.
  richSection: ['ytd-rich-section-renderer', 'ytd-rich-grid-row'],
  // Cinedrape's own DOM (home layout mirror and the span its cards must wrap the view count in).
  mirrorRoot: ['.cd-home'],
  mirrorViews: ['.cd-card-views'],
};

const PLACEHOLDER = 'Home recommendations are hidden. Turn off Calm mode in Cinedrape to bring them back.';

// ---- selector plumbing ---------------------------------------------------------------------------------------------

/** Splits a selector list on its top-level commas (not those inside (), [] or strings). */
function splitSelectorList(css) {
  const out = [];
  if (typeof css !== 'string') return out;
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) { out.push(css.slice(start, i)); start = i + 1; }
  }
  out.push(css.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Never throws: a map that lost a role must cost one toggle some coverage, not the whole stylesheet. */
function attempt(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

const roleList = (map, role) => attempt(() => splitSelectorList(roleCss(map, role)), []);
const roleOr = (map, role, fallback) => {
  const found = roleList(map, role);
  return found.length ? found : fallback;
};
const dedupe = (list) => [...new Set(list)];
const union = (list) => (list.length === 1 ? list[0] : `:is(${list.join(',')})`);

/** Everything the narrowing needs, or null when the map has no ad list (then calm hides nothing: fail closed). */
function createGuards(map) {
  const ads = attempt(() => splitSelectorList(protectedCss(map, 'ads')), []);
  if (!ads.length) return null;
  const sponsor = attempt(() => splitSelectorList(protectedCss(map, 'sponsor')), []);
  return { ads: ads.join(','), adList: ads, sponsor: sponsor.join(',') };
}

/**
 * True only when `safe` is `subject` followed by exactly one `:not(:has(<the whole ads list>))`. Looking at the tail rather than
 * the whole string matters: map selectors may contain `:not(:has(` themselves, which must not pass for the guard.
 */
function carriesAdsGuard(safe, subject, adList) {
  if (typeof safe !== 'string' || !safe.startsWith(subject)) return false;
  const tail = safe.slice(subject.length);
  if (!tail.startsWith(':not(:has(') || !tail.endsWith('))')) return false;
  const inner = splitSelectorList(tail.slice(':not(:has('.length, -2));
  return inner.length === adList.length && adList.every((sel) => inner.includes(sel));
}

/**
 * One hide rule: `gate subject` with the contract guard (safeHide) plus calm's extra narrowing.
 * @param {object} map
 * @param {{ads:string,sponsor:string}} guards
 * @param {string} gate   compound on <html>, e.g. html[cd-calm-hideShorts]
 * @param {string[]} subjects  complex selectors (no top-level comma); unioned
 * @param {{tiles?:string[], outside?:string}} [opts]  tiles: leaf subjects inside a tile that holds an ad are left alone (omit
 *   for wrappers); outside: a selector whose descendants are never hidden
 */
function hideRule(map, guards, gate, subjects, opts = {}) {
  const list = dedupe(subjects.filter(Boolean));
  if (!list.length) return '';
  const subject = union(list);
  const safe = attempt(() => safeHide(map, subject), '');
  // Fail closed: only emit a rule whose subject really got the full ads guard appended.
  if (!carriesAdsGuard(safe, subject, guards.adList)) return '';
  let narrow = guards.sponsor ? `:not(:has(${guards.sponsor}))` : '';
  if (opts.tiles) {
    const inside = [guards.ads, guards.sponsor, `:is(${dedupe(opts.tiles).join(',')}):has(${guards.ads})`].filter(Boolean);
    narrow += `:not(:is(${inside.join(',')}) *)`;
  }
  if (opts.outside) narrow += `:not(${opts.outside} *)`;
  return `${gate} ${safe}${narrow}${HIDE}`;
}

/** Block of rules for one toggle, led by a marker comment so a stylesheet dump stays readable. */
function block(key, rules) {
  const body = rules.filter(Boolean);
  return body.length ? `/* calm:${key} */\n${body.join('\n')}` : '';
}

const gateFor = (key, extra = '') => `html[${ATTR.calmPrefix}${key}]${extra}`;

// ---- the five toggles ----------------------------------------------------------------------------------------------

function shorts(map, g) {
  const tiles = [...roleList(map, 'videoTile'), ...roleList(map, 'richItem'), ...roleList(map, 'shortsTiles')];
  // Guide and mini-guide entries, shelves, tiles in any grid and the channel Shorts tab. The Shorts player itself is left
  // alone (its own links are not feed items; hiding them would only break the page).
  const subjects = [
    ...roleList(map, 'shortsNavEntry'), ...roleList(map, 'shortsShelf'), ...roleList(map, 'shortsTiles'), ...EXTRA.shortsTab,
  ];
  return block('hideShorts', [hideRule(map, g, gateFor('hideShorts'), subjects, { tiles, outside: EXTRA.shortsPlayer })]);
}

function homeRecs(map, g) {
  const gate = gateFor('hideHomeRecs', `[${ATTR.page}="home"]`);
  const feed = roleList(map, 'homeGridContents');
  // Every direct child of the feed except an ad-carrying one: tiles, shelves, and the continuation item. Hiding the
  // continuation is deliberate: with every tile gone it would stay on screen and keep fetching pages nobody can see.
  const children = [...roleList(map, 'richItem'), ...roleOr(map, 'richSection', EXTRA.richSection), ...roleList(map, 'continuation')];
  const subjects = feed.length ? [`${union(feed)}>${union(dedupe(children))}`] : [];
  const placeholder = feed.length
    ? `${gate} ${union(feed)}::before{content:"${PLACEHOLDER}";display:block;flex:1 0 100%;padding:48px 16px;text-align:center;`
      + 'color:var(--cd-muted,var(--yt-sys-color-baseline--text-secondary,#aaa))}'
    : '';
  // The notice only makes sense next to the hide rule (and so depends on safeHide like every other rule here).
  const hide = hideRule(map, g, gate, [...subjects, ...EXTRA.mirrorRoot]);
  return block('hideHomeRecs', hide ? [hide, placeholder] : []);
}

function comments(map, g) {
  return block('hideComments', [hideRule(map, g, gateFor('hideComments'), roleList(map, 'comments'))]);
}

function endScreens(map, g) {
  // Only end cards and the end-of-video wall. Player controls and anything ad-like are protected groups the guard keeps.
  return block('hideEndScreens', [hideRule(map, g, gateFor('hideEndScreens'), [...roleList(map, 'endScreens'), ...EXTRA.endScreenArrows])]);
}

function viewCounts(map, g) {
  const tiles = [...roleList(map, 'videoTile'), ...roleList(map, 'richItem')];
  const subjects = [...roleList(map, 'viewCounts'), ...EXTRA.shortsViews, ...EXTRA.mirrorViews];
  return block('hideViewCounts', [hideRule(map, g, gateFor('hideViewCounts'), subjects, { tiles })]);
}

// ---- public API ----------------------------------------------------------------------------------------------------

/**
 * Static calm stylesheet. `cfg` is accepted for the common builder signature but not read: every toggle is always emitted
 * and the html attributes decide (applyCalmAttributes already honours cfg.calm and cfg.disabled).
 * @param {object} map  selector map (payload of the signed envelope)
 * @param {object} [cfg]  EffectiveConfig
 * @returns {string}
 */
export function buildCalmCss(map, cfg) {
  void cfg;
  const guards = createGuards(map);
  if (!guards) return '';
  const blocks = [shorts(map, guards), homeRecs(map, guards), comments(map, guards), endScreens(map, guards), viewCounts(map, guards)];
  const css = blocks.filter(Boolean).join('\n');
  return css ? `${css}\n` : '';
}

/** Name of the html attribute that switches one calm toggle. */
export const calmAttr = (key) => ATTR.calmPrefix + key;

/**
 * Mirrors the effective calm toggles onto <html>. Attribute present = on. A toggle is on only when its value is exactly
 * `true` and its feature `calm-<key>` is not health-disabled; a disabled toggle has its attribute removed, so a feature that
 * breaks mid-session switches itself off. Unknown keys are ignored, nothing else on <html> is touched, and a call that
 * changes nothing writes nothing (no mutation records, no layout reads).
 * @param {Document} doc
 * @param {Record<string, boolean>} calm
 * @param {string[]|Set<string>} [disabled]  FEATURES turned off by the health check
 * @returns {string[]} the calm keys that are on afterwards
 */
export function applyCalmAttributes(doc, calm, disabled) {
  const root = doc && doc.documentElement;
  if (!root || typeof root.hasAttribute !== 'function') return [];
  const off = Array.isArray(disabled) ? new Set(disabled) : disabled instanceof Set ? disabled : new Set();
  const wanted = calm && typeof calm === 'object' ? calm : {};
  const active = [];
  for (const key of CALM_KEYS) {
    const name = ATTR.calmPrefix + key;
    const on = Object.hasOwn(wanted, key) && wanted[key] === true && !off.has(FEATURE_PREFIX + key);
    const present = root.hasAttribute(name);
    if (on) {
      if (!present) root.setAttribute(name, '');
      active.push(key);
    } else if (present) {
      root.removeAttribute(name);
    }
  }
  return active;
}

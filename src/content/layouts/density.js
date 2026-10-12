// Density (ARCHITECTURE.md section 4, "content/layouts/density.js"): 1 = compact ... 5 = roomy.
//
// buildDensityCss(map, cfg) is pure CSS. It writes the three spacing variables every other builder reads
// (--cd-gap, --cd-card-min, --cd-row-gap), overrides YouTube's own columns-per-row variable on the home grid (inline style
// beats a plain rule, so that one declaration carries !important) and nudges the search and channel spacing a little.
//
// The home layout needs the same table (how many cards fit one row), so the numbers live here once and home.js imports them.
//
// Nothing in this file hides, collapses or fades anything, so nothing needs the ad guard.
//
// Every read of a variable a stylesheet could set is wrapped in clamp(): the theme validator refuses a theme that declares an
// engine variable, and this is the second line, so that even a stylesheet that got past it cannot give an ad-bearing tile a
// negative or page-sized margin (ad-safety review, finding 2).

export const DEFAULT_DENSITY = 3;

/**
 * gap / cardMin / rowGap are pixels. visible = cards in view per Cinedrape row. perRow = YouTube grid columns at the
 * breakpoints xl (>= 1700px), lg (the base, 1200-1699px), md (700-1199px) and sm (< 700px); every column is non-increasing
 * with the density so "roomier" never packs more tiles in.
 */
export const DENSITY_TABLE = Object.freeze({
  1: Object.freeze({ gap: 8, cardMin: 150, rowGap: 16, visible: 8, perRow: Object.freeze({ xl: 7, lg: 6, md: 4, sm: 3 }) }),
  2: Object.freeze({ gap: 12, cardMin: 170, rowGap: 22, visible: 7, perRow: Object.freeze({ xl: 6, lg: 5, md: 4, sm: 2 }) }),
  3: Object.freeze({ gap: 16, cardMin: 190, rowGap: 30, visible: 6, perRow: Object.freeze({ xl: 5, lg: 4, md: 3, sm: 2 }) }),
  4: Object.freeze({ gap: 20, cardMin: 220, rowGap: 38, visible: 5, perRow: Object.freeze({ xl: 4, lg: 3, md: 2, sm: 2 }) }),
  5: Object.freeze({ gap: 26, cardMin: 260, rowGap: 48, visible: 4, perRow: Object.freeze({ xl: 3, lg: 3, md: 2, sm: 1 }) }),
});

/** Anything that is not a usable number becomes the default; numbers are rounded and clamped to 1..5. */
export function normalizeDensity(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_DENSITY;
  return Math.min(5, Math.max(1, Math.round(n)));
}

/** Cards visible at once in one Cinedrape row: 1 -> 8 ... 5 -> 4. */
export const rowVisibleForDensity = (density) => DENSITY_TABLE[normalizeDensity(density)].visible;

/** Cards held by one Cinedrape row section: two screens' worth, so the arrows and the keyboard have somewhere to go. */
export const rowChunkForDensity = (density) => rowVisibleForDensity(density) * 2;

/** True when the health check switched the feature off (cfg.disabled lists FEATURES ids). */
export function isFeatureDisabled(cfg, feature) {
  return !!cfg && Array.isArray(cfg.disabled) && cfg.disabled.includes(feature);
}

/** The role's selectors, each one a single complex selector (map data rule); a missing role is an empty list. */
export function roleEntries(map, role) {
  const list = map && map.roles && Object.hasOwn(map.roles, role) ? map.roles[role] : null;
  return Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()) : [];
}

/**
 * True when `guarded` is `subject` with the ad guard appended, i.e. what safeHide(map, subject) must return. The layouts check
 * it before emitting a hide rule so that a broken or replaced safeHide can only ever cost them a rule (fail closed).
 */
export function carriesAdGuard(map, subject, guarded) {
  if (typeof subject !== 'string' || typeof guarded !== 'string' || !guarded.startsWith(subject)) return false;
  const ads = map && map.protected && Array.isArray(map.protected.ads) ? map.protected.ads.filter((s) => typeof s === 'string' && s.trim() !== '') : [];
  const tail = guarded.slice(subject.length);
  return ads.length > 0 && tail.startsWith(':not(:has(') && ads.every((a) => tail.includes(a.trim()));   // every ad selector, not just one: a guard that dropped some is not the guard
}

const ROW_GAP = 'clamp(0px,var(--cd-row-gap,30px),64px)';

/** One rule per selector: a selector this browser cannot parse then costs one rule, not the whole list. */
const perSelector = (selectors, body) => selectors.map((sel) => `${sel}{${body}}`).join('\n');

export function buildDensityCss(map, cfg) {
  if (isFeatureDisabled(cfg, 'density')) return '';
  const level = normalizeDensity(cfg && cfg.density);
  const d = DENSITY_TABLE[level];
  const out = [`/* density ${level} */`];

  // Same specificity as the token block (html[cd-theme]) and later in the sheet, so the density wins over theme spacing.
  out.push(`html[cd-theme]{--cd-gap:${d.gap}px;--cd-card-min:${d.cardMin}px;--cd-row-gap:${d.rowGap}px}`);

  // Home grid columns. YouTube writes --ytd-rich-grid-items-per-row inline on the grid, so only !important gets past it.
  const grids = roleEntries(map, 'homeGrid').map((s) => `html[cd-theme] ${s}`);
  const cols = (n) => perSelector(grids, `--ytd-rich-grid-items-per-row:${n} !important`);
  if (grids.length) {
    const { xl, lg, md, sm } = d.perRow;
    out.push(cols(lg));
    if (xl !== lg) out.push(`@media (min-width:1700px){\n${cols(xl)}\n}`);
    if (md !== lg) out.push(`@media (max-width:1199px){\n${cols(md)}\n}`);
    if (sm !== md) out.push(`@media (max-width:699px){\n${cols(sm)}\n}`);
  }

  // A little vertical rhythm on the pages that keep YouTube's own list or grid. Spacing only, no visibility.
  const homeContents = roleEntries(map, 'homeGridContents');
  if (homeContents.length) {
    out.push(perSelector(homeContents.map((s) => `html[cd-theme] ${s} > ytd-rich-item-renderer`), `margin-bottom:${ROW_GAP}`));
  }
  const search = roleEntries(map, 'searchResults');
  if (search.length) {
    out.push(perSelector(search.map((s) => `html[cd-theme] ${s} > ytd-video-renderer`), `margin-top:calc(${ROW_GAP} * 0.55)`));
  }
  // The channel grid has no role of its own (verified markup: ytd-browse[page-subtype="channels"] > ... > ytd-rich-grid-renderer).
  out.push(`html[cd-theme] ytd-browse[page-subtype="channels"] ytd-rich-grid-renderer > #contents > ytd-rich-item-renderer{margin-bottom:${ROW_GAP}}`);

  return `${out.join('\n')}\n`;
}

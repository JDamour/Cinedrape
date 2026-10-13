// The one stylesheet the engine injects (ARCHITECTURE.md section 4): every builder in contract order, then the theme's own CSS
// when (and only when) it validates against the selector map. Pure: no DOM, no storage, never throws.
import { buildTokenCss } from '../shared/tokens.js';
import { validateTheme } from '../shared/theme-schema.js';
import { buildSkinCss } from './skin.js';
import { buildDensityCss } from './layouts/density.js';
import { buildHomeLayoutCss } from './layouts/home.js';
import { buildWatchLayoutCss, buildWatchLiveCss } from './layouts/watch.js';
import { buildCalmCss } from './calm.js';

// id|mapVersion -> {css, ok, reason}. The css is compared too, so a different theme that reuses an id is judged again.
const verdicts = new Map();
const MAX_VERDICTS = 64;

/** Whether `theme.css` may be injected, memoised per theme id and map version. */
function themeCssVerdict(theme, map) {
  const css = typeof theme.css === 'string' ? theme.css : '';
  if (css.trim() === '') return { ok: true, css: '', reason: '' };
  const key = `${theme.id}|${map && map.mapVersion}`;
  const hit = verdicts.get(key);
  if (hit && hit.source === css) return hit;
  const res = validateTheme(theme, { selectorMap: map });
  const entry = {
    source: css,
    ok: res.ok && res.cssValidated !== false,
    css: res.ok && res.theme ? res.theme.css : '',
    reason: res.ok ? 'its CSS could not be validated' : (res.errors[0] ? `${res.errors[0].path ? `${res.errors[0].path}: ` : ''}${res.errors[0].message}` : 'it did not validate'),
  };
  if (verdicts.size >= MAX_VERDICTS) verdicts.clear();
  verdicts.set(key, entry);
  return entry;
}

const isDisabled = (cfg, feature) => Array.isArray(cfg.disabled) && cfg.disabled.includes(feature);

/**
 * @param {{map: object, cfg: object}} input  map = verified selector map, cfg = EffectiveConfig (cfg.disabled reaches every builder)
 * @returns {{css: string, warnings: string[]}} a builder that throws contributes nothing and leaves a warning instead
 */
export function composeStylesheet({ map, cfg } = {}) {
  const warnings = [];
  const theme = cfg && cfg.theme;
  const parts = [];
  const part = (name, build) => {
    try {
      const css = build();
      if (typeof css === 'string' && css.trim() !== '') parts.push(css.trim());
    } catch (err) {
      warnings.push(`${name}: ${err && err.message ? err.message : String(err)}`);
    }
  };

  const themeOn = !!theme && !isDisabled(cfg, 'theme');
  if (themeOn) part('tokens', () => buildTokenCss(theme, { accent: cfg.accent, animations: cfg.animations }, map));
  part('skin', () => buildSkinCss(map, cfg));
  part('density', () => buildDensityCss(map, cfg));
  part('home layout', () => buildHomeLayoutCss(map, cfg));
  part('watch layout', () => buildWatchLayoutCss(map, cfg));
  part('watch live', () => buildWatchLiveCss(map, cfg));
  part('calm', () => buildCalmCss(map, cfg));
  if (themeOn) {
    part('theme css', () => {
      const verdict = themeCssVerdict(theme, map);
      if (!verdict.ok) {
        warnings.push(`theme css skipped for "${theme.id}": ${verdict.reason}`);
        return '';
      }
      return verdict.css;
    });
  }
  return { css: parts.join('\n'), warnings };
}

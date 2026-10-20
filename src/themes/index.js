// The 16 bundled themes (ARCHITECTURE.md section 4, "themes/*.json").
//
// THEMES is ordered like ALL_THEME_IDS and frozen: every theme is fully specified (no defaults left to fill), so it is
// already the NormalizedTheme the engine expects. Nothing downloads at runtime.
import cinema from './cinema.json' with { type: 'json' };
import minimal from './minimal.json' with { type: 'json' };
import classic from './classic.json' with { type: 'json' };
import primetime from './primetime.json' with { type: 'json' };
import studio from './studio.json' with { type: 'json' };
import arcade from './arcade.json' with { type: 'json' };
import oled from './oled.json' with { type: 'json' };
import frost from './frost.json' with { type: 'json' };
import mocha from './mocha.json' with { type: 'json' };
import midnightCity from './midnight-city.json' with { type: 'json' };
import ember from './ember.json' with { type: 'json' };
import paper from './paper.json' with { type: 'json' };
import matcha from './matcha.json' with { type: 'json' };
import sunset from './sunset.json' with { type: 'json' };
import terminal from './terminal.json' with { type: 'json' };
import imax from './imax.json' with { type: 'json' };

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** @type {ReadonlyArray<import('../shared/theme-schema.js').NormalizedTheme>} */
export const THEMES = Object.freeze([
  cinema, minimal, classic, primetime, studio, arcade,
  oled, frost, mocha, midnightCity, ember, paper, matcha, sunset, terminal, imax,
].map(deepFreeze));

const BY_ID = new Map(THEMES.map((t) => [t.id, t]));

/** The bundled theme with this id, or null (unknown ids, non-strings and inherited keys all give null). */
export function getTheme(id) {
  return typeof id === 'string' ? BY_ID.get(id) ?? null : null;
}

/**
 * Cheap card data for the popup: no CSS, no layout. `swatch` holds the colours to paint a preview with.
 * @type {ReadonlyArray<{id:string, name:string, tier:'free'|'pro', swatch:{bg:string, surface:string, text:string, accent:string, border:string}}>}
 */
export const THEME_META = Object.freeze(THEMES.map((t) => Object.freeze({
  id: t.id,
  name: t.name,
  tier: t.tier,
  swatch: Object.freeze({
    bg: t.tokens.color.bg,
    surface: t.tokens.color.surface,
    text: t.tokens.color.text,
    accent: t.tokens.color.accent,
    border: t.tokens.color.border,
  }),
})));

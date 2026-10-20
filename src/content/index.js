// Content-script entry (manifest: run_at document_start). The only module in src/content with side effects at import time:
// it wires the real chrome, document, window and location to the engine and starts it. Everything else is injected.
import bundledEnvelope from '../data/selector-map.signed.json' with { type: 'json' };
import { THEMES } from '../themes/index.js';
import { createEngine } from './engine.js';

// One engine per extension world. A second injection (script run twice, extension reloaded into the same world) does nothing.
const GUARD = Symbol.for('cinedrape.engine');

(function boot() {
  try {
    if (typeof document === 'undefined' || typeof chrome === 'undefined' || globalThis[GUARD]) return;
    if (!document.documentElement) {
      const onReady = () => {
        if (document.documentElement && !globalThis[GUARD]) {
          boot();
        }
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady, { once: true });
        document.addEventListener('readystatechange', onReady, { once: true });
      }
      if (typeof MutationObserver !== 'undefined') {
        const obs = new MutationObserver(() => {
          if (document.documentElement) {
            obs.disconnect();
            onReady();
          }
        });
        obs.observe(document, { childList: true });
      }
      return;
    }
    globalThis[GUARD] = true;
    const engine = createEngine({ doc: document, win: window, chrome, loc: location, themes: THEMES, bundledEnvelope });
    globalThis[GUARD] = engine;
    engine.start();
  } catch (err) {
    try { console.warn('[Cinedrape] could not start:', err && err.message ? err.message : err); } catch { /* no console */ }
  }
}());

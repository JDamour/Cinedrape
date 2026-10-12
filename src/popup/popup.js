// Popup entry: wires the real document, chrome and the bundled themes into createPopup (all logic is in app.js).
import { THEMES } from '../themes/index.js';
import { createPopup } from './app.js';

const start = () => createPopup({ doc: document, chrome, themes: THEMES });

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();

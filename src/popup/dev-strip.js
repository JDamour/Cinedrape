// Developer-only strip. app.js imports and mounts it only inside `if (typeof __DEV__ !== 'undefined' && __DEV__)`, so a
// production build (esbuild define __DEV__=false) drops this module entirely. The check is test/build.test.js ("__DEV__ is false and
// its code stripped in production"), which builds a synthetic bundle; the real dist/popup/popup.js carries none of the strip's markers.
import { h, setMessage, MESSAGE_ICONS } from './ui.js';

/**
 * @param {{doc: Document, host: HTMLElement, activate: (token: string, report: object) => Promise<any>}} deps
 *   `activate` is the same routine the Activate Pro form uses (message to the background, verified there), so the
 *   strip is a shortcut for pasting a token from `npm run licence:dev`, not a back door.
 */
export function mountDevStrip({ doc, host, activate }) {
  const input = h(doc, 'input', {
    id: 'dev-token', class: 'input', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    'aria-describedby': 'dev-help dev-result',
  });
  const button = h(doc, 'button', { type: 'button', id: 'dev-unlock', class: 'btn btn-secondary btn-small' }, 'Unlock Pro (dev)');
  const result = h(doc, 'p', { id: 'dev-result', class: 'hint activate-result', role: 'status' });

  const report = {
    busy(on) {
      if (on) button.setAttribute('aria-disabled', 'true'); else button.removeAttribute('aria-disabled');
    },
    result(text, kind) { result.dataset.kind = kind; setMessage(doc, result, text, MESSAGE_ICONS[kind]); },
    success() { input.value = ''; },
  };

  button.addEventListener('click', () => {
    if (button.getAttribute('aria-disabled') === 'true') return;
    activate(input.value, report);
  });

  const strip = h(doc, 'section', { id: 'dev-strip', class: 'card dev-strip', 'aria-labelledby': 'dev-title' },
    h(doc, 'h2', { id: 'dev-title', class: 'card-title' }, 'Developer'),
    h(doc, 'label', { for: 'dev-token', class: 'field-label' }, 'Dev licence token'),
    input,
    h(doc, 'p', { id: 'dev-help', class: 'hint' }, 'Development builds only. Paste a token from npm run licence:dev.'),
    button,
    result);
  host.replaceChildren(strip);
  return { strip, input, button, result };
}

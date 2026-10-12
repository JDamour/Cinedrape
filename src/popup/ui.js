// Tiny DOM helpers for the popup. Everything is built with createElement/textContent, never innerHTML,
// so no string from storage, a theme or a message can ever become markup.
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h(doc, 'button', {type: 'button', class: 'btn', hidden: true}, 'Label', childNode)
 * `false`/`null` attributes are skipped, `true` becomes an empty attribute, strings become text nodes.
 */
export function h(doc, tag, attrs, ...children) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value === null || value === undefined) continue;
    node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? doc.createTextNode(child) : child);
  }
  return node;
}

/** Decorative inline icon that points at a <symbol> in popup.html's sprite. */
export function icon(doc, name, className = 'icon') {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = doc.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/** Replaces the content of a message element with an icon and text (or empties it when text is ''). */
export function setMessage(doc, el, text, iconName) {
  if (!text) { el.replaceChildren(); return; }
  el.replaceChildren(...(iconName ? [icon(doc, iconName)] : []), doc.createTextNode(text));
}

export const MESSAGE_ICONS = Object.freeze({ info: 'info', ok: 'ok', error: 'warn', warn: 'warn', pro: 'lock' });

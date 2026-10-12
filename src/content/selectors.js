// Role-based DOM lookup driven by the selector map (ARCHITECTURE.md sections 3.1 and 4).
//
// A role is an ordered list of selectors. find/findAll use the FIRST selector that matches anything (never a union), so a
// page that mixes two shapes returns only the first shape; css(role) is the union, for stylesheet rules.
//
// Nothing here throws once the object exists: a hot-swapped signed map may contain a selector this engine cannot parse, a
// role that is missing, or a caller may hand over a root that went stale (null, detached, a non-node). All of those are a
// plain "not found". Results are never cached (YouTube mutates the DOM constantly); only the verdict "this selector string
// is syntactically invalid" is remembered, because that depends on the string and the engine alone.

const hasOwn = Object.prototype.hasOwnProperty;
const NONE = Object.freeze([]);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isQueryable = (n) => n != null && typeof n.querySelector === 'function' && typeof n.querySelectorAll === 'function';
const isSyntaxError = (err) => err != null && err.name === 'SyntaxError';

/** The smallest shape the module can work with. Individual selectors are checked lazily, when they are used. */
function isUsableMap(map) {
  return isObject(map) && isObject(map.roles);
}

/**
 * @param {{roles: Record<string, string[]>}} map  verified selector map (see section 3.1)
 * @param {Document|null} doc  the document `find`, `findAll` and `has` search when no root is given
 */
export function createSelectors(map, doc) {
  if (!isUsableMap(map)) throw new TypeError('createSelectors(map, doc): map.roles must be an object');
  let current = map;
  /** Selector strings the engine rejected with a SyntaxError. Only SyntaxError is remembered, so a hostile root that throws
   *  something else can never poison a good selector. */
  const rejected = new Set();
  const accepted = new Set();

  /** Own-property lookup: roles named 'constructor' or '__proto__' must not reach Object.prototype. */
  function selectorsOf(role) {
    if (typeof role !== 'string' || !hasOwn.call(current.roles, role)) return NONE;
    const list = current.roles[role];
    return Array.isArray(list) ? list : NONE;
  }

  const usable = (sel) => typeof sel === 'string' && sel.trim() !== '' && !rejected.has(sel);

  /** `undefined` means "the document"; `null` (a root the caller failed to find) means "nothing", never "everywhere". */
  function scopeOf(root) {
    const scope = root === undefined ? doc : root;
    return isQueryable(scope) ? scope : null;
  }

  function find(role, root) {
    const scope = scopeOf(root);
    if (!scope) return null;
    for (const sel of selectorsOf(role)) {
      if (!usable(sel)) continue;
      let hit = null;
      try {
        hit = scope.querySelector(sel);
      } catch (err) {
        if (isSyntaxError(err)) rejected.add(sel);
        continue;
      }
      if (hit) return hit;
    }
    return null;
  }

  function findAll(role, root) {
    const scope = scopeOf(root);
    if (!scope) return [];
    for (const sel of selectorsOf(role)) {
      if (!usable(sel)) continue;
      let hits;
      try {
        hits = scope.querySelectorAll(sel);
      } catch (err) {
        if (isSyntaxError(err)) rejected.add(sel);
        continue;
      }
      if (hits && hits.length) return Array.from(hits);
    }
    return [];
  }

  const has = (role, root) => find(role, root) !== null;

  /** Parses `sel` against an empty fragment: a SyntaxError means a stylesheet rule containing it would be dropped whole. */
  function parses(sel) {
    if (accepted.has(sel)) return true;
    if (!doc || typeof doc.createDocumentFragment !== 'function') return true;
    try {
      doc.createDocumentFragment().querySelector(sel);
    } catch (err) {
      if (isSyntaxError(err)) { rejected.add(sel); return false; }
      return true;
    }
    accepted.add(sel);
    return true;
  }

  /** Comma-joined union of every selector of the role that parses, '' for an unknown role. */
  function css(role) {
    const out = [];
    for (const sel of selectorsOf(role)) if (usable(sel) && parses(sel)) out.push(sel.trim());
    return out.join(', ');
  }

  /** Hot-swap. A map without `roles` is refused (returns false) and the previous map keeps working. */
  function setMap(next) {
    if (!isUsableMap(next)) return false;
    current = next;
    return true;
  }

  const getMap = () => current;

  return { find, findAll, has, css, setMap, map: getMap };
}

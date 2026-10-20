// In-memory stand-in for the slice of the `chrome.*` API that Cinedrape uses.
//
//   const { chrome, reset, spies, addTab, removeTab, setSender, listenerErrors } = createChromeMock();
//
// Faithful where it matters for catching real bugs:
//  - every API accepts a callback OR returns a promise (not both), always asynchronously;
//  - storage clones through JSON like Chrome does (undefined dropped, Dates become strings);
//  - storage.onChanged fires only for keys whose value really changed, with
//    {key: {oldValue?, newValue?}} and the area name; it fires before the call settles;
//  - storage.sync enforces Chrome's 8 KB per item / 100 KB total / 512 items quotas;
//  - runtime.sendMessage rejects ("Receiving end does not exist") when nothing is listening and
//    ("message port closed") when listeners exist but nobody responds; callback form sets
//    chrome.runtime.lastError instead. A listener answers by calling sendResponse, either
//    synchronously or after returning true.
//
// One mock = one process: runtime.onMessage listeners stand for "the other side" of
// runtime.sendMessage. tabs.sendMessage delivers to the handler registered with addTab().
import { isDeepStrictEqual } from 'node:util';

const jsonClone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
const PORT_CLOSED = 'The message port closed before a response was received.';

const QUOTAS = {
  local: { QUOTA_BYTES: 10485760 },
  session: { QUOTA_BYTES: 10485760 },
  sync: { QUOTA_BYTES: 102400, QUOTA_BYTES_PER_ITEM: 8192, MAX_ITEMS: 512 },
};

/** Event object with Chrome's listener API plus a `fire` helper for tests. */
function createEvent(onError) {
  const listeners = [];
  return {
    addListener(fn) { if (!listeners.includes(fn)) listeners.push(fn); },
    removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    hasListener(fn) { return listeners.includes(fn); },
    hasListeners() { return listeners.length > 0; },
    /** Calls every listener with `args`; returns their results. A throwing listener is recorded. */
    fire(...args) {
      return listeners.slice().map((fn) => {
        try { return fn(...args); } catch (err) { onError?.(err); return undefined; }
      });
    },
    _listeners: listeners,
    _clear() { listeners.length = 0; },
  };
}

/**
 * @param {{ manifest?: object, now?: () => number }} [options]
 */
export function createChromeMock(options = {}) {
  const now = options.now || (() => Date.now());
  const manifest = {
    manifest_version: 3, name: 'Cinedrape', version: '0.0.0-test', ...(options.manifest || {}),
  };
  const listenerErrors = [];
  const onError = (err) => listenerErrors.push(err);

  // ---- spies ------------------------------------------------------------------------------------
  /** @type {Record<string, Function & {calls: any[][], callCount: number}>} */
  const spies = {};
  function spy(name, impl) {
    const calls = [];
    const fn = function spied(...args) { calls.push(args); return impl.apply(this, args); };
    fn.calls = calls;
    Object.defineProperty(fn, 'callCount', { get: () => calls.length });
    spies[name] = fn;
    return fn;
  }

  // ---- runtime state ----------------------------------------------------------------------------
  const runtime = { id: 'test-id', lastError: undefined };
  let sender = { id: 'test-id' };

  /**
   * Shared Chrome-style call convention: `work` runs synchronously on the parsed args and returns
   * {result, after}; `after` (event delivery) runs before the callback/promise settles.
   */
  function call(args, work) {
    const hasCb = typeof args[args.length - 1] === 'function';
    const cb = hasCb ? args[args.length - 1] : null;
    const params = hasCb ? args.slice(0, -1) : args;
    let result; let after; let error;
    try { ({ result, after } = work(...params) || {}); } catch (err) { error = err; }
    const settled = Promise.resolve().then(() => { if (!error && after) after(); });
    if (cb) {
      settled.then(() => {
        if (error) {
          runtime.lastError = { message: error.message };
          try { cb(); } finally { runtime.lastError = undefined; }
        } else {
          cb(jsonClone(result));
        }
      });
      return undefined;
    }
    return settled.then(() => { if (error) throw error; return jsonClone(result); });
  }

  // ---- storage ----------------------------------------------------------------------------------
  const storageOnChanged = createEvent(onError);

  function createArea(name) {
    const data = Object.create(null);
    const onChanged = createEvent(onError);
    const quota = QUOTAS[name];
    const bytes = (k, v) => k.length + JSON.stringify(v).length;

    const emit = (changes) => {
      if (!Object.keys(changes).length) return;
      onChanged.fire(changes);
      storageOnChanged.fire(changes, name);
    };

    const pick = (keys) => {
      if (keys == null) return { ...data };
      if (typeof keys === 'string') return keys in data ? { [keys]: data[keys] } : {};
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (k in data) out[k] = data[k];
        return out;
      }
      if (typeof keys === 'object') {
        const out = {};
        for (const k of Object.keys(keys)) out[k] = k in data ? data[k] : keys[k];
        return out;
      }
      throw new Error('Error in invocation of storage.get: invalid keys argument');
    };

    const area = {
      ...quota,
      onChanged,
      get: spy(`storage.${name}.get`, (...args) => call(args, (keys) => ({ result: pick(keys) }))),
      getBytesInUse: spy(`storage.${name}.getBytesInUse`, (...args) => call(args, (keys) => {
        const entries = Object.entries(pick(keys ?? null));
        return { result: entries.reduce((n, [k, v]) => n + bytes(k, v), 0) };
      })),
      set: spy(`storage.${name}.set`, (...args) => call(args, (items) => {
        if (items === null || typeof items !== 'object' || Array.isArray(items)) {
          throw new Error('Error in invocation of storage.set: items must be an object');
        }
        const next = {};
        for (const [k, v] of Object.entries(items)) {
          const clone = jsonClone(v);
          if (clone !== undefined) next[k] = clone;
        }
        if (quota?.QUOTA_BYTES_PER_ITEM) {
          for (const [k, v] of Object.entries(next)) {
            if (bytes(k, v) > quota.QUOTA_BYTES_PER_ITEM) throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
          }
        }
        const merged = { ...data, ...next };
        if (quota?.MAX_ITEMS && Object.keys(merged).length > quota.MAX_ITEMS) throw new Error('MAX_ITEMS quota exceeded');
        if (quota?.QUOTA_BYTES) {
          const total = Object.entries(merged).reduce((n, [k, v]) => n + bytes(k, v), 0);
          if (total > quota.QUOTA_BYTES) throw new Error('QUOTA_BYTES quota exceeded');
        }
        const changes = {};
        for (const [k, v] of Object.entries(next)) {
          const existed = k in data;
          if (existed && isDeepStrictEqual(data[k], v)) continue;
          changes[k] = existed ? { oldValue: data[k], newValue: jsonClone(v) } : { newValue: jsonClone(v) };
          data[k] = v;
        }
        return { result: undefined, after: () => emit(changes) };
      })),
      remove: spy(`storage.${name}.remove`, (...args) => call(args, (keys) => {
        const list = typeof keys === 'string' ? [keys] : keys;
        if (!Array.isArray(list)) throw new Error('Error in invocation of storage.remove: invalid keys argument');
        const changes = {};
        for (const k of list) {
          if (!(k in data)) continue;
          changes[k] = { oldValue: data[k] };
          delete data[k];
        }
        return { result: undefined, after: () => emit(changes) };
      })),
      clear: spy(`storage.${name}.clear`, (...args) => call(args, () => {
        const changes = {};
        for (const k of Object.keys(data)) { changes[k] = { oldValue: data[k] }; delete data[k]; }
        return { result: undefined, after: () => emit(changes) };
      })),
    };
    area._wipe = () => { for (const k of Object.keys(data)) delete data[k]; onChanged._clear(); };
    return area;
  }

  const storage = {
    local: createArea('local'),
    sync: createArea('sync'),
    session: createArea('session'),
    onChanged: storageOnChanged,
  };

  // ---- messaging --------------------------------------------------------------------------------
  /**
   * Delivers `message` to a listener chain the way Chrome does and returns a promise for the
   * response. Rejects with the Chrome error strings when nobody receives or answers.
   */
  function deliver(listeners, message, from) {
    if (!listeners.length) return Promise.reject(new Error(NO_RECEIVER));
    const payload = jsonClone(message);
    return new Promise((resolve, reject) => {
      let answered = false;
      let keepOpen = false;
      const sendResponse = (value) => {
        if (answered) return;
        answered = true;
        resolve(jsonClone(value));
      };
      for (const fn of listeners.slice()) {
        try {
          if (fn(jsonClone(payload), jsonClone(from), sendResponse) === true) keepOpen = true;
        } catch (err) { onError(err); }
      }
      if (!answered && !keepOpen) reject(new Error(PORT_CLOSED));
    });
  }

  /** Adapts a promise-returning delivery to the callback-or-promise convention. */
  function viaMessaging(args, start) {
    const hasCb = typeof args[args.length - 1] === 'function';
    const cb = hasCb ? args[args.length - 1] : null;
    const params = hasCb ? args.slice(0, -1) : args;
    let promise;
    try { promise = start(params); } catch (err) { promise = Promise.reject(err); }
    if (!cb) return promise;
    promise.then(
      (value) => cb(value),
      (err) => {
        runtime.lastError = { message: err.message };
        try { cb(); } finally { runtime.lastError = undefined; }
      },
    );
    return undefined;
  }

  const onMessage = createEvent(onError);
  runtime.onMessage = onMessage;
  runtime.onInstalled = createEvent(onError);
  runtime.onStartup = createEvent(onError);
  runtime.getURL = (path = '') => `chrome-extension://test-id/${String(path).replace(/^\/+/, '')}`;
  runtime.getManifest = () => jsonClone(manifest);
  runtime.sendMessage = spy('runtime.sendMessage', (...args) => viaMessaging(args, (params) => {
    // sendMessage(message[, options]) or sendMessage(extensionId, message[, options])
    const message = typeof params[0] === 'string' && params.length >= 2 && params[1] !== undefined
      ? params[1] : params[0];
    return deliver(onMessage._listeners, message, sender);
  }));

  let uninstallURL = '';
  runtime.setUninstallURL = spy('runtime.setUninstallURL', (...args) => call(args, (url = '') => {
    uninstallURL = String(url);
    return { result: undefined };
  }));

  // ---- alarms -----------------------------------------------------------------------------------

  /** @type {Map<string, {name:string, scheduledTime:number, periodInMinutes?:number}>} */
  const alarmStore = new Map();
  const onAlarm = createEvent(onError);
  const dispatchAlarm = onAlarm.fire;           // generic "call every listener with these args"
  const alarms = {
    onAlarm,
    create: spy('alarms.create', (...args) => call(args, (a, b) => {
      const [name, info] = typeof a === 'string' ? [a, b] : ['', a];
      if (!info || typeof info !== 'object') throw new Error('Error in invocation of alarms.create: alarmInfo required');
      const alarm = {
        name,
        scheduledTime: info.when ?? now() + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60000,
      };
      if (info.periodInMinutes != null) alarm.periodInMinutes = info.periodInMinutes;
      alarmStore.set(name, alarm);
      return { result: undefined };
    })),
    get: spy('alarms.get', (...args) => call(args, (name = '') => ({ result: alarmStore.get(name) }))),
    getAll: spy('alarms.getAll', (...args) => call(args, () => ({ result: [...alarmStore.values()] }))),
    clear: spy('alarms.clear', (...args) => call(args, (name = '') => ({ result: alarmStore.delete(name) }))),
    clearAll: spy('alarms.clearAll', (...args) => call(args, () => {
      const had = alarmStore.size > 0;
      alarmStore.clear();
      return { result: had };
    })),
    /**
     * Test helper: delivers an alarm to onAlarm listeners. One-shot alarms are removed afterwards,
     * periodic ones stay (rescheduled). Unknown names fire a synthetic alarm. Resolves when every
     * (possibly async) listener has settled.
     */
    fire(name = '') {
      let alarm = alarmStore.get(name);
      if (!alarm) alarm = { name, scheduledTime: now() };
      else if (alarm.periodInMinutes != null) alarmStore.set(name, { ...alarm, scheduledTime: now() + alarm.periodInMinutes * 60000 });
      else alarmStore.delete(name);
      return Promise.all(dispatchAlarm(jsonClone(alarm)));
    },
  };
  onAlarm.fire = (name) => alarms.fire(name);   // chrome.alarms.onAlarm.fire(name) is an alias

  // ---- tabs -------------------------------------------------------------------------------------
  /** @type {{tab: object, listeners: Function[]}[]} */
  const tabEntries = [];
  const patternToRegExp = (pattern) => {
    if (pattern === '<all_urls>') return /^https?:\/\/.*$/;
    const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${esc}$`);
  };
  let nextTabId = 100;
  const tabs = {
    create: spy('tabs.create', (...args) => call(args, (props = {}) => {
      const tab = addTab({ id: nextTabId++, url: props.url, active: props.active !== false });
      return { result: tab };
    })),
    query: spy('tabs.query', (...args) => call(args, (info = {}) => {
      const patterns = info.url == null ? null : [].concat(info.url).map(patternToRegExp);
      const result = tabEntries.map((e) => e.tab).filter((t) => (
        (info.active == null || t.active === info.active)
        && (info.windowId == null || t.windowId === info.windowId)
        && (info.currentWindow == null || (t.windowId === 1) === info.currentWindow)
        && (!patterns || (t.url && patterns.some((re) => re.test(t.url))))
      ));
      return { result };
    })),
    sendMessage: spy('tabs.sendMessage', (...args) => viaMessaging(args, (params) => {
      const [tabId, message] = params;
      const entry = tabEntries.find((e) => e.tab.id === tabId);
      if (!entry) return Promise.reject(new Error(`No tab with id: ${tabId}.`));
      return deliver(entry.listeners, message, sender);
    })),
  };

  /**
   * Registers a fake tab. `handler(message, sender, sendResponse)` stands for that tab's content
   * script and follows the onMessage conventions (return true to respond asynchronously).
   */
  function addTab(tab, handler) {
    const entry = {
      tab: { active: false, windowId: 1, index: tabEntries.length, ...tab },
      listeners: handler ? [handler] : [],
    };
    const existing = tabEntries.findIndex((e) => e.tab.id === tab.id);
    if (existing >= 0) tabEntries.splice(existing, 1, entry);
    else tabEntries.push(entry);
    return entry.tab;
  }
  function removeTab(id) {
    const i = tabEntries.findIndex((e) => e.tab.id === id);
    if (i >= 0) tabEntries.splice(i, 1);
  }

  // ---- assemble ---------------------------------------------------------------------------------
  const chrome = { storage, runtime, alarms, tabs };

  function reset() {
    for (const area of [storage.local, storage.sync, storage.session]) area._wipe();
    storageOnChanged._clear();
    onMessage._clear();
    runtime.onInstalled._clear();
    runtime.onStartup._clear();
    onAlarm._clear();
    alarmStore.clear();
    tabEntries.length = 0;
    runtime.lastError = undefined;
    sender = { id: 'test-id' };
    listenerErrors.length = 0;
    uninstallURL = '';
    for (const fn of Object.values(spies)) fn.calls.length = 0;
  }

  return {
    chrome,
    reset,
    spies,
    addTab,
    removeTab,
    getUninstallURL() { return uninstallURL; },
    /** Sets the `sender` object listeners receive from sendMessage / tabs.sendMessage. */
    setSender(next) { sender = { id: 'test-id', ...next }; },
    /** Errors thrown by event listeners (Chrome would only log them). */
    listenerErrors,
  };
}

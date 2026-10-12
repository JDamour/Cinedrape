import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createChromeMock } from './chrome-mock.js';

let mock;
let chrome;
beforeEach(() => {
  mock = createChromeMock();
  chrome = mock.chrome;
});

const cbCall = (fn, ...args) => new Promise((resolve) => {
  fn(...args, (value) => resolve({ value, lastError: chrome.runtime.lastError }));
});

// ---- storage ------------------------------------------------------------------------------------

test('storage.local get/set: promise form and callback form', async () => {
  await chrome.storage.local.set({ a: 1, b: { c: [1, 2] } });
  assert.deepEqual(await chrome.storage.local.get('a'), { a: 1 });
  assert.deepEqual(await chrome.storage.local.get(['a', 'zzz']), { a: 1 });
  assert.deepEqual(await chrome.storage.local.get(null), { a: 1, b: { c: [1, 2] } });
  assert.deepEqual(await chrome.storage.local.get(), { a: 1, b: { c: [1, 2] } });
  assert.deepEqual(await chrome.storage.local.get({ a: 9, d: 'dflt' }), { a: 1, d: 'dflt' });

  const viaCb = await cbCall(chrome.storage.local.get.bind(chrome.storage.local), 'a');
  assert.deepEqual(viaCb.value, { a: 1 });
  assert.equal(viaCb.lastError, undefined);

  const setRet = chrome.storage.local.set({ x: 1 }, () => {});
  assert.equal(setRet, undefined, 'callback form returns undefined, not a promise');
  assert.ok(chrome.storage.local.set({ y: 1 }) instanceof Promise);
});

test('storage callbacks are asynchronous, writes are visible immediately to later reads', async () => {
  let called = false;
  chrome.storage.local.set({ k: 1 }, () => { called = true; });
  assert.equal(called, false);
  assert.deepEqual(await chrome.storage.local.get('k'), { k: 1 });
  assert.equal(called, true);
});

test('storage values are JSON-cloned on the way in and out', async () => {
  const input = { nested: { n: 1 }, gone: undefined, when: new Date(0) };
  await chrome.storage.local.set({ obj: input });
  input.nested.n = 99;
  const out = (await chrome.storage.local.get('obj')).obj;
  assert.deepEqual(out, { nested: { n: 1 }, when: '1970-01-01T00:00:00.000Z' });
  out.nested.n = 5;
  assert.equal((await chrome.storage.local.get('obj')).obj.nested.n, 1);
});

test('storage.local and storage.sync are independent areas', async () => {
  await chrome.storage.local.set({ k: 'local' });
  await chrome.storage.sync.set({ k: 'sync' });
  assert.equal((await chrome.storage.local.get('k')).k, 'local');
  assert.equal((await chrome.storage.sync.get('k')).k, 'sync');
  await chrome.storage.sync.clear();
  assert.equal((await chrome.storage.local.get('k')).k, 'local');
  assert.deepEqual(await chrome.storage.sync.get(null), {});
});

test('storage remove and clear (string, array, callback forms)', async () => {
  await chrome.storage.local.set({ a: 1, b: 2, c: 3, d: 4 });
  await chrome.storage.local.remove('a');
  await chrome.storage.local.remove(['b', 'nope']);
  assert.deepEqual(await chrome.storage.local.get(null), { c: 3, d: 4 });
  await cbCall(chrome.storage.local.remove.bind(chrome.storage.local), 'c');
  assert.deepEqual(await chrome.storage.local.get(null), { d: 4 });
  await chrome.storage.local.clear();
  assert.deepEqual(await chrome.storage.local.get(null), {});
});

test('storage.onChanged reports {oldValue,newValue} per key with the area name', async () => {
  const seen = [];
  chrome.storage.onChanged.addListener((changes, area) => seen.push({ changes, area }));

  await chrome.storage.local.set({ a: 1 });
  await chrome.storage.local.set({ a: 2, b: { x: 1 } });
  await chrome.storage.sync.set({ s: 's' });
  await chrome.storage.local.remove('a');
  await chrome.storage.local.clear();

  assert.deepEqual(seen, [
    { area: 'local', changes: { a: { newValue: 1 } } },
    { area: 'local', changes: { a: { oldValue: 1, newValue: 2 }, b: { newValue: { x: 1 } } } },
    { area: 'sync', changes: { s: { newValue: 's' } } },
    { area: 'local', changes: { a: { oldValue: 2 } } },
    { area: 'local', changes: { b: { oldValue: { x: 1 } } } },
  ]);
});

test('storage.onChanged does not fire for unchanged values, and fires before the call settles', async () => {
  await chrome.storage.local.set({ a: { deep: [1] } });
  const events = [];
  chrome.storage.onChanged.addListener((c) => events.push(c));
  await chrome.storage.local.set({ a: { deep: [1] } });
  assert.equal(events.length, 0);

  let firedBeforeCallback = false;
  chrome.storage.onChanged.addListener(() => { firedBeforeCallback = true; });
  await new Promise((resolve) => {
    chrome.storage.local.set({ a: 2 }, () => {
      assert.equal(firedBeforeCallback, true);
      resolve();
    });
  });
});

test('storage.onChanged add/remove/hasListener and per-area onChanged', async () => {
  const fn = () => {};
  chrome.storage.onChanged.addListener(fn);
  assert.equal(chrome.storage.onChanged.hasListener(fn), true);
  chrome.storage.onChanged.removeListener(fn);
  assert.equal(chrome.storage.onChanged.hasListener(fn), false);

  const local = [];
  const sync = [];
  chrome.storage.local.onChanged.addListener((c) => local.push(c));
  chrome.storage.sync.onChanged.addListener((c) => sync.push(c));
  await chrome.storage.local.set({ q: 1 });
  assert.deepEqual(local, [{ q: { newValue: 1 } }]);
  assert.deepEqual(sync, []);
});

test('storage.sync enforces the per-item quota (promise rejects, callback sets lastError)', async () => {
  const big = 'x'.repeat(9000);
  await assert.rejects(chrome.storage.sync.set({ big }), /QUOTA_BYTES_PER_ITEM/);
  const res = await cbCall(chrome.storage.sync.set.bind(chrome.storage.sync), { big });
  assert.equal(res.value, undefined);
  assert.match(res.lastError.message, /QUOTA_BYTES_PER_ITEM/);
  assert.equal(chrome.runtime.lastError, undefined, 'lastError is cleared after the callback');
  assert.deepEqual(await chrome.storage.sync.get(null), {}, 'a failed set stores nothing');
  await chrome.storage.local.set({ big }); // local has no per-item cap
});

test('storage.getBytesInUse counts key + JSON value length', async () => {
  await chrome.storage.local.set({ ab: 'cd' });
  assert.equal(await chrome.storage.local.getBytesInUse('ab'), 'ab'.length + '"cd"'.length);
});

// ---- runtime ------------------------------------------------------------------------------------

test('runtime id, getURL and getManifest', () => {
  assert.equal(chrome.runtime.id, 'test-id');
  assert.equal(chrome.runtime.getURL('icons/icon-16.png'), 'chrome-extension://test-id/icons/icon-16.png');
  assert.equal(chrome.runtime.getURL('/popup/popup.html'), 'chrome-extension://test-id/popup/popup.html');
  assert.equal(chrome.runtime.lastError, undefined);
  assert.equal(chrome.runtime.getManifest().name, 'Cinedrape');
  assert.equal(createChromeMock({ manifest: { version: '9.9.9' } }).chrome.runtime.getManifest().version, '9.9.9');
});

test('sendMessage: synchronous sendResponse', async () => {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    sendResponse({ echo: msg.type, from: sender.id });
  });
  assert.deepEqual(await chrome.runtime.sendMessage({ type: 'cd:getStatus' }), { echo: 'cd:getStatus', from: 'test-id' });
  const viaCb = await cbCall(chrome.runtime.sendMessage.bind(chrome.runtime), { type: 'x' });
  assert.deepEqual(viaCb.value, { echo: 'x', from: 'test-id' });
  assert.equal(viaCb.lastError, undefined);
});

test('sendMessage: async response when the listener returns true', async () => {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    setTimeout(() => sendResponse({ late: true }), 5);
    return true;
  });
  assert.deepEqual(await chrome.runtime.sendMessage({ type: 'x' }), { late: true });
});

test('sendMessage: answering after returning nothing loses the response (as in Chrome)', async () => {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    setTimeout(() => sendResponse({ too: 'late' }), 0);
  });
  await assert.rejects(chrome.runtime.sendMessage({ type: 'x' }), /message port closed/);
});

test('sendMessage: first response wins, messages are cloned, sender can be set', async () => {
  const received = [];
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    received.push({ msg, sender });
    msg.mutated = true;
    sendResponse('first');
  });
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => { sendResponse('second'); });
  const original = { type: 'x' };
  mock.setSender({ tab: { id: 7 }, url: 'https://www.youtube.com/' });
  assert.equal(await chrome.runtime.sendMessage(original), 'first');
  assert.deepEqual(original, { type: 'x' });
  assert.deepEqual(received[0].sender, { id: 'test-id', tab: { id: 7 }, url: 'https://www.youtube.com/' });
});

test('sendMessage: no listener rejects / sets lastError; extensionId form is accepted', async () => {
  await assert.rejects(chrome.runtime.sendMessage({ type: 'x' }), /Receiving end does not exist/);
  const res = await cbCall(chrome.runtime.sendMessage.bind(chrome.runtime), { type: 'x' });
  assert.equal(res.value, undefined);
  assert.match(res.lastError.message, /Receiving end does not exist/);
  assert.equal(chrome.runtime.lastError, undefined);

  chrome.runtime.onMessage.addListener((msg, s, send) => send(msg));
  assert.deepEqual(await chrome.runtime.sendMessage('test-id', { type: 'y' }), { type: 'y' });
});

test('onMessage add/remove/hasListener, and throwing listeners are recorded not propagated', async () => {
  const fn = (msg, sender, send) => send('ok');
  chrome.runtime.onMessage.addListener(fn);
  chrome.runtime.onMessage.addListener(fn);
  assert.equal(chrome.runtime.onMessage.hasListener(fn), true);
  assert.equal(await chrome.runtime.sendMessage({}), 'ok');
  chrome.runtime.onMessage.removeListener(fn);
  assert.equal(chrome.runtime.onMessage.hasListener(fn), false);
  await assert.rejects(chrome.runtime.sendMessage({}), /Receiving end/);

  const boom = new Error('boom');
  chrome.runtime.onMessage.addListener(() => { throw boom; });
  chrome.runtime.onMessage.addListener((m, s, send) => send('still delivered'));
  assert.equal(await chrome.runtime.sendMessage({}), 'still delivered');
  assert.deepEqual(mock.listenerErrors, [boom]);
});

test('onInstalled / onStartup stubs accept listeners and can be fired', () => {
  const calls = [];
  chrome.runtime.onInstalled.addListener((d) => calls.push(['installed', d]));
  chrome.runtime.onStartup.addListener(() => calls.push(['startup']));
  chrome.runtime.onInstalled.fire({ reason: 'install' });
  chrome.runtime.onStartup.fire();
  assert.deepEqual(calls, [['installed', { reason: 'install' }], ['startup']]);
});

// ---- alarms -------------------------------------------------------------------------------------

test('alarms create/get/getAll/clear (promise and callback forms)', async () => {
  let t = 1_000_000;
  const m = createChromeMock({ now: () => t });
  const { alarms } = m.chrome;
  await alarms.create('cd-licence', { periodInMinutes: 60 * 24 * 7 });
  await alarms.create('cd-map', { delayInMinutes: 1, periodInMinutes: 360 });
  alarms.create({ when: t + 5000 }, () => {});

  assert.deepEqual(await alarms.get('cd-map'), { name: 'cd-map', scheduledTime: t + 60000, periodInMinutes: 360 });
  assert.equal((await alarms.get('cd-licence')).periodInMinutes, 10080);
  assert.equal(await alarms.get('missing'), undefined);
  assert.deepEqual((await alarms.getAll()).map((a) => a.name).sort(), ['', 'cd-licence', 'cd-map']);

  assert.equal(await alarms.clear('cd-map'), true);
  assert.equal(await alarms.clear('cd-map'), false);
  const viaCb = await new Promise((resolve) => alarms.getAll((list) => resolve(list)));
  assert.deepEqual(viaCb.map((a) => a.name).sort(), ['', 'cd-licence']);
  assert.equal(await alarms.clearAll(), true);
  assert.deepEqual(await alarms.getAll(), []);
});

test('alarms.fire(name) delivers to onAlarm listeners; one-shot alarms are consumed, periodic stay', async () => {
  const fired = [];
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    await new Promise((r) => setTimeout(r, 2));
    fired.push(alarm.name);
  });
  await chrome.alarms.create('once', { delayInMinutes: 1 });
  await chrome.alarms.create('repeat', { periodInMinutes: 5 });

  await chrome.alarms.fire('once');
  await chrome.alarms.fire('repeat');
  await chrome.alarms.onAlarm.fire('repeat');       // alias
  await chrome.alarms.fire('never-created');

  assert.deepEqual(fired, ['once', 'repeat', 'repeat', 'never-created']);
  assert.equal(await chrome.alarms.get('once'), undefined);
  assert.equal((await chrome.alarms.get('repeat')).periodInMinutes, 5);
});

// ---- tabs ---------------------------------------------------------------------------------------

test('tabs.query filters by active, url pattern and window', async () => {
  mock.addTab({ id: 1, url: 'https://www.youtube.com/watch?v=abc', active: true });
  mock.addTab({ id: 2, url: 'https://www.youtube.com/', active: false });
  mock.addTab({ id: 3, url: 'https://example.com/', active: false, windowId: 2 });

  assert.deepEqual((await chrome.tabs.query({})).map((t) => t.id), [1, 2, 3]);
  assert.deepEqual((await chrome.tabs.query({ active: true, currentWindow: true })).map((t) => t.id), [1]);
  assert.deepEqual((await chrome.tabs.query({ url: 'https://www.youtube.com/*' })).map((t) => t.id), [1, 2]);
  assert.deepEqual((await chrome.tabs.query({ url: ['https://example.com/*', '*://www.youtube.com/watch*'] })).map((t) => t.id), [1, 3]);
  assert.deepEqual((await chrome.tabs.query({ windowId: 2 })).map((t) => t.id), [3]);
  const viaCb = await new Promise((resolve) => chrome.tabs.query({ active: true }, resolve));
  assert.equal(viaCb[0].id, 1);
  mock.removeTab(1);
  assert.deepEqual((await chrome.tabs.query({ active: true })).map((t) => t.id), []);
});

test('tabs.sendMessage reaches the registered tab handler (sync and async), else rejects', async () => {
  mock.addTab({ id: 1, url: 'https://www.youtube.com/' }, (msg, sender, sendResponse) => sendResponse({ pageType: 'home', got: msg.type }));
  mock.addTab({ id: 2, url: 'https://www.youtube.com/watch' }, (msg, sender, sendResponse) => {
    setTimeout(() => sendResponse({ pageType: 'watch' }), 1);
    return true;
  });
  mock.addTab({ id: 3, url: 'https://www.youtube.com/feed' });

  assert.deepEqual(await chrome.tabs.sendMessage(1, { type: 'cd:getStatus' }), { pageType: 'home', got: 'cd:getStatus' });
  assert.deepEqual(await chrome.tabs.sendMessage(2, { type: 'cd:getStatus' }), { pageType: 'watch' });
  await assert.rejects(chrome.tabs.sendMessage(3, {}), /Receiving end does not exist/);
  await assert.rejects(chrome.tabs.sendMessage(99, {}), /No tab with id: 99/);
  const res = await cbCall(chrome.tabs.sendMessage.bind(chrome.tabs), 99, {});
  assert.equal(res.value, undefined);
  assert.match(res.lastError.message, /No tab with id/);
});

// ---- spies and reset ----------------------------------------------------------------------------

test('spies record calls, and reset() restores a pristine mock', async () => {
  await chrome.storage.local.set({ a: 1 });
  await chrome.storage.local.get('a');
  chrome.runtime.onMessage.addListener((m, s, send) => send(1));
  await chrome.runtime.sendMessage({ type: 't' });
  await chrome.alarms.create('x', { periodInMinutes: 1 });
  mock.addTab({ id: 1, url: 'https://www.youtube.com/' });

  assert.equal(mock.spies['storage.local.set'].callCount, 1);
  assert.deepEqual(mock.spies['storage.local.set'].calls[0], [{ a: 1 }]);
  assert.deepEqual(mock.spies['storage.local.get'].calls[0], ['a']);
  assert.deepEqual(mock.spies['runtime.sendMessage'].calls[0], [{ type: 't' }]);

  const changes = [];
  chrome.storage.onChanged.addListener((c) => changes.push(c));
  chrome.alarms.onAlarm.addListener(() => changes.push('alarm'));
  mock.reset();

  assert.equal(mock.spies['storage.local.set'].callCount, 0);
  assert.deepEqual(await chrome.storage.local.get(null), {});
  assert.deepEqual(await chrome.alarms.getAll(), []);
  assert.deepEqual(await chrome.tabs.query({}), []);
  assert.equal(chrome.runtime.onMessage.hasListeners(), false);
  await assert.rejects(chrome.runtime.sendMessage({}), /Receiving end/);
  await chrome.storage.local.set({ b: 1 });
  await chrome.alarms.fire('x');
  assert.deepEqual(changes, [], 'listeners were dropped by reset(), and reset itself fires no events');
});

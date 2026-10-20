import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mount, STATUS_OK, YT_URL } from './_harness.js';

test('missing content script is restored in the active YouTube main frame', async () => {
  const injections = [];
  const t = await mount({ status: null, prepare(t) {
    t.chrome.scripting = { async executeScript(options) {
      injections.push(options);
      t.mock.addTab(t.tab, (message, sender, respond) => { respond(STATUS_OK); });
      return [{ frameId: 0 }];
    } };
  } });
  try {
    assert.deepEqual(injections, [{ target: { tabId: 7 }, files: ['content.js'] }]);
    assert.equal(t.popup.getState().status.kind, 'ok');
    assert.equal(t.$('status-reload').hidden, true);
    await t.popup.refresh();
    assert.equal(injections.length, 1);
  } finally { t.close(); }
});

test('healthy and non-YouTube tabs never receive recovery injection', async () => {
  for (const tabUrl of [YT_URL, 'https://example.com/']) {
    let calls = 0;
    const t = await mount({ tabUrl, prepare(t) {
      t.chrome.scripting = { async executeScript() { calls++; } };
    } });
    try {
      assert.equal(calls, 0);
      assert.equal(t.$('status-reload').hidden, true);
    } finally { t.close(); }
  }
});

test('denied recovery exposes reload, surfaces site-access notice, and does not repeatedly inject', async () => {
  for (const errText of ['Site access denied', 'Blocked']) {
    let calls = 0;
    const t = await mount({ status: null, prepare(t) {
      t.chrome.scripting = { async executeScript() { calls++; throw new Error(errText); } };
    } });
    try {
      assert.equal(t.popup.getState().status.kind, 'unreachable');
      assert.equal(t.$('status-reload').hidden, false);
      assert.match(t.$('notice').textContent, /Allow extensions on youtube\.com/i);
      await t.popup.refresh();
      assert.equal(calls, 1);
    } finally { t.close(); }
  }
});

test('reload action reloads YouTube and checks the restored connection', async () => {
  const reloads = [];
  const t = await mount({ status: null, prepare(t) {
    t.chrome.tabs.get = async () => t.tab;
    t.chrome.tabs.reload = async (id) => {
      reloads.push(id);
      t.mock.addTab(t.tab, (message, sender, respond) => { respond(STATUS_OK); });
    };
  } });
  try {
    t.click(t.$('status-reload'));
    await t.popup.idle();
    assert.deepEqual(reloads, [7]);
    assert.equal(t.popup.getState().status.kind, 'ok');
  } finally { t.close(); }
});

test('reload action does not reload a tab that navigated away from YouTube', async () => {
  let reloads = 0;
  const t = await mount({ status: null, prepare(t) {
    t.chrome.tabs.get = async () => ({ id: 7, url: 'https://example.com/' });
    t.chrome.tabs.reload = async () => { reloads++; };
  } });
  try {
    t.click(t.$('status-reload'));
    await t.popup.idle();
    assert.equal(reloads, 0);
  } finally { t.close(); }
});

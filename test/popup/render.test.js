// What the popup shows for each licence state and stored setting, and that every control is accessible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CALM_KEYS, DEFAULT_SETTINGS, FREE_CALM_KEYS, STORAGE_KEYS } from '../../src/shared/constants.js';
import { signLicenceToken } from '../../src/shared/licence.js';
import { toPublicJwk } from '../../src/shared/signing.js';
import {
  EXPIRED, FAKE_THEMES, FREE, GRACE, PRO, SETTINGS_KEY, accessibleName, interactiveElements, mount as mountPopup,
} from './_harness.js';

// A throw-away licence key pair: the popup's fallback verifies the stored token's signature, so stored records carry real tokens.
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
const SIGNER = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, kid: 'popup-test' };
const LICENCE_KEY = toPublicJwk(SIGNER);
const IAT = Math.floor(Date.now() / 1000) - 60;
const EXP = IAT + 90 * 86400;
const claimsFor = (plan, extra = {}) => ({ v: 1, sub: 'tester', plan, iat: IAT, exp: EXP, ...extra });
const TOKENS = { pro: await signLicenceToken(claimsFor('pro'), SIGNER), free: await signLicenceToken(claimsFor('free'), SIGNER) };
const mount = (o = {}) => mountPopup({ licenceKey: LICENCE_KEY, ...o });

const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
const visibleText = (el) => {
  let out = '';
  for (const n of el.childNodes) {
    if (n.nodeType === 3) out += n.textContent;
    else if (n.nodeType === 1 && !n.hidden && n.getAttribute('aria-hidden') !== 'true') out += ` ${visibleText(n)} `;
  }
  return out.replace(/\s+/g, ' ').trim();
};
const locked = (el) => el.getAttribute('aria-disabled') === 'true';

test('free user: six theme cards in contract order, Cinema selected, Pro themes locked and explained', async () => {
  const t = await mount({ licence: FREE });
  try {
    const cards = [...t.doc.querySelectorAll('#theme-grid [role="radio"]')];
    assert.deepEqual(cards.map((c) => c.dataset.themeId), ['cinema', 'minimal', 'classic', 'primetime', 'studio', 'arcade']);
    assert.deepEqual(cards.map((c) => c.getAttribute('aria-checked')), ['true', 'false', 'false', 'false', 'false', 'false']);
    assert.deepEqual(cards.map(locked), [false, false, false, true, true, true]);
    for (const id of ['primetime', 'studio', 'arcade']) {
      const card = t.card(id);
      assert.equal(card.getAttribute('aria-describedby'), 'theme-locked-desc');
      assert.equal(card.querySelector('.tag-lock').hidden, false, 'lock icon shown');
      assert.match(visibleText(card), /Pro/);
      assert.match(accessibleName(card), /Pro ?, locked/); // an inline tag and its screen-reader suffix, joined by the harness
    }
    for (const id of ['cinema', 'minimal', 'classic']) {
      assert.equal(t.card(id).querySelector('.tag-pro'), null, 'free cards carry no Pro badge');
      assert.equal(t.card(id).hasAttribute('aria-describedby'), false);
    }
    assert.match(t.$('theme-locked-desc').textContent, /Requires Cinedrape Pro/);
    assert.equal(t.$('theme-group').getAttribute('role'), 'radiogroup');
    assert.equal(accessibleName(t.$('theme-group')), 'Theme');
  } finally { t.close(); }
});

test('free user: a roving tab stop on the selected card only', async () => {
  const t = await mount({ settings: { ...DEFAULT_SETTINGS, themeId: 'classic' }, licence: FREE });
  try {
    const stops = [...t.doc.querySelectorAll('#theme-grid [role="radio"]')].filter((c) => c.tabIndex === 0);
    assert.deepEqual(stops.map((c) => c.dataset.themeId), ['classic']);
  } finally { t.close(); }
});

test('free user: density is disabled with a lock and a note; Pro calm toggles are locked; free ones are not', async () => {
  const t = await mount({ licence: FREE });
  try {
    assert.equal(t.$('density').disabled, true);
    assert.equal(t.$('density-pro').hidden, false);
    assert.match(accessibleName(t.$('density-group').querySelector('legend')), /Density/);
    assert.match(t.$('density-note').textContent, /^Pro feature\. Free users get Cinema.s own spacing\.$/);
    assert.equal(t.$('density-unlock').hidden, false);
    assert.equal(t.$('density-reset').hidden, true);
    assert.equal(t.$('density').value, '3');
    assert.equal(t.$('density-value').textContent, 'Balanced');

    for (const key of CALM_KEYS) {
      const toggle = t.calm(key);
      const free = FREE_CALM_KEYS.includes(key);
      assert.equal(locked(toggle), !free, key);
      assert.equal(t.$(`calm-${key}-pro`).hidden, free, `${key} Pro tag`);
      assert.equal(toggle.getAttribute('aria-checked'), 'false');
      assert.equal(toggle.getAttribute('role'), 'switch');
      assert.equal(toggle.getAttribute('aria-describedby').includes(`calm-${key}-pro`), !free);
    }
    assert.match(accessibleName(t.calm('hideComments')), /^Hide comments$/);
    // The visible Pro tag says why (text, not colour alone).
    assert.match(text(t.$('calm-hideComments-pro')), /Pro setting, locked/);
  } finally { t.close(); }
});

test('free user: the Pro card says Free and offers the token form, open', async () => {
  const t = await mount({ licence: FREE });
  try {
    assert.equal(text(t.$('pro-state-text')), 'Free');
    assert.equal(t.$('pro-state').dataset.state, 'free');
    assert.equal(t.$('activate').open, true);
    assert.equal(text(t.$('activate-summary')), 'Activate Pro');
    assert.equal(t.$('token').value, '');
    assert.equal(t.$('pro-saved').textContent, '', 'nothing is saved-and-waiting');
  } finally { t.close(); }
});

test('Pro active: nothing is locked and the token form tucks away', async () => {
  const t = await mount({ licence: PRO, settings: { ...DEFAULT_SETTINGS, themeId: 'studio', density: 5, calm: { ...DEFAULT_SETTINGS.calm, hideComments: true } } });
  try {
    assert.equal(text(t.$('pro-state-text')), 'Pro active');
    assert.equal(t.$('pro-state').dataset.state, 'active');
    assert.equal(t.doc.querySelectorAll('[aria-disabled="true"]:not(#accent-reset)').length, 0, 'no locked control');
    assert.equal(t.card('studio').getAttribute('aria-checked'), 'true');
    assert.equal(t.card('studio').querySelector('.tag-lock').hidden, true, 'a Pro theme keeps its Pro badge but not the lock');
    assert.equal(t.$('density').disabled, false);
    assert.equal(t.$('density').value, '5');
    assert.equal(t.$('density-value').textContent, 'Roomy');
    assert.equal(t.$('density-reset').hidden, false, 'a custom density can go back to the theme default');
    assert.equal(t.$('density-unlock').hidden, true);
    assert.equal(t.calm('hideComments').getAttribute('aria-checked'), 'true');
    assert.equal(t.calm('hideComments').querySelector('.switch-state').textContent, 'On');
    assert.equal(t.$('activate').open, false);
    assert.equal(text(t.$('activate-summary')), 'Use a different licence token');
    assert.match(t.$('pro-detail').textContent, /unlocked/);
  } finally { t.close(); }
});

test('offline grace: still Pro, and the line says so', async () => {
  const t = await mount({ licence: GRACE });
  try {
    assert.equal(text(t.$('pro-state-text')), 'Pro (offline grace)');
    assert.equal(t.$('pro-state').dataset.state, 'grace');
    assert.equal(locked(t.card('studio')), false);
    assert.match(t.$('pro-detail').textContent, /could not re-check your licence/);
  } finally { t.close(); }
});

test('expired: Pro features lock, and the saved Pro choices are reported as waiting, not lost', async () => {
  const settings = { ...DEFAULT_SETTINGS, themeId: 'arcade', density: 4, accent: '#7c8cff', calm: { ...DEFAULT_SETTINGS.calm, hideComments: true, hideShorts: true } };
  const t = await mount({ licence: EXPIRED, settings });
  try {
    assert.equal(text(t.$('pro-state-text')), 'Pro expired');
    assert.equal(t.$('pro-state').dataset.state, 'expired');
    assert.equal(t.card('cinema').getAttribute('aria-checked'), 'true', 'the tab shows Cinema, so the popup does too');
    assert.equal(t.card('arcade').getAttribute('aria-checked'), 'false');
    assert.equal(text(t.$('theme-note')), 'Arcade theme is saved and returns when Pro is active.');
    assert.equal(text(t.$('pro-saved')), 'Saved and waiting for Pro: Arcade theme, density, hide comments.');
    assert.match(t.$('density-note').textContent, /saved density returns when Pro is active/);
    assert.equal(t.calm('hideComments').getAttribute('aria-checked'), 'false');
    assert.equal(t.calm('hideShorts').getAttribute('aria-checked'), 'true', 'a free calm key keeps working');
    assert.equal(t.$('density').disabled, true);
    assert.equal(t.$('accent-hex').value, '#7c8cff', 'the accent is free and stays');
    assert.equal((await t.stored()).themeId, 'arcade', 'rendering never rewrites storage');
    assert.equal(t.writes(), 0);
  } finally { t.close(); }
});

const DAY = 86400000;
const record = (ageDays, plan = 'pro', over = {}) => ({
  token: TOKENS[plan], claims: claimsFor(plan), checkedAt: Date.now() - ageDays * DAY, ...over,
});

test('licence status unavailable only when neither the background nor storage can say; Pro stays locked and it is said plainly', async () => {
  for (const licenceMode of ['silent', 'junk', 'hang']) {
    const t = await mount({
      licence: PRO, licenceMode, requestTimeoutMs: 60,
      prepare: (x) => { x.chrome.storage.local.get = () => Promise.reject(new Error('storage is down')); },
    });
    try {
      assert.equal(text(t.$('pro-state-text')), 'Licence status unavailable', licenceMode);
      assert.equal(t.$('pro-state').dataset.state, 'unknown');
      assert.equal(locked(t.card('studio')), true, 'fails closed: Pro stays locked');
      assert.match(t.$('pro-detail').textContent, /reopen this popup/);
    } finally { t.close(); }
  }
});

test('the background asleep or restarting does not blank the licence: asked twice, then computed from the stored record (same rules, never a guess)', async () => {
  const cases = [
    ['fresh Pro record', record(2), 'Pro active', false],
    ['record 10 days old: offline grace', record(10), 'Pro (offline grace)', false],
    ['record 31 days old: not re-checked, said as such (the token has no expiry problem)', record(31), 'Pro paused', true],
    ['claims edited by hand to Pro on a free token', record(1, 'free', { claims: claimsFor('pro') }), 'Pro paused', true],
    ['a token that does not verify', record(1, 'pro', { token: 'aaaa.bbbb' }), 'Pro paused', true],
    ['a token past its own exp', record(1, 'pro', { claims: claimsFor('pro', { exp: IAT + 5 }), token: TOKENS.pro }), 'Pro expired', true],
    ['a free-plan record', record(1, 'free'), 'Free', true],
    ['no record at all', null, 'Free', true],
    ['a record with the wrong shape', { token: 'x' }, 'Free', true],
    ['junk where the record should be', 'not a record', 'Free', true],
  ];
  for (const licenceMode of ['silent', 'junk', 'hang']) {
    for (const [name, storedLicence, label, proLocked] of cases) {
      const t = await mount({ licence: PRO, licenceMode, storedLicence, requestTimeoutMs: 60 });
      try {
        assert.equal(text(t.$('pro-state-text')), label, `${licenceMode}: ${name}`);
        assert.equal(locked(t.card('studio')), proLocked, `${licenceMode}: ${name}`);
        assert.notEqual(t.$('pro-state').dataset.state, 'unknown');
        assert.equal(t.messages.filter((m) => m.type === 'cd:getLicence').length, 2, 'the background was asked twice (one retry), not more');
        assert.equal(t.writes(), 0, 'reading the licence writes nothing');
      } finally { t.close(); }
    }
  }
});

test('a worker that fails the first message and answers the second is believed over the stored record', async () => {
  const t = await mount({ licence: PRO, licenceMode: 'flaky', storedLicence: record(31), requestTimeoutMs: 80 });
  try {
    assert.equal(text(t.$('pro-state-text')), 'Pro active', 'the worker answered on the retry');
    assert.equal(t.messages.filter((m) => m.type === 'cd:getLicence').length, 2);
    assert.equal(locked(t.card('studio')), false);
  } finally { t.close(); }
});

test('a healthy background is asked once and the stored record is not even read', async () => {
  const t = await mount({ licence: PRO, storedLicence: record(31) });
  try {
    assert.equal(text(t.$('pro-state-text')), 'Pro active', 'the background wins');
    assert.equal(t.messages.filter((m) => m.type === 'cd:getLicence').length, 1);
    assert.equal(t.mock.spies['storage.local.get'].calls.some((c) => JSON.stringify(c.args || c).includes('cd.licence')), false);
  } finally { t.close(); }
});

test('activation retries once when the worker refuses the connection, but not after a timeout', async () => {
  let calls = 0;
  const t = await mount({
    licence: FREE, requestTimeoutMs: 80,
    prepare: (x) => {
      const send = x.chrome.runtime.sendMessage.bind(x.chrome.runtime);
      x.chrome.runtime.sendMessage = (message, ...rest) => {
        if (message && message.type === 'cd:activateLicence' && ++calls === 1) return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
        return send(message, ...rest);
      };
    },
    activate: () => ({ ok: true, state: PRO }),
  });
  try {
    t.$('token').value = 'aaaa.bbbb';
    t.fire(t.$('activate-form'), 'submit');
    await t.settle();
    await t.settle();
    assert.equal(calls, 2, 'one retry');
    assert.match(text(t.$('activate-result')), /Pro is now active/);
  } finally { t.close(); }
});

test('accent: eight labelled swatches, the stored one checked, a custom one leaves the group without a selection', async () => {
  const t = await mount({ settings: { ...DEFAULT_SETTINGS, accent: '#4cc3ff' } });
  try {
    const swatches = [...t.doc.querySelectorAll('#accent-swatches [role="radio"]')];
    assert.equal(swatches.length, 8);
    assert.deepEqual(swatches.filter((s) => s.getAttribute('aria-checked') === 'true').map((s) => s.dataset.hex), ['#4cc3ff']);
    assert.deepEqual(swatches.filter((s) => s.tabIndex === 0).map((s) => s.dataset.hex), ['#4cc3ff']);
    assert.equal(accessibleName(t.swatch('#4cc3ff')), 'Sky, #4cc3ff');
    assert.equal(t.swatch('#e8b04a').style.getPropertyValue('--sw'), '#e8b04a');
    assert.equal(t.$('accent-hex').value, '#4cc3ff');
    assert.equal(locked(t.$('accent-reset')), false);
    assert.equal(text(t.$('accent-help')), 'Using your accent #4cc3ff.');
  } finally { t.close(); }

  const custom = await mount({ settings: { ...DEFAULT_SETTINGS, accent: '#123456' } });
  try {
    const swatches = [...custom.doc.querySelectorAll('#accent-swatches [role="radio"]')];
    assert.equal(swatches.filter((s) => s.getAttribute('aria-checked') === 'true').length, 0);
    assert.deepEqual(swatches.filter((s) => s.tabIndex === 0).map((s) => s.dataset.hex), ['#e8b04a'], 'first swatch is the tab stop');
    assert.equal(custom.$('accent-hex').value, '#123456');
  } finally { custom.close(); }
});

test('accent: with no override it says the theme accent is in use and Reset is inert', async () => {
  const t = await mount({ settings: { ...DEFAULT_SETTINGS, themeId: 'minimal' } });
  try {
    assert.equal(t.$('accent-hex').value, '');
    assert.equal(text(t.$('accent-help')), 'Using the Minimal theme’s own accent (#0b57d0).');
    assert.equal(locked(t.$('accent-reset')), true);
    assert.equal(t.$('accent-preview').style.getPropertyValue('--hex'), '#0b57d0');
    assert.equal(t.$('accent-warning').textContent, '');
  } finally { t.close(); }
});

test('accent: a low-contrast accent shows the warning, with the ratio and the theme, in a status region', async () => {
  const t = await mount({ settings: { ...DEFAULT_SETTINGS, accent: '#222222' } });
  try {
    assert.match(text(t.$('accent-warning')), /^Low contrast on Cinema: 1\.\d:1, and 3:1 is needed\./);
    assert.equal(t.$('accent-warning').getAttribute('role'), 'status');
    assert.ok(t.$('accent-hex').getAttribute('aria-describedby').split(' ').includes('accent-warning'));
  } finally { t.close(); }
  const fine = await mount({ settings: { ...DEFAULT_SETTINGS, accent: '#e8b04a' } });
  try { assert.equal(fine.$('accent-warning').textContent, ''); } finally { fine.close(); }
});

test('theme cards paint their swatches from tokens.color and refuse anything that is not a plain colour', async () => {
  const evil = FAKE_THEMES.map((th) => (th.id === 'minimal'
    ? { ...th, name: '<img src=x onerror=alert(1)>', tokens: { ...th.tokens, color: { ...th.tokens.color, bg: 'url(https://evil.example/x)', accent: 'red; background: url(x)' } } }
    : th));
  const t = await mount({ themes: evil });
  try {
    const cinema = t.card('cinema').querySelector('.theme-preview').style;
    const c = FAKE_THEMES[0].tokens.color;
    assert.equal(cinema.getPropertyValue('--tp-bg'), c.bg);
    assert.equal(cinema.getPropertyValue('--tp-surface'), c.surface);
    assert.equal(cinema.getPropertyValue('--tp-text'), c.text);
    assert.equal(cinema.getPropertyValue('--tp-muted'), c.muted);
    assert.equal(cinema.getPropertyValue('--tp-accent'), c.accent);
    assert.equal(cinema.getPropertyValue('--tp-border'), c.border);

    const minimal = t.card('minimal');
    assert.equal(minimal.querySelector('.theme-preview').style.getPropertyValue('--tp-bg'), '', 'url() is not a colour');
    assert.equal(minimal.querySelector('.theme-preview').style.getPropertyValue('--tp-accent'), '');
    assert.equal(minimal.querySelector('.theme-preview').style.getPropertyValue('--tp-text'), FAKE_THEMES[1].tokens.color.text);
    assert.equal(minimal.querySelector('.theme-name').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(t.doc.querySelector('img'), null, 'a theme name is text, never markup');
    assert.equal(t.doc.querySelector('[onerror]'), null);
  } finally { t.close(); }
});

test('themes the contract does not know, or without a tier, never get a card', async () => {
  const t = await mount({ themes: [...FAKE_THEMES.slice(0, 2), { ...FAKE_THEMES[2], id: 'rogue' }, { ...FAKE_THEMES[3], tier: undefined }] });
  try {
    assert.deepEqual([...t.doc.querySelectorAll('#theme-grid [role="radio"]')].map((c) => c.dataset.themeId), ['cinema', 'minimal']);
  } finally { t.close(); }
});

test('no themes at all: says so instead of an empty box, and nothing throws', async () => {
  const t = await mount({ themes: [] });
  try {
    assert.equal(t.doc.querySelectorAll('#theme-grid [role="radio"]').length, 0);
    assert.equal(text(t.$('theme-note')), 'No themes are available.');
  } finally { t.close(); }
});

test('corrupt stored settings render the defaults', async () => {
  const t = await mount({ licence: PRO, settings: { themeId: { x: 1 }, accent: ['#fff'], density: '4', animations: 'no', calm: 'all' } });
  try {
    assert.equal(t.card('cinema').getAttribute('aria-checked'), 'true');
    assert.equal(t.$('accent-hex').value, '');
    assert.equal(t.$('animations').getAttribute('aria-checked'), 'true');
    assert.equal(t.$('density').value, '3');
    assert.equal(t.calm('hideShorts').getAttribute('aria-checked'), 'false');
  } finally { t.close(); }
});

test('animations switch shows its state in words as well as in aria-checked', async () => {
  const on = await mount({ settings: { ...DEFAULT_SETTINGS, animations: true } });
  const off = await mount({ settings: { ...DEFAULT_SETTINGS, animations: false } });
  try {
    assert.equal(on.$('animations').getAttribute('aria-checked'), 'true');
    assert.equal(on.$('animations').querySelector('.switch-state').textContent, 'On');
    assert.equal(off.$('animations').getAttribute('aria-checked'), 'false');
    assert.equal(off.$('animations').querySelector('.switch-state').textContent, 'Off');
    assert.equal(accessibleName(on.$('animations')), 'Animations');
  } finally { on.close(); off.close(); }
});

test('footer: version from the manifest, not-affiliated line, cinedrape.com opens safely in a new tab', async () => {
  const t = await mount({ version: '2.5.1' });
  try {
    assert.equal(text(t.$('version')), 'Cinedrape v2.5.1');
    assert.match(text(t.doc.querySelector('.footer')), /Not affiliated with Google/);
    const link = t.$('site-link');
    assert.equal(link.getAttribute('href'), 'https://cinedrape.com');
    assert.equal(link.getAttribute('target'), '_blank');
    assert.ok(link.getAttribute('rel').split(/\s+/).includes('noopener'));
    assert.match(accessibleName(link), /^cinedrape\.com \(opens in a new tab\)$/);
  } finally { t.close(); }
  for (const version of [undefined, '', '<b>1</b>', 'x'.repeat(80)]) {
    const odd = await mount({ version });
    try {
      // The mock replaces `undefined` with its default; the others are not version-shaped.
      assert.doesNotMatch(odd.$('version').textContent, /[<>]/);
    } finally { odd.close(); }
  }
  const noManifest = await mount();
  try {
    noManifest.chrome.runtime.getManifest = () => { throw new Error('gone'); };
    noManifest.popup.destroy();
  } finally { noManifest.close(); }
});

// ---- accessibility ----------------------------------------------------------------------------------------------------

const STATES = [
  ['free', { licence: FREE }],
  ['pro', { licence: PRO, settings: { ...DEFAULT_SETTINGS, themeId: 'studio', density: 2, accent: '#222222' } }],
  ['expired with saved Pro choices', { licence: EXPIRED, settings: { ...DEFAULT_SETTINGS, themeId: 'arcade', density: 4 } }],
  ['dev build', { licence: FREE, dev: true }],
  ['paused', { licence: PRO, status: { themeId: 'cinema', pageType: 'home', features: { 'layout-home': 'broken' } } }],
];

for (const [name, opts] of STATES) {
  test(`accessibility walk (${name}): every interactive element has an accessible name and valid references`, async () => {
    const t = await mount(opts);
    try {
      const { doc } = t;
      const els = interactiveElements(doc);
      assert.ok(els.length >= 25, `found ${els.length} controls`);
      for (const el of els) assert.ok(accessibleName(el).length > 0, `unnamed: ${el.outerHTML.slice(0, 140)}`);

      // Real elements only: no clickable divs/spans, and every <button> says it is not a submit.
      for (const el of doc.querySelectorAll('[tabindex]')) {
        assert.ok(['BUTTON', 'INPUT', 'SUMMARY', 'A'].includes(el.tagName), `tabindex on <${el.localName}>`);
      }
      for (const b of doc.querySelectorAll('button')) assert.ok(['button', 'submit'].includes(b.getAttribute('type')), 'button type set');
      assert.equal(doc.querySelectorAll('button[type="submit"]').length, 1 + (opts.dev ? 0 : 0), 'only the activate form submits');
      for (const el of doc.querySelectorAll('*')) {
        for (const attr of el.attributes) assert.ok(!/^on/i.test(attr.name), `inline handler ${attr.name} on <${el.localName}>`);
      }

      // Unique ids, and every id reference points at something.
      const ids = [...doc.querySelectorAll('[id]')].map((e) => e.id);
      assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'duplicate ids');
      for (const attr of ['aria-labelledby', 'aria-describedby']) {
        for (const el of doc.querySelectorAll(`[${attr}]`)) {
          for (const id of el.getAttribute(attr).split(/\s+/)) assert.ok(doc.getElementById(id), `${attr}="${id}" on <${el.localName}> points nowhere`);
        }
      }
      for (const label of doc.querySelectorAll('label[for]')) assert.ok(doc.getElementById(label.getAttribute('for')), 'label[for] target');

      // Groups: every fieldset has a legend; every radio sits in a radiogroup with exactly one tab stop.
      for (const fs of doc.querySelectorAll('fieldset')) assert.ok(fs.querySelector(':scope > legend'), `fieldset #${fs.id} needs a legend`);
      const groups = [...doc.querySelectorAll('[role="radiogroup"]')];
      assert.equal(groups.length, 3);
      for (const group of groups) {
        assert.ok(accessibleName(group), 'radiogroup is named');
        const radios = [...group.querySelectorAll('[role="radio"]')];
        assert.ok(radios.length >= 5);
        assert.equal(radios.filter((r) => r.tabIndex === 0).length, 1, 'one tab stop per group');
        for (const r of radios) assert.ok(['true', 'false'].includes(r.getAttribute('aria-checked')));
      }
      for (const r of doc.querySelectorAll('[role="radio"]')) assert.ok(r.closest('[role="radiogroup"]'), 'radio outside a radiogroup');
      for (const s of doc.querySelectorAll('[role="switch"]')) assert.ok(['true', 'false'].includes(s.getAttribute('aria-checked')), 'switch state');

      // Structure: one h1, then h2s; live regions exist for async results.
      assert.equal(doc.querySelectorAll('h1').length, 1);
      const levels = [...doc.querySelectorAll('h1, h2, h3')].map((h) => Number(h.tagName[1]));
      assert.equal(levels[0], 1);
      assert.ok(levels.every((l, i) => i === 0 || l - levels[i - 1] <= 1), 'no skipped heading level');
      for (const id of ['notice', 'status-text', 'accent-warning', 'activate-result']) assert.equal(t.$(id).getAttribute('role'), 'status', id);
      assert.equal(t.$('accent-error').getAttribute('role'), 'alert');
      assert.equal(doc.querySelector('main').getAttribute('aria-labelledby'), 'app-title');
      assert.equal(doc.documentElement.lang, 'en');

      // Decorative SVG is hidden from assistive tech; nothing loads from the network.
      for (const svg of doc.querySelectorAll('svg:not(.sprite)')) assert.equal(svg.getAttribute('aria-hidden'), 'true');
      assert.equal(doc.querySelectorAll('img, iframe, object, embed, video, audio, link[rel="stylesheet"][href^="http"]').length, 0);
      const scripts = [...doc.querySelectorAll('script')];
      assert.deepEqual(scripts.map((s) => s.getAttribute('src')), ['popup.js']);
    } finally { t.close(); }
  });
}

test('named controls read as people would expect', async () => {
  const t = await mount({ licence: FREE });
  try {
    assert.equal(accessibleName(t.$('density')), 'Density, from compact to roomy');
    assert.equal(accessibleName(t.$('accent-hex')), 'Custom colour');
    assert.equal(accessibleName(t.$('accent-reset')), 'Reset to theme');
    assert.equal(accessibleName(t.$('token')), 'Licence token');
    assert.equal(accessibleName(t.$('activate-btn')), 'Activate Pro');
    assert.equal(accessibleName(t.$('activate-summary')), 'Activate Pro');
    assert.equal(accessibleName(t.$('notice-dismiss')), 'Dismiss message');
    assert.equal(accessibleName(t.card('minimal')), 'Minimal');
    assert.equal(accessibleName(t.calm('hideHomeRecs')), 'Hide home recommendations');
    assert.equal(accessibleName(t.$('density-unlock')), 'Activate Pro');
    assert.equal(t.$('density').getAttribute('aria-valuetext'), '3 of 5, Balanced');
  } finally { t.close(); }
});

test('the Calm card says ads and sponsorship labels are never hidden', async () => {
  const t = await mount();
  try { assert.match(text(t.$('calm-note')), /Ads and sponsorship labels are never hidden/); } finally { t.close(); }
});

test('text size: five steps in segmented control, 100% selected by default, clicking a step writes setting', async () => {
  const t = await mount({ licence: FREE });
  try {
    const group = t.$('textscale');
    assert.equal(group.getAttribute('role'), 'radiogroup');
    assert.equal(accessibleName(group), 'Text size');
    const buttons = [...group.querySelectorAll('[role="radio"]')];
    assert.deepEqual(buttons.map((b) => b.dataset.scale), ['0.9', '1', '1.1', '1.25', '1.5']);
    assert.deepEqual(buttons.map((b) => b.textContent.trim()), ['90%', '100%', '110%', '125%', '150%']);
    assert.deepEqual(buttons.map((b) => b.getAttribute('aria-checked')), ['false', 'true', 'false', 'false', 'false']);
    assert.deepEqual(buttons.map((b) => b.tabIndex), [-1, 0, -1, -1, -1]);

    // Click 125%
    t.click(buttons[3]);
    await t.settle();
    assert.equal(buttons[3].getAttribute('aria-checked'), 'true');
    assert.equal((await t.stored()).textScale, 1.25);
  } finally { t.close(); }
});

test('rendering is read-only: opening the popup never writes to storage', async () => {
  for (const licence of [FREE, PRO, GRACE, EXPIRED]) {
    const t = await mount({ licence, settings: { ...DEFAULT_SETTINGS, themeId: 'studio', density: 4 } });
    try {
      assert.equal(t.writes(), 0);
      assert.equal(t.mock.spies['storage.local.set'].callCount, 0);
      assert.equal((await t.chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY].themeId, 'studio');
    } finally { t.close(); }
  }
});

test('theme export: clicking export theme copies active theme with current overrides to clipboard', async () => {
  const t = await mount({ licence: FREE, settings: { ...DEFAULT_SETTINGS, themeId: 'cinema', accent: '#3b82f6' } });
  try {
    let clipboardText = null;
    t.win.navigator.clipboard = {
      writeText: async (text) => { clipboardText = text; },
    };
    t.click(t.$('theme-export'));
    await t.settle();
    assert.ok(clipboardText, 'clipboard writeText called');
    const parsed = JSON.parse(clipboardText);
    assert.equal(parsed.schema, 1);
    assert.equal(parsed.id, 'cinema');
    assert.equal(parsed.tokens.color.accent, '#3b82f6');
    assert.match(t.$('notice').textContent, /Theme "Cinema" copied to clipboard/);
  } finally { t.close(); }
});

test('theme editor button: opens editor/editor.html tab on click', async () => {
  const t = await mount({ licence: FREE });
  try {
    let createdUrl = null;
    t.chrome.tabs = {
      create: async ({ url }) => { createdUrl = url; },
    };
    t.chrome.runtime.getURL = (path) => `chrome-extension://cinedrape/${path}`;
    t.click(t.$('theme-editor-btn'));
    await t.settle();
    assert.equal(createdUrl, 'chrome-extension://cinedrape/editor/editor.html');
  } finally { t.close(); }
});

test('theme import: toggles panel, validates input, imports and activates valid custom theme', async () => {
  const t = await mount({ licence: FREE });
  try {
    const panel = t.$('theme-import-panel');
    assert.equal(panel.hidden, true);

    // Toggle open
    t.click(t.$('theme-import-btn'));
    assert.equal(panel.hidden, false);

    // Empty submit fails
    t.click(t.$('theme-import-submit'));
    assert.match(t.$('theme-import-error').textContent, /Paste JSON or choose a file first/);

    // Invalid JSON fails
    t.type(t.$('theme-import-json'), '{ invalid json');
    t.click(t.$('theme-import-submit'));
    assert.match(t.$('theme-import-error').textContent, /valid JSON/);

    // Pro theme import as free user fails
    const proTheme = {
      schema: 1, id: 'custom-pro', name: 'Custom Pro', author: 'Tester', version: '1.0.0', tier: 'pro',
      tokens: {
        color: { bg: '#080810', surface: '#141420', text: '#ffffff', muted: '#a0a0b0', accent: '#3b82f6', border: '#606070' },
        type: { family: 'Inter', baseSize: 14, headingWeight: 700 },
        shape: { radius: 8, shadow: false, spacing: 3 },
      },
      layout: { home: 'grid', watch: 'cinema', density: 3 },
      calm: {}, css: '',
    };
    t.type(t.$('theme-import-json'), JSON.stringify(proTheme));
    t.click(t.$('theme-import-submit'));
    await t.settle();
    assert.match(t.$('theme-import-error').textContent, /Theme requires Pro/);

    // Valid free theme succeeds
    const freeTheme = {
      schema: 1, id: 'custom-free', name: 'Custom Free', author: 'Tester', version: '1.0.0', tier: 'free',
      tokens: {
        color: { bg: '#080810', surface: '#141420', text: '#ffffff', muted: '#a0a0b0', accent: '#3b82f6', border: '#606070' },
        type: { family: 'Inter', baseSize: 14, headingWeight: 700 },
        shape: { radius: 8, shadow: false, spacing: 3 },
      },
      layout: { home: 'grid', watch: 'cinema', density: 3 },
      calm: {}, css: '',
    };
    t.type(t.$('theme-import-json'), JSON.stringify(freeTheme));
    t.click(t.$('theme-import-submit'));
    await t.settle();

    // Check panel closed and notice shown
    assert.equal(panel.hidden, true);
    assert.match(t.$('notice').textContent, /Imported and activated theme "Custom Free"/);

    // Stored settings has themeId custom-free
    const storedSettings = await t.stored();
    assert.equal(storedSettings.themeId, 'custom-free');

    // Stored custom themes has custom-free
    const rawCustom = (await t.chrome.storage.local.get(STORAGE_KEYS.customThemes))[STORAGE_KEYS.customThemes];
    const storedCustom = rawCustom?.items || rawCustom || {};
    assert.ok(storedCustom['custom-free']);

    // Theme grid now includes custom-free and it is selected
    const customCard = t.card('custom-free');
    assert.ok(customCard, 'custom card rendered');
    assert.equal(customCard.getAttribute('aria-checked'), 'true');
    assert.ok(customCard.querySelector('.tag-custom'), 'custom tag present');

    // Close button works
    t.click(t.$('theme-import-btn'));
    assert.equal(panel.hidden, false);
    t.click(t.$('theme-import-close'));
    assert.equal(panel.hidden, true);
  } finally { t.close(); }
});

test('custom theme deletion: deletes custom theme from storage and falls back to cinema', async () => {
  const customTheme = {
    schema: 1, id: 'to-delete', name: 'To Delete', author: 'Tester', version: '1.0.0', tier: 'free',
    tokens: {
      color: { bg: '#080810', surface: '#141420', text: '#ffffff', muted: '#a0a0b0', accent: '#3b82f6', border: '#606070' },
      type: { family: 'Inter', baseSize: 14, headingWeight: 700 },
      shape: { radius: 8, shadow: false, spacing: 3 },
    },
    layout: { home: 'grid', watch: 'cinema', density: 3 },
    calm: {}, css: '',
  };
  const t = await mount({
    licence: FREE,
    settings: { ...DEFAULT_SETTINGS, themeId: 'to-delete' },
    prepare: async (testEnv) => {
      await testEnv.chrome.storage.local.set({ [STORAGE_KEYS.customThemes]: { 'to-delete': customTheme } });
    },
  });
  try {
    const card = t.card('to-delete');
    assert.ok(card, 'to-delete card exists');
    assert.equal(card.getAttribute('aria-checked'), 'true');

    const delBtn = card.querySelector('[data-delete-theme="to-delete"]');
    assert.ok(delBtn, 'delete button exists');

    t.click(delBtn);
    await t.settle();

    // Verify card is removed from theme-grid
    assert.equal(t.card('to-delete'), null);

    // Verify theme fell back to cinema
    const storedSettings = await t.stored();
    assert.equal(storedSettings.themeId, 'cinema');
    assert.equal(t.card('cinema').getAttribute('aria-checked'), 'true');

    // Verify storage has no custom theme
    const rawStoredCustom = (await t.chrome.storage.local.get(STORAGE_KEYS.customThemes))[STORAGE_KEYS.customThemes];
    const storedCustom = rawStoredCustom?.items || rawStoredCustom || {};
    assert.equal(storedCustom['to-delete'], undefined);
  } finally { t.close(); }
});

// ---- profiles & schedule (S13 / F8) ------------------------------------------------------------------------

test('profiles & schedule: Free user clicking Manage button shows Pro notice', async () => {
  const t = await mount({ licence: FREE });
  try {
    const manageBtn = t.$('profile-manage-btn');
    assert.ok(manageBtn);
    assert.equal(t.$('profile-schedule-panel').hidden, true);

    t.click(manageBtn);
    assert.equal(t.$('profile-schedule-panel').hidden, true);
    assert.match(text(t.$('notice')), /Profiles are a Pro feature/);
  } finally { t.close(); }
});

test('profiles: Pro user can save, apply, and delete profiles', async () => {
  const t = await mount({
    licence: PRO,
    settings: { ...DEFAULT_SETTINGS, themeId: 'minimal', density: 4 },
  });
  try {
    const manageBtn = t.$('profile-manage-btn');
    t.click(manageBtn);
    const panel = t.$('profile-schedule-panel');
    assert.equal(panel.hidden, false);

    // Save a new profile named "Reading Mode"
    t.$('profile-name-input').value = 'Reading Mode';
    t.click(t.$('profile-save-btn'));
    await t.settle();

    // Verify profile is listed in UI
    const list = t.$('profile-list');
    const items = list.querySelectorAll('.profile-item');
    assert.equal(items.length, 1);
    assert.match(text(items[0]), /Reading Mode/);

    // Verify profile is stored in chrome storage
    const rawStored = (await t.chrome.storage.local.get(STORAGE_KEYS.profiles))[STORAGE_KEYS.profiles];
    const stored = Array.isArray(rawStored) ? rawStored : rawStored?.items;
    assert.equal(Array.isArray(stored), true);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].name, 'Reading Mode');
    assert.equal(stored[0].settings.themeId, 'minimal');
    assert.equal(stored[0].settings.density, 4);

    // Change settings to classic
    await t.chrome.storage.local.set({ [STORAGE_KEYS.settings]: { ...DEFAULT_SETTINGS, themeId: 'classic', density: 1 } });
    await t.settle();
    assert.equal(t.card('classic').getAttribute('aria-checked'), 'true');

    // Click Apply on "Reading Mode"
    const applyBtn = t.$('profile-list').querySelector('[data-apply-profile]');
    assert.ok(applyBtn, 'apply button exists in live list');
    t.click(applyBtn);
    await t.settle();

    // Verify settings restored to minimal
    const appliedSettings = await t.stored();
    assert.equal(appliedSettings.themeId, 'minimal');
    assert.equal(appliedSettings.density, 4);

    // Delete profile
    const delBtn = t.$('profile-list').querySelector('[data-delete-profile]');
    assert.ok(delBtn, 'delete button exists in live list');
    t.click(delBtn);
    await t.settle();

    const rawStoredAfterDel = (await t.chrome.storage.local.get(STORAGE_KEYS.profiles))[STORAGE_KEYS.profiles];
    const storedAfterDel = Array.isArray(rawStoredAfterDel) ? rawStoredAfterDel : rawStoredAfterDel?.items;
    assert.equal(storedAfterDel.length, 0);
    assert.match(text(t.$('profile-list')), /No saved profiles yet/);
  } finally { t.close(); }
});

test('schedule: Pro user can toggle schedule and configure day/night times and profiles', async () => {
  const profileA = { id: 'prof-day', name: 'Day Look', settings: { themeId: 'minimal' } };
  const profileB = { id: 'prof-night', name: 'Night Look', settings: { themeId: 'cinema' } };
  const t = await mount({
    licence: PRO,
    prepare: async (testEnv) => {
      await testEnv.chrome.storage.local.set({
        [STORAGE_KEYS.profiles]: [profileA, profileB],
      });
    },
  });
  try {
    t.click(t.$('profile-manage-btn'));
    assert.equal(t.$('profile-schedule-panel').hidden, false);

    // Toggle schedule ON
    t.click(t.$('schedule-toggle-btn'));
    await t.settle();

    let sched = (await t.chrome.storage.local.get(STORAGE_KEYS.schedule))[STORAGE_KEYS.schedule];
    assert.equal(sched.enabled, true);
    assert.equal(text(t.$('schedule-toggle-btn')), 'Schedule: On');

    // Change day time & profile
    t.$('schedule-day-time').value = '07:30';
    t.$('schedule-day-profile').value = 'prof-day';
    t.fire(t.$('schedule-day-time'), 'change');
    t.fire(t.$('schedule-day-profile'), 'change');
    await t.settle();

    sched = (await t.chrome.storage.local.get(STORAGE_KEYS.schedule))[STORAGE_KEYS.schedule];
    assert.equal(sched.dayTime, '07:30');
    assert.equal(sched.dayProfileId, 'prof-day');

    // Toggle schedule OFF
    t.click(t.$('schedule-toggle-btn'));
    await t.settle();

    sched = (await t.chrome.storage.local.get(STORAGE_KEYS.schedule))[STORAGE_KEYS.schedule];
    assert.equal(sched.enabled, false);
    assert.equal(text(t.$('schedule-toggle-btn')), 'Schedule: Off');
  } finally { t.close(); }
});


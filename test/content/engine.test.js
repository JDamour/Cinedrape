// The content engine end to end on jsdom pages: real signed map, real themes, real builders, the chrome mock.
// Never shares a Document between tests (every test builds its own page through createEnv).
import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, makeKeyPair, proLicence, signedMap, sleep, waitFor, MAP, THEMES } from '../helpers/engine-env.js';
import { createTile, navigateTo, tileId } from '../helpers/dom.js';
import { createHealth } from '../../src/content/health.js';
import { composeStylesheet } from '../../src/content/stylesheet.js';
import { FEATURES, FIRST_PAINT_LS_KEY, MSG, STORAGE_KEYS } from '../../src/shared/constants.js';
import { UNREADABLE_TTL_MS, normalizeVerdict } from '../../src/content/engine.js';

const HOME = { tiles: 12, tileStyle: 'home' };
const cdAttrs = (env) => env.html.getAttributeNames().filter((n) => n.startsWith('cd-'));
const noticeCount = (env) => env.document.querySelectorAll('.cd-notice').length;
const mounted = (env) => !!env.document.querySelector('.cd-home');
const theme = (id) => THEMES.find((t) => t.id === id);

/** Runs `fn(env)` and always closes the page, whatever happens. */
async function withEnv(kind, opts, fn) {
  const env = await createEnv(kind, opts);
  try { return await fn(env); } finally { env.close(); }
}

/** A createHealth wrapper that records watch() and record() calls. */
function spyHealth() {
  const watches = [];
  const records = [];
  const factory = (options) => {
    const health = createHealth(options);
    return {
      ...health,
      watch: (...args) => { watches.push(args); return health.watch(...args); },
      record: (...args) => { records.push(args); return health.record(...args); },
    };
  };
  return { factory, watches, records };
}

describe('boot and apply', () => {
  test('defaults: attributes, one <style> with rules, cinema theme, status', async () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      await withEnv('home', { page: HOME }, async (env) => {
        await env.engine.start();
        assert.equal(env.attr('cd-theme'), 'cinema');
        assert.equal(env.attr('cd-page'), 'home');
        assert.equal(env.attr('cd-home'), theme('cinema').layout.home);
        assert.equal(env.attr('cd-watch'), theme('cinema').layout.watch);
        assert.equal(env.attr('cd-density'), String(theme('cinema').layout.density));
        assert.equal(env.attr('cd-motion'), 'on');
        assert.equal(env.document.querySelectorAll('style#cinedrape-theme').length, 1);
        assert.ok(env.style().sheet.cssRules.length > 50, 'real rules, not just text');
        assert.ok(env.style().textContent.includes('--cd-accent'));

        const status = env.engine.getStatus();
        assert.deepEqual(Object.keys(status.features), FEATURES);
        assert.equal(status.themeId, 'cinema');
        assert.equal(status.pageType, 'home');
        assert.equal(status.pro, false);
        assert.equal(status.mapVersion, MAP.mapVersion);
        assert.deepEqual(status.missingRoles, []);
        assert.equal(status.features.theme, 'on');
        assert.equal(status.features['layout-home'], 'on');
        assert.equal(status.features['layout-watch'], 'on');
        assert.equal(status.features.density, 'locked');
        assert.equal(status.features['calm-hideShorts'], 'off');
        assert.equal(status.features['calm-hideComments'], 'locked');
        assert.equal(warn.mock.callCount(), 0);
        await waitFor(() => mounted(env), 'home layout mounted');
      });
    } finally { warn.mock.restore(); }
  });

  test('a theme switch by storage change completes in under 150 ms with the real map', async () => {
    await withEnv('home', { page: HOME, stored: { settings: { themeId: 'cinema' } } }, async (env) => {
      await env.engine.start();
      // Fastest of several switches: a real regression slows all of them, CPU contention from parallel test files only some.
      const samples = [];
      for (const id of ['minimal', 'cinema', 'minimal', 'cinema', 'minimal', 'cinema', 'minimal']) {
        const t0 = performance.now();
        await env.set('settings', { themeId: id });
        await waitFor(() => env.attr('cd-theme') === id, id + ' applied');
        samples.push(performance.now() - t0);
      }
      const ms = Math.min(...samples);
      assert.ok(ms < 150, `theme switch took ${ms.toFixed(1)} ms (samples ${samples.map((x) => x.toFixed(0)).join(', ')})`);
      assert.ok(env.style().textContent.includes(theme('minimal').tokens.color.bg), 'new tokens are in the stylesheet');
      assert.equal(env.attr('cd-home'), 'grid');
      await waitFor(() => !mounted(env), 'rows layout removed for a grid theme');
    });
  });

  test('settings written in a burst apply once per frame, the last one wins', async () => {
    let composes = 0;
    const compose = (input) => { composes += 1; return composeStylesheet(input); };
    await withEnv('home', { page: HOME, engine: { compose } }, async (env) => {
      await env.engine.start();
      const before = composes;
      for (const themeId of ['classic', 'minimal', 'cinema', 'classic']) await env.set('settings', { themeId });
      await waitFor(() => env.attr('cd-theme') === 'classic', 'last write applied');
      await sleep(40);
      assert.ok(composes - before <= 2, `composed ${composes - before} times for 4 writes`);
    });
  });

  test('prefers-reduced-motion forces animations off, live', async () => {
    await withEnv('home', { page: { ...HOME, reducedMotion: true }, stored: { settings: { animations: true } } }, async (env) => {
      await env.engine.start();
      assert.equal(env.attr('cd-motion'), 'off');
      assert.ok(env.style().textContent.includes('--cd-duration:0ms'));
      env.window.__cd.setReducedMotion(false);
      await waitFor(() => env.attr('cd-motion') === 'on', 'motion back on');
      assert.ok(env.style().textContent.includes('--cd-duration:160ms'));
      env.window.__cd.setReducedMotion(true);
      await waitFor(() => env.attr('cd-motion') === 'off', 'motion off again');
    });
  });

  test('junk stored settings and licence are tolerated: defaults, no warning', async () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      const junkSettings = ['banana', 42, null, [], true, { themeId: 42, density: 99, accent: {}, calm: 'x', animations: 'yes' },
        { themeId: 'does-not-exist', density: 2.5, calm: { hideShorts: 'yes' } }, JSON.parse('{"__proto__":{"themeId":"studio"}}')];
      for (const settings of junkSettings) {
        await withEnv('home', { page: HOME, stored: { settings } }, async (env) => {
          await env.engine.start();
          assert.equal(env.attr('cd-theme'), 'cinema', JSON.stringify(settings));
          assert.equal(env.engine.getStatus().pro, false);
          assert.equal(env.attr('cd-motion'), 'on');
        });
      }
      for (const licence of ['x', 5, [], { token: 5 }, { token: 'a.b', claims: 'junk', checkedAt: 'now' }, { claims: { plan: 'pro' } }]) {
        await withEnv('home', { page: HOME, stored: { settings: { themeId: 'studio' }, licence } }, async (env) => {
          await env.engine.start();
          assert.equal(env.attr('cd-theme'), 'cinema', JSON.stringify(licence));
          assert.equal(env.engine.getStatus().pro, false);
        });
      }
      assert.equal(warn.mock.callCount(), 0);
    } finally { warn.mock.restore(); }
  });
});

describe('tiers', () => {
  test('a free user with a Pro theme stored gets cinema (status says so); a verified Pro licence unlocks it; removing it falls back', async () => {
    const keys = await makeKeyPair('licence-1');
    const licence = await proLicence(keys.privateJwk);
    await withEnv('home', { page: HOME, stored: { settings: { themeId: 'primetime' } }, engine: { publicKeys: { licence: keys.publicJwk } } }, async (env) => {
      await env.engine.start();
      assert.equal(env.attr('cd-theme'), 'cinema');
      let status = env.engine.getStatus();
      assert.equal(status.themeId, 'cinema');
      assert.equal(status.pro, false);
      const stored = (await env.chrome.storage.local.get(STORAGE_KEYS.settings))[STORAGE_KEYS.settings];
      assert.equal(stored.themeId, 'primetime', 'the stored choice is never rewritten');

      await env.set('licence', licence);
      await waitFor(() => env.attr('cd-theme') === 'primetime', 'pro theme applied');
      status = env.engine.getStatus();
      assert.equal(status.themeId, 'primetime');
      assert.equal(status.pro, true);
      assert.equal(status.features.density, 'off', 'unlocked but not set');
      assert.ok(env.style().textContent.includes(theme('primetime').tokens.color.bg));

      await env.set('licence', null);
      await waitFor(() => env.attr('cd-theme') === 'cinema', 'back to cinema');
    });
  });

  test('a Pro licence in storage at boot unlocks the theme; a token that does not verify is downgraded', async () => {
    const keys = await makeKeyPair('licence-1');
    const other = await makeKeyPair('licence-1');
    const settings = { themeId: 'studio' };
    await withEnv('home', { page: HOME, stored: { settings, licence: await proLicence(keys.privateJwk) }, engine: { publicKeys: { licence: keys.publicJwk } } }, async (env) => {
      await env.engine.start();
      assert.equal(env.attr('cd-theme'), 'studio');
      await sleep(60);
      assert.equal(env.attr('cd-theme'), 'studio', 'a valid token stays Pro after the background verification');
    });
    await withEnv('home', { page: HOME, stored: { settings, licence: await proLicence(other.privateJwk) }, engine: { publicKeys: { licence: keys.publicJwk } } }, async (env) => {
      await env.engine.start();
      await waitFor(() => env.attr('cd-theme') === 'cinema', 'forged licence downgraded');
      assert.equal(env.engine.getStatus().pro, false);
    });
  });

  test('the plan comes from the SIGNED token: a free token with hand-edited claims.plan = pro is lapsed, and so are edited sub/exp', async () => {
    const keys = await makeKeyPair('licence-1');
    const settings = { themeId: 'studio' };
    const free = await proLicence(keys.privateJwk, { plan: 'free' });
    const edits = {
      'plan free -> pro': { ...free, claims: { ...free.claims, plan: 'pro' } },
      'exp pushed out': { ...(await proLicence(keys.privateJwk)), claims: { ...(await proLicence(keys.privateJwk)).claims, exp: 4e9 } },
    };
    for (const [name, licence] of Object.entries(edits)) {
      await withEnv('home', { page: HOME, stored: { settings, licence }, engine: { publicKeys: { licence: keys.publicJwk } } }, async (env) => {
        await env.engine.start();
        await waitFor(() => env.attr('cd-theme') === 'cinema', `${name}: lapsed after the signature check`);
        const status = env.engine.getStatus();
        assert.equal(status.pro, false, name);
        assert.equal(status.features['calm-hideComments'], 'locked', name);
      });
    }
  });

  test('a token whose signed exp passes while the page is open ends Pro at that moment (the signed exp is what counts)', async () => {
    const keys = await makeKeyPair('licence-1');
    const clock = { t: Date.now() };
    const licence = await proLicence(keys.privateJwk, { now: clock.t, days: 1 });
    await withEnv('home', { page: HOME, stored: { settings: { themeId: 'studio' }, licence }, engine: { now: () => clock.t, publicKeys: { licence: keys.publicJwk } } }, async (env) => {
      await env.engine.start();
      await sleep(40);
      assert.equal(env.attr('cd-theme'), 'studio');
      assert.equal(env.engine.getStatus().pro, true);
      clock.t += 2 * 86400000;
      await env.engine.recompute();
      assert.equal(env.attr('cd-theme'), 'cinema');
      assert.equal(env.engine.getStatus().pro, false);
    });
  });

  test('density and calm are gated: free keeps the theme density and only the free calm toggles; Pro gets all', async () => {
    const settings = { themeId: 'cinema', density: 5, calm: { hideShorts: true, hideComments: true, hideViewCounts: true } };
    await withEnv('home', { page: HOME, stored: { settings } }, async (env) => {
      await env.engine.start();
      assert.equal(env.attr('cd-density'), String(theme('cinema').layout.density));
      assert.equal(env.html.hasAttribute('cd-calm-hideShorts'), true);
      assert.equal(env.html.hasAttribute('cd-calm-hideComments'), false);
      assert.equal(env.html.hasAttribute('cd-calm-hideViewCounts'), false);
      const f = env.engine.getStatus().features;
      assert.equal(f.density, 'locked');
      assert.equal(f['calm-hideShorts'], 'on');
      assert.equal(f['calm-hideComments'], 'locked');
    });
    const keys = await makeKeyPair('licence-1');
    await withEnv('home', { page: HOME, stored: { settings, licence: await proLicence(keys.privateJwk) }, engine: { publicKeys: { licence: keys.publicJwk } } }, async (env) => {
      await env.engine.start();
      assert.equal(env.attr('cd-density'), '5');
      assert.equal(env.html.hasAttribute('cd-calm-hideComments'), true);
      assert.equal(env.html.hasAttribute('cd-calm-hideViewCounts'), true);
      const f = env.engine.getStatus().features;
      assert.equal(f.density, 'on');
      assert.equal(f['calm-hideComments'], 'on');
      assert.equal(f['calm-hideEndScreens'], 'off');
    });
  });

  test("a theme's own calm default applies until the user decides (Minimal hides Shorts)", async () => {
    await withEnv('home', { page: HOME, stored: { settings: { themeId: 'minimal' } } }, async (env) => {
      await env.engine.start();
      assert.equal(env.html.hasAttribute('cd-calm-hideShorts'), true);
      await env.set('settings', { themeId: 'minimal', calm: { hideShorts: false } });
      await waitFor(() => !env.html.hasAttribute('cd-calm-hideShorts'), 'user choice wins');
    });
  });
});

describe('navigation', () => {
  test('the several signals of one navigation are one pass (one compose), and cd-page, layout and status follow', async () => {
    let composes = 0;
    const compose = (input) => { composes += 1; return composeStylesheet(input); };
    const health = spyHealth();
    await withEnv('home', { page: HOME, engine: { compose, createHealth: health.factory } }, async (env) => {
      await env.engine.start();
      await waitFor(() => mounted(env), 'home layout mounted');
      const composesBefore = composes;
      const watchesBefore = health.watches.length;

      navigateTo(env.page, 'watch', { tiles: 8 });
      await waitFor(() => env.attr('cd-page') === 'watch', 'cd-page follows');
      await sleep(60);
      assert.equal(composes - composesBefore, 1, 'three events + the page-manager mutation = one pass');
      assert.equal(health.watches.length - watchesBefore, 1, 'one health watch for the new page');
      assert.deepEqual(health.watches.at(-1)[0], 'watch');
      assert.ok(health.watches.at(-1)[1].includes('theme') && health.watches.at(-1)[1].includes('layout-watch'));
      assert.equal(mounted(env), false, 'the home layout is gone off the home page');
      assert.equal(env.engine.getStatus().pageType, 'watch');

      const burstStart = composes;
      for (let i = 0; i < 25; i++) env.document.dispatchEvent(new env.window.CustomEvent('yt-navigate-finish', { bubbles: true }));
      env.window.dispatchEvent(new env.window.PopStateEvent('popstate'));
      await sleep(60);
      assert.equal(composes - burstStart, 1, '26 signals in one tick = one pass');
    });
  });

  test('back on home the layout mounts again, and tiles that arrive late are picked up', async () => {
    await withEnv('home', { page: { tiles: 0, tileStyle: 'home' } }, async (env) => {
      await env.engine.start();
      await sleep(40);
      assert.equal(mounted(env), false, 'no tiles yet: nothing to mount, nothing broken');
      assert.equal(env.engine.getStatus().features['layout-home'], 'on');
      const contents = env.document.querySelector('ytd-rich-grid-renderer > [id="contents"]');
      assert.ok(contents);
      for (let i = 0; i < 6; i++) contents.insertAdjacentHTML('beforeend', createTile({ id: tileId(i), channel: 'Some channel', title: `Video ${i}` }));
      await waitFor(() => mounted(env), 'layout mounts once tiles exist');
      assert.ok(env.document.querySelectorAll('.cd-hero, .cd-card').length >= 6);
    });
  });

  test('on watch page, cd-watch-live is set for live streams and removed for VODs', async () => {
    await withEnv('watch', { page: { tiles: 4 } }, async (env) => {
      await env.engine.start();
      assert.equal(env.attr('cd-page'), 'watch');
      // Fixture is VOD (84k views) -> cd-watch-live is absent
      assert.equal(env.attr('cd-watch-live'), null);

      // Now update the view count text to live stream text
      const viewSpan = env.document.querySelector('ytd-watch-info-text #info-container #info > span:first-child');
      assert.ok(viewSpan);
      viewSpan.textContent = '1,250 watching now';

      // Trigger navigation / data event to re-evaluate
      env.document.dispatchEvent(new env.window.CustomEvent('yt-page-data-updated', { bubbles: true }));
      await waitFor(() => env.attr('cd-watch-live') !== null, 'cd-watch-live set');

      // Now change back to VOD
      viewSpan.textContent = '150k views';
      env.document.dispatchEvent(new env.window.CustomEvent('yt-page-data-updated', { bubbles: true }));
      await waitFor(() => env.attr('cd-watch-live') === null, 'cd-watch-live cleared');

      // Now set live again
      viewSpan.textContent = '2,000 watching';
      env.document.dispatchEvent(new env.window.CustomEvent('yt-page-data-updated', { bubbles: true }));
      await waitFor(() => env.attr('cd-watch-live') !== null, 'cd-watch-live set again');

      // Navigate away to home -> cd-watch-live must be removed
      navigateTo(env.page, 'home', { tiles: 8, tileStyle: 'home' });
      await waitFor(() => env.attr('cd-page') === 'home', 'navigated to home');
      assert.equal(env.attr('cd-watch-live'), null);
    });
  });
});

describe('health', () => {
  const RENAMED = { ...HOME, rename: ['[page-subtype]'] };   // the home shell YouTube renamed: homeBrowse is gone

  test('a broken home shell: layout-home reported broken, layout off, CSS minus that part, exactly one notice; a healthy page heals it', async () => {
    const health = spyHealth();
    await withEnv('home', { page: RENAMED, engine: { createHealth: health.factory } }, async (env) => {
      assert.ok(env.page.renamed > 0);
      await env.engine.start();
      await waitFor(() => env.html.hasAttribute('cd-off-layout-home'), 'layout-home disabled');
      assert.deepEqual(health.watches[0].slice(0, 2).map((x, i) => (i === 0 ? x : x.includes('layout-home'))), ['home', true]);
      const status = env.engine.getStatus();
      assert.equal(status.features['layout-home'], 'broken');
      assert.deepEqual(status.missingRoles, ['homeBrowse', 'homeGrid', 'homeGridContents']);
      assert.equal(mounted(env), false);
      assert.equal(env.document.querySelectorAll('[cd-source]').length, 0);
      assert.ok(!env.style().textContent.includes('.cd-row-track'), 'the layout rules are out of the stylesheet');
      assert.ok(env.style().textContent.includes('--cd-bg'), 'the theme is still applied');
      assert.equal(env.attr('cd-theme'), 'cinema');
      assert.equal(noticeCount(env), 1);
      assert.match(env.document.querySelector('.cd-notice').textContent, /Cinedrape turned off/);

      navigateTo(env.page, 'home', { ...RENAMED });   // still broken after the next navigation: no second notice
      await sleep(60);
      assert.equal(noticeCount(env), 1);
      assert.equal(env.engine.getStatus().features['layout-home'], 'broken');

      navigateTo(env.page, 'home', HOME);             // YouTube is healthy again
      await waitFor(() => !env.html.hasAttribute('cd-off-layout-home'), 'feature re-enabled');
      await waitFor(() => mounted(env), 'layout back');
      assert.equal(env.engine.getStatus().features['layout-home'], 'on');
      assert.ok(env.style().textContent.includes('.cd-row-track'));
      assert.equal(noticeCount(env), 0, 'the "turned off" notice goes away once the feature works again');
    });
  });

  test('a notice naming two features loses the one that healed and goes when the last one heals', async () => {
    const keys = await makeKeyPair('selector-map-1');
    const licKeys = await makeKeyPair('licence-1');
    const record = await proLicence(licKeys.privateJwk);
    const broken = await signedMap(keys.privateJwk, '2026.10.20.1', (m) => { m.roles.comments = ['cd-nope-comments']; m.roles.viewCounts = ['cd-nope-views']; return m; });
    const half = await signedMap(keys.privateJwk, '2026.10.20.2', (m) => { m.roles.comments = ['cd-nope-comments']; return m; });
    const good = await signedMap(keys.privateJwk, '2026.10.20.3');
    const calm = { hideComments: true, hideViewCounts: true };
    const opts = { page: { tiles: 3 }, stored: { settings: { themeId: 'cinema', calm }, licence: record, selectorMap: broken }, engine: { publicKeys: { selectorMap: keys.publicJwk, licence: licKeys.publicJwk } } };
    await withEnv('watch', opts, async (env) => {
      await env.engine.start();
      await waitFor(() => env.html.hasAttribute('cd-off-calm-hidecomments') && env.html.hasAttribute('cd-off-calm-hideviewcounts'), 'both calm features disabled');
      assert.equal(noticeCount(env), 1);
      assert.match(env.document.querySelector('.cd-notice-text').textContent, /Hide comments and Hide view counts/);

      await env.set('selectorMap', half);
      await waitFor(() => !env.html.hasAttribute('cd-off-calm-hideviewcounts'), 'view counts back');
      assert.equal(noticeCount(env), 1);
      const text = env.document.querySelector('.cd-notice-text').textContent;
      assert.match(text, /turned off Hide comments because/);
      assert.doesNotMatch(text, /view counts/i);

      await env.set('selectorMap', good);
      await waitFor(() => !env.html.hasAttribute('cd-off-calm-hidecomments'), 'comments back');
      assert.equal(noticeCount(env), 0);
      assert.equal(env.engine.getStatus().features['calm-hideComments'], 'on');
    });
  });

  test("a layout that fails to mount reports through health.record('layout-home') and is switched off", async () => {
    const health = spyHealth();
    await withEnv('home', { page: HOME, engine: { createHealth: health.factory } }, async (env) => {
      const proto = env.window.Node.prototype;
      const original = proto.insertBefore;
      let armed = true;
      proto.insertBefore = function insertBefore(node, ref) {
        if (armed && node && node.classList && node.classList.contains('cd-home')) { armed = false; throw new Error('YouTube said no'); }
        return original.call(this, node, ref);
      };
      await env.engine.start();
      await waitFor(() => env.html.hasAttribute('cd-off-layout-home'), 'layout-home disabled');
      assert.equal(health.records.length, 1);
      assert.equal(health.records[0][0], 'layout-home');
      assert.ok(Array.isArray(health.records[0][1]));
      assert.equal(mounted(env), false);
      assert.equal(env.document.querySelectorAll('[cd-source]').length, 0, 'rolled back');
      assert.equal(env.engine.getStatus().features['layout-home'], 'broken');
      assert.ok(!env.style().textContent.includes('.cd-row-track'));
      assert.equal(noticeCount(env), 1);
    });
  });

  test('with a real settle time nothing is judged until the window closes, then the broken feature is reported', async () => {
    await withEnv('home', { page: RENAMED, engine: { healthTimeoutMs: 60 } }, async (env) => {
      await env.engine.start();
      assert.equal(env.html.hasAttribute('cd-off-layout-home'), false);
      assert.equal(noticeCount(env), 0);
      await waitFor(() => env.html.hasAttribute('cd-off-layout-home'), 'judged after the settle window', 800);
      assert.equal(noticeCount(env), 1);
    });
  });

  test('a calm toggle whose role vanished is switched off on its own, the others stay', async () => {
    const keys = await makeKeyPair('licence-1');
    await withEnv('watch', {
      page: { tiles: 8, rename: ['ytd-comments', '#comments', '#comment-teaser'] },
      stored: { settings: { calm: { hideShorts: true, hideComments: true } }, licence: await proLicence(keys.privateJwk) },
      engine: { publicKeys: { licence: keys.publicJwk } },
    }, async (env) => {
      await env.engine.start();
      await waitFor(() => env.html.hasAttribute('cd-off-calm-hideComments'), 'hideComments disabled');
      assert.equal(env.html.hasAttribute('cd-calm-hideComments'), false);
      assert.equal(env.html.hasAttribute('cd-calm-hideShorts'), true);
      const f = env.engine.getStatus().features;
      assert.equal(f['calm-hideComments'], 'broken');
      assert.equal(f['calm-hideShorts'], 'on');
      assert.equal(f.theme, 'on');
      assert.equal(noticeCount(env), 1);
    });
  });
});

describe('messages', () => {
  test('GET_STATUS is answered, even when asked before the first pass has finished', async () => {
    await withEnv('home', { page: HOME, stored: { settings: { themeId: 'minimal' } } }, async (env) => {
      const started = env.engine.start();
      const reply = await env.chrome.runtime.sendMessage({ type: MSG.GET_STATUS });
      assert.equal(reply.themeId, 'minimal');
      assert.equal(reply.pageType, 'home');
      assert.deepEqual(Object.keys(reply.features), FEATURES);
      assert.equal(reply.mapVersion, MAP.mapVersion);
      await started;
    });
  });

  test('other messages are left alone', async () => {
    await withEnv('home', { page: HOME }, async (env) => {
      await env.engine.start();
      await assert.rejects(env.chrome.runtime.sendMessage({ type: 'something-else' }), /message port closed/);
    });
  });
});

describe('stop()', () => {
  test('restores the document byte for byte, detaches every listener, clears the first-paint cache', async () => {
    await withEnv('home', { page: HOME, stored: { settings: { calm: { hideShorts: true } } } }, async (env) => {
      const before = env.html.outerHTML;
      await env.engine.start();
      await waitFor(() => mounted(env), 'layout mounted');
      assert.notEqual(env.html.outerHTML, before);
      assert.notEqual(env.window.localStorage.getItem(FIRST_PAINT_LS_KEY), null);

      env.engine.stop();
      assert.equal(env.html.outerHTML, before);
      assert.deepEqual(cdAttrs(env), []);
      assert.equal(env.window.localStorage.getItem(FIRST_PAINT_LS_KEY), null);
      assert.equal(env.chrome.storage.onChanged.hasListeners(), false);
      assert.equal(env.chrome.runtime.onMessage.hasListeners(), false);

      await env.set('settings', { themeId: 'minimal' });
      navigateTo(env.page, 'watch');
      await sleep(50);
      assert.equal(env.style(), null);
      assert.equal(env.attr('cd-theme'), null);
      env.engine.stop();   // idempotent
    });
  });

  test('also removes a shown notice and a half-built state (broken page)', async () => {
    await withEnv('home', { page: { ...HOME, rename: ['[page-subtype]'] } }, async (env) => {
      const before = env.html.outerHTML;
      await env.engine.start();
      await waitFor(() => noticeCount(env) === 1, 'notice shown');
      env.engine.stop();
      assert.equal(env.html.outerHTML, before);
    });
  });

  test('a stopped engine can be started again', async () => {
    await withEnv('home', { page: HOME }, async (env) => {
      await env.engine.start();
      env.engine.stop();
      assert.equal(env.style(), null);
      await env.engine.start();
      assert.equal(env.attr('cd-theme'), 'cinema');
      assert.ok(env.style());
    });
  });
});

describe('fail-open', () => {
  test('a compose that throws on the first pass leaves YouTube alone, warns once, never throws', async () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      await withEnv('home', { page: HOME, engine: { compose: () => { throw new Error('boom'); } } }, async (env) => {
        const before = env.html.outerHTML;
        await env.engine.start();
        assert.equal(env.html.outerHTML, before);
        assert.equal(warn.mock.callCount(), 1);
        assert.match(String(warn.mock.calls[0].arguments.join(' ')), /boom/);
        await env.set('settings', { themeId: 'minimal' });
        navigateTo(env.page, 'watch');
        await sleep(40);
        assert.equal(warn.mock.callCount(), 1, 'one warning, however many events follow');
        const status = env.engine.getStatus();
        assert.equal(status.themeId, null);
        assert.ok(FEATURES.every((id) => status.features[id] === 'off'));
      });
    } finally { warn.mock.restore(); }
  });

  test('a failure after a good pass removes everything that pass added, including a first-paint cache', async () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      let calls = 0;
      const compose = (input) => { calls += 1; if (calls >= 2) throw new Error('second pass'); return composeStylesheet(input); };
      await withEnv('home', { page: HOME, engine: { compose } }, async (env) => {
        const before = env.html.outerHTML;
        await env.engine.start();
        await waitFor(() => mounted(env), 'mounted');
        await env.set('settings', { themeId: 'minimal' });
        await waitFor(() => env.style() === null, 'fail-open');
        assert.equal(env.html.outerHTML, before);
        assert.equal(env.window.localStorage.getItem(FIRST_PAINT_LS_KEY), null);
        assert.equal(warn.mock.callCount(), 1);
      });
    } finally { warn.mock.restore(); }
  });

  test('a module that cannot be built (bad bundled map) fails open at start', async () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      await withEnv('home', { page: HOME }, async (env) => {
        const { createEngine } = await import('../../src/content/engine.js');
        const engine = createEngine({ doc: env.document, win: env.window, chrome: env.chrome, themes: THEMES, bundledEnvelope: { payload: '{', sig: 'x', kid: 'k' } });
        await engine.start();
        assert.equal(env.style(), null);
        assert.equal(warn.mock.callCount(), 1);
        engine.stop();
      });
    } finally { warn.mock.restore(); }
  });

  test('an extension context that went away detaches the engine and leaves the page to its successor', async () => {
    await withEnv('home', { page: HOME }, async (env) => {
      await env.engine.start();
      const style = env.style();
      env.chrome.runtime.id = undefined;
      await env.set('settings', { themeId: 'minimal' });
      await sleep(40);
      assert.equal(env.style(), style, 'the shared <style> is not touched by the dead script');
      assert.equal(env.attr('cd-theme'), 'cinema');
      assert.equal(env.chrome.storage.onChanged.hasListeners(), false);
    });
  });
});

describe('first paint', () => {
  test('the cached look is applied synchronously, then confirmed without a rewrite when nothing changed', async () => {
    let css1;
    let cache;
    await withEnv('home', { page: HOME }, async (env) => {
      await env.engine.start();
      css1 = env.style().textContent;
      cache = env.window.localStorage.getItem(FIRST_PAINT_LS_KEY);
      assert.equal(JSON.parse(cache).key.split(':')[0], 'cinema');
    });
    await withEnv('home', { page: HOME }, async (env) => {
      env.window.localStorage.setItem(FIRST_PAINT_LS_KEY, cache);
      const started = env.engine.start();
      assert.equal(env.style().textContent, css1, 'applied before start() returned');
      assert.equal(env.attr('cd-theme'), 'cinema');
      assert.equal(env.attr('cd-page'), 'home');
      const watcher = new env.window.MutationObserver(() => {});
      watcher.observe(env.style(), { childList: true, characterData: true, subtree: true });
      await started;
      assert.deepEqual(watcher.takeRecords(), [], 'identical css is not written again');
      assert.equal(env.window.localStorage.getItem(FIRST_PAINT_LS_KEY), cache);
    });
  });

  test('the cache carries the html attributes the css depends on, and applies them in the same synchronous step: no restyle after storage answers', async () => {
    const stored = { settings: { themeId: 'minimal', animations: false, calm: { hideShorts: true, hideHomeRecs: true } } };
    let cache;
    let finalAttrs;
    await withEnv('home', { page: HOME, stored }, async (env) => {
      await env.engine.start();
      cache = env.window.localStorage.getItem(FIRST_PAINT_LS_KEY);
      finalAttrs = Object.fromEntries(env.html.getAttributeNames().filter((n) => n.startsWith('cd-') && n !== 'cd-theme' && n !== 'cd-page').map((n) => [n, env.attr(n)]));
      const entry = JSON.parse(cache);
      assert.deepEqual(Object.keys(entry), ['v', 'key', 'css', 'attrs']);
      assert.deepEqual(entry.attrs, finalAttrs, 'exactly the attributes the engine set, names as the DOM reports them');
      assert.equal(entry.attrs['cd-motion'], 'off');
      assert.equal(entry.attrs['cd-calm-hideshorts'], '');
      assert.ok(!('cd-theme' in entry.attrs) && !('cd-page' in entry.attrs), 'theme comes from the key, page from the URL');
    });
    await withEnv('home', { page: HOME, stored }, async (env) => {
      env.window.localStorage.setItem(FIRST_PAINT_LS_KEY, cache);
      const watcher = new env.window.MutationObserver(() => {});
      watcher.observe(env.html, { attributes: true, childList: true, subtree: true, characterData: true });
      const started = env.engine.start();
      // synchronously, before start() returns: the css AND every attribute it is keyed on
      assert.equal(env.attr('cd-theme'), 'minimal');
      for (const [name, value] of Object.entries(finalAttrs)) assert.equal(env.attr(name), value, name);
      assert.ok(env.style().textContent.length > 1000);
      watcher.takeRecords();
      await started;
      assert.deepEqual(watcher.takeRecords().map((r) => `${r.type}:${r.attributeName || ''}`), [], 'nothing is rewritten once storage has loaded: the first frame was already the final look');
      assert.equal(env.window.localStorage.getItem(FIRST_PAINT_LS_KEY), cache, 'and the cache is not rewritten either');
    });
  });

  test('when only an attribute changes (a calm toggle) the cache is rewritten with the new attributes', async () => {
    await withEnv('home', { page: HOME }, async (env) => {
      await env.engine.start();
      const first = JSON.parse(env.window.localStorage.getItem(FIRST_PAINT_LS_KEY));
      assert.equal('cd-calm-hideshorts' in first.attrs, false);
      await env.set('settings', { calm: { hideShorts: true } });
      await waitFor(() => env.attr('cd-calm-hideshorts') !== null, 'calm flag set');
      const next = JSON.parse(env.window.localStorage.getItem(FIRST_PAINT_LS_KEY));
      assert.equal(next.attrs['cd-calm-hideshorts'], '');
      assert.notEqual(next.key, first.key, 'the key changes with the attributes, so the engine notices');
    });
  });

  test('attributes from the cache are trusted only when exactly the known ones with allowed values; the css is judged separately', async () => {
    const entry = (attrs) => JSON.stringify({ v: 1, key: 'minimal:feedbeef', css: 'html[cd-theme] body { color: red }', attrs });
    const hostile = [
      { 'cd-home': 'rows', 'cd-evil': 'x' },                 // unknown name
      { 'cd-home': 'rows; background: url(x)' },              // value outside the closed set
      { 'cd-density': '9' },
      { 'cd-motion': '' },
      { 'cd-calm-hideshorts': 'yes' },                        // flags carry no value
      { 'cd-theme': 'studio' },                               // the theme comes from the key only
      { 'cd-off-theme': '' },
      { onload: 'alert(1)' },
      ['cd-home', 'rows'],
      'cd-home=rows',
      7,
      null,
    ];
    for (const attrs of hostile) {
      await withEnv('home', { page: HOME }, async (env) => {
        env.window.localStorage.setItem(FIRST_PAINT_LS_KEY, entry(attrs));
        const started = env.engine.start();
        assert.equal(env.attr('cd-theme'), 'minimal', 'css and theme from the key still apply');
        assert.equal(env.style().textContent, 'html[cd-theme] body { color: red }');
        assert.deepEqual(env.html.getAttributeNames().filter((n) => n.startsWith('cd-') && n !== 'cd-theme' && n !== 'cd-page').sort(), [], JSON.stringify(attrs));
        await started;
      });
    }
    await withEnv('home', { page: HOME }, async (env) => {   // the sane subset is applied
      env.window.localStorage.setItem(FIRST_PAINT_LS_KEY, entry({ 'cd-home': 'rows', 'cd-watch': 'focus', 'cd-density': '2', 'cd-motion': 'off', 'cd-calm-hidecomments': '' }));
      const started = env.engine.start();
      assert.deepEqual(['cd-home', 'cd-watch', 'cd-density', 'cd-motion', 'cd-calm-hidecomments'].map((n) => env.attr(n)), ['rows', 'focus', '2', 'off', '']);
      await started;
      assert.equal(env.attr('cd-theme'), 'cinema', 'then storage decides (nothing stored: the default theme)');
      assert.equal(env.attr('cd-home'), theme('cinema').layout.home);
      assert.equal(env.attr('cd-calm-hidecomments'), null);
    });
  });

  test('textScale: cd-textscale attribute flows from settings to html, into paintAttrs, and applies from firstPaint cache', async () => {
    await withEnv('home', { page: HOME, stored: { settings: { themeId: 'cinema', textScale: 1.25 } } }, async (env) => {
      await env.engine.start();
      assert.equal(env.attr('cd-textscale'), '1.25');
      const fp = JSON.parse(env.window.localStorage.getItem(FIRST_PAINT_LS_KEY));
      assert.equal(fp.attrs['cd-textscale'], '1.25');
    });

    // When textScale is null/unset, cd-textscale is not set on html
    await withEnv('home', { page: HOME, stored: { settings: { themeId: 'cinema', textScale: null } } }, async (env) => {
      await env.engine.start();
      assert.equal(env.attr('cd-textscale'), null);
      const fp = JSON.parse(env.window.localStorage.getItem(FIRST_PAINT_LS_KEY));
      assert.equal(fp.attrs['cd-textscale'], undefined);
    });

    // Applied from firstPaint cache at boot
    const entry = (attrs) => JSON.stringify({ v: 1, key: 'cinema:feedbeef', css: 'html[cd-theme] { font-size: 17.5px }', attrs });
    await withEnv('home', { page: HOME }, async (env) => {
      env.window.localStorage.setItem(FIRST_PAINT_LS_KEY, entry({ 'cd-home': 'hero-rows', 'cd-watch': 'cinema', 'cd-density': '3', 'cd-motion': 'on', 'cd-textscale': '1.25' }));
      const started = env.engine.start();
      assert.equal(env.attr('cd-textscale'), '1.25');
      await started;
    });
  });

  test('a stale cache (another theme) is replaced by the real state and the cache is rewritten', async () => {
    await withEnv('home', { page: HOME, stored: { settings: { themeId: 'classic' } } }, async (env) => {
      env.window.localStorage.setItem(FIRST_PAINT_LS_KEY, JSON.stringify({ v: 1, key: 'minimal:deadbeef', css: 'html[cd-theme] body { color: red }' }));
      const started = env.engine.start();
      assert.equal(env.attr('cd-theme'), 'minimal', 'the cache decides the first frame');
      assert.equal(env.style().textContent, 'html[cd-theme] body { color: red }');
      await started;
      assert.equal(env.attr('cd-theme'), 'classic');
      assert.ok(env.style().textContent.includes('--cd-accent'));
      assert.equal(JSON.parse(env.window.localStorage.getItem(FIRST_PAINT_LS_KEY)).key.split(':')[0], 'classic');
    });
  });

  test('an unusable cache entry (bad theme id, unsafe css) is ignored', async () => {
    for (const entry of [{ v: 1, key: 'nope:1', css: 'a{}' }, { v: 1, key: 'cinema:1', css: '@import "x.css";' }]) {
      await withEnv('home', { page: HOME }, async (env) => {
        env.window.localStorage.setItem(FIRST_PAINT_LS_KEY, JSON.stringify(entry));
        const started = env.engine.start();
        assert.equal(env.style(), null);
        assert.equal(env.attr('cd-theme'), null);
        await started;
        assert.equal(env.attr('cd-theme'), 'cinema');
      });
    }
  });
});

describe('cached selector map', () => {
  // always one step above whatever map the package ships, so a new bundled map never turns this test into an "older" case
  const NEWER = MAP.mapVersion.replace(/\d+$/, (n) => String(Number(n) + 1));

  test('accepted when signed by the map key and newer than the bundled one (at boot and live)', async () => {
    const keys = await makeKeyPair('selector-map-1');
    const newer = await signedMap(keys.privateJwk, NEWER);
    await withEnv('home', { page: HOME, stored: { selectorMap: newer }, engine: { publicKeys: { selectorMap: keys.publicJwk } } }, async (env) => {
      await env.engine.start();
      assert.equal(env.engine.getStatus().mapVersion, NEWER);
    });
    await withEnv('home', { page: HOME, engine: { publicKeys: { selectorMap: keys.publicJwk } } }, async (env) => {
      await env.engine.start();
      assert.equal(env.engine.getStatus().mapVersion, MAP.mapVersion);
      await env.set('selectorMap', newer);
      await waitFor(() => env.engine.getStatus().mapVersion === NEWER, 'live map swap');
      await waitFor(() => mounted(env), 'layout re-mounted on the new map');
      await env.chrome.storage.local.remove(STORAGE_KEYS.selectorMap);
      await waitFor(() => env.engine.getStatus().mapVersion === MAP.mapVersion, 'back to the bundled map');
    });
  });

  test('rejected when tampered, older, equal, unsigned, garbage-signed or signed by another key', async () => {
    const keys = await makeKeyPair('selector-map-1');
    const stranger = await makeKeyPair('selector-map-1');
    const good = await signedMap(keys.privateJwk, NEWER);
    const cases = {
      tampered: { ...good, payload: good.payload.replace(NEWER, '2026.10.11.1') },
      older: await signedMap(keys.privateJwk, '2026.01.01.1'),
      equal: await signedMap(keys.privateJwk, MAP.mapVersion),
      unsigned: { payload: good.payload, kid: 'selector-map-1' },
      emptySig: { ...good, sig: '' },
      garbageSig: { ...good, sig: 'A'.repeat(86) },
      otherKey: await signedMap(stranger.privateJwk, NEWER),
      notAnEnvelope: 'just a string',
    };
    for (const [name, envelope] of Object.entries(cases)) {
      await withEnv('home', { page: HOME, stored: { selectorMap: envelope }, engine: { publicKeys: { selectorMap: keys.publicJwk } } }, async (env) => {
        await env.engine.start();
        assert.equal(env.engine.getStatus().mapVersion, MAP.mapVersion, name);
        assert.equal(env.attr('cd-theme'), 'cinema', name);
      });
    }
  });
});

describe('cached selector map that breaks a feature', () => {
  test('writing a newer map with a missing role pauses exactly that feature; removing the cached map restores the bundled map and heals it', async () => {
    const keys = await makeKeyPair('selector-map-1');
    const licKeys = await makeKeyPair('licence-1');
    const record = await proLicence(licKeys.privateJwk);
    const broken = await signedMap(keys.privateJwk, '2026.10.21.1', (m) => { m.roles.comments = ['cd-nope-comments']; return m; });
    const opts = { page: { tiles: 3 }, stored: { settings: { themeId: 'cinema', calm: { hideComments: true } }, licence: record }, engine: { publicKeys: { selectorMap: keys.publicJwk, licence: licKeys.publicJwk } } };
    await withEnv('watch', opts, async (env) => {
      await env.engine.start();
      assert.equal(env.engine.getStatus().features['calm-hideComments'], 'on');
      await env.set('selectorMap', broken);
      await waitFor(() => env.engine.getStatus().features['calm-hideComments'] === 'broken', 'comments paused');
      assert.deepEqual(Object.entries(env.engine.getStatus().features).filter(([, v]) => v === 'broken').map(([k]) => k), ['calm-hideComments']);
      assert.equal(noticeCount(env), 1);
      assert.equal(env.engine.getStatus().mapVersion, '2026.10.21.1');

      await env.chrome.storage.local.remove(STORAGE_KEYS.selectorMap);   // storage.onChanged with newValue undefined
      await waitFor(() => env.engine.getStatus().mapVersion === MAP.mapVersion, 'bundled map back');
      await waitFor(() => env.engine.getStatus().features['calm-hideComments'] === 'on', 'comments healed');
      await waitFor(() => !env.html.hasAttribute('cd-off-calm-hidecomments'), 'cd-off flag cleared');
      assert.deepEqual(env.engine.getStatus().missingRoles, []);
      assert.equal(noticeCount(env), 0);
    });
  });
});

describe('index.js', () => {
  test('wires the real globals, starts the engine, and a second injection does nothing', async () => {
    await withEnv('home', { page: HOME }, async (env) => {
      const saved = { window: globalThis.window, document: globalThis.document, chrome: globalThis.chrome, location: globalThis.location };
      Object.assign(globalThis, { window: env.window, document: env.document, chrome: env.chrome, location: env.window.location });
      try {
        await import('../../src/content/index.js?first');
        await waitFor(() => env.attr('cd-theme') === 'cinema', 'index.js booted the engine');
        assert.equal(env.document.querySelectorAll('style#cinedrape-theme').length, 1);
        const listeners = env.chrome.storage.onChanged._listeners.length;
        assert.equal(listeners, 1);
        await import('../../src/content/index.js?second');
        assert.equal(env.chrome.storage.onChanged._listeners.length, listeners, 'no second engine');
        globalThis[Symbol.for('cinedrape.engine')].stop();
        assert.equal(env.style(), null);
      } finally {
        delete globalThis[Symbol.for('cinedrape.engine')];
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
      }
    });
  });
});

describe('persisted health verdict and the readability sentinel', () => {
  const RENAMED = { ...HOME, rename: ['[page-subtype]'] };   // homeBrowse is gone: layout-home is broken
  const verdictOf = async (env) => (await env.chrome.storage.local.get(STORAGE_KEYS.health))[STORAGE_KEYS.health];
  const UNREADABLE = () => ({ checked: 3, low: [{ id: 'tile', ratio: 1.1 }] });
  const READABLE = () => ({ checked: 3, low: [] });

  test('a settled broken page is remembered: {mapVersion, themeId, broken, pages, at}; a healthy settle removes it again', async () => {
    await withEnv('home', { page: RENAMED }, async (env) => {
      await env.engine.start();
      await waitFor(() => env.html.hasAttribute('cd-off-layout-home'), 'layout-home disabled');
      const v = await waitFor(() => verdictOf(env), 'verdict stored');
      assert.equal(v.mapVersion, MAP.mapVersion);
      assert.equal(v.themeId, 'cinema');
      assert.deepEqual(v.broken, ['layout-home']);
      assert.deepEqual(v.pages, { home: ['layout-home'] });
      assert.equal(typeof v.at, 'number');
      assert.equal(v.unreadable, false);
      navigateTo(env.page, 'home', HOME);
      await waitFor(() => !env.html.hasAttribute('cd-off-layout-home'), 'healed');
      await waitFor(async () => (await verdictOf(env)) === undefined, 'verdict removed by the healthy settle');
    });
  });

  test('the next load starts from the remembered set: no flash of the broken feature, one notice for the new tab session, healed on the first healthy settle', async () => {
    const verdict = { mapVersion: MAP.mapVersion, themeId: 'cinema', broken: ['layout-home'], pages: { home: ['layout-home'] }, unreadable: false, at: Date.now() };
    // The settle time is long: only the remembered verdict can mark the feature off before the check has run (without it the
    // feature is on for the whole settle time and is paused after it).
    await withEnv('home', { page: RENAMED, engine: { healthTimeoutMs: 60000 } }, async (env) => {
      await env.engine.start();
      assert.equal(env.html.hasAttribute('cd-off-layout-home'), false, 'without a verdict the feature is on during the settle time');
      assert.equal(env.engine.getStatus().features['layout-home'], 'on');
    });
    await withEnv('home', { page: RENAMED, stored: { [STORAGE_KEYS.health]: verdict }, engine: { healthTimeoutMs: 60000 } }, async (env) => {
      await env.engine.start();
      assert.equal(env.html.hasAttribute('cd-off-layout-home'), true, 'off from the first pass');
      await sleep(40);
      assert.equal(mounted(env), false, 'the layout never flashed on');
      assert.equal(env.engine.getStatus().features['layout-home'], 'broken');
    });
    // Still broken at the settle: the same set, announced once, kept.
    await withEnv('home', { page: RENAMED, stored: { [STORAGE_KEYS.health]: verdict } }, async (env) => {
      await env.engine.start();
      await waitFor(() => noticeCount(env) === 1, 'announced once');
      assert.equal(env.html.hasAttribute('cd-off-layout-home'), true);
      assert.deepEqual((await verdictOf(env)).broken, ['layout-home']);
    });
    // Healthy at the settle: the verdict must not survive it.
    await withEnv('home', { page: HOME, stored: { [STORAGE_KEYS.health]: verdict } }, async (env) => {
      await env.engine.start();
      await waitFor(() => !env.html.hasAttribute('cd-off-layout-home'), 're-enabled by the healthy settle');
      await waitFor(() => mounted(env), 'layout mounted');
      await waitFor(async () => (await verdictOf(env)) === undefined, 'verdict cleared');
      assert.equal(noticeCount(env), 0);
    });
  });

  test('a verdict for another map version, other page type, or junk is ignored; a healthy home page does not clear the watch verdict', async () => {
    const base = { themeId: 'cinema', broken: ['layout-home'], pages: { home: ['layout-home'] }, unreadable: false, at: Date.now() };
    for (const [name, stored] of Object.entries({
      'other map': { ...base, mapVersion: '1999.01.01.1' },
      'junk': 'broken',
      'unknown feature': { ...base, mapVersion: MAP.mapVersion, broken: ['nope'], pages: { home: ['nope'] } },
      'wrong theme id': { ...base, mapVersion: MAP.mapVersion, themeId: '<script>' },
    })) {
      await withEnv('home', { page: HOME, stored: { [STORAGE_KEYS.health]: stored }, engine: { healthTimeoutMs: 60000 } }, async (env) => {
        await env.engine.start();
        assert.equal(env.html.hasAttribute('cd-off-layout-home'), false, name);
        await waitFor(() => mounted(env), `${name}: mounted`);
      });
    }
    assert.equal(normalizeVerdict({ ...base, mapVersion: MAP.mapVersion }).broken[0], 'layout-home');
    assert.equal(normalizeVerdict(null), null);
    const watchVerdict = { mapVersion: MAP.mapVersion, themeId: 'cinema', broken: ['calm-hideComments'], pages: { watch: ['calm-hideComments'] }, unreadable: false, at: Date.now() };
    await withEnv('home', { page: HOME, stored: { [STORAGE_KEYS.health]: watchVerdict } }, async (env) => {
      await env.engine.start();
      await waitFor(() => mounted(env), 'home layout mounted');
      await sleep(30);
      assert.deepEqual((await verdictOf(env)).pages, { watch: ['calm-hideComments'] }, 'the watch verdict survives a healthy home settle');
    });
  });

  test('an unreadable themed page: theme switched off after the settle, one notice, verdict remembered with unreadable:true', async () => {
    await withEnv('home', { page: HOME, engine: { readability: UNREADABLE, healthTimeoutMs: 20 } }, async (env) => {
      await env.engine.start();
      assert.equal(env.html.hasAttribute('cd-off-theme'), false, 'applied first');
      await waitFor(() => env.html.hasAttribute('cd-off-theme'), 'theme off by the sentinel', 3000);
      assert.equal(env.engine.getStatus().features.theme, 'broken');
      assert.ok(!/--cd-(bg|accent|text):/.test(env.style().textContent), 'YouTube keeps its own look: no theme tokens');
      await waitFor(() => noticeCount(env) === 1, 'notice');
      assert.match(env.document.querySelector('.cd-notice-text').textContent, /Theme/);
      const v = await waitFor(() => verdictOf(env), 'stored');
      assert.deepEqual(v.broken, ['theme']);
      assert.equal(v.unreadable, true);
      assert.equal(v.themeId, 'cinema');
    }).catch((e) => { throw e; });
  });

  test('an unreadable verdict from an earlier load keeps the theme off from the first pass; it is re-tested after a day, for another theme, and for another map', async () => {
    const at = Date.now();
    const verdict = { mapVersion: MAP.mapVersion, themeId: 'cinema', broken: ['theme'], pages: { home: ['theme'] }, unreadable: true, at };
    // Standing verdict, long settle: off at once, never measured while off.
    let measured = 0;
    await withEnv('home', {
      page: HOME, stored: { [STORAGE_KEYS.health]: verdict },
      engine: { readability: () => { measured++; return READABLE(); }, healthTimeoutMs: 20 },
    }, async (env) => {
      await env.engine.start();
      assert.equal(env.html.hasAttribute('cd-off-theme'), true);
      await sleep(120);
      assert.equal(env.html.hasAttribute('cd-off-theme'), true, 'a theme that is off cannot be measured, so it stays off');
      assert.equal(measured, 0);
    });
    // A day later it is tried again: applied, measured readable, verdict cleared.
    await withEnv('home', {
      page: HOME, stored: { [STORAGE_KEYS.health]: verdict },
      engine: { now: () => at + UNREADABLE_TTL_MS + 1000, readability: READABLE, healthTimeoutMs: 20 },
    }, async (env) => {
      await env.engine.start();
      assert.equal(env.html.hasAttribute('cd-off-theme'), false, 'the old verdict has expired');
      await waitFor(async () => (await verdictOf(env)) === undefined, 'verdict cleared by a readable settle');
      assert.equal(env.html.hasAttribute('cd-off-theme'), false);
    });
    // The user picked another theme since: the verdict was about the first one.
    await withEnv('home', {
      page: HOME, stored: { [STORAGE_KEYS.health]: verdict, settings: { themeId: 'minimal' } },
      engine: { readability: READABLE, healthTimeoutMs: 20 },
    }, async (env) => {
      await env.engine.start();
      assert.equal(env.html.hasAttribute('cd-off-theme'), false);
      assert.equal(env.attr('cd-theme'), 'minimal');
    });
  });
});

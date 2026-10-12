// Argument parsing and the fixed page catalogue for the e2e harness.
import { parseArgs } from 'node:util';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Exit codes (documented in README.md). */
export const EXIT = { OK: 0, CHECKS_FAILED: 1, USAGE: 2, ENVIRONMENT: 3, NETWORK: 4, TIMEOUT: 5, INTERNAL: 6 };

/** Thrown for anything that should end the run with a specific exit code and a one-line message. */
export class HarnessError extends Error {
  constructor(code, message) {
    super(message);
    this.exitCode = code;
  }
}

/**
 * The pages the harness visits. `ready` = selectors of which any one means the page has content;
 * `title` = candidates for "a main title" (first visible one wins); `full` = also take a full-page screenshot.
 */
export const PAGES = {
  home: {
    url: 'https://www.youtube.com/',
    full: true,
    minSampled: 10, // logged-out home is an empty state (masthead, guide, one message): about 17 measurable elements
    ready: ['ytd-browse[page-subtype="home"]'],
    title: ['yt-lockup-view-model a.ytLockupMetadataViewModelTitle', 'ytd-rich-item-renderer a#video-title-link', 'ytd-feed-nudge-renderer #title', 'ytd-browse #title', 'h1'],
  },
  channel: {
    url: 'https://www.youtube.com/@NatGeo/videos',
    full: true,
    ready: ['ytd-browse[page-subtype="channels"] yt-lockup-view-model', 'ytd-browse ytd-rich-item-renderer'],
    title: ['yt-lockup-view-model a.ytLockupMetadataViewModelTitle', 'ytd-rich-item-renderer a#video-title-link', 'h1'],
  },
  search: {
    url: 'https://www.youtube.com/results?search_query=nature+documentary',
    full: false,
    ready: ['ytd-search ytd-video-renderer', 'ytd-search yt-lockup-view-model'],
    title: ['ytd-video-renderer a#video-title', 'yt-lockup-view-model a.ytLockupMetadataViewModelTitle', 'h3 a'],
  },
  watch: {
    url: 'https://www.youtube.com/watch?v=BzpdP2APcIM',
    full: false,
    ready: ['ytd-watch-flexy:not([hidden]) #movie_player'],
    title: ['ytd-watch-metadata #title h1', 'h1.ytd-watch-metadata', 'h1'],
  },
};

export const FALLBACK = {
  allThemes: ['cinema', 'minimal', 'classic', 'primetime', 'studio', 'arcade'],
  freeThemes: ['cinema', 'minimal', 'classic'],
};

const USAGE = `usage: node test/e2e/run.mjs [options]
  --extension <dir>      unpacked extension to load (default: dist)
  --themes <list|all>    comma list of theme ids (default: all)
  --pages <list>         comma list of: ${Object.keys(PAGES).join(',')} (default: home,watch,search,channel)
  --pro                  seed a dev Pro licence (tools/dev-licence.mjs) so Pro themes and toggles are active
  --calm                 turn on all five calm toggles (stress-tests the hide rules against the ad check)
  --viewport <WxH>       default 1440x900
  --mode <m>             YouTube's own colour mode: light (default), dark, or both. Dark is forced with the PREF cookie f6=400
                         (light with f6=80000) and verified through html[dark]; every report row records the mode
  --no-perf              skip the theme-switch / heap measurements (readability audits run faster)
  --shots <s>            all (default) | view (viewport shots only) | none
  --offenders <n>        worst readability offenders listed per row (default 15)
  --out <dir>            screenshots and reports (default: test/e2e/out)
  --headed               headed Chrome (window parked off-screen) instead of headless
  --chrome <path>        Chrome executable (default: CHROME_PATH or the system Chrome)
  --chrome-arg <flag>    extra Chrome command-line flag, repeatable (e.g. --chrome-arg=--proxy-server=host:3128)
  --settle <ms>          max wait for the extension to settle per page (default 7000)
  --page-timeout <ms>    per-page budget (default 90000)
  --total-timeout <ms>   whole-run budget (default 1500000)
  --help`;

function toMs(name, text, fallback) {
  if (text === undefined) return fallback;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 100) throw new HarnessError(EXIT.USAGE, `--${name} must be a number of milliseconds (>= 100), got ${JSON.stringify(text)}.\n${USAGE}`);
  return n;
}

/**
 * @param {string[]} argv
 * @param {{allThemes: string[], freeThemes: string[]}} catalogue
 */
export function parseCli(argv, catalogue = FALLBACK) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        extension: { type: 'string' }, themes: { type: 'string' }, pages: { type: 'string' }, pro: { type: 'boolean' }, calm: { type: 'boolean' },
        viewport: { type: 'string' }, mode: { type: 'string' }, 'no-perf': { type: 'boolean' }, shots: { type: 'string' }, offenders: { type: 'string' }, out: { type: 'string' }, headed: { type: 'boolean' }, chrome: { type: 'string' }, 'chrome-arg': { type: 'string', multiple: true },
        settle: { type: 'string' }, 'page-timeout': { type: 'string' }, 'total-timeout': { type: 'string' }, help: { type: 'boolean' },
      },
    }));
  } catch (err) {
    throw new HarnessError(EXIT.USAGE, `${err.message}\n${USAGE}`);
  }
  if (values.help) return { help: USAGE };

  const list = (text) => text.split(',').map((s) => s.trim()).filter(Boolean);
  const themes = !values.themes || values.themes === 'all' ? [...catalogue.allThemes] : list(values.themes);
  const badTheme = themes.find((t) => !catalogue.allThemes.includes(t));
  if (badTheme || themes.length === 0) throw new HarnessError(EXIT.USAGE, `unknown theme ${JSON.stringify(badTheme)}; known: ${catalogue.allThemes.join(', ')}`);
  const pages = values.pages ? list(values.pages) : ['home', 'watch', 'search', 'channel'];
  const badPage = pages.find((p) => !PAGES[p]);
  if (badPage || pages.length === 0) throw new HarnessError(EXIT.USAGE, `unknown page ${JSON.stringify(badPage)}; known: ${Object.keys(PAGES).join(', ')}`);

  const mode = values.mode || 'light';
  if (!['light', 'dark', 'both'].includes(mode)) throw new HarnessError(EXIT.USAGE, `--mode must be light, dark or both, got ${JSON.stringify(mode)}
${USAGE}`);
  const shots = values.shots || 'all';
  if (!['all', 'view', 'none'].includes(shots)) throw new HarnessError(EXIT.USAGE, `--shots must be all, view or none, got ${JSON.stringify(shots)}
${USAGE}`);
  const offenders = values.offenders === undefined ? 15 : Number(values.offenders);
  if (!Number.isInteger(offenders) || offenders < 1 || offenders > 100) throw new HarnessError(EXIT.USAGE, `--offenders must be an integer 1..100, got ${JSON.stringify(values.offenders)}
${USAGE}`);

  const vp = /^(\d{3,4})x(\d{3,4})$/.exec(values.viewport || '1440x900');
  if (!vp) throw new HarnessError(EXIT.USAGE, `--viewport must look like 1440x900, got ${JSON.stringify(values.viewport)}`);

  const abs = (p, base) => (isAbsolute(p) ? p : resolve(base, p));
  return {
    extension: values.extension ? abs(values.extension, process.cwd()) : resolve(REPO_ROOT, 'dist'),
    out: values.out ? abs(values.out, process.cwd()) : resolve(REPO_ROOT, 'test', 'e2e', 'out'),
    themes: [...new Set(themes)],
    pages: [...new Set(pages)],
    pro: Boolean(values.pro),
    calm: Boolean(values.calm),
    modes: mode === 'both' ? ['light', 'dark'] : [mode],
    perf: !values['no-perf'],
    shots,
    offenders,
    headed: Boolean(values.headed),
    chrome: values.chrome || process.env.CHROME_PATH || null,
    chromeArgs: values['chrome-arg'] || [],
    viewport: { width: Number(vp[1]), height: Number(vp[2]) },
    settleMs: toMs('settle', values.settle, 7000),
    pageTimeoutMs: toMs('page-timeout', values['page-timeout'], 90000),
    totalTimeoutMs: toMs('total-timeout', values['total-timeout'], 1500000),
  };
}

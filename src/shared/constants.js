export const STYLE_ID = 'cinedrape-theme';
export const CD_PREFIX = 'cd-';
export const ATTR = {            // attributes set on <html> by the engine
  theme: 'cd-theme', page: 'cd-page', home: 'cd-home', watch: 'cd-watch', watchLive: 'cd-watch-live',
  density: 'cd-density', motion: 'cd-motion', textScale: 'cd-textscale', calmPrefix: 'cd-calm-', offPrefix: 'cd-off-',
};
export const SRC_ATTR = 'cd-source';      // on a YouTube tile Cinedrape has mirrored into its own card
export const PAGE_TYPES = ['home','watch','search','channel','subscriptions','history','playlist','shorts','other'];
export const CALM_KEYS = ['hideShorts','hideHomeRecs','hideComments','hideEndScreens','hideViewCounts','hideLive'];
export const FREE_CALM_KEYS = [...CALM_KEYS];
export const FEATURES = ['theme','layout-home','layout-watch','density',
  'calm-hideShorts','calm-hideHomeRecs','calm-hideComments','calm-hideEndScreens','calm-hideViewCounts','calm-hideLive'];
export const PACK_1_THEME_IDS = ['oled','frost','mocha','midnight-city','ember','paper','matcha','sunset','terminal','imax'];
export const ALL_THEME_IDS = ['cinema','minimal','classic','primetime','studio','arcade',...PACK_1_THEME_IDS];
export const FREE_THEME_IDS = [...ALL_THEME_IDS];
export const LAYOUT_HOME = ['grid','rows','hero-rows'];
export const LAYOUT_WATCH = ['default','cinema','focus'];
export const RESERVED_THEME_IDS = Object.freeze([...ALL_THEME_IDS, 'broadcast']);
export const STORAGE_KEYS = { settings:'cd.settings', licence:'cd.licence', selectorMap:'cd.selectorMap',
  health:'cd.health', telemetry:'cd.telemetry', firstPaint:'cd.firstPaint', customThemes:'cd.customThemes',
  profiles:'cd.profiles', schedule:'cd.schedule', backup:'cd.backup', draft:'cd.editorDraft',
  trial:'cd.trial', trialLog:'cd.trialLog', install:'cd.install' };
export const DEFAULT_SETTINGS = { schema:1, themeId:'cinema', accent:null, density:null, animations:true,
  textScale:null, layout:{ home:null, watch:null }, calm:{ hideShorts:false, hideHomeRecs:false, hideComments:false, hideEndScreens:false, hideViewCounts:false, hideLive:false },
  telemetryOptIn:false };
export const DEFAULT_SCHEDULE = { schema:1, enabled:false, dayProfileId:'cinema', nightProfileId:'cinema',
  dayTime:'08:00', nightTime:'20:00', manualOverrideUntil:null, lastError:null };
export const LIMITS = { cssMaxBytes:20480, contentMaxChars:100, offlineGraceMs:30*864e5,
  licenceRecheckMs:7*864e5, mapRefreshMs:6*36e5, maxBrowsersPerLicence:3,
  maxCustomThemes:10, maxCustomThemeBytes:65536, maxProfiles:10,
  trialDurationMs:10*60*1000, maxDailyTrials:3, day7UpgradeMs:7*864e5 };
export const CHECKOUT_URL = 'https://cinedrape.lemonsqueezy.com/checkout'; // TODO-OWNER: replace with production checkout URL
export const SUPPORT_URL = 'https://github.com/sponsors/JDamour';
export const WELCOME_URL = 'https://jdamour.github.io/Cinedrape/#welcome';
export const UNINSTALL_URL = 'https://jdamour.github.io/Cinedrape/#bye';
export const MSG = {
  GET_STATUS:'cd:getStatus',
  ACTIVATE_LICENCE:'cd:activateLicence',
  GET_LICENCE:'cd:getLicence',
  REFRESH_MAP:'cd:refreshMap',
  STATUS_CHANGED:'cd:statusChanged',
  SAVE_THEME:'cd:saveTheme',
  DELETE_THEME:'cd:deleteTheme',
  SAVE_PROFILE:'cd:saveProfile',
  DELETE_PROFILE:'cd:deleteProfile',
  APPLY_PROFILE:'cd:applyProfile',
  UPDATE_SCHEDULE:'cd:updateSchedule',
  SAVE_SETTINGS:'cd:saveSettings',
  START_TRIAL:'cd:startTrial',
  GET_TRIAL:'cd:getTrial',
};
export const FIRST_PAINT_LS_KEY = 'cd:v1:firstPaint';   // localStorage key used by the engine (§5)

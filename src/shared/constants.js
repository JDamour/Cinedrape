export const STYLE_ID = 'cinedrape-theme';
export const CD_PREFIX = 'cd-';
export const ATTR = {            // attributes set on <html> by the engine
  theme: 'cd-theme', page: 'cd-page', home: 'cd-home', watch: 'cd-watch', watchLive: 'cd-watch-live',
  density: 'cd-density', motion: 'cd-motion', textScale: 'cd-textscale', calmPrefix: 'cd-calm-', offPrefix: 'cd-off-',
};
export const SRC_ATTR = 'cd-source';      // on a YouTube tile Cinedrape has mirrored into its own card
export const PAGE_TYPES = ['home','watch','search','channel','subscriptions','history','playlist','shorts','other'];
export const CALM_KEYS = ['hideShorts','hideHomeRecs','hideComments','hideEndScreens','hideViewCounts'];
export const FREE_CALM_KEYS = ['hideShorts','hideHomeRecs'];
export const FEATURES = ['theme','layout-home','layout-watch','density',
  'calm-hideShorts','calm-hideHomeRecs','calm-hideComments','calm-hideEndScreens','calm-hideViewCounts'];
export const ALL_THEME_IDS = ['cinema','minimal','classic','primetime','studio','arcade'];
export const FREE_THEME_IDS = ['cinema','minimal','classic'];
export const LAYOUT_HOME = ['grid','rows','hero-rows'];
export const LAYOUT_WATCH = ['default','cinema','focus'];
export const STORAGE_KEYS = { settings:'cd.settings', licence:'cd.licence', selectorMap:'cd.selectorMap',
  health:'cd.health', telemetry:'cd.telemetry', firstPaint:'cd.firstPaint' };
export const DEFAULT_SETTINGS = { schema:1, themeId:'cinema', accent:null, density:null, animations:true,
  textScale:null, calm:{ hideShorts:false, hideHomeRecs:false, hideComments:false, hideEndScreens:false, hideViewCounts:false },
  telemetryOptIn:false };
export const LIMITS = { cssMaxBytes:20480, contentMaxChars:100, offlineGraceMs:30*864e5,
  licenceRecheckMs:7*864e5, mapRefreshMs:6*36e5, maxBrowsersPerLicence:3 };
export const MSG = { GET_STATUS:'cd:getStatus', ACTIVATE_LICENCE:'cd:activateLicence',
  GET_LICENCE:'cd:getLicence', REFRESH_MAP:'cd:refreshMap', STATUS_CHANGED:'cd:statusChanged' };
export const FIRST_PAINT_LS_KEY = 'cd:v1:firstPaint';   // localStorage key used by the engine (§5)

// @ts-check
// Mutation messages from extension pages (popup, editor) to the background worker (audit F1, F7, F8).
//
// Both sides import this file: senders build every message with `messages.*`, the worker reads fields with `messageId` /
// `messagePatch`. Before this module the popup sent `themeId` / `profileId` / `settings` while the worker read `id` / `patch`,
// so delete, apply and "save and apply" silently failed. Nothing here touches chrome.* APIs.
import { MSG } from './constants.js';

/** Builders. Optional fields that are undefined are dropped by structured cloning, so callers may pass them freely. */
export const messages = Object.freeze({
  /** @param {{mode?: 'create'|'update', expectedRevision?: number, apply?: boolean}} [opts] */
  saveTheme: (theme, opts = {}) => ({
    type: MSG.SAVE_THEME, theme, mode: opts.mode, expectedRevision: opts.expectedRevision, apply: opts.apply,
  }),
  /** @param {{expectedRevision?: number, resetReferences?: boolean}} [opts] */
  deleteTheme: (id, opts = {}) => ({
    type: MSG.DELETE_THEME, id, expectedRevision: opts.expectedRevision, resetReferences: opts.resetReferences,
  }),
  saveProfile: (profile, expectedRevision) => ({ type: MSG.SAVE_PROFILE, profile, expectedRevision }),
  deleteProfile: (id, expectedRevision) => ({ type: MSG.DELETE_PROFILE, id, expectedRevision }),
  applyProfile: (id) => ({ type: MSG.APPLY_PROFILE, id }),
  updateSchedule: (schedule) => ({ type: MSG.UPDATE_SCHEDULE, schedule }),
  saveSettings: (patch) => ({ type: MSG.SAVE_SETTINGS, patch }),
});

const isString = (v) => typeof v === 'string' && v !== '';

/** The target id of a delete/apply message. Accepts the legacy `themeId` / `profileId` spellings for one release. */
export function messageId(message) {
  if (!message || typeof message !== 'object') return undefined;
  for (const key of ['id', 'themeId', 'profileId']) if (isString(message[key])) return message[key];
  return undefined;
}

/** The settings patch of a SAVE_SETTINGS message. Accepts the legacy `settings` spelling. */
export function messagePatch(message) {
  if (!message || typeof message !== 'object') return undefined;
  return message.patch !== undefined ? message.patch : message.settings;
}

/** True when a reply is a real worker answer (as opposed to no listener, a closed port, an unhandled stub, or a timeout). */
export function isWorkerReply(reply) {
  if (!reply || typeof reply !== 'object') return false;
  if (reply.ok === true) return true;
  if (reply.ok === false && Boolean(reply.reason || reply.error || (Array.isArray(reply.issues) && reply.issues.length > 0))) {
    return true;
  }
  return false;
}

const FIRST_ISSUE = (res) => {
  const issue = Array.isArray(res.issues) ? res.issues[0] : undefined;
  return issue && typeof issue.message === 'string' ? issue.message : undefined;
};

/**
 * Human-readable sentence for a failed worker reply (`{ok:false, reason, message?, issues?, error?}`).
 * @param {object} res
 * @param {string} [fallback]
 */
export function describeFailure(res, fallback = 'Something went wrong. Please try again.') {
  if (!res || typeof res !== 'object') return fallback;
  switch (res.reason) {
    case 'requires-pro': return 'This needs Cinedrape Pro.';
    case 'conflict':
      if (res.exists) return typeof res.message === 'string' ? res.message : 'A theme with this ID already exists.';
      return 'This changed in another Cinedrape window. Reopen it and try again.';
    case 'reserved-id': return typeof res.message === 'string' ? res.message : 'That ID is reserved for a bundled theme.';
    case 'limit': return typeof res.message === 'string' ? res.message : 'Limit reached. Delete one first.';
    case 'invalid': return FIRST_ISSUE(res) || (typeof res.error === 'string' ? res.error : 'That value is not valid.');
    case 'invalid-reference': return typeof res.error === 'string' ? res.error : 'Choose existing profiles for day and night.';
    case 'not-found': return 'That item no longer exists.';
    case 'referenced': {
      const names = Array.isArray(res.affectedProfiles) ? res.affectedProfiles : [];
      return names.length ? `Still used by profile ${names.join(', ')}.` : 'This theme is currently in use.';
    }
    case 'map-unavailable': return 'Cinedrape could not check this theme\'s CSS. Try again after reloading the extension.';
    case 'forbidden': return 'This action is only available from Cinedrape\'s own pages.';
    default:
      if (typeof res.error === 'string' && res.error) return res.error;
      if (typeof res.message === 'string' && res.message) return res.message;
      return fallback;
  }
}

// The write requests the Timeline sends, and how a refusal is put into words. Pure: nothing is sent here.
// A request is { method: 'POST', url, body }; callers send it with `dryRun: true` first when a preview is wanted, then for real.
import { explainCodexFailure } from '../codex/requests.js';
import { explainFailure } from '../structure/helpers.js';

const enc = encodeURIComponent;
const base = (bookId) => `/api/books/${enc(bookId)}`;

/**
 * A new event: title, slug, when, order, date and (optionally) the scenes, characters and locations. With `twoSided` the scenes' own `events` lists are kept in step.
 * @param {string} bookId @param {{ title: string, slug?: string, when?: string, order: number, date?: string, scenes?: string[], characters?: string[], locations?: string[] }} e
 */
export const newEventRequest = (bookId, { title, slug, when, order, date, scenes = [], characters = [], locations = [] }) => ({
  method: /** @type {const} */ ('POST'),
  url: `${base(bookId)}/events`,
  body: { title, ...(slug ? { slug } : {}), order, ...(when ? { when } : {}), ...(date ? { date } : {}), scenes, characters, locations },
});

/** Only what changed: { title?, when?, date?, order?, characters?, locations?, add?, remove?, two_sided? }. @param {string} bookId @param {{ id: string, sha256?: string | null }} event @param {Record<string, unknown>} patch */
export const eventFieldsRequest = (bookId, event, patch) => ({
  method: /** @type {const} */ ('POST'),
  url: `${base(bookId)}/events/${enc(event.id)}/fields`,
  body: { ...patch, ...(event.sha256 ? { base_sha256: event.sha256 } : {}) },
});

/** The one-line `order` edit of a reorder. @param {string} bookId @param {{ id: string, sha256?: string | null }} event @param {number} order */
export const eventOrderRequest = (bookId, event, order) => eventFieldsRequest(bookId, event, { order });

/** Add scenes to / remove scenes from an event. `twoSided`: also edit the scenes' own `events` lists. @param {string} bookId @param {{ id: string, sha256?: string | null }} event @param {{ add?: string[], remove?: string[], twoSided: boolean }} change */
export const eventScenesRequest = (bookId, event, { add = [], remove = [], twoSided }) =>
  eventFieldsRequest(bookId, event, {
    ...(add.length > 0 ? { add: { scenes: add } } : {}),
    ...(remove.length > 0 ? { remove: { scenes: remove } } : {}),
    two_sided: twoSided,
  });

/** @param {string} bookId @param {{ id: string, sha256?: string | null }} event */
export const eventArchiveRequest = (bookId, event) => ({
  method: /** @type {const} */ ('POST'),
  url: `${base(bookId)}/events/${enc(event.id)}/archive`,
  body: event.sha256 ? { base_sha256: event.sha256 } : {},
});

/** @param {string} bookId @param {{ id: string }} event */
export const eventRestoreRequest = (bookId, event) => ({ method: /** @type {const} */ ('POST'), url: `${base(bookId)}/events/${enc(event.id)}/restore`, body: {} });

/** GET <this> is the event with its `body` and `sha256`; PUT <this>/body saves the text. @param {string} bookId @param {string} eventId */
export const eventUrl = (bookId, eventId) => `${base(bookId)}/events/${enc(eventId)}`;

/** The refusal of an event write, in words the author can act on. @param {number} status @param {any} json */
export function explainTimelineFailure(status, json) {
  switch (json?.code) {
    case 'SLUG_TAKEN':
      return 'That slug is already used by another entry, thread or event. Choose a different one.';
    case 'REFUSED_UNKNOWN_EVENT':
      return 'That event is not there any more. Reload the page.';
    case 'REFUSED_UNKNOWN_SCENE':
      return 'That scene is not in the book any more. Reload the page.';
    case 'REFUSED_UNKNOWN_ENTRY':
      return 'That entry is not in the Codex any more. Reload the page.';
    case 'REFUSED_PATH_TAKEN':
      return 'A file with that name already exists. Nothing was changed.';
    default:
      break;
  }
  if (typeof json?.code === 'string' && (json.code.startsWith('REFUSED_UNSIMPLE') || json.code === 'ROLLED_BACK' || status === 409)) return explainCodexFailure(status, json);
  return explainFailure(status, json);
}

// The requests the Insights page sends: add, change or remove one goal (activity/goals.md). Nothing else is written from here.
import { sendRequest } from '../continuity/requests.js';
import { explainFailure } from '../structure/helpers.js';

export { sendRequest };
const enc = encodeURIComponent;

/** POST: add a goal, or change the one with this `id`. @param {string} bookId @param {{ id?: string, kind: string, target: number, period: string, due?: string, scope?: string }} goal */
export const setGoalRequest = (bookId, goal) => ({ method: /** @type {const} */ ('POST'), url: `/api/books/${enc(bookId)}/goals`, body: { goal } });

/** DELETE: remove one goal. @param {string} bookId @param {string} id */
export const removeGoalRequest = (bookId, id) => ({ method: /** @type {const} */ ('DELETE'), url: `/api/books/${enc(bookId)}/goals/${enc(id)}`, body: {} });

/** @param {number} status @param {any} json */
export const explainGoalFailure = (status, json) => (json?.code === 'BAD_ARGS' && json?.message ? json.message : explainFailure(status, json));

/**
 * The goal the form describes, or an error text. `values`: { kind, period, target, due, scope } as typed.
 * @param {{ id?: string, kind: string, period: string, target: string, due: string, scope: string }} values
 * @returns {{ ok: true, goal: { id?: string, kind: string, target: number, period: string, due?: string, scope?: string } } | { ok: false, message: string }}
 */
export function goalFromForm(values) {
  const target = /^\s*\d{1,9}\s*$/.test(values.target) ? Number(values.target) : NaN;
  if (!Number.isInteger(target) || target < 1) return { ok: false, message: 'The target is a whole number, 1 or more.' };
  if (values.due.trim() !== '' && values.period !== 'total') return { ok: false, message: 'A due date is only for a goal in total.' };
  if (values.due.trim() !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(values.due.trim())) return { ok: false, message: 'The due date looks like 2027-03-01.' };
  return {
    ok: true,
    goal: {
      ...(values.id ? { id: values.id } : {}),
      kind: values.kind, target, period: values.period,
      ...(values.due.trim() !== '' ? { due: values.due.trim() } : {}),
      ...(values.scope !== '' ? { scope: values.scope } : {}),
    },
  };
}

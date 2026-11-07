// The rule table and the fingerprint (contract M05-J01 sections 2.1 and 3).
import { createHash } from 'node:crypto';

/**
 * Every rule is at version 1. TH1 reports TH1a as an error and TH1b as info; the table lists the strongest.
 * The inputs to each fingerprint are named in `description`.
 * @type {readonly {id:string, version:number, title:string, severity:'error'|'warning'|'info', description:string}[]}
 */
export const RULES = Object.freeze([
  { id: 'CF1', version: 1, title: 'Fact conflict', severity: 'warning',
    description: 'A codex field (for example Eyes: Grey) and the text or a canon research note give different words for the same fact. Fingerprint: CF1, the entry, the entry and the scene or note, "label|value|other".' },
  { id: 'TL1', version: 1, title: 'Timeline impossibility', severity: 'error',
    description: 'TL1a: a dead or destroyed subject takes part in a later event ("dead|slug|later event"). TL1b: one character in two places at the same order ("place|slug|sorted events"). TL1c: an event with a higher order has an earlier date ("date|sorted events"). Fingerprint: TL1, the subject, the two events, the key.' },
  { id: 'KN1', version: 1, title: 'Character knowledge', severity: 'error',
    description: 'A character is asserted to know a fact (knows) before any event teaches it (learns). Fingerprint: KN1, the character, the knows event (and the later learns event if there is one), "knows|slug|fact".' },
  { id: 'ST1', version: 1, title: 'Possession and location state', severity: 'warning',
    description: 'ST1a: a lost object is held or placed before it is found ("lost|slug|using event"). ST1b: two holders for one object at the same order ("holders|slug|sorted events"). Fingerprint: ST1, the object, the two events, the key.' },
  { id: 'TH1', version: 1, title: 'Thread lifecycle', severity: 'error',
    description: 'TH1a (error): the first payoff scene comes before the first setup scene ("order|thread id"). TH1b (info): a planted, developed or open thread is never resolved by the end of the book ("open|thread id"). Fingerprint: TH1, the thread, its scenes (TH1a only), the key.' },
  { id: 'PL1', version: 1, title: 'Scene not in the flow', severity: 'info',
    description: 'A scene has no live planner link in or out, in a book that has at least one live link. Fingerprint: PL1, the scene, the scene, "unlinked|scene id".' },
  { id: 'PL2', version: 1, title: 'Transition not documented', severity: 'info',
    description: 'Two scenes next to each other in reading order each have links, but no live link joins them in either direction. Fingerprint: PL2, the earlier scene, both scenes, "transition|sorted scene ids".' },
  { id: 'PL3', version: 1, title: 'Beat with no scenes', severity: 'info',
    description: 'A beat in a live structure lists no scenes. Fingerprint: PL3, the structure, the beat, "beat|structure id|beat id".' },
  { id: 'PL4', version: 1, title: 'Payoff with no setup', severity: 'warning',
    description: 'A thread lists payoff scenes but no setup scenes. Fingerprint: PL4, the thread, the thread, "nosetup|thread id".' },
  { id: 'PL5', version: 1, title: 'Clue never revealed', severity: 'info',
    description: 'A clue (kind clue) has planted scenes, no revealed scene and is not a red herring. Fingerprint: PL5, the clue, the clue, "unrevealed|clue id".' },
  { id: 'PL6', version: 1, title: 'Revealed before it is planted', severity: 'warning',
    description: 'The revealed scene of a clue comes before its first planted scene in reading order. Fingerprint: PL6, the clue, the revealed scene and the first planted scene, "order|clue id".' },
]);

/**
 * "<rule lower-case>-<first 16 hex of sha256(JSON.stringify([rule, subjectId, ...sorted sourceIds, key]))>".
 * Never uses lines, columns, excerpts, paths or the rule version. Accepts positional or object arguments.
 * @param {string | { rule: string, subjectId: string, sourceIds: string[], key: string }} rule
 * @param {string} [subjectId]
 * @param {string[]} [sourceIds]
 * @param {string} [key]
 * @returns {string}
 */
export function fingerprintOf(rule, subjectId, sourceIds, key) {
  if (rule && typeof rule === 'object') ({ rule, subjectId, sourceIds, key } = rule);
  const ids = [...sourceIds].sort();
  const hex = createHash('sha256').update(JSON.stringify([rule, subjectId, ...ids, key])).digest('hex').slice(0, 16);
  return `${String(rule).toLowerCase()}-${hex}`;
}

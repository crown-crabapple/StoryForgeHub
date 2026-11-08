// TH1: thread lifecycle in book order (contract 3.5). TH2 (M12): a promise or question left open too many chapters after its setup.
import { fingerprintOf } from './rules.mjs';
import { DEFAULT_OVERDUE_CHAPTERS } from './settings.mjs';

const CLOSED = ['paid', 'dropped', 'abandoned'];

/**
 * @param {import('./model.mjs').Model} model
 * @returns {Promise<import('./engine.mjs').Finding[]>}
 */
export async function threadFindings(model, { overdueChapters = DEFAULT_OVERDUE_CHAPTERS } = {}) {
  /** @type {import('./engine.mjs').Finding[]} */
  const findings = [];
  const last = model.scenes.length ? model.scenes[model.scenes.length - 1].position : 0;
  const lastChapter = model.scenes.reduce((m, s) => (Number.isInteger(s.doc.fm.chapter) ? Math.max(m, s.doc.fm.chapter) : m), 0);

  for (const thread of model.threads) {
    const title = String(thread.fm.title ?? thread.fm.slug);
    const subject = { kind: 'thread', id: thread.fm.id, slug: thread.fm.slug, name: title };
    /** the earliest scene (in book order) a list field names @param {string} field */
    const earliest = (field) => {
      let best = null;
      for (const r of model.refs(thread, field)) {
        const position = model.positionOf.get(r.doc);
        if (position !== undefined && (!best || position < best.position)) best = { doc: r.doc, position };
      }
      return best;
    };
    const setup = earliest('setup');
    const payoff = earliest('payoff');

    // TH1a payoff before setup
    if (setup && payoff && payoff.position < setup.position) {
      const at = (s) => model.fmSource(s.doc, 'text', 'scene', 'title', ['title']);
      findings.push({
        fingerprint: fingerprintOf('TH1', thread.fm.id, [setup.doc.fm.id, payoff.doc.fm.id], `order|${thread.fm.id}`),
        rule: 'TH1', rule_version: 1, severity: 'error',
        title: `"${title}" is paid off before it is set up`,
        message: `The first payoff of "${title}" is "${payoff.doc.fm.title}" (scene ${payoff.position}), which comes before its first setup, "${setup.doc.fm.title}" (scene ${setup.position}).`,
        subject,
        sources: [await at(setup), await at(payoff)],
      });
    }

    // TH2 promise or question still open long after its setup
    if (['promise', 'question'].includes(thread.fm.kind) && !CLOSED.includes(thread.fm.status) && setup && Number.isInteger(setup.doc.fm.chapter)) {
      const x = setup.doc.fm.chapter;
      if (lastChapter - x > overdueChapters) {
        findings.push({
          fingerprint: fingerprintOf('TH2', thread.fm.id, [thread.fm.id], `overdue|${thread.fm.id}`),
          rule: 'TH2', rule_version: 1, severity: 'warning',
          title: `"${title}" is overdue`,
          message: `The ${thread.fm.kind} "${title}" is set up in chapter ${x} ("${setup.doc.fm.title}") and is still ${thread.fm.status}; the book now runs to chapter ${lastChapter}, ${lastChapter - x} chapters later (the limit is ${overdueChapters}). Pay it off, drop it or raise the limit in the continuity settings.`,
          subject,
          sources: [await model.fmSource(thread, 'thread', 'thread', 'status', ['status']), await model.fmSource(setup.doc, 'text', 'scene', 'title', ['title'])],
          related: [setup.doc.fm.id],
        });
      }
    }

    // TH1b never resolved
    if (['planted', 'developed', 'open'].includes(thread.fm.status) && last > 0) {
      let reach = 0;
      for (const field of ['setup', 'develop', 'payoff']) {
        for (const r of model.refs(thread, field)) reach = Math.max(reach, model.positionOf.get(r.doc) ?? 0);
      }
      for (const s of model.scenes) {
        if (model.refs(s.doc, 'plot_threads').some((r) => r.doc === thread)) reach = Math.max(reach, s.position);
      }
      if (last > reach) {
        findings.push({
          fingerprint: fingerprintOf('TH1', thread.fm.id, [thread.fm.id], `open|${thread.fm.id}`),
          rule: 'TH1', rule_version: 1, severity: 'info',
          title: `"${title}" is never resolved`,
          message: `"${title}" has status "${thread.fm.status}", but the book ends (scene ${last}) after the last scene it appears in${reach ? ` (scene ${reach})` : ''}. Mark it paid, dropped or unresolved if that is intended.`,
          subject,
          sources: [await model.fmSource(thread, 'thread', 'thread', 'status', ['status'])],
        });
      }
    }
  }
  return findings;
}

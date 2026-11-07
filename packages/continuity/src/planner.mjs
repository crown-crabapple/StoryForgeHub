// PL1-PL6: planner checks. They read only explicit structured records (links, structures, threads, clues), never prose.
import { fingerprintOf } from './rules.mjs';

/**
 * @param {import('./model.mjs').Model} model
 * @returns {Promise<import('./engine.mjs').Finding[]>}
 */
export async function plannerFindings(model) {
  /** @type {import('./engine.mjs').Finding[]} */
  const findings = [];
  const at = (s) => model.fmSource(s.doc, 'text', 'scene', 'title', ['title']);
  const nameOf = (s) => String(s.doc.fm.title ?? s.doc.fm.slug ?? s.doc.fm.id);

  // PL1 / PL2: only in a book that uses the flow. Only the main plan counts: a link with a branch (a what-if) is left out, so exploring a branch never creates notes.
  const mainLinks = model.links.filter((l) => !(typeof l.fm.branch === 'string' && l.fm.branch !== ''));
  if (mainLinks.length > 0) {
    /** @type {Set<string>} */
    const linked = new Set();
    /** @type {Set<string>} */
    const pairs = new Set();
    for (const l of mainLinks) {
      const { from, to } = l.fm;
      if (typeof from === 'string') linked.add(from);
      if (typeof to === 'string') linked.add(to);
      if (typeof from === 'string' && typeof to === 'string') {
        pairs.add(`${from}\0${to}`);
        pairs.add(`${to}\0${from}`);
      }
    }

    for (const s of model.scenes) {
      const sid = s.doc.fm.id;
      if (linked.has(sid)) continue;
      findings.push({
        fingerprint: fingerprintOf('PL1', sid, [sid], `unlinked|${sid}`),
        rule: 'PL1', rule_version: 1, severity: 'info',
        title: `"${nameOf(s)}" is not in the flow`,
        message: `No link in the planner goes into or out of "${nameOf(s)}" (scene ${s.position}). If it belongs in the flow, link it to the scenes around it.`,
        subject: { kind: 'scene', id: sid, slug: s.doc.fm.slug, name: nameOf(s) },
        related: [sid],
        sources: [await at(s)],
      });
    }

    for (let i = 0; i + 1 < model.scenes.length; i++) {
      const a = model.scenes[i];
      const b = model.scenes[i + 1];
      const aId = a.doc.fm.id;
      const bId = b.doc.fm.id;
      if (!linked.has(aId) || !linked.has(bId) || pairs.has(`${aId}\0${bId}`)) continue;
      findings.push({
        fingerprint: fingerprintOf('PL2', aId, [aId, bId], `transition|${[aId, bId].sort().join('|')}`),
        rule: 'PL2', rule_version: 1, severity: 'info',
        title: `Transition from "${nameOf(a)}" to "${nameOf(b)}" is not documented`,
        message: `"${nameOf(a)}" (scene ${a.position}) and "${nameOf(b)}" (scene ${b.position}) are next to each other, and both have links, but the link between them is not documented in the planner.`,
        subject: { kind: 'scene', id: aId, slug: a.doc.fm.slug, name: nameOf(a) },
        related: [aId, bId],
        sources: [await at(a), await at(b)],
      });
    }
  }

  // PL3: beats with no scenes (a beat marked omitted is skipped)
  for (const st of model.structures) {
    const sname = String(st.fm.name ?? st.fm.slug);
    const beats = Array.isArray(st.fm.beats) ? st.fm.beats : [];
    for (const beat of beats) {
      if (!beat || typeof beat !== 'object' || Array.isArray(beat) || typeof beat.id !== 'string') continue;
      if (beat.state === 'omitted') continue; // the author has left this beat out on purpose
      if (Array.isArray(beat.scenes) && beat.scenes.length > 0) continue;
      const bname = String(beat.name ?? beat.id);
      findings.push({
        fingerprint: fingerprintOf('PL3', st.fm.id, [beat.id], `beat|${st.fm.id}|${beat.id}`),
        rule: 'PL3', rule_version: 1, severity: 'info',
        title: `Beat "${bname}" in "${sname}" has no scenes`,
        message: `The beat "${bname}" in the structure "${sname}" does not list any scenes yet.`,
        subject: { kind: 'structure', id: st.fm.id, slug: st.fm.slug, name: sname },
        related: [beat.id],
        sources: [await model.fmSource(st, 'plan', 'structure', 'beats', ['beats'])],
      });
    }
  }

  // PL4: payoff with no setup
  for (const thread of model.threads) {
    if (model.refs(thread, 'payoff').length === 0 || model.refs(thread, 'setup').length > 0) continue;
    const title = String(thread.fm.title ?? thread.fm.slug);
    findings.push({
      fingerprint: fingerprintOf('PL4', thread.fm.id, [thread.fm.id], `nosetup|${thread.fm.id}`),
      rule: 'PL4', rule_version: 1, severity: 'warning',
      title: `"${title}" has a payoff but no setup`,
      message: `"${title}" lists payoff scenes but no setup scenes. Add the scene that plants it, or leave it if that is intended.`,
      subject: { kind: 'thread', id: thread.fm.id, slug: thread.fm.slug, name: title },
      related: [],
      sources: [await model.fmSource(thread, 'thread', 'thread', 'payoff', ['payoff'])],
    });
  }

  // PL5 / PL6: clues (a clue with no kind is a clue)
  const sceneById = new Map(model.scenes.map((s) => [s.doc.fm.id, s]));
  for (const clue of model.clues) {
    const fact = String(clue.fm.fact ?? clue.fm.slug);
    const subject = { kind: 'clue', id: clue.fm.id, slug: clue.fm.slug, name: fact };
    const planted = (Array.isArray(clue.fm.planted) ? clue.fm.planted : []).filter((s) => typeof s === 'string').map((id) => sceneById.get(id)).filter(Boolean);
    const revealed = typeof clue.fm.revealed === 'string' ? sceneById.get(clue.fm.revealed) : undefined;

    // PL5 clue never revealed
    const hasPlanted = Array.isArray(clue.fm.planted) && clue.fm.planted.some((s) => typeof s === 'string' && s !== '');
    const hasRevealed = typeof clue.fm.revealed === 'string' && clue.fm.revealed !== '';
    if ((clue.fm.kind ?? 'clue') === 'clue' && hasPlanted && !hasRevealed && clue.fm.red_herring !== true) {
      findings.push({
        fingerprint: fingerprintOf('PL5', clue.fm.id, [clue.fm.id], `unrevealed|${clue.fm.id}`),
        rule: 'PL5', rule_version: 1, severity: 'info',
        title: `"${fact}" is planted but never revealed`,
        message: `The clue "${fact}" is planted in the planner but no scene reveals it. Add the scene where the truth comes out, or mark it as a red herring if that is intended.`,
        subject,
        related: planted.map((x) => x.doc.fm.id),
        sources: [await model.fmSource(clue, 'plan', 'clue', 'planted', ['planted'])],
      });
    }

    // PL6 revealed before it is planted
    if (revealed && planted.length > 0) {
      const first = planted.reduce((a, b) => (b.position < a.position ? b : a));
      if (revealed.position < first.position) {
        const rId = revealed.doc.fm.id;
        const pId = first.doc.fm.id;
        findings.push({
          fingerprint: fingerprintOf('PL6', clue.fm.id, [rId, pId], `order|${clue.fm.id}`),
          rule: 'PL6', rule_version: 1, severity: 'warning',
          title: `"${fact}" is revealed before it is planted`,
          message: `The clue "${fact}" is revealed in "${nameOf(revealed)}" (scene ${revealed.position}), which comes before the first scene that plants it, "${nameOf(first)}" (scene ${first.position}).`,
          subject,
          related: [rId, pId],
          sources: [await model.fmSource(clue, 'plan', 'clue', 'revealed', ['revealed']), await model.fmSource(clue, 'plan', 'clue', 'planted', ['planted']), await at(revealed), await at(first)],
        });
      }
    }
  }
  return findings;
}

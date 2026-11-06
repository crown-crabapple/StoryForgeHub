// PL1-PL4: planner checks. They read only explicit structured records (links, structures, threads), never prose.
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

  // PL1 / PL2: only in a book that uses the flow
  if (model.links.length > 0) {
    /** @type {Set<string>} */
    const linked = new Set();
    /** @type {Set<string>} */
    const pairs = new Set();
    for (const l of model.links) {
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
      sources: [await model.fmSource(thread, 'thread', 'thread', 'payoff', ['payoff'])],
    });
  }
  return findings;
}

// TL1 (timeline impossibilities), KN1 (character knowledge) and ST1 (possession and location state) - contract 3.2 to 3.4.
// All three read the events in chronological order (FORMAT-v1 6.2) and their `state` items.
import { fingerprintOf } from './rules.mjs';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const has = (value, type) => value && value.fm.type === type;

/**
 * @typedef {{ event: import('@storyforge/format').Doc, index: number, kind: string, entry: import('@storyforge/format').Doc,
 *   value: import('@storyforge/format').Doc | string | null, order: number }} StateItem
 */

/**
 * The usable `state` items of every canonical event, in chronological order. An item the validator already reports
 * (unknown event word, unresolved or wrong-type slug) is left out.
 * @param {import('./model.mjs').Model} model
 * @returns {StateItem[]}
 */
export function stateItems(model) {
  /** @type {StateItem[]} */
  const out = [];
  for (const event of model.events) {
    if (!Array.isArray(event.fm.state)) continue;
    event.fm.state.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.event !== 'string') return;
      const entry = model.ref(event, `state[${index}].slug`);
      if (!entry || entry.kind !== 'entry') return;
      const kind = raw.event;
      let value = null;
      if (kind === 'died' || kind === 'revived') {
        if (!has(entry, 'character')) return;
      } else if (kind === 'holder') {
        if (!has(entry, 'object')) return;
        if (raw.value !== '') {
          value = model.ref(event, `state[${index}].value`);
          if (!has(value, 'character')) return;
        }
      } else if (kind === 'location') {
        if (!has(entry, 'character') && !has(entry, 'object')) return;
        value = model.ref(event, `state[${index}].value`);
        if (!has(value, 'location')) return;
      } else if (kind === 'learns' || kind === 'knows') {
        if (!has(entry, 'character') || typeof raw.value !== 'string') return;
        value = raw.value;
      } else if (!['destroyed', 'lost', 'found'].includes(kind)) return;
      out.push({ event, index, kind, entry, value, order: event.fm.order });
    });
  }
  return out;
}

const nameOf = (d) => String(d.fm.name ?? d.fm.slug);
const subjectOf = (d) => ({ kind: 'entry', id: d.fm.id, slug: d.fm.slug, name: nameOf(d) });

/**
 * @param {import('./model.mjs').Model} model
 * @returns {Promise<import('./engine.mjs').Finding[]>}
 */
export async function timelineFindings(model) {
  const items = stateItems(model);
  /** @type {import('./engine.mjs').Finding[]} */
  const findings = [];
  const stateSource = (it, role = 'event') => model.fmSource(it.event, role, 'event', `state[${it.index}]`, ['state', it.index]);

  // ---------------------------------------------------------------- TL1a dead or destroyed, then present
  /** @type {Map<import('@storyforge/format').Doc, StateItem[]>} */
  const byEntry = new Map();
  for (const it of items) {
    if (!byEntry.has(it.entry)) byEntry.set(it.entry, []);
    byEntry.get(it.entry).push(it);
  }
  for (const [entry, list] of byEntry) {
    const isCharacter = has(entry, 'character');
    const ending = list.filter((i) => i.kind === (isCharacter ? 'died' : 'destroyed'));
    if (ending.length === 0) continue;
    const revivals = list.filter((i) => i.kind === 'revived');
    for (const later of model.events) {
      // the latest death before this event with no revival between that death and this event
      const gone = [...ending].reverse().find((d) => d.order < later.fm.order && !revivals.some((r) => r.order > d.order && r.order <= later.fm.order));
      if (!gone) continue;
      let evidence = null;
      const inList = model.refs(later, 'characters').find((r) => r.doc === entry);
      if (isCharacter && inList) {
        evidence = { source: () => model.fmSource(later, 'event', 'event', `characters[${inList.index}]`, ['characters', inList.index]) };
      }
      if (!evidence) {
        const used = items.find((i) => i.event === later && i.entry === entry && i.kind !== 'revived' && i.kind !== (isCharacter ? 'died' : 'destroyed'));
        if (used) evidence = { source: () => stateSource(used) };
      }
      /** @type {import('./model.mjs').Source|null} */
      let sceneSource = null;
      if (!evidence) {
        for (const s of model.eventScenes.get(later) ?? []) {
          const fields = isCharacter ? ['pov', 'characters'] : ['characters', 'locations'];
          for (const f of fields) {
            const hit = f === 'pov' ? (model.ref(s.doc, 'pov') === entry ? { index: -1 } : null) : model.refs(s.doc, f).find((r) => r.doc === entry);
            if (!hit) continue;
            const where = hit.index < 0 ? 'pov' : `${f}[${hit.index}]`;
            sceneSource = await model.fmSource(s.doc, 'text', 'scene', where, hit.index < 0 ? ['pov'] : [f, hit.index]);
            break;
          }
          if (sceneSource) break;
        }
        if (!sceneSource) continue;
        const sc = sceneSource;
        const eventScenesIdx = Array.isArray(later.fm.scenes) ? later.fm.scenes.findIndex((_, i) => model.ref(later, `scenes[${i}]`)?.fm.id === sc.id) : -1;
        evidence = { source: () => (eventScenesIdx >= 0
          ? model.fmSource(later, 'event', 'event', `scenes[${eventScenesIdx}]`, ['scenes', eventScenesIdx])
          : model.fmSource(later, 'event', 'event', 'title', ['title'])) };
      }
      const name = nameOf(entry);
      const sources = [await stateSource(gone, 'event'), await evidence.source()];
      if (sceneSource) sources.push(sceneSource);
      findings.push({
        fingerprint: fingerprintOf('TL1', entry.fm.id, [gone.event.fm.id, later.fm.id], `dead|${entry.fm.slug}|${later.fm.id}`),
        rule: 'TL1', rule_version: 1, severity: 'error',
        title: isCharacter ? `${name} takes part in "${later.fm.title}" after dying` : `${name} is used in "${later.fm.title}" after being destroyed`,
        message: `${name} ${isCharacter ? 'died' : 'was destroyed'} at "${gone.event.fm.title}" (order ${gone.order}) but ${isCharacter ? 'is present' : 'is used'} at "${later.fm.title}" (order ${later.fm.order}) with no revival in between.`,
        subject: subjectOf(entry),
        sources,
      });
    }
  }

  // ---------------------------------------------------------------- TL1b in two places at once
  /** @param {import('@storyforge/format').Doc} event @returns {Map<import('@storyforge/format').Doc, {place: import('@storyforge/format').Doc, path: (string|number)[], location: string}>} */
  const placesOf = (event) => {
    /** @type {Map<import('@storyforge/format').Doc, any>} */
    const m = new Map();
    for (const it of items) {
      if (it.event === event && it.kind === 'location' && has(it.entry, 'character') && !m.has(it.entry)) {
        m.set(it.entry, { place: it.value, path: ['state', it.index], location: `state[${it.index}]` });
      }
    }
    const locations = model.refs(event, 'locations');
    if (locations.length === 1) {
      for (const c of model.refs(event, 'characters')) {
        if (has(c.doc, 'character') && !m.has(c.doc)) m.set(c.doc, { place: locations[0].doc, path: ['locations', locations[0].index], location: `locations[${locations[0].index}]` });
      }
    }
    return m;
  };
  for (let i = 0; i < model.events.length; i++) {
    for (let j = i + 1; j < model.events.length && model.events[j].fm.order === model.events[i].fm.order; j++) {
      const a = model.events[i];
      const b = model.events[j];
      const pa = placesOf(a);
      const pb = placesOf(b);
      for (const [character, here] of pa) {
        const there = pb.get(character);
        if (!there || there.place === here.place) continue;
        findings.push({
          fingerprint: fingerprintOf('TL1', character.fm.id, [a.fm.id, b.fm.id], `place|${character.fm.slug}|${[a.fm.id, b.fm.id].sort().join(',')}`),
          rule: 'TL1', rule_version: 1, severity: 'error',
          title: `${nameOf(character)} is in two places at order ${a.fm.order}`,
          message: `${nameOf(character)} is at ${nameOf(here.place)} in "${a.fm.title}" and at ${nameOf(there.place)} in "${b.fm.title}", and both events have order ${a.fm.order}.`,
          subject: subjectOf(character),
          sources: [await model.fmSource(a, 'event', 'event', here.location, here.path), await model.fmSource(b, 'event', 'event', there.location, there.path)],
        });
      }
    }
  }

  // ---------------------------------------------------------------- TL1c a date runs backwards
  const dated = model.events
    .map((event) => ({ event, date: event.fm.date === undefined || event.fm.date === null || event.fm.date === '' ? null : String(event.fm.date) }))
    .filter((x) => x.date !== null);
  for (let j = 0; j < dated.length; j++) {
    const later = dated[j];
    /** the earlier-ordered event whose date is furthest ahead of this one */
    let worst = null;
    for (let i = 0; i < j; i++) {
      const earlier = dated[i];
      if (earlier.event.fm.order >= later.event.fm.order) continue;
      const n = Math.min(earlier.date.length, later.date.length);
      if (earlier.date.slice(0, n) <= later.date.slice(0, n)) continue;
      if (!worst || earlier.date.slice(0, n) > worst.date.slice(0, Math.min(worst.date.length, n))) worst = earlier;
    }
    if (!worst) continue;
    const ids = [worst.event.fm.id, later.event.fm.id];
    findings.push({
      fingerprint: fingerprintOf('TL1', later.event.fm.id, ids, `date|${[...ids].sort().join(',')}`),
      rule: 'TL1', rule_version: 1, severity: 'error',
      title: `"${later.event.fm.title}" is dated before "${worst.event.fm.title}" but comes after it`,
      message: `"${worst.event.fm.title}" (order ${worst.event.fm.order}) is dated ${worst.date}, but "${later.event.fm.title}" (order ${later.event.fm.order}) is dated ${later.date}.`,
      subject: { kind: 'event', id: later.event.fm.id, slug: later.event.fm.slug, name: String(later.event.fm.title) },
      sources: [await model.fmSource(worst.event, 'event', 'event', 'date', ['date']), await model.fmSource(later.event, 'event', 'event', 'date', ['date'])],
    });
  }

  // ---------------------------------------------------------------- KN1 knows before learns
  for (const k of items.filter((i) => i.kind === 'knows')) {
    const learns = items.filter((i) => i.kind === 'learns' && i.entry === k.entry && i.value === k.value);
    if (learns.some((l) => l.order <= k.order)) continue;
    const later = learns[0] ?? null;
    const sources = [await stateSource(k)];
    if (later) sources.push(await stateSource(later));
    findings.push({
      fingerprint: fingerprintOf('KN1', k.entry.fm.id, sources.map((s) => s.id), `knows|${k.entry.fm.slug}|${k.value}`),
      rule: 'KN1', rule_version: 1, severity: 'error',
      title: `${nameOf(k.entry)} knows "${k.value}" before learning it`,
      message: `"${k.event.fm.title}" (order ${k.order}) says ${nameOf(k.entry)} knows "${k.value}"; ${later ? `the event that teaches it, "${later.event.fm.title}", is at order ${later.order}` : 'no event teaches it'}.`,
      subject: subjectOf(k.entry),
      sources,
    });
  }

  // ---------------------------------------------------------------- ST1a lost, then used
  for (const [entry, list] of byEntry) {
    if (!has(entry, 'object')) continue;
    const finds = list.filter((i) => i.kind === 'found');
    for (const use of list) {
      if (!(use.kind === 'location' || (use.kind === 'holder' && use.value !== null))) continue;
      const lost = [...list].reverse().find((l) => l.kind === 'lost' && l.order < use.order && !finds.some((f) => f.order > l.order && f.order <= use.order));
      if (!lost) continue;
      findings.push({
        fingerprint: fingerprintOf('ST1', entry.fm.id, [lost.event.fm.id, use.event.fm.id], `lost|${entry.fm.slug}|${use.event.fm.id}`),
        rule: 'ST1', rule_version: 1, severity: 'warning',
        title: `${nameOf(entry)} is used after being lost`,
        message: `${nameOf(entry)} is lost at "${lost.event.fm.title}" (order ${lost.order}) and not found again, but "${use.event.fm.title}" (order ${use.order}) gives it ${use.kind === 'holder' ? `a holder (${nameOf(use.value)})` : `a location (${nameOf(use.value)})`}.`,
        subject: subjectOf(entry),
        sources: [await stateSource(lost), await stateSource(use)],
      });
    }
  }

  // ---------------------------------------------------------------- ST1b two holders at once
  for (const [entry, list] of byEntry) {
    const holders = list.filter((i) => i.kind === 'holder' && i.value !== null);
    for (let i = 0; i < holders.length; i++) {
      for (let j = i + 1; j < holders.length; j++) {
        const a = holders[i];
        const b = holders[j];
        if (a.order !== b.order || a.event === b.event || a.value === b.value) continue;
        const ids = [a.event.fm.id, b.event.fm.id];
        findings.push({
          fingerprint: fingerprintOf('ST1', entry.fm.id, ids, `holders|${entry.fm.slug}|${[...ids].sort().join(',')}`),
          rule: 'ST1', rule_version: 1, severity: 'warning',
          title: `${nameOf(entry)} has two holders at order ${a.order}`,
          message: `${nameOf(entry)} is held by ${nameOf(a.value)} in "${a.event.fm.title}" and by ${nameOf(b.value)} in "${b.event.fm.title}", and both events have order ${a.order}.`,
          subject: subjectOf(entry),
          sources: [await stateSource(a), await stateSource(b)],
        });
      }
    }
  }

  const seen = new Set();
  return findings.filter((f) => !seen.has(f.fingerprint) && seen.add(f.fingerprint)).sort((x, y) => cmp(x.fingerprint, y.fingerprint));
}

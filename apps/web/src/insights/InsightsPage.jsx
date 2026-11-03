import { useState } from 'react';
import { Link } from '../router.jsx';
import { TimerPanel } from '../writing/TimerPanel.jsx';
import { BarList, ChartFrame, ColumnChart, DataTable, HeatMap, ThreadMatrix } from './charts.jsx';
import { GoalsPanel } from './GoalsPanel.jsx';
import {
  cellScenes, chapterName, insightsHref, chapterRows, chapterShort, codexHref, dayRows, eventRows, fmt, heatTable, labelRows, lastDays, outlineHref, outlineStatusHref, povRows, sceneHref, statusRows,
  tasksHref, threadHref, threadTable, timelineHref,
} from './model.js';

/** The scenes behind one heat-map cell, each a link into the manuscript, and a link to the entry. */
function CellDetail({ bookId, data, selected, entries, chapters }) {
  const row = data.story.characters.rows.find((r) => r.id === selected.id);
  const chapter = data.story.chapters.find((c) => c.chapter === selected.chapter);
  if (!row || !chapter) return null;
  const count = row.cells[data.story.chapters.indexOf(chapter)] ?? 0;
  const scenes = entries ? cellScenes(entries, chapters, selected.id, selected.chapter) : null;
  return (
    <div className="ins-cell-detail" role="region" aria-label={`Scenes: ${row.name} in ${chapterShort(chapter)}`}>
      <p>
        <strong>
          {row.name} in {chapterName(chapter)}
        </strong>
        : {count} {count === 1 ? 'scene' : 'scenes'}
      </p>
      {scenes === null ? (
        <p className="muted">Loading the scenes…</p>
      ) : scenes.length === 0 ? (
        <p className="muted">The Codex does not list the scenes for this cell yet. Open the entry to see where it appears.</p>
      ) : (
        <ul className="ins-scene-links">
          {scenes.map((s) => (
            <li key={s.id}>
              <Link to={sceneHref(bookId, s.id)}>{s.title}</Link>
            </li>
          ))}
        </ul>
      )}
      <p>
        <Link to={codexHref(bookId, { entry: selected.id })}>Open {row.name} in the Codex</Link>
      </p>
    </div>
  );
}

/** Words per day: the last 30 or 90 days, as columns, with the table form. */
function DaysChart({ days }) {
  const [range, setRange] = useState(30);
  const shown = lastDays(days, range);
  return (
    <section className="ins-chart" aria-labelledby="ins-days-h">
      <div className="ins-chart-head">
        <h3 id="ins-days-h">Words per day</h3>
        <div className="ins-range" role="group" aria-label="Days shown">
          {[30, 90].map((n) => (
            <button key={n} type="button" className="btn btn-small" aria-pressed={range === n ? 'true' : 'false'} onClick={() => setRange(n)}>
              {n} days
            </button>
          ))}
        </div>
      </div>
      <DaysFrame key={range} shown={shown} range={range} />
    </section>
  );
}

function DaysFrame({ shown, range }) {
  const [asTable, setAsTable] = useState(false);
  const total = shown.reduce((n, d) => n + d.net, 0);
  return (
    <>
      <p className="muted ins-note">
        Net words (added minus removed) per day from the writing log: {fmt(total)} in the last {range} days.{' '}
        <button type="button" className="btn btn-small" aria-pressed={asTable ? 'true' : 'false'} onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'Show as chart' : 'Show as table'}
        </button>
      </p>
      {asTable ? (
        <DataTable caption={`Words per day, the last ${range} days`} head={['Date', 'Net words', 'Added', 'Removed', 'Minutes']} rows={dayRows(shown)} />
      ) : (
        <ColumnChart
          label={`Net words per day over the last ${range} days. Use the table for the same facts.`}
          items={shown.map((d) => ({ key: d.date, label: d.date.slice(5), value: Math.max(0, d.net), name: `${d.date}: ${fmt(d.net)} net words, ${fmt(d.minutes)} minutes` }))}
          tickLabel={(it) => it.label}
        />
      )}
    </>
  );
}

/**
 * The Insights page (/books/:id/insights): Progress, Manuscript, Story, Tasks. Every number comes from GET /insights; every chart has "Show as table", and its elements link to their
 * source. Presentational: the fetching view hands everything in.
 * @param {{ bookId: string, data: any, entries?: any[] | null, entryChapters?: any[] | null,
 *   goalHandlers?: { onAdd?: () => void, onRemove?: (goal: any) => void }, extra?: import('react').ReactNode, cell?: { id: string, chapter: number } | null }} props
 * `cell` is the heat-map cell the URL selected (?cell=<entry id>:<chapter>); its scenes are named from `entries` (the Codex answer, loaded by the view).
 */
export function InsightsPage({ bookId, data, entries = null, entryChapters = null, goalHandlers = {}, extra = null, cell = null }) {
  const m = data.manuscript;
  const s = data.story;
  const wordsLabel = data.book.word_target ? `${fmt(data.book.words)} of ${fmt(data.book.word_target)} words` : `${fmt(data.book.words)} words`;
  const statusTotal = m.status.reduce((n, x) => n + x.scenes, 0);
  return (
    <main id="main" tabIndex={-1} className="page ins-page">
      <h1>Insights</h1>
      <p className="muted">
        {data.book.title ?? 'This book'}: {wordsLabel} in {fmt(data.book.scenes)} {data.book.scenes === 1 ? 'scene' : 'scenes'}. Computed from your files; nothing here is stored anywhere else.
      </p>

      <section aria-labelledby="ins-progress-h">
        <h2 id="ins-progress-h">Progress</h2>
        <GoalsPanel goals={data.progress.goals} onAdd={goalHandlers.onAdd} onRemove={goalHandlers.onRemove} />
        <TimerPanel bookId={bookId} />
        <DaysChart days={data.progress.days} />
      </section>

      <section aria-labelledby="ins-manuscript-h">
        <h2 id="ins-manuscript-h">Manuscript</h2>
        <ChartFrame
          id="ins-chapters"
          title="Words per chapter"
          empty={m.chapters.length === 0 ? 'No chapters yet.' : null}
          chart={
            <ColumnChart
              label="Words in each chapter. Each column opens the outline. Use the table for the same facts."
              items={m.chapters.map((c) => ({ key: `${c.act}/${c.chapter}`, label: chapterShort(c), value: c.words, href: outlineHref(bookId), name: `${chapterName(c)}: ${fmt(c.words)} words in ${c.scenes} ${c.scenes === 1 ? 'scene' : 'scenes'}` }))}
              tickLabel={(it) => it.label}
            />
          }
          table={<DataTable caption="Words and scenes in each chapter" head={['Chapter', 'Words', 'Scenes', 'Final']} rows={chapterRows(data)} />}
        />
        <ChartFrame
          id="ins-scenes"
          title="Words per scene"
          empty={m.scenes.length === 0 ? 'No scenes yet.' : null}
          chart={
            <ColumnChart
              label="Words in each scene, in book order. Each column opens the scene. Use the table for the same facts."
              items={m.scenes.map((x) => ({ key: x.id, label: String(x.position), value: x.words, href: sceneHref(bookId, x.id), name: `${x.title ?? 'Untitled scene'}: ${fmt(x.words)} words` }))}
              tickLabel={(it) => it.label}
            />
          }
          table={<DataTable caption="Words in each scene, in book order" head={['Scene', 'Words', 'Status']} rows={m.scenes.map((x) => [x.title ?? 'Untitled scene', x.words, x.status ?? ''])} />}
        />
        <ChartFrame
          id="ins-status"
          title="Scenes by status"
          empty={statusTotal === 0 ? 'No scenes yet.' : null}
          chart={
            <BarList
              label="Scenes by status. Each bar opens the outline filtered to that status. Use the table for the same facts."
              rows={m.status.map((x) => ({ key: x.status, label: x.status, value: x.scenes, text: `${x.scenes} (${fmt(x.words)} words)`, href: outlineStatusHref(bookId, x.status), name: `${x.status}: ${x.scenes} ${x.scenes === 1 ? 'scene' : 'scenes'}. Open them in the outline` }))}
            />
          }
          table={<DataTable caption="Scenes and words by status" head={['Status', 'Scenes', 'Words']} rows={statusRows(data)} />}
        />
        <ChartFrame
          id="ins-labels"
          title="Scenes by label"
          note={m.labels.unlabeled > 0 ? `${m.labels.unlabeled} ${m.labels.unlabeled === 1 ? 'scene has' : 'scenes have'} no label.` : ''}
          empty={m.labels.rows.length === 0 ? 'No labels are used yet. Labels are set on scenes and defined in the book or its series.' : null}
          chart={<BarList label="Scenes by label. Use the table for the same facts." rows={m.labels.rows.map((l) => ({ key: l.label, label: l.label, value: l.scenes, text: `${l.scenes}`, name: `${l.label}: ${l.scenes} ${l.scenes === 1 ? 'scene' : 'scenes'}${l.defined ? '' : ', label not defined'}` }))} />}
          table={<DataTable caption="Scenes and words by label" head={['Label', 'Scenes', 'Words', 'Note']} rows={labelRows(data)} />}
        />
        <ChartFrame
          id="ins-pov"
          title="Point of view, by words"
          empty={m.pov.length === 0 ? 'No scenes yet.' : null}
          chart={
            <BarList
              label="Share of the words by point of view. A bar opens that character in the Codex. Use the table for the same facts."
              rows={m.pov.map((p, i) => ({ key: `${p.id ?? 'none'}|${i}`, label: `${p.name ?? '(no POV)'}${p.shared ? ' ◆' : ''}`, value: p.words, text: `${p.share}%`, href: p.id ? codexHref(bookId, { entry: p.id }) : null, name: `${p.name ?? 'No POV'}${p.shared ? ' (series entry)' : ''}: ${p.share} percent of the words, ${p.scenes} ${p.scenes === 1 ? 'scene' : 'scenes'}` }))}
            />
          }
          table={<DataTable caption="Scenes, words and share of the words by point of view" head={['POV', 'Scenes', 'Words', 'Share']} rows={povRows(data)} />}
        />
      </section>

      <section aria-labelledby="ins-story-h">
        <h2 id="ins-story-h">Story</h2>
        <ChartFrame
          id="ins-heat"
          title="Character appearances by chapter"
          note={`${s.characters.rows.length} ${s.characters.rows.length === 1 ? 'character appears' : 'characters appear'} in scenes${s.characters.without_scenes ? `; ${s.characters.without_scenes} not yet` : ''}. ◆ marks an entry shared by the series.`}
          empty={s.characters.rows.length === 0 ? 'No character is linked to a scene yet.' : null}
          chart={
            <>
              <HeatMap
                bookId={bookId}
                chapters={s.chapters}
                rows={s.characters.rows}
                selected={cell}
                cellHref={(id, chapter) => insightsHref(bookId, { cell: { id, chapter } })}
                chapterShort={chapterShort}
                entryHref={(id) => codexHref(bookId, { entry: id })}
              />
              {cell && <CellDetail bookId={bookId} data={data} selected={cell} entries={entries} chapters={entryChapters} />}
            </>
          }
          table={<DataTable caption="Scenes per character per chapter" head={heatTable(data).head} rows={heatTable(data).rows} />}
        />
        <ChartFrame
          id="ins-threads"
          title="Plot threads by chapter"
          empty={s.threads.rows.length === 0 ? 'No plot threads yet.' : null}
          chart={<ThreadMatrix chapters={s.chapters} rows={s.threads.rows} threadHref={(id) => threadHref(bookId, id)} />}
          table={<DataTable caption="Scenes where each thread is planted, developed and paid" head={threadTable(data).head} rows={threadTable(data).rows} />}
        />
        <ChartFrame
          id="ins-rel"
          title="Relationships per character"
          empty={s.relationships.length === 0 ? 'No entry names a relationship yet.' : null}
          chart={
            <BarList
              label="Relationships per character. A bar opens that character in the Codex. Use the table for the same facts."
              rows={s.relationships.map((r) => ({ key: r.id, label: `${r.name}${r.shared ? ' ◆' : ''}`, value: r.count, href: codexHref(bookId, { entry: r.id }), name: `${r.name}${r.shared ? ' (series entry)' : ''}: ${r.count} ${r.count === 1 ? 'relationship' : 'relationships'}` }))}
            />
          }
          table={<DataTable caption="Relationships per character" head={['Character', 'Relationships']} rows={s.relationships.map((r) => [r.shared ? `${r.name} (series)` : r.name, r.count])} />}
        />
        <ChartFrame
          id="ins-events"
          title="Timeline events by chapter"
          note={`${s.events.total} ${s.events.total === 1 ? 'event' : 'events'}${s.events.unplaced ? `, ${s.events.unplaced} not linked to a scene` : ''}.`}
          empty={s.events.total === 0 ? 'No events yet.' : null}
          chart={
            <ColumnChart
              label="Timeline events in each chapter. Each column opens the timeline. Use the table for the same facts."
              items={s.events.by_chapter.map((c) => ({ key: `${c.act}/${c.chapter}`, label: chapterShort(c), value: c.events, href: timelineHref(bookId), name: `${chapterName(c)}: ${c.events} ${c.events === 1 ? 'event' : 'events'}` }))}
              tickLabel={(it) => it.label}
            />
          }
          table={<DataTable caption="Timeline events in each chapter" head={['Chapter', 'Events']} rows={eventRows(data)} />}
        />
      </section>

      <section aria-labelledby="ins-tasks-h">
        <h2 id="ins-tasks-h">Revision tasks</h2>
        <ul className="ins-task-counts" aria-label="Tasks by status">
          {['open', 'doing', 'done', 'dropped'].map((k) => (
            <li key={k}>
              <Link to={tasksHref(bookId, { status: k })}>
                {data.tasks[k]} {k}
              </Link>
            </li>
          ))}
        </ul>
        <p>
          <Link to={tasksHref(bookId)}>All {data.tasks.total} {data.tasks.total === 1 ? 'task' : 'tasks'}</Link>
        </p>
      </section>
      {extra}
    </main>
  );
}

import { CHAPTER_STARTS, FONTS, MARGINS, SCENE_BREAKS, TEXT_LIMITS, TRIMS } from './requests.js';

/** @param {{ id: string, label: string, value: string | number, onChange: (v: string) => void, min: number, max: number, step: number, problem?: string }} props */
function NumberField({ id, label, value, onChange, min, max, step, problem }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="number" inputMode="decimal" min={min} max={max} step={step} value={value} aria-invalid={problem ? 'true' : undefined} aria-describedby={problem ? `${id}-problem` : undefined} onChange={(e) => onChange(e.target.value)} />
      {problem && (
        <p role="alert" className="field-error" id={`${id}-problem`}>
          {problem}
        </p>
      )}
    </div>
  );
}

/** @param {{ id: string, label: string, value: string, options: { key: string, label: string }[], onChange: (v: string) => void }} props */
function SelectField({ id, label, value, options, onChange }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** @param {{ id: string, label: string, value: string, limit: number, hint?: string, onChange: (v: string) => void }} props */
function TextField({ id, label, value, limit, hint, onChange }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} rows={3} maxLength={limit} value={value} aria-describedby={hint ? `${id}-hint` : undefined} onChange={(e) => onChange(e.target.value)} />
      {hint && (
        <p className="secondary field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * The controls for every interior setting (contract section 2). Pure: it shows `layout` and calls `onChange(patch)`; the page saves and previews. `problems` are the checks of
 * layoutProblems (field names), each shown next to its field.
 * @param {{ layout: Record<string, any>, onChange: (patch: Record<string, any>) => void, problems?: { field: string, message: string }[] }} props
 */
export function InteriorControls({ layout, onChange, problems = [] }) {
  const problem = (/** @type {string} */ field) => problems.find((p) => p.field === field)?.message;
  const margins = layout.margins ?? {};
  return (
    <form className="interior-controls" aria-label="Book interior settings" onSubmit={(e) => e.preventDefault()} noValidate>
      <SelectField id="interior-trim" label="Trim size" value={layout.trim} options={TRIMS} onChange={(trim) => onChange({ trim })} />
      <SelectField id="interior-font" label="Font" value={layout.font} options={FONTS} onChange={(font) => onChange({ font })} />
      <NumberField id="interior-font-size" label="Font size (points)" value={layout.fontSize} min={9} max={14} step={0.5} problem={problem('fontSize')} onChange={(fontSize) => onChange({ fontSize })} />
      <NumberField id="interior-line-height" label="Line spacing" value={layout.lineHeight} min={1.1} max={1.8} step={0.05} problem={problem('lineHeight')} onChange={(lineHeight) => onChange({ lineHeight })} />
      <fieldset className="field">
        <legend>Margins (inches)</legend>
        {MARGINS.map((m) => (
          <NumberField
            key={m.key}
            id={`interior-margin-${m.key}`}
            label={m.label}
            value={margins[m.key] ?? ''}
            min={0.25}
            max={1.5}
            step={0.05}
            problem={problem(`margin-${m.key}`)}
            onChange={(v) => onChange({ margins: { ...margins, [m.key]: v } })}
          />
        ))}
      </fieldset>
      <SelectField id="interior-chapter-start" label="Chapters start" value={layout.chapterStart} options={CHAPTER_STARTS} onChange={(chapterStart) => onChange({ chapterStart })} />
      <SelectField id="interior-scene-break" label="Scene break" value={layout.sceneBreak} options={SCENE_BREAKS} onChange={(sceneBreak) => onChange({ sceneBreak })} />
      <div className="field">
        <label className="choice">
          <input type="checkbox" checked={layout.runningHeads === true} onChange={(e) => onChange({ runningHeads: e.target.checked })} />
          <span>Running heads (book title on left pages, chapter title on right pages)</span>
        </label>
        <label className="choice">
          <input type="checkbox" checked={layout.pageNumbers === true} onChange={(e) => onChange({ pageNumbers: e.target.checked })} />
          <span>Page numbers</span>
        </label>
      </div>
      <TextField
        id="interior-copyright"
        label="Copyright page text"
        value={layout.frontMatter?.copyright ?? ''}
        limit={TEXT_LIMITS.copyright}
        hint="Plain text. Left empty, the page says Copyright, the year and the author."
        onChange={(copyright) => onChange({ frontMatter: { ...layout.frontMatter, copyright } })}
      />
      <TextField
        id="interior-dedication"
        label="Dedication"
        value={layout.frontMatter?.dedication ?? ''}
        limit={TEXT_LIMITS.dedication}
        hint="Plain text. Left empty, there is no dedication page."
        onChange={(dedication) => onChange({ frontMatter: { ...layout.frontMatter, dedication } })}
      />
      <TextField
        id="interior-about-author"
        label="About the author"
        value={layout.backMatter?.aboutAuthor ?? ''}
        limit={TEXT_LIMITS.aboutAuthor}
        hint="Plain text paragraphs. Left empty, there is no page at the back."
        onChange={(aboutAuthor) => onChange({ backMatter: { ...layout.backMatter, aboutAuthor } })}
      />
    </form>
  );
}

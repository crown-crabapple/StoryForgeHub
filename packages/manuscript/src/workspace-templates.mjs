// Starter text of the workspace docs `setupWorkspace` creates (M12 W2): the book settings doc, the style guide and the "before chapter 1" state docs.
// Structure (headings and field names) follows the Claude-Book templates; the guidance text is generic. Planning material, never prose.

export const BOOK_TEMPLATE = `# Book settings

- **Title:** [the full title]
- **Language:** [for example en]
- **Point of view and tense:** [for example close third person, past tense]
- **Chapter length:** [minimum]-[maximum] words
- **Next chapter:** [number]

## Writing checks
- **Variant:** [spelling variant, for example en-US]
- **Reading level:** [elementary | middle | high school | college | graduate]
- **Tone:** [casual | professional | academic]
- **Maximum revision passes:** 3
- **Voice matching:** [on | off]

## Notes used as sources
- [note name]: [what it provides, for example style, plan, decisions log]

## Open questions for the author
- [anything the assistant could not settle on its own]
`;

export const STYLE_TEMPLATE = `# Style guide

## Narrative voice

### Point of view
- [ ] First person
- [ ] Third person limited (focused on: ...)
- [ ] Third person omniscient
- [ ] Multiple points of view (which characters: ...)

### Tense
- Primary tense: [for example past simple]
- Other tenses: [for example past perfect for flashbacks]

### Narrator tone
[Distant or intimate, serious or playful, formal or casual.]

---

## Language and vocabulary

### Register
[Formal, standard, casual, childlike, archaic.]

### Period and setting language
- Target period or place: [...]
- Words and phrases to avoid: [...]
- Words and phrases to prefer: [...]

### Characteristic expressions
- [expression]
- [expression]

---

## Sentence structure

### Length
- Target: [for example 15-25 words per sentence]
- Maximum: [for example 40 words]

### Complexity
- [ ] Simple sentences preferred
- [ ] Compound sentences allowed
- [ ] Nested clauses allowed

### Rhythm
[Punchy or flowing, varied or even.]

---

## Paragraphs and chapters

### Paragraph length
- Average: [for example 3-5 sentences]
- Maximum: [for example 8 sentences]

### Chapter length
- Target: [for example 2000-3000 words]
- Typical shape: [how a chapter usually opens, turns and closes]

### Chapter endings
- [ ] A hook or cliffhanger is required
- [ ] A question or mystery is left open
- [ ] A soft transition is fine

---

## Dialogue

### Formatting
- Quotation marks: [for example double quotes]
- Attribution: [before or after the line, how free the tags may be]

### Tags
- Preferred: [for example said, asked]
- Avoid: [...]

### Balance
- Dialogue to narration: [for example about 40% dialogue]

---

## Description

### Senses
Priority: [for example sight, then sound, then touch]

### Length
- Setting: [brief | moderate | elaborate]
- Characters: [minimal | detailed]
- Action: [sparse | rich]

### Techniques
- [ ] Similes encouraged
- [ ] Metaphors encouraged
- [ ] Personification allowed

---

## Tone and mood

### Overall tone
[For example adventurous, cozy, dark, humorous.]

### Emotional range
[Which emotions belong in the book and which do not.]

### Humor
[Slapstick, wit, irony or none.]

---

## Things to avoid

### Content
- [themes or content that are off limits]

### Style
- [habits and constructions to avoid]

---

## Voice samples

> [Two or three paragraphs that show the target voice.]

> [Another example.]
`;

const STATE_TEMPLATES = {
  situation: `# Current situation - before chapter 1

## Immediate context
- Time: [starting time]
- Place: [starting place]
- Atmosphere: [weather, mood, conditions]
- Tension level: 1/10

## Starting state
[The situation before the story begins.]

## Immediate setup
[What is about to happen, or what sets the story going.]

## Open hooks
- None yet
`,
  characters: `# Character states - before chapter 1

## [Character 1]
- Location: [starting place]
- Emotional state: [starting state]
- Current goal: [starting motivation]
- Active conflicts: none

<!-- Copy this block for each character. -->
`,
  knowledge: `# Knowledge state - before chapter 1

## Known to everyone
- [shared knowledge at the start]

## Known to specific characters
- None yet

## Unknown to the characters (dramatic irony)
- [secrets the reader may learn before the characters do]

## Clues found
- None yet
`,
  inventory: `# Inventory and objects - before chapter 1

## Carried by characters
- [Character 1]: [objects]
- [Character 2]: [objects]

## Important objects in play
- [Object]: [place and condition]

## Lost or destroyed
- None yet

## Hidden or not yet discovered
- [objects that exist but have not been found]
`,
};

/** The starter docs: [{ path (doc address), title, body }] in creation order. */
export const WORKSPACE_STARTERS = [
  { path: 'workspace/book', title: 'Book settings', body: BOOK_TEMPLATE },
  { path: 'workspace/style', title: 'Style guide', body: STYLE_TEMPLATE },
  ...['situation', 'characters', 'knowledge', 'inventory'].map((k) => ({ path: `state/chapter-00/${k}`, title: `Before chapter 1: ${k}`, body: STATE_TEMPLATES[/** @type {keyof typeof STATE_TEMPLATES} */ (k)] })),
];

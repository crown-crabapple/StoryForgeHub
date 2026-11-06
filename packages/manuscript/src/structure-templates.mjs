// Story Planner M4 (ADR 0003): the built-in structure templates. Plain data, not files. Applying one copies its beats into a book's
// planning/structures/<slug>.md (createStructure); the book never follows the template again. All wording here is our own; method names
// are used only as references. `version` is written to the structure file as template_version.

/** @param {string} name @param {string} purpose @param {string} question @param {string} [position] */
const beat = (name, purpose, question, position) => Object.freeze({ name, purpose, question, ...(position ? { position } : {}) });

/** @param {{ id: string, name: string, description: string, beats: ReturnType<typeof beat>[] }} t */
const template = (t) => Object.freeze({ id: t.id, version: 1, name: t.name, description: t.description, beats: Object.freeze(t.beats) });

/** Built-in templates, in the order the app lists them. Each beat: { name, purpose, question, position? }. `custom` has no beats. */
export const STRUCTURE_TEMPLATES = Object.freeze([
  template({
    id: 'three-act',
    name: 'Three acts',
    description: 'Setup, confrontation and resolution, in eight beats.',
    beats: [
      beat('Opening image', 'Show the world and the hero as they are before anything changes.', 'What does normal look like for this person?', 'about 1%'),
      beat('Inciting event', 'Something happens that the hero cannot ignore.', 'What knocks the hero off the usual path?', 'about 10%'),
      beat('First turning point', 'The hero commits, and going back is no longer an option.', 'What choice closes the door behind the hero?', 'about 25%'),
      beat('Rising pressure', 'Each attempt to solve the problem makes it harder.', 'What does the hero try, and why does it cost more than expected?', 'about 40%'),
      beat('Midpoint', 'A discovery or reversal changes what the hero thinks the story is about.', 'What does the hero learn that cannot be unlearned?', 'about 50%'),
      beat('Low point', 'The plan fails and the hero loses something that matters.', 'What is the worst moment, and what does it take away?', 'about 75%'),
      beat('Climax', 'The hero faces the central conflict with everything learned so far.', 'What does the hero do when there is no other way out?', 'about 90%'),
      beat('Closing image', 'Show the new normal and what the journey changed.', 'How is the world, or the hero, different from the first page?', 'about 100%'),
    ],
  }),
  template({
    id: 'five-act',
    name: 'Five acts',
    description: 'A rise and a fall around a central turn, in five beats.',
    beats: [
      beat('Exposition', 'Introduce the people, the place and the tension already in the air.', 'Who are we with, and what is already wrong?', 'about 10%'),
      beat('Rising action', 'Complications pile up and the stakes become clear.', 'What gets in the way, and what is now at risk?', 'about 30%'),
      beat('Climax', 'The story turns on one decisive event.', 'What moment decides which way everything goes?', 'about 50%'),
      beat('Falling action', 'The consequences of the turn play out.', 'What follows from that decision, and who pays for it?', 'about 75%'),
      beat('Resolution', 'Settle the main question and show where everyone ends up.', 'What is left standing, and what has been settled?', 'about 100%'),
    ],
  }),
  template({
    id: 'heros-journey',
    name: "Hero's journey",
    description: 'A departure, a trial and a return, in twelve beats.',
    beats: [
      beat('Ordinary world', 'Show the hero in a life that feels complete enough, but is not.', 'What is the hero used to, and what is missing?', 'about 5%'),
      beat('Call to adventure', 'A problem or an offer arrives that asks for more than the hero has given before.', 'What is being asked of the hero?', 'about 10%'),
      beat('Reluctance', 'The hero hesitates because the risk feels real.', 'What is the hero afraid of losing?', 'about 12%'),
      beat('Meeting the guide', 'Someone gives the hero a reason, a tool or the nerve to go on.', 'Who or what makes the first step possible?', 'about 15%'),
      beat('Crossing the threshold', 'The hero leaves the familiar world and enters the unknown one.', 'What is the moment of no return?', 'about 25%'),
      beat('Tests and allies', 'The new world teaches its rules through trouble, friends and rivals.', 'Who can the hero trust, and who cannot be trusted?', 'about 35%'),
      beat('Approach', 'The hero prepares for the hardest challenge ahead.', 'What does the hero need before facing the big danger?', 'about 45%'),
      beat('The ordeal', 'The hero meets the greatest danger yet and something seems to die.', 'What is the hero closest to losing?', 'about 55%'),
      beat('The reward', 'Surviving brings a gain, such as a truth, an object or a bond.', 'What does the hero take from the ordeal?', 'about 65%'),
      beat('The road back', 'The hero turns toward home, and the danger follows.', 'What pushes the hero to act again?', 'about 75%'),
      beat('The last trial', 'A final test shows whether the hero has really changed.', 'What must the hero do that the old self could not?', 'about 90%'),
      beat('Return with the gift', 'The hero comes home changed and brings something of value.', 'What does the hero bring back, and who benefits?', 'about 100%'),
    ],
  }),
  template({
    id: 'seven-point',
    name: 'Seven points',
    description: 'Work backwards from the ending, in seven beats.',
    beats: [
      beat('Hook', 'Begin with a state the story will end up reversing.', 'What is the starting situation, and why is it opposite to the ending?', 'about 1%'),
      beat('First plot turn', 'The main conflict arrives and sets the story moving.', 'What event starts the real story?', 'about 25%'),
      beat('First pinch', 'The opposing force shows its strength.', 'How does the hero feel the pressure for the first time?', 'about 37%'),
      beat('Midpoint', 'The hero stops reacting and starts to act.', 'What changes from reacting to acting?', 'about 50%'),
      beat('Second pinch', 'The pressure returns harder and the hero seems to run out of options.', 'What is taken away, and what is left?', 'about 62%'),
      beat('Second plot turn', 'The hero gets the last piece needed to win.', 'What final piece falls into place?', 'about 75%'),
      beat('Resolution', 'The hero uses everything gathered to settle the conflict.', 'How does the ending answer the hook?', 'about 100%'),
    ],
  }),
  template({
    id: 'story-circle',
    name: 'Story circle',
    description: 'A character goes into the unknown and comes back changed, in eight beats.',
    beats: [
      beat('You', 'Show a character in a comfortable zone.', 'Who is this person, and where do they feel safe?', 'about 6%'),
      beat('Need', 'The character wants something they do not have.', 'What do they want, and what is it costing them not to have it?', 'about 12%'),
      beat('Go', 'The character steps into an unfamiliar situation.', 'What takes them out of the comfort zone?', 'about 25%'),
      beat('Search', 'The character adapts to the new place and tries to get what they want.', 'What do they try, and what does it cost?', 'about 40%'),
      beat('Find', 'The character gets what they were looking for.', 'What do they win, and is it what they thought it was?', 'about 50%'),
      beat('Take', 'The character pays a heavy price for it.', 'What is the price, and who pays?', 'about 65%'),
      beat('Return', 'The character heads back to the familiar world.', 'What do they carry back, and what has followed them?', 'about 85%'),
      beat('Change', 'The character has been changed by the trip.', 'What can they do now that they could not before?', 'about 100%'),
    ],
  }),
  template({
    id: 'mystery',
    name: 'Mystery',
    description: 'A question, a trail of clues and an answer, in seven beats.',
    beats: [
      beat('The crime or puzzle', 'Present the event that needs explaining.', 'What happened, and why does it matter to the detective?', 'about 5%'),
      beat('The investigator commits', 'Give the investigator a personal reason to stay on the case.', 'Why can this person not walk away?', 'about 15%'),
      beat('First clues and suspects', 'Lay out the people and facts the story can later reuse.', 'Who had a reason, and what looks odd?', 'about 30%'),
      beat('The false answer', 'Point at an explanation that feels right and is wrong.', 'What does everyone, including the reader, believe for now?', 'about 50%'),
      beat('The turn', 'A new fact breaks the false answer and raises the danger.', 'What fact does not fit, and what does it put at risk?', 'about 70%'),
      beat('The reveal', 'Gather the clues and name the true answer.', 'Which clues were pointing at the truth all along?', 'about 90%'),
      beat('Aftermath', 'Show the cost of knowing and what happens next to the people involved.', 'What does the answer change for those left behind?', 'about 100%'),
    ],
  }),
  template({
    id: 'romance',
    name: 'Romance',
    description: 'Two people meet, grow close, break apart and choose each other, in eight beats.',
    beats: [
      beat('Before', 'Show each lead alone, with a reason they are guarded.', 'What is each person protecting?', 'about 5%'),
      beat('The meeting', 'Bring the two leads together in a way that creates friction or interest.', 'What makes them notice each other?', 'about 12%'),
      beat('Forced closeness', 'Give them a reason to keep spending time together.', 'What keeps them in the same room?', 'about 25%'),
      beat('Growing closer', 'Let trust and attraction build through shared moments.', 'What do they learn about each other that surprises them?', 'about 40%'),
      beat('The deepening', 'Mark a point where the relationship becomes real and the stakes rise.', 'What does it now cost them to turn back?', 'about 55%'),
      beat('The break', 'An old fear, a secret or a clash pushes them apart.', 'What flaw or lie gets in the way?', 'about 75%'),
      beat('The dark moment', 'Each lead faces life without the other and sees what they must change.', 'What does each one finally understand about themselves?', 'about 85%'),
      beat('The choice', 'One or both of them act to win the other back, and the ending is earned.', 'What brave act shows they have changed?', 'about 100%'),
    ],
  }),
  template({
    id: 'custom',
    name: 'Custom',
    description: 'An empty structure; add your own beats.',
    beats: [],
  }),
]);

/** The template with this id, or null. @param {unknown} id */
export function templateById(id) {
  return typeof id === 'string' ? (STRUCTURE_TEMPLATES.find((t) => t.id === id) ?? null) : null;
}

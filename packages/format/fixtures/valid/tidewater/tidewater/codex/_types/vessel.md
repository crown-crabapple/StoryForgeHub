---
schema: storyforge.codex-type/v1
id: note_01W10000000000000000000005
type: vessel
name: Vessel
plural: Vessels
fields:
  - Master
  - label: Tonnage
    kind: number
  - label: Launched
    kind: date
  - label: Home port
    kind: link
  - label: Rig
    kind: choice
    choices: [sloop, ketch, schooner]
  - label: Cargoes
    kind: list
  - label: Notes
    kind: text
---
Ships and boats.

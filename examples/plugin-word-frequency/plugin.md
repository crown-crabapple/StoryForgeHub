---
schema: storyforge.plugin/v1
id: note_01S8000000000000000000WF01
plugin: word-frequency
name: Word frequency
version: 1.0.0
api: 1
permissions: [read]
books: all
homepage: ""
---
Reads a book over the StoryForge API and prints the most used words of each chapter. It only reads; it cannot change anything in your book.

To use it, copy this folder to `<library>/_plugins/word-frequency/`, open Settings, then Plugins, and choose Grant access. Copy the token it shows (once) and run `plugin.mjs` with it.

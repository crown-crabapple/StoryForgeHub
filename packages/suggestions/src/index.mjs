// @storyforge/suggestions - suggestion documents (FORMAT-v1 9.3): build from two texts, parse, apply one hunk, record a decision.
// Pure: no filesystem, no network. Core, the server and the Claude-Book adapter use it; none of them re-implement the diff.
export { buildSuggestion, parseSuggestion, applyHunk, setHunkStatus, suggestionPath, deriveStatus, sha256Hex, splitLines, lineDiff, SUGGESTION_SCHEMA } from './suggestion.mjs';

// @storyforge/suggestions - suggestion documents (FORMAT-v1 9.3): build from two texts, parse, apply one hunk, record a decision.
// Pure: no filesystem, no network. Core, the server and the Claude-Book adapter use it; none of them re-implement the diff.
export { buildSuggestion, parseSuggestion, applyHunk, setHunkStatus, suggestionPath, deriveStatus, sha256Hex, splitLines, lineDiff, SUGGESTION_SCHEMA } from './suggestion.mjs';
// Comments (M07-J03, FORMAT-v1 9.5): author-data notes anchored to lines of a scene.
export { COMMENT_SCHEMA, COMMENT_STATUSES, MAX_COMMENT_CHARS, MAX_QUOTE_CHARS, buildComment, parseComment, addReply, setCommentStatus, commentPath, anchorSha, locateAnchor } from './comment.mjs';

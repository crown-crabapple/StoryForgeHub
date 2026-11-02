// Context packages (M05-J04 contract section 3): the exact request that would be sent, built without sending anything, and the
// in-memory store that lets "send" refer to it by id (15 minutes). Pure: the caller reads the files; nothing here touches disk or network.
import { createHash, randomBytes } from 'node:crypto';

export const CONTEXT_TTL_MS = 15 * 60 * 1000;
export const MAX_STORED_CONTEXTS = 100;
/** A truncated last file must keep at least this many characters, otherwise it is left out. */
const MIN_TRUNCATED_CHARS = 200;
const TRUNCATION_MARK = '\n[... the rest of this file was left out to fit the context budget ...]';

export const SYSTEM_PROMPTS = {
  chat: 'You are a writing assistant for a novelist. Use the project files given in the user message as background. Answer the request directly. You cannot change any file; anything you write is only a suggestion the author may copy.',
  rewrite: 'You are a fiction editor. Rewrite the passage the author gives you, following their instruction. Reply with the rewritten passage only: no commentary, no quotation marks around it, no Markdown code fence.',
};

/** Token estimate: ceil(characters / 4). @param {string} text */
export const estimateTokens = (text) => Math.ceil(text.length / 4);

/** JSON with object keys sorted at every level, so equal data always gives equal text. @param {unknown} value @returns {string} */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The part of `text` up to `max` characters, never splitting a surrogate pair. */
function cut(text, max) {
  let end = Math.max(0, max);
  if (end > 0 && end < text.length) {
    const c = text.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  }
  return text.slice(0, end);
}

const fileBlock = (path, text, truncated) => `--- FILE: ${path}${truncated ? ' (truncated)' : ''} ---\n${text}\n--- END FILE ---\n\n`;

/**
 * @param {{ task: 'chat' | 'rewrite', instruction: string, selectionText?: string,
 *   files: { path: string, text: string, sha256: string, bytes: number }[] }} input
 * @param {{ blocks: { path: string, text: string, truncated: boolean }[] }} used
 * @returns {{ role: 'system' | 'user', content: string }[]}
 */
function messagesFor(input, used) {
  const context = used.blocks.length > 0 ? `Project files for background:\n\n${used.blocks.map((b) => fileBlock(b.path, b.text, b.truncated)).join('')}` : '';
  const task =
    input.task === 'rewrite'
      ? `Passage to rewrite:\n<<<PASSAGE\n${input.selectionText ?? ''}\nPASSAGE>>>\n\nInstruction:\n${input.instruction}`
      : `Request:\n${input.instruction}`;
  return [
    { role: 'system', content: SYSTEM_PROMPTS[input.task] },
    { role: 'user', content: `${context}${task}` },
  ];
}

/**
 * Build the context package. Files are added in the given order while the estimate stays within `profile.contextBudget`; the first file that no
 * longer fits is cut at the budget and marked `truncated` (only if enough of it fits), and every file after that is `omitted`.
 * @param {{ task: 'chat' | 'rewrite', instruction: string, selectionText?: string,
 *   files: { path: string, text: string, sha256: string, bytes: number }[] }} input
 * @param {{ name: string, model: string, baseUrl: string, locality: 'local' | 'cloud', contextBudget: number, temperature?: number, maxTokens?: number }} profile
 * @returns {{ ok: true, package: {
 *     messages: { role: string, content: string }[],
 *     files: { path: string, sha256: string, bytes: number, tokens: number, included: 'full' | 'truncated' | 'omitted' }[],
 *     tokens: { estimate: number, budget: number },
 *     provider: { name: string, model: string, baseUrl: string, locality: 'local' | 'cloud' },
 *     contextSha256: string, settings: { temperature: number | null, maxTokens: number | null } } }
 *   | { ok: false, code: 'OVER_BUDGET', message: string }}
 *   Each file's `tokens` is the estimate for its whole text (what it would cost), whatever part was included; `tokens.estimate` counts only what is sent.
 */
export function buildContext(input, profile) {
  const budgetChars = profile.contextBudget * 4;
  const baseChars = messagesFor(input, { blocks: [] }).reduce((n, m) => n + m.content.length, 0);
  if (baseChars > budgetChars) {
    return { ok: false, code: 'OVER_BUDGET', message: `the instruction${input.task === 'rewrite' ? ' and the selected text' : ''} alone need about ${Math.ceil(baseChars / 4)} tokens, more than the budget of ${profile.contextBudget}` };
  }
  let remaining = budgetChars - baseChars - (input.files.length > 0 ? 'Project files for background:\n\n'.length : 0);
  let stopped = false;
  /** @type {{ path: string, text: string, truncated: boolean }[]} */
  const blocks = [];
  const files = input.files.map((f) => {
    const entry = { path: f.path, sha256: f.sha256, bytes: f.bytes, tokens: estimateTokens(f.text), included: /** @type {'full' | 'truncated' | 'omitted'} */ ('omitted') };
    if (stopped) return entry;
    const whole = fileBlock(f.path, f.text, false).length;
    if (whole <= remaining) {
      blocks.push({ path: f.path, text: f.text, truncated: false });
      remaining -= whole;
      entry.included = 'full';
      return entry;
    }
    stopped = true;
    const room = remaining - fileBlock(f.path, '', true).length - TRUNCATION_MARK.length;
    if (room >= MIN_TRUNCATED_CHARS) {
      blocks.push({ path: f.path, text: `${cut(f.text, room)}${TRUNCATION_MARK}`, truncated: true });
      entry.included = 'truncated';
    }
    return entry;
  });
  const messages = messagesFor(input, { blocks });
  const settings = { temperature: profile.temperature ?? null, maxTokens: profile.maxTokens ?? null };
  const contextSha256 = sha256(canonicalJson({ messages, model: profile.model, settings }));
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  return {
    ok: true,
    package: {
      messages,
      files,
      tokens: { estimate: Math.ceil(chars / 4), budget: profile.contextBudget },
      provider: { name: profile.name, model: profile.model, baseUrl: profile.baseUrl, locality: profile.locality },
      contextSha256,
      settings,
    },
  };
}

/** The JSON body sent to the provider for a stored package. @param {{ model: string, messages: unknown[], settings: { temperature: number | null, maxTokens: number | null } }} p */
export function requestBody(p) {
  return {
    model: p.model,
    messages: p.messages,
    ...(p.settings.temperature !== null ? { temperature: p.settings.temperature } : {}),
    ...(p.settings.maxTokens !== null ? { max_tokens: p.settings.maxTokens } : {}),
    stream: false,
  };
}

/**
 * Packages waiting to be sent, kept in memory for 15 minutes and keyed by `contextId`.
 * @param {{ ttlMs?: number, now?: () => number, max?: number }} [options]
 */
export function createContextStore({ ttlMs = CONTEXT_TTL_MS, now = () => Date.now(), max = MAX_STORED_CONTEXTS } = {}) {
  /** @type {Map<string, { expires: number, entry: any }>} */
  const map = new Map();
  const sweep = () => {
    const t = now();
    for (const [id, v] of map) if (v.expires <= t) map.delete(id);
  };
  return {
    /** @param {any} entry @returns {string} the new contextId */
    put(entry) {
      sweep();
      while (map.size >= max) map.delete(/** @type {string} */ (map.keys().next().value));
      const id = `ctx_${randomBytes(12).toString('hex')}`;
      map.set(id, { expires: now() + ttlMs, entry });
      return id;
    },
    /** @param {unknown} id @returns {any | null} */
    get(id) {
      sweep();
      return typeof id === 'string' ? (map.get(id)?.entry ?? null) : null;
    },
    /** @param {unknown} id */
    delete(id) {
      if (typeof id === 'string') map.delete(id);
    },
    get size() {
      sweep();
      return map.size;
    },
  };
}

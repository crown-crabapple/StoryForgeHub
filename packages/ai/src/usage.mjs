// Token accounting (contract M08-J03 section 2): the provider's reported usage when there is one, else an estimate (characters / 4) marked "estimated".
// Counts only; nothing here holds text, and nothing is ever sent anywhere.
import { estimateTokens } from './context.mjs';

const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/**
 * @param {any} reported the provider's `usage` object (OpenAI: prompt_tokens / completion_tokens) or null
 * @param {{ promptText: string, completionText: string }} texts what was sent and what came back (for the estimate)
 * @returns {{ promptTokens: number, completionTokens: number, totalTokens: number, estimated: boolean }}
 */
export function accountUsage(reported, { promptText, completionText }) {
  const p = count(reported?.prompt_tokens ?? reported?.input_tokens);
  const c = count(reported?.completion_tokens ?? reported?.output_tokens);
  if (p !== null && c !== null) return { promptTokens: p, completionTokens: c, totalTokens: p + c, estimated: false };
  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(completionText);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, estimated: true };
}

/** The prompt text of a message list, for the estimate. @param {{ content: string }[]} messages */
export const messagesText = (messages) => messages.map((m) => (typeof m?.content === 'string' ? m.content : '')).join('\n');

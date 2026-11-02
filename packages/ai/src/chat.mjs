// One OpenAI-compatible chat completion (POST <baseUrl>/chat/completions). The only caller of postJson.
// The key goes out only as `Authorization: Bearer` to the profile's own base URL; every error text is redacted before it is returned.
import { requestBody } from './context.mjs';
import { redact } from './redact.mjs';
import { postJson, TransportError } from './transport.mjs';

/** The fixed prompt of the connection test: the only request that carries no book text. */
export const TEST_PROMPT = 'Reply with OK.';

/** @param {any} json */
function replyOf(json) {
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
  return null;
}

/**
 * @param {{ baseUrl: string }} profile
 * @param {string | null} apiKey
 * @param {Record<string, unknown>} body the JSON request body
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: true, reply: string, model: string | null, usage: unknown } | { ok: false, code: string, status?: number, message: string }>}
 */
export async function chatCompletion(profile, apiKey, body, { timeoutMs, signal } = {}) {
  const secrets = [apiKey];
  try {
    const res = await postJson(`${profile.baseUrl}/chat/completions`, body, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const detail = typeof res.json?.error?.message === 'string' ? res.json.error.message : typeof res.json?.error === 'string' ? res.json.error : res.text;
      return { ok: false, code: 'PROVIDER_ERROR', status: res.status, message: redact(`the provider answered ${res.status}: ${detail}`, secrets) };
    }
    const reply = replyOf(res.json);
    if (reply === null || reply.trim() === '') return { ok: false, code: 'BAD_RESPONSE', message: 'the provider answered without any text' };
    return { ok: true, reply, model: typeof res.json?.model === 'string' ? res.json.model : null, usage: res.json?.usage ?? null };
  } catch (e) {
    if (e instanceof TransportError) return { ok: false, code: e.code, message: redact(e.message, secrets) };
    return { ok: false, code: 'NETWORK', message: 'the provider could not be reached' };
  }
}

/** Send a stored package exactly as it was previewed. @param {any} profile @param {string | null} apiKey @param {any} stored */
export const sendPackage = (profile, apiKey, stored, options) => chatCompletion(profile, apiKey, requestBody(stored), options);

/** The connection test: one tiny fixed prompt. @param {any} profile @param {string | null} apiKey */
export const testConnection = (profile, apiKey, options) =>
  chatCompletion(profile, apiKey, { model: profile.model, messages: [{ role: 'user', content: TEST_PROMPT }], max_tokens: 16, stream: false }, options);

// One OpenAI-compatible chat completion (POST <baseUrl>/chat/completions), whole or streamed. The only caller of postJson / postStream for chat.
// The key goes out only as `Authorization: Bearer` to the profile's own base URL; every error text is redacted before it is returned.
import { requestBody } from './context.mjs';
import { redact } from './redact.mjs';
import { postJson, postStream, TransportError } from './transport.mjs';
import { accountUsage, messagesText } from './usage.mjs';

/** The fixed prompt of the connection test: the only request that carries no book text. */
export const TEST_PROMPT = 'Reply with OK.';

/** @param {any} json */
function replyOf(json) {
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
  return null;
}

/** @param {any} res @param {(string | null)[]} secrets */
function providerError(res, secrets) {
  const detail = typeof res.json?.error?.message === 'string' ? res.json.error.message : typeof res.json?.error === 'string' ? res.json.error : res.text;
  return { ok: /** @type {const} */ (false), code: 'PROVIDER_ERROR', status: res.status, message: redact(`the provider answered ${res.status}: ${detail}`, secrets) };
}

/** @param {unknown} e @param {(string | null)[]} secrets */
function failure(e, secrets) {
  if (e instanceof TransportError) return { ok: /** @type {const} */ (false), code: e.code, message: redact(e.message, secrets) };
  return { ok: /** @type {const} */ (false), code: 'NETWORK', message: 'the provider could not be reached' };
}

/**
 * @typedef {{ promptTokens: number, completionTokens: number, totalTokens: number, estimated: boolean }} Tokens
 * @typedef {{ ok: true, reply: string, model: string | null, usage: unknown, tokens: Tokens, streamed?: boolean } | { ok: false, code: string, status?: number, message: string }} ChatResult
 */

/**
 * @param {{ baseUrl: string }} profile
 * @param {string | null} apiKey
 * @param {Record<string, any>} body the JSON request body
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<ChatResult>}
 */
export async function chatCompletion(profile, apiKey, body, { timeoutMs, signal } = {}) {
  const secrets = [apiKey];
  try {
    const res = await postJson(`${profile.baseUrl}/chat/completions`, body, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return providerError(res, secrets);
    const reply = replyOf(res.json);
    if (reply === null || reply.trim() === '') return { ok: false, code: 'BAD_RESPONSE', message: 'the provider answered without any text' };
    const usage = res.json?.usage ?? null;
    return { ok: true, reply, model: typeof res.json?.model === 'string' ? res.json.model : null, usage, tokens: accountUsage(usage, { promptText: messagesText(body.messages ?? []), completionText: reply }) };
  } catch (e) {
    return failure(e, secrets);
  }
}

/**
 * The same request, streamed (SSE `data:` lines from an OpenAI-compatible server, or NDJSON as Ollama writes it). `onDelta(text)` sees each piece as it arrives;
 * the caller shows it but must not apply anything until this returns ok. A stream that ends early, or is cancelled (`signal`), is `{ ok: false }` and carries no text.
 * @param {{ baseUrl: string }} profile @param {string | null} apiKey @param {Record<string, any>} body
 * @param {{ timeoutMs?: number, signal?: AbortSignal, onDelta?: (text: string) => void }} [options]
 * @returns {Promise<ChatResult>}
 */
export async function streamCompletion(profile, apiKey, body, { timeoutMs, signal, onDelta } = {}) {
  const secrets = [apiKey];
  let reply = '';
  let model = null;
  let usage = null;
  let complete = false;
  let events = 0;
  /** @type {string[]} lines that were not events: a provider that ignored `stream` answers with one plain JSON document */
  const rest = [];
  /** @type {string | null} */
  let streamError = null;
  /** @param {string} line */
  const onLine = (line) => {
    let payload;
    if (line.startsWith('data:')) {
      payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        complete = true;
        return;
      }
    } else if (line.startsWith('{') && line.endsWith('}')) payload = line;
    else {
      if (!/^(:|event:|id:|retry:)/.test(line) && rest.join('').length < 1_000_000) rest.push(line);
      return;
    }
    let j;
    try {
      j = JSON.parse(payload);
    } catch {
      return;
    }
    if (j === null || typeof j !== 'object') return;
    if (j.error) {
      streamError = typeof j.error?.message === 'string' ? j.error.message : typeof j.error === 'string' ? j.error : 'the provider reported an error';
      return;
    }
    const choice = j.choices?.[0];
    if (typeof j.model === 'string') model = j.model;
    const delta =
      typeof choice?.delta?.content === 'string' ? choice.delta.content
      : typeof choice?.message?.content === 'string' ? choice.message.content
      : typeof choice?.text === 'string' ? choice.text
      : typeof j.message?.content === 'string' ? j.message.content
      : '';
    if (delta !== '') {
      events++;
      reply += delta;
      onDelta?.(delta);
    }
    if (j.usage && typeof j.usage === 'object') usage = j.usage;
    else if (typeof j.prompt_eval_count === 'number' || typeof j.eval_count === 'number') usage = { prompt_tokens: j.prompt_eval_count, completion_tokens: j.eval_count }; // Ollama's final line
    if (choice?.finish_reason || j.done === true) complete = true;
  };
  const promptText = messagesText(body.messages ?? []);
  try {
    const res = await postStream(`${profile.baseUrl}/chat/completions`, { ...body, stream: true, stream_options: { include_usage: true } }, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(signal ? { signal } : {}),
      onLine,
    });
    if (!res.ok) return providerError(res, secrets);
    if (streamError !== null) return { ok: false, code: 'PROVIDER_ERROR', message: redact(`the provider reported an error: ${streamError}`, secrets) };
    if (events === 0 && rest.length > 0) {
      // not a stream after all: one plain completion
      try {
        const whole = JSON.parse(rest.join('\n'));
        const text = replyOf(whole);
        if (text !== null && text.trim() !== '') {
          onDelta?.(text);
          const u = whole?.usage ?? null;
          return { ok: true, reply: text, model: typeof whole?.model === 'string' ? whole.model : null, usage: u, tokens: accountUsage(u, { promptText, completionText: text }), streamed: false };
        }
      } catch {
        // falls through to BAD_RESPONSE
      }
    }
    if (reply.trim() === '') return { ok: false, code: 'BAD_RESPONSE', message: 'the provider answered without any text' };
    if (!complete) return { ok: false, code: 'STREAM_INCOMPLETE', message: 'the connection ended before the reply was complete; nothing was kept' };
    return { ok: true, reply, model, usage, tokens: accountUsage(usage, { promptText, completionText: reply }), streamed: true };
  } catch (e) {
    return failure(e, secrets);
  }
}

/** Send a stored package exactly as it was previewed. @param {any} profile @param {string | null} apiKey @param {any} stored */
export const sendPackage = (profile, apiKey, stored, options) => chatCompletion(profile, apiKey, requestBody(stored), options);

/** The same, streamed. @param {any} profile @param {string | null} apiKey @param {any} stored @param {Parameters<typeof streamCompletion>[3]} [options] */
export const streamPackage = (profile, apiKey, stored, options) => streamCompletion(profile, apiKey, requestBody(stored), options);

/** The connection test: one tiny fixed prompt. @param {any} profile @param {string | null} apiKey */
export const testConnection = (profile, apiKey, options) =>
  chatCompletion(profile, apiKey, { model: profile.model, messages: [{ role: 'user', content: TEST_PROMPT }], max_tokens: 16, stream: false }, options);

/** The same fixed prompt, streamed: shows whether the provider streams and reports usage. @param {any} profile @param {string | null} apiKey */
export const testStreaming = (profile, apiKey, options) =>
  streamCompletion(profile, apiKey, { model: profile.model, messages: [{ role: 'user', content: TEST_PROMPT }], max_tokens: 16 }, options);

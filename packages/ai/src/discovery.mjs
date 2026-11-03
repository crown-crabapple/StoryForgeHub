// Capability discovery (contract M08-J03 section 2): which models a provider offers, and whether it streams and reports token usage.
// Only GET requests and the fixed one-line test prompt are sent: no manuscript text can reach a provider from here.
import { testStreaming } from './chat.mjs';
import { redact } from './redact.mjs';
import { getJson, LOOPBACK_HOSTS, TransportError } from './transport.mjs';

const MAX_MODELS = 500;

/** @param {any} json @returns {string[]} model ids from an OpenAI-style `{ data: [{ id }] }` list (some servers use `models`) */
function openAiIds(json) {
  const list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  return list.map((m) => (typeof m === 'string' ? m : typeof m?.id === 'string' ? m.id : typeof m?.name === 'string' ? m.name : null)).filter((x) => typeof x === 'string' && x !== '');
}

/** @param {any} json @returns {string[]} model names from Ollama's `{ models: [{ name }] }` */
function ollamaIds(json) {
  return (Array.isArray(json?.models) ? json.models : []).map((m) => (typeof m?.name === 'string' ? m.name : typeof m?.model === 'string' ? m.model : null)).filter((x) => typeof x === 'string' && x !== '');
}

/**
 * List the models of a profile's provider. OpenAI-compatible: GET {base}/models. On a localhost base also Ollama's GET {origin}/api/tags (that is how Ollama is recognised).
 * With `probe` (chat profiles) one fixed test message is streamed to learn whether streaming and usage reporting work.
 * @param {{ baseUrl: string, kind?: string, model: string }} profile @param {string | null} apiKey @param {{ signal?: AbortSignal, probe?: boolean }} [options]
 * @returns {Promise<{ ok: true, models: string[], ollama: boolean, streaming: boolean | null, usageReported: boolean | null, at: string } | { ok: false, code: string, message: string }>}
 */
export async function discoverCapabilities(profile, apiKey, { signal, probe = true } = {}) {
  const secrets = [apiKey];
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  let origin;
  let local = false;
  try {
    const u = new URL(profile.baseUrl);
    origin = u.origin;
    local = LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return { ok: false, code: 'BAD_URL', message: 'the address is not a valid URL' };
  }
  /** @type {Set<string>} */
  const models = new Set();
  let listed = false;
  let ollama = false;
  /** @type {{ code: string, message: string } | null} */
  let firstProblem = null;
  try {
    const r = await getJson(`${profile.baseUrl}/models`, { headers, ...(signal ? { signal } : {}) }).catch((e) => {
      if (e instanceof TransportError && (e.code === 'ABORTED' || !local)) throw e;
      return null; // a local server may have only Ollama's own list
    });
    if (r?.ok) {
      listed = true;
      for (const id of openAiIds(r.json)) models.add(id);
    } else if (r) firstProblem = { code: 'PROVIDER_ERROR', message: redact(`the provider answered ${r.status} to the model list`, secrets) };
    if (local) {
      const t = await getJson(`${origin}/api/tags`, { ...(signal ? { signal } : {}) }).catch((e) => (e instanceof TransportError && e.code === 'ABORTED' ? Promise.reject(e) : null));
      if (t?.ok && Array.isArray(t.json?.models)) {
        ollama = true;
        listed = true;
        for (const id of ollamaIds(t.json)) models.add(id);
      }
    }
  } catch (e) {
    if (e instanceof TransportError) return { ok: false, code: e.code, message: redact(e.message, secrets) };
    return { ok: false, code: 'NETWORK', message: 'the provider could not be reached' };
  }
  if (!listed) return { ok: false, ...(firstProblem ?? { code: 'NETWORK', message: 'the provider could not be reached' }) };
  let streaming = null;
  let usageReported = null;
  if (probe) {
    const s = await testStreaming(profile, apiKey, { ...(signal ? { signal } : {}) });
    if (s.ok) {
      streaming = s.streamed !== false;
      usageReported = !s.tokens.estimated;
    } else if (s.code === 'ABORTED') return { ok: false, code: 'ABORTED', message: s.message };
    else {
      streaming = false;
      usageReported = false;
    }
  }
  return { ok: true, models: [...models].sort().slice(0, MAX_MODELS), ollama, streaming, usageReported, at: new Date().toISOString() };
}

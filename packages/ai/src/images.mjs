// Image generation (contract M08-J03 section 3): POST {base}/images/generations. The only thing sent is the prompt text the author saw and agreed to.
// The answer must carry the picture itself (b64_json); a link is refused, because following it would be a second request to an address the author did not see.
import { redact } from './redact.mjs';
import { MAX_IMAGE_RESPONSE_BYTES, postJson, TransportError } from './transport.mjs';

export const MAX_PROMPT_CHARS = 4000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @param {{ baseUrl: string, model: string }} profile @param {string | null} apiKey @param {string} prompt exactly the text the author confirmed
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: true, bytes: Buffer, model: string } | { ok: false, code: string, status?: number, message: string }>}
 */
export async function generateImage(profile, apiKey, prompt, { signal, timeoutMs } = {}) {
  const secrets = [apiKey];
  try {
    const res = await postJson(`${profile.baseUrl}/images/generations`, { model: profile.model, prompt, n: 1, size: '1024x1536', response_format: 'b64_json' }, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      maxBytes: MAX_IMAGE_RESPONSE_BYTES,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const detail = typeof res.json?.error?.message === 'string' ? res.json.error.message : typeof res.json?.error === 'string' ? res.json.error : res.text;
      return { ok: false, code: 'PROVIDER_ERROR', status: res.status, message: redact(`the provider answered ${res.status}: ${detail}`, secrets) };
    }
    const item = res.json?.data?.[0];
    if (typeof item?.b64_json !== 'string' || item.b64_json === '') {
      return { ok: false, code: 'BAD_RESPONSE', message: typeof item?.url === 'string' ? 'the provider answered with a link instead of the picture; nothing was downloaded' : 'the provider answered without a picture' };
    }
    const bytes = Buffer.from(item.b64_json, 'base64');
    if (bytes.length < 16 || !bytes.subarray(0, 8).equals(PNG)) return { ok: false, code: 'BAD_RESPONSE', message: 'the provider answered with something that is not a PNG picture' };
    return { ok: true, bytes, model: typeof res.json?.model === 'string' ? res.json.model : profile.model };
  } catch (e) {
    if (e instanceof TransportError) return { ok: false, code: e.code, message: redact(e.message, secrets) };
    return { ok: false, code: 'NETWORK', message: 'the provider could not be reached' };
  }
}

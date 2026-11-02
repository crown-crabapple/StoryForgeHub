// Key redaction: any text that could reach a response, a log line or a record passes through here first.

export const REDACTED = '[key removed]';

/**
 * Replace every occurrence of each secret in `text` (also the form the secret takes after JSON or URL encoding), and cut the text to `max` characters.
 * @param {unknown} text @param {Iterable<string | null | undefined>} secrets @param {number} [max]
 * @returns {string}
 */
export function redact(text, secrets, max = 500) {
  let out = typeof text === 'string' ? text : '';
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    const forms = new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]);
    for (const form of forms) if (form !== '') out = out.split(form).join(REDACTED);
  }
  return out.length > max ? `${out.slice(0, max)}...` : out;
}

// Pure helpers for the optional AI workshop (M05-J04): locality, paths, and the "don't ask again" memory. No DOM.

/** Hosts that count as this computer (the same rule as the server's; the server's answer is the one that counts). */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** @param {string} baseUrl @returns {'local' | 'cloud'} */
export function localityOf(baseUrl) {
  try {
    return LOCAL_HOSTS.includes(new URL(baseUrl).hostname) ? 'local' : 'cloud';
  } catch {
    return 'cloud';
  }
}

/** @param {string} baseUrl */
export function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return '';
  }
}

/** True when the address is http: to somewhere that is not this computer (the server refuses to save it). @param {string} baseUrl */
export function isInsecureCloud(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return u.protocol === 'http:' && !LOCAL_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

/** Offered first, and only when the server reports a secure backend (Settings shows which one). */
export const SECURE_CHOICE = { value: 'secure', label: 'Keep the key in secure storage (recommended)' };

export const KEY_STORAGE_CHOICES = [
  { value: 'none', label: 'No key (typical for a server on this computer)' },
  { value: 'session', label: 'Keep the key for this session only (forgotten when StoryForge restarts)' },
  { value: 'config', label: 'Save the key in the settings file, as plain text' },
];

/** The key-storage radio choices: secure first when a secure backend is active. @param {string | null | undefined} backend */
export const keyStorageChoices = (backend) => (backend ? [SECURE_CHOICE, ...KEY_STORAGE_CHOICES] : KEY_STORAGE_CHOICES);

/** The backend names in words. @param {string | null | undefined} backend */
export function backendText(backend) {
  return { dpapi: 'Windows protected storage (DPAPI)', 'macos-keychain': 'the macOS keychain', 'secret-service': 'the Linux Secret Service', 'file-key': 'an encrypted file with its own key' }[backend ?? ''] ?? 'none';
}

/** "1,234 prompt + 56 reply tokens (estimated)". @param {{ promptTokens: number, completionTokens: number, estimated: boolean }} t */
export const usageText = (t) => `${t.promptTokens.toLocaleString('en-US')} prompt + ${t.completionTokens.toLocaleString('en-US')} reply tokens (${t.estimated ? 'estimated: the provider reported none' : 'reported by the provider'})`;

/** A scene's path inside its book: scene summaries carry the path from the library root. @param {string} bookPath @param {string} path */
export function bookRelative(bookPath, path) {
  return bookPath && path.startsWith(`${bookPath}/`) ? path.slice(bookPath.length + 1) : path;
}

/** "about 1,234 tokens". @param {number} n */
export const tokensText = (n) => `${n.toLocaleString('en-US')} token${n === 1 ? '' : 's'}`;

// "Don't ask again for this book this session" for cloud sends: held in browser memory only, gone on reload.
const remembered = new Set();
export const cloudRemembered = (bookId) => remembered.has(bookId);
export function rememberCloud(bookId, on) {
  if (on) remembered.add(bookId);
  else remembered.delete(bookId);
}

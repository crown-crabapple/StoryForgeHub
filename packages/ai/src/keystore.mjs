// Secure storage for the secrets StoryForge keeps: AI provider keys and webhook signing secrets (contract M08-J03 section 1).
// Backends, chosen in this order: Windows DPAPI (CurrentUser), the macOS keychain, the Linux Secret Service, then an AES-256-GCM file whose key is
// in STORYFORGE_SECRETS_KEY or in secrets-key.json (mode 0600) beside it. A secret is never put in a process's arguments or environment, never logged
// and never returned in an error message. This is the only file in packages/ai that starts a process (enforced by lint).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { readSharedJson, writeSharedJson } from '@storyforge/store';

export const BACKENDS = Object.freeze(['dpapi', 'macos-keychain', 'secret-service', 'file-key']);
const FILE = 'secrets.json';
const KEY_FILE = 'secrets-key.json';
const ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const SERVICE = 'storyforge';
/** DPAPI optional entropy: ties the ciphertext to StoryForge as well as to the Windows user. */
const ENTROPY_B64 = Buffer.from('storyforge-secrets-v1', 'utf8').toString('base64');

export class KeystoreError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Run a program with `input` on stdin; resolve stdout. The child's environment never carries STORYFORGE_SECRETS_KEY.
 * @param {string} cmd @param {string[]} args @param {string} input @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ code: number | null, stdout: string }>}
 */
function runProcess(cmd, args, input, env) {
  return new Promise((resolve) => {
    const childEnv = { ...env };
    delete childEnv.STORYFORGE_SECRETS_KEY;
    let child;
    try {
      child = spawn(cmd, args, { env: childEnv, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve({ code: -1, stdout: '' });
      return;
    }
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve({ code: -1, stdout: '' }));
    child.on('close', (code) => resolve({ code, stdout: out }));
    child.stdin.on('error', () => {}); // a child that exits early must not crash us
    child.stdin.end(input);
  });
}

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
/** PowerShell that reads base64 from stdin and writes base64 DPAPI output. `op` is Protect or Unprotect; the scripts hold no secret. */
const psScript = (op) =>
  `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd().Trim(); ` +
  `$b=[Convert]::FromBase64String($in); $e=[Convert]::FromBase64String('${ENTROPY_B64}'); ` +
  `$o=[System.Security.Cryptography.ProtectedData]::${op}($b,$e,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
  `[Console]::Out.Write([Convert]::ToBase64String($o))`;

/**
 * @param {{ dir: string, env?: NodeJS.ProcessEnv, platform?: string, run?: typeof runProcess }} opts
 *   `dir` holds secrets.json (and secrets-key.json for the file backend): the user config folder, or the shared-data folder in shared mode.
 *   STORYFORGE_SECRETS_BACKEND (env) forces a backend (tests, containers).
 */
export function createKeystore({ dir, env = process.env, platform = process.platform, run = runProcess }) {
  /** @type {Map<string, string>} decrypted secrets, kept for the life of the process */
  const cache = new Map();
  /** @type {Promise<string> | null} */
  let chosen = null;
  let queue = Promise.resolve();

  async function has(cmd, args) {
    const r = await run(cmd, args, '', env);
    return r.code === 0;
  }

  /** Pick the backend once. */
  function backend() {
    chosen ??= (async () => {
      const forced = env.STORYFORGE_SECRETS_BACKEND;
      if (forced) {
        if (!BACKENDS.includes(forced)) throw new KeystoreError('BAD_BACKEND', `STORYFORGE_SECRETS_BACKEND must be one of ${BACKENDS.join(', ')}`);
        return forced;
      }
      if (platform === 'win32') return 'dpapi';
      if (platform === 'darwin' && (await has('security', ['list-keychains']))) return 'macos-keychain';
      if (platform === 'linux' && env.DBUS_SESSION_BUS_ADDRESS && (await has('secret-tool', ['--version']))) return 'secret-service';
      return 'file-key';
    })();
    return chosen;
  }

  async function readFile() {
    const r = await readSharedJson(dir, FILE);
    if (r.state === 'missing') return { version: 1, entries: {} };
    if (r.state === 'corrupt' || !r.value || r.value.version !== 1 || typeof r.value.entries !== 'object' || r.value.entries === null) {
      throw new KeystoreError('LOCKED', `cannot unlock stored keys: ${FILE} is damaged`);
    }
    return r.value;
  }

  /** The file backend's 32-byte key: from the environment, or secrets-key.json (created on first use). */
  async function fileKey(create) {
    if (env.STORYFORGE_SECRETS_KEY) {
      const k = Buffer.from(env.STORYFORGE_SECRETS_KEY, 'base64');
      if (k.length !== 32) throw new KeystoreError('LOCKED', 'cannot unlock stored keys: STORYFORGE_SECRETS_KEY must be 32 bytes, base64');
      return k;
    }
    const r = await readSharedJson(dir, KEY_FILE);
    if (r.state === 'ok' && r.value && typeof r.value.key === 'string') {
      const k = Buffer.from(r.value.key, 'base64');
      if (k.length === 32) return k;
    }
    if (r.state !== 'missing') throw new KeystoreError('LOCKED', `cannot unlock stored keys: ${KEY_FILE} is damaged`);
    if (!create) throw new KeystoreError('LOCKED', `cannot unlock stored keys: ${KEY_FILE} is missing`);
    const k = crypto.randomBytes(32);
    await writeSharedJson(dir, KEY_FILE, { version: 1, key: k.toString('base64') });
    return k;
  }

  /** @param {string} id */
  const checkId = (id) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new KeystoreError('BAD_ARGS', 'bad secret id');
  };

  /** Serialise writes to secrets.json. @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const serial = (fn) => {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  };

  return {
    /** The backend in use (for Settings). */
    backend,

    /**
     * Store `secret` under `id`, replacing any earlier one.
     * @param {string} id @param {string} secret
     */
    async set(id, secret) {
      checkId(id);
      if (typeof secret !== 'string' || secret === '' || secret.length > 8192) throw new KeystoreError('BAD_ARGS', 'a secret must be 1 to 8192 characters');
      const b = await backend();
      await serial(async () => {
        const f = await readFile();
        if (b === 'dpapi') {
          const r = await run('powershell.exe', [...PS_ARGS, psScript('Protect')], Buffer.from(secret, 'utf8').toString('base64'), env);
          if (r.code !== 0 || r.stdout.trim() === '') throw new KeystoreError('STORE_FAILED', 'Windows could not protect the key (DPAPI)');
          f.entries[id] = { alg: 'dpapi', data: r.stdout.trim() };
        } else if (b === 'macos-keychain') {
          // `security -i` reads the command from stdin, so the secret never appears in a process list; hex keeps quoting trivial
          const r = await run('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${id} -w ${Buffer.from(secret, 'utf8').toString('hex')}\n`, env);
          if (r.code !== 0) throw new KeystoreError('STORE_FAILED', 'the macOS keychain refused the key');
          f.entries[id] = { alg: 'macos-keychain' };
        } else if (b === 'secret-service') {
          const r = await run('secret-tool', ['store', `--label=StoryForge ${id}`, 'service', SERVICE, 'account', id], secret, env);
          if (r.code !== 0) throw new KeystoreError('STORE_FAILED', 'the Secret Service refused the key');
          f.entries[id] = { alg: 'secret-service' };
        } else {
          const key = await fileKey(true);
          const iv = crypto.randomBytes(12);
          const c = crypto.createCipheriv('aes-256-gcm', key, iv);
          c.setAAD(Buffer.from(id, 'utf8'));
          const data = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
          f.entries[id] = { alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
        }
        await writeSharedJson(dir, FILE, f);
      });
      cache.set(id, secret);
    },

    /**
     * The secret stored under `id`, or null when none is stored. Throws KeystoreError('LOCKED') when one is stored but cannot be read.
     * @param {string} id @returns {Promise<string | null>}
     */
    async get(id) {
      checkId(id);
      if (cache.has(id)) return /** @type {string} */ (cache.get(id));
      const f = await readFile();
      const e = f.entries[id];
      if (!e) return null;
      let secret;
      if (e.alg === 'dpapi') {
        const r = await run('powershell.exe', [...PS_ARGS, psScript('Unprotect')], String(e.data ?? ''), env);
        if (r.code !== 0 || r.stdout.trim() === '') throw new KeystoreError('LOCKED', 'cannot unlock stored keys: they were protected for another Windows user or computer');
        secret = Buffer.from(r.stdout.trim(), 'base64').toString('utf8');
      } else if (e.alg === 'macos-keychain') {
        const r = await run('security', ['find-generic-password', '-s', SERVICE, '-a', id, '-w'], '', env);
        if (r.code !== 0) throw new KeystoreError('LOCKED', 'cannot unlock stored keys: the macOS keychain did not return it');
        secret = Buffer.from(r.stdout.trim(), 'hex').toString('utf8');
      } else if (e.alg === 'secret-service') {
        const r = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', id], '', env);
        if (r.code !== 0) throw new KeystoreError('LOCKED', 'cannot unlock stored keys: the Secret Service did not return it');
        secret = r.stdout.replace(/\n$/, '');
      } else if (e.alg === 'aes-256-gcm') {
        const key = await fileKey(false);
        try {
          const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
          d.setAAD(Buffer.from(id, 'utf8'));
          d.setAuthTag(Buffer.from(e.tag, 'base64'));
          secret = Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8');
        } catch {
          throw new KeystoreError('LOCKED', 'cannot unlock stored keys: the key file does not match (was secrets-key.json replaced?)');
        }
      } else {
        throw new KeystoreError('LOCKED', `cannot unlock stored keys: unknown storage "${String(e.alg)}"`);
      }
      if (secret === '') throw new KeystoreError('LOCKED', 'cannot unlock stored keys: an empty key came back');
      cache.set(id, secret);
      return secret;
    },

    /** Forget `id` everywhere it was stored. @param {string} id */
    async remove(id) {
      checkId(id);
      cache.delete(id);
      await serial(async () => {
        const f = await readFile();
        const e = f.entries[id];
        if (!e) return;
        if (e.alg === 'macos-keychain') await run('security', ['delete-generic-password', '-s', SERVICE, '-a', id], '', env);
        if (e.alg === 'secret-service') await run('secret-tool', ['clear', 'service', SERVICE, 'account', id], '', env);
        delete f.entries[id];
        await writeSharedJson(dir, FILE, f);
      });
    },

    /** Ids that have a stored secret (no values). @returns {Promise<string[]>} */
    async ids() {
      return Object.keys((await readFile()).entries).sort();
    },
  };
}

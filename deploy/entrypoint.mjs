// The container's entrypoint (M08-J01), also usable on a bare server (deploy/storyforge.service runs it). A launcher like scripts/launch.mjs: it reads the
// environment, checks it, creates the owner once (shared mode) and then starts `apps/server/src/main.mjs serve ...` and passes its exit code on.
//
//   STORYFORGE_MODE         personal | shared (default shared)
//   STORYFORGE_PUBLIC_URL   shared: the address people use, e.g. https://write.example.org (the TLS reverse proxy's)
//   STORYFORGE_PORT         default 4317
//   STORYFORGE_HOST         default 0.0.0.0 in shared mode, 127.0.0.1 in personal mode (personal refuses anything else, like the CLI)
//   STORYFORGE_OWNER        shared: when set and the shared data has no owner yet, run `shared init` once and print the setup link
//   STORYFORGE_LIBRARY      the library folder (default /library)
//   STORYFORGE_SHARED_DATA  shared: accounts, sessions and audit (default /shared-data)
//   XDG_CONFIG_HOME         the per-user config folder (the image sets /config)
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../apps/server/src/main.mjs', import.meta.url));
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * What the environment asks for. Pure, so a test can check every refusal.
 * @param {Record<string, string | undefined>} env
 * @returns {{ ok: true, mode: 'personal' | 'shared', host: string, port: string, library: string, sharedData: string, publicUrl: string | null, owner: string | null }
 *   | { ok: false, message: string }}
 */
export function planStart(env) {
  const text = (/** @type {string} */ name) => (env[name] ?? '').trim() || null;
  const mode = text('STORYFORGE_MODE') ?? 'shared';
  if (mode !== 'personal' && mode !== 'shared') return { ok: false, message: `STORYFORGE_MODE must be personal or shared, not "${mode}"` };
  const port = text('STORYFORGE_PORT') ?? '4317';
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) return { ok: false, message: `STORYFORGE_PORT must be a port number (0-65535), not "${port}"` };
  const host = text('STORYFORGE_HOST') ?? (mode === 'shared' ? '0.0.0.0' : '127.0.0.1');
  if (mode === 'personal' && !LOOPBACK.has(host.toLowerCase())) {
    return { ok: false, message: `STORYFORGE_HOST=${host} is refused in personal mode: it listens on 127.0.0.1 only (inside a container that is only reachable with network_mode: host). Use STORYFORGE_MODE=shared for access from other computers.` };
  }
  return { ok: true, mode, host, port, library: text('STORYFORGE_LIBRARY') ?? '/library', sharedData: text('STORYFORGE_SHARED_DATA') ?? '/shared-data', publicUrl: mode === 'shared' ? text('STORYFORGE_PUBLIC_URL') : null, owner: mode === 'shared' ? text('STORYFORGE_OWNER') : null };
}

/** @param {string} message @returns {number} */
function refuse(message) {
  process.stderr.write(`storyforge-entrypoint: ${message}\n`);
  return 2;
}

async function main() {
  const plan = planStart(process.env);
  if (!plan.ok) return refuse(plan.message);
  const node = process.execPath;
  const common = ['--library', plan.library, '--port', plan.port];
  const sharedArgs = ['--shared-data', plan.sharedData, ...(plan.publicUrl ? ['--public-url', plan.publicUrl] : [])];
  if (plan.mode === 'personal' && (process.env.STORYFORGE_OWNER || process.env.STORYFORGE_PUBLIC_URL)) {
    process.stderr.write('storyforge-entrypoint: STORYFORGE_OWNER and STORYFORGE_PUBLIC_URL are ignored in personal mode (no accounts)\n');
  }

  if (plan.mode === 'shared') {
    const { SharedDataError, openSharedData } = await import('@storyforge/shared');
    let hasOwner;
    try {
      hasOwner = (await openSharedData(plan.sharedData)).listMembers().some((m) => m.role === 'owner');
    } catch (e) {
      if (e instanceof SharedDataError) return refuse(`the shared data cannot be used: ${e.message} (nothing was changed; fix or move that file)`);
      throw e;
    }
    if (!hasOwner) {
      if (!plan.owner) return refuse(`shared mode has no owner yet: set STORYFORGE_OWNER=<user name> (3-32 characters: a-z, 0-9, dot, underscore, hyphen) and start again. Shared data: ${plan.sharedData}`);
      // once: the next start finds the owner and stays quiet. The setup link goes to this process's stdout, that is, the container log.
      const init = spawnSync(node, [MAIN, 'shared', 'init', '--owner', plan.owner, ...common, ...sharedArgs], { stdio: 'inherit' });
      if (init.status !== 0) return init.status ?? 1;
    }
  }

  const args = [MAIN, 'serve', ...common, ...(plan.mode === 'shared' ? ['--shared', '--host', plan.host, ...sharedArgs] : [])];
  const child = spawn(node, args, { stdio: 'inherit' });
  // as the container's first process this one gets the stop signal; the server closes cleanly on it
  for (const sig of /** @type {const} */ (['SIGTERM', 'SIGINT'])) process.on(sig, () => child.kill(sig));
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(await main());

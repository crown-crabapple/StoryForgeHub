// --open: show the running app in the user's browser with the system's own opener. No network, no dependency: the URL is the loopback address of this process.
import { spawn } from 'node:child_process';

/**
 * The command that opens `url` on `platform`. STORYFORGE_OPENER replaces it: a program that takes the URL as its last argument, or a JSON array [program, ...arguments]
 * (the URL is added at the end). That is how the tests observe the call without starting a browser.
 * @param {string} url
 * @param {{ platform?: string, env?: Record<string, string | undefined> }} [o]
 * @returns {{ command: string, args: string[] }}
 */
export function openerCommand(url, { platform = process.platform, env = process.env } = {}) {
  if (env.STORYFORGE_OPENER) {
    if (env.STORYFORGE_OPENER.startsWith('[')) {
      try {
        const [command, ...args] = JSON.parse(env.STORYFORGE_OPENER);
        if (typeof command === 'string') return { command, args: [...args.map(String), url] };
      } catch {
        /* not JSON: use it as a program name */
      }
    }
    return { command: env.STORYFORGE_OPENER, args: [url] };
  }
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  if (platform === 'darwin') return { command: 'open', args: [url] };
  return { command: 'xdg-open', args: [url] };
}

/**
 * Start the opener and do not wait for it. Resolves true when it was started, false (never throws) when there is no opener: the caller prints the address anyway.
 * @param {string} url
 * @param {Parameters<typeof openerCommand>[1]} [o]
 * @returns {Promise<boolean>}
 */
export function openBrowser(url, o) {
  const { command, args } = openerCommand(url, o);
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

// Runtime configuration for the server. Host is always loopback in this version.
import path from 'node:path';

export const DEFAULT_PORT = 4317;
export const HOST = '127.0.0.1';

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    /** process exit code the CLI should use */
    this.exitCode = 2;
  }
}

/**
 * Value of `--name <value>` or `--name=<value>`; the last occurrence wins.
 * @param {string[]} argv
 * @param {string} name
 * @returns {string | undefined}
 */
function argValue(argv, name) {
  let found;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === name) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new ConfigError(`${name} needs a value`);
      found = argv[i + 1];
      i++;
    } else if (a.startsWith(`${name}=`)) {
      found = a.slice(name.length + 1);
    }
  }
  return found;
}

/**
 * @param {{ argv?: string[], env?: Record<string, string | undefined> }} [input]
 *   argv: command-line arguments (flags are found wherever they appear).
 * @returns {{ libraryRoot: string, host: '127.0.0.1', port: number }}
 */
export function loadConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  const library = argValue(argv, '--library') || env.STORYFORGE_LIBRARY || '';
  if (!library) {
    throw new ConfigError('no library given: pass --library <path> or set STORYFORGE_LIBRARY');
  }
  const rawPort = argValue(argv, '--port') ?? env.STORYFORGE_PORT;
  let port = DEFAULT_PORT;
  if (rawPort !== undefined && rawPort !== '') {
    if (!/^\d+$/.test(rawPort) || Number(rawPort) > 65535) {
      throw new ConfigError(`invalid port: ${rawPort}`);
    }
    port = Number(rawPort);
  }
  return { libraryRoot: path.resolve(library), host: HOST, port };
}

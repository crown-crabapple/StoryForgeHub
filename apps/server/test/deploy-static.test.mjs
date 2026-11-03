// M08-J01 contract section 5.3: static checks of the Docker files. They parse the text; Docker is not needed and is never called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT } from './helpers.mjs';
import { HELP, HELP_COMMANDS } from '../src/help.mjs';

const read = (...p) => fs.readFile(path.join(REPO_ROOT, ...p), 'utf8');
const code = (text) => text.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));

/** Dockerfile instructions with continuation lines joined: [{ op, args }]. */
async function instructions() {
  const joined = code(await read('deploy', 'Dockerfile')).join('\n').replace(/\\\n\s*/g, ' ');
  return joined.split('\n').map((l) => {
    const m = /^(\w+)\s+(.*)$/.exec(l.trim());
    return { op: m[1].toUpperCase(), args: m[2] };
  });
}

test('Dockerfile: pinned base image, non-root USER, the three volumes, the entrypoint, no curl | sh', async () => {
  const ins = await instructions();
  const text = await read('deploy', 'Dockerfile');

  const froms = ins.filter((i) => i.op === 'FROM').map((i) => i.args.split(/\s+/)[0]);
  assert.ok(froms.length >= 2, 'multi-stage: a build stage and a runtime stage');
  for (const image of froms) {
    assert.match(image, /^node:\d+-bookworm-slim(@sha256:[0-9a-f]{64})?$/, `base image has an exact tag (and may carry a digest): ${image}`);
    assert.ok(!image.includes('latest'));
  }
  assert.match(text, /^# .*digest/im, 'the digest pinning is explained in a comment');
  assert.match(text, /npm ci --omit=dev|npm prune --omit=dev/, 'the runtime stage has production node_modules only');

  const users = ins.filter((i) => i.op === 'USER').map((i) => i.args.trim());
  assert.ok(users.length >= 1, 'a USER instruction');
  const last = users[users.length - 1];
  assert.ok(!/^(root|0)(:|$)/.test(last), `the container does not run as root: USER ${last}`);
  assert.match(last, /^10001(:10001)?$/, 'uid 10001');
  assert.ok(ins.findLastIndex((i) => i.op === 'USER') > ins.findLastIndex((i) => i.op === 'FROM'), 'USER is set in the final stage');

  const volume = ins.find((i) => i.op === 'VOLUME');
  assert.ok(volume, 'a VOLUME instruction');
  assert.deepEqual(JSON.parse(volume.args).sort(), ['/config', '/library', '/shared-data']);

  assert.deepEqual(JSON.parse(ins.find((i) => i.op === 'ENTRYPOINT').args), ['node', 'deploy/entrypoint.mjs']);
  await fs.access(path.join(REPO_ROOT, 'deploy', 'entrypoint.mjs'));

  assert.ok(!/(curl|wget)[^\n]*\|\s*(ba|z)?sh\b/.test(text), 'no curl | sh');
  const health = ins.find((i) => i.op === 'HEALTHCHECK');
  assert.ok(health, 'a HEALTHCHECK');
  assert.match(health.args, /node -e/);
  assert.match(health.args, /\/api\/health/);
  assert.ok(!/\bcurl\b/.test(health.args), 'curl is not in the slim image');

  const env = ins.filter((i) => i.op === 'ENV').map((i) => i.args).join(' ');
  for (const v of ['STORYFORGE_MODE=shared', 'STORYFORGE_LIBRARY=/library', 'XDG_CONFIG_HOME=/config', 'STORYFORGE_SHARED_DATA=/shared-data']) assert.ok(env.includes(v), v);
});

test('compose: built from the Dockerfile, published on 127.0.0.1 by default, the three folders mounted, restart policy, no database, no secrets', async () => {
  const text = await read('deploy', 'compose.yaml');
  const lines = code(text); // the commented caddy service is not part of the default
  const body = lines.join('\n');
  assert.match(body, /dockerfile: deploy\/Dockerfile/);
  assert.match(body, /restart: unless-stopped/);
  assert.match(body, /env_file:\s*\n\s*- storyforge\.env/);
  const ports = lines.filter((l) => /^\s*- ["']?[\d.:]+:\d+["']?\s*$/.test(l) && /\d+:\d+/.test(l)).map((l) => l.trim().replace(/^- /, '').replace(/["']/g, ''));
  assert.deepEqual(ports, ['127.0.0.1:4317:4317'], 'the only published port is on loopback');
  for (const m of ['./library:/library', './config:/config', './shared-data:/shared-data']) assert.ok(body.includes(`- ${m}`), m);
  assert.ok(!/\b(postgres|mysql|mariadb|mongo|redis)\b/i.test(body), 'no database service');
  assert.deepEqual([...body.matchAll(/^ {2}([a-z][\w-]*):\s*$/gm)].map((m) => m[1]).filter((n) => n !== 'storyforge' && n !== 'build'), [], 'one service by default');
  // the optional caddy service exists as a comment, not enabled
  assert.match(text, /^ {2}# caddy:/m);
  assert.match(text, /# {3}image: caddy:2/);
});

test('no secrets in the deployment files; every variable the entrypoint reads is documented line by line in the example env file', async () => {
  const names = ['Dockerfile', 'compose.yaml', 'storyforge.env.example', 'storyforge.service', 'Caddyfile.example', 'entrypoint.mjs'];
  for (const n of names) {
    const body = code(await read('deploy', n)).join('\n');
    assert.ok(!/(password|passwd|secret|api[_-]?key|token|credential)\s*[:=]\s*["']?[^\s"'#]{3,}/i.test(body), `${n}: no secret-looking assignment`);
    assert.ok(!/\b[A-Za-z0-9+/_-]{40,}\b/.test(body.replace(/https?:\/\/\S+/g, '')), `${n}: no long key-like string`);
    assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(body), n);
  }
  const example = (await read('deploy', 'storyforge.env.example')).split('\n');
  const entry = await read('deploy', 'entrypoint.mjs');
  const read_ = new Set([...entry.matchAll(/STORYFORGE_[A-Z_]+/g)].map((m) => m[0]));
  for (const v of ['STORYFORGE_MODE', 'STORYFORGE_PUBLIC_URL', 'STORYFORGE_PORT', 'STORYFORGE_HOST', 'STORYFORGE_OWNER', 'STORYFORGE_LIBRARY', 'STORYFORGE_SHARED_DATA']) {
    assert.ok(read_.has(v), `${v} is read by the entrypoint`);
    const i = example.findIndex((l) => l.startsWith(`${v}=`)) >= 0 ? example.findIndex((l) => l.startsWith(`${v}=`)) : example.findIndex((l) => l.startsWith(`# ${v}=`));
    assert.ok(i > 0, `${v} is in the example env file`);
    let j = i - 1;
    while (j >= 0 && example[j].trim() === '') j--;
    assert.ok(example[j].startsWith('#'), `${v} has a comment above it`);
  }
  assert.ok(example.some((l) => l.startsWith('XDG_CONFIG_HOME=') || l.startsWith('# XDG_CONFIG_HOME=')));
  assert.ok(!(await fs.access(path.join(REPO_ROOT, 'deploy', 'storyforge.env')).then(() => true, () => false)), 'a real storyforge.env is never committed');
});

test('.dockerignore keeps node_modules, .git, .storyforge/ and local data out of the build context', async () => {
  const lines = code(await read('.dockerignore')).map((l) => l.trim());
  for (const need of ['node_modules', '.git', '**/.storyforge']) assert.ok(lines.includes(need), need);
  assert.ok(lines.some((l) => /fixtures/.test(l)), 'test fixtures not needed at runtime');
  assert.ok(lines.includes('deploy/storyforge.env'));
});

test('systemd unit and Caddyfile examples: not root, the same entrypoint, a reverse proxy to the app', async () => {
  const unit = await read('deploy', 'storyforge.service');
  assert.match(unit, /^User=storyforge$/m);
  assert.match(unit, /^ExecStart=\S*node deploy\/entrypoint\.mjs$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/storyforge\/storyforge\.env$/m);
  assert.ok(!/^User=root$/m.test(unit));
  assert.match(await read('deploy', 'Caddyfile.example'), /reverse_proxy storyforge:4317/);
});

test('the docs name only commands and flags that exist in --help', async () => {
  const docs = ['self-hosting.md', 'development.md', 'install.md'];
  let seen = 0;
  for (const d of docs) {
    for (const line of (await read('docs', d)).split('\n')) {
      const m = /main\.mjs\s+([^`|]*)/.exec(line);
      if (!m) continue;
      seen++;
      const words = m[1].trim().split(/\s+/);
      const flags = words.filter((w) => w.startsWith('--'));
      const [first, second] = words.filter((w) => !w.startsWith('--') && !w.startsWith('<') && !w.startsWith('['));
      if (words[0] && !words[0].startsWith('--') && !words[0].startsWith('<') && !words[0].startsWith('[')) {
        const cmd = HELP_COMMANDS.find((c) => c === first || c === `${first} ${second}`);
        assert.ok(cmd, `${d}: "${words.join(' ')}" starts with a command that --help does not list`);
      }
      for (const f of flags) assert.ok(HELP.includes(f.replace(/=.*/, '')), `${d}: ${f} is not in --help`);
    }
  }
  assert.ok(seen >= 6, `the docs show main.mjs commands (${seen})`);
  // the new docs mention the owner recovery command by its help name
  assert.ok((await read('docs', 'self-hosting.md')).includes('shared reset-owner --owner'));
});

test('install-server.sh: shared mode on 127.0.0.1, settings written once and private, Caddy validated before a reload (never restarted), no firewall changes, no build', async () => {
  const text = await read('deploy', 'install-server.sh');
  const lines = code(text).join('\n');
  assert.match(text, /^#!\/bin\/sh\n/);
  assert.match(lines, /set -eu/);
  assert.match(lines, /STORYFORGE_MODE=shared/);
  assert.match(lines, /STORYFORGE_HOST=127\.0\.0\.1/);
  assert.match(lines, /if \[ ! -f "\$ENV_FILE" \]/, 'an existing storyforge.env is kept');
  assert.match(lines, /chmod 640 "\$ENV_FILE"/);
  assert.match(lines, /npm ci --omit=dev/);
  assert.doesNotMatch(lines, /npm run build/, 'a release ships the built app');
  const validate = lines.indexOf('caddy validate');
  const reload = lines.indexOf('systemctl reload caddy');
  assert.ok(validate > 0 && reload > validate, 'caddy validate comes before the reload');
  assert.doesNotMatch(lines, /systemctl (restart|stop) caddy/, 'other sites stay up');
  assert.doesNotMatch(lines, /\b(ufw|iptables|nft)\b/, 'the firewall is left alone');
  assert.doesNotMatch(lines, /curl[^\n]*\|\s*(sh|bash)/);
  const files = (await import('../../../scripts/release-build.mjs')).releaseFiles;
  assert.ok(files(REPO_ROOT).includes('deploy/install-server.sh'), 'the script ships in the release zip');
});

#!/usr/bin/env node
// Webhook receiver: a small Node HTTP server that checks the signature of every StoryForge webhook and appends each good event, one JSON line, to a local file.
// No dependencies; Node 22 or newer.
//
//   STORYFORGE_WEBHOOK_SECRET=<secret> node receiver.mjs [--port 8787] [--out events.jsonl]
//   node receiver.mjs --secret-file secret.txt         (the secret is read again for each request)
//
// StoryForge signs the exact request body: header  x-storyforge-signature: sha256=<hex hmac-sha256 of the body bytes, keyed with the secret>. Compute it over the
// raw bytes you received (before parsing) and compare in constant time; answer 401 to anything else. The body holds ids and hashes only (no text) unless the author
// turned on "include content" for this webhook. Answer with a 2xx quickly: StoryForge waits 5 seconds and retries a failure 3 times. See docs/plugins.md.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

/** Is `header` the signature of `body` under `secret`? @param {string | undefined} header @param {Buffer} body @param {string} secret */
export function signatureOk(header, body, secret) {
  if (typeof header !== 'string' || !header.startsWith('sha256=') || secret === '') return false;
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  const wanted = createHmac('sha256', secret).update(body).digest();
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/**
 * A receiver server (not yet listening).
 * @param {{ getSecret: () => string, out: string, onEvent?: (event: any) => void }} p `getSecret` is called for each request
 */
export function createReceiver({ getSecret, out, onEvent }) {
  return http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method !== 'POST' || !signatureOk(req.headers['x-storyforge-signature'], body, getSecret())) {
        res.writeHead(401).end();
        return;
      }
      let event;
      try {
        event = JSON.parse(body.toString('utf8'));
      } catch {
        res.writeHead(400).end();
        return;
      }
      appendFileSync(out, `${JSON.stringify(event)}\n`);
      onEvent?.(event);
      res.writeHead(204).end();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
  };
  const secretFile = flag('secret-file', undefined);
  const getSecret = () => (secretFile ? readFileSync(secretFile, 'utf8').trim() : (process.env.STORYFORGE_WEBHOOK_SECRET ?? ''));
  if (!secretFile && !process.env.STORYFORGE_WEBHOOK_SECRET) {
    process.stderr.write('usage: STORYFORGE_WEBHOOK_SECRET=<secret> node receiver.mjs [--port 8787] [--out events.jsonl]   (or --secret-file <file>)\n');
    process.exit(2);
  }
  const server = createReceiver({ getSecret, out: flag('out', 'events.jsonl') });
  server.listen(Number(flag('port', '8787')), '127.0.0.1', () => {
    process.stdout.write(`listening on http://127.0.0.1:${server.address().port}/\n`);
  });
}

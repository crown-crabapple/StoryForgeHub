// Preload (node --import) for spawned servers: records every outbound-network call to the JSONL file named by SF_NET_LOG.
// Not a test file. Wrapped: fetch, WebSocket, http/https request+get, net.connect/createConnection/Socket#connect,
// tls.connect, dgram.createSocket. Accepting inbound connections (http.createServer) is not recorded.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

const LOG = process.env.SF_NET_LOG;
const note = (api, args) => {
  let target = '';
  try {
    const a = args[0];
    target = typeof a === 'string' ? a : (a?.href ?? a?.url ?? JSON.stringify({ host: a?.host ?? a?.hostname, port: a?.port }));
  } catch {
    /* ignore */
  }
  if (LOG) fs.appendFileSync(LOG, JSON.stringify({ api, target: String(target).slice(0, 200) }) + '\n');
};
const wrap = (obj, name, api) => {
  const orig = obj[name];
  if (typeof orig !== 'function') return;
  obj[name] = function (...args) {
    note(api, args);
    return orig.apply(this, args);
  };
};

wrap(globalThis, 'fetch', 'fetch');
wrap(globalThis, 'WebSocket', 'WebSocket');
for (const [m, n] of [
  [http, 'http'],
  [https, 'https'],
]) {
  wrap(m, 'request', `${n}.request`);
  wrap(m, 'get', `${n}.get`);
}
wrap(net, 'connect', 'net.connect');
wrap(net, 'createConnection', 'net.createConnection');
wrap(net.Socket.prototype, 'connect', 'net.Socket#connect');
wrap(tls, 'connect', 'tls.connect');
wrap(dgram, 'createSocket', 'dgram.createSocket');
syncBuiltinESMExports();

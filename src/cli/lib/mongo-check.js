import { connect } from 'node:net';

/**
 * Where a MongoDB URI points: { srv: true } for mongodb+srv:// (needs DNS SRV, not checked),
 * { host, port } for the first host of a mongodb:// URI, or null when it cannot be read.
 * Credentials are dropped, so the result is safe to print.
 */
export function mongoTarget(uri) {
  const m = /^mongodb(\+srv)?:\/\/([^/?#]*)/i.exec(String(uri ?? '').trim());
  if (!m) return null;
  if (m[1]) return { srv: true };
  const first = m[2].slice(m[2].lastIndexOf('@') + 1).split(',')[0];
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(first);
  const [host, port] = v6 ? [v6[1], v6[2]] : first.split(':');
  if (!host) return null;
  const n = port === undefined || port === '' ? 27017 : Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return { host, port: n };
}

/** True when something accepts a TCP connection at host:port within the timeout. Never rejects. */
export function canConnect(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (up) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(up);
    };
    const socket = connect({ host, port });
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

/**
 * Lines to print after `calm create` when the MongoDB server is not reachable: empty when it is up
 * or the URI cannot be checked. A mongodb+srv:// URI gets a one-line note instead.
 */
export async function mongoHint(uri, { timeout } = {}) {
  const target = mongoTarget(uri);
  if (!target) return [];
  if (target.srv) return ['  Skipped the MongoDB check: mongodb+srv:// (Atlas) URIs need a DNS lookup.'];
  if (await canConnect(target.host, target.port, timeout)) return [];
  const where = target.host.includes(':') ? `[${target.host}]:${target.port}` : `${target.host}:${target.port}`;
  return [
    `  ! Nothing is listening on ${where} yet. Start MongoDB first:`,
    ...(LOCAL.has(target.host) ? [`      docker run -d --name mongo -p ${target.port}:27017 mongo:8`] : []),
    '    or use MongoDB Atlas: https://docs.calmapi.dev/getting-started#requirements',
  ];
}

import { lookup } from 'node:dns/promises';
import { createServer, request } from 'node:http';
import { BlockList, connect, isIP } from 'node:net';

const subnets = (list, entries) => {
  for (const [address, prefix] of entries) list.addSubnet(address, prefix, isIP(address) === 6 ? 'ipv6' : 'ipv4');
  return list;
};
const metadata = subnets(new BlockList(), [['169.254.0.0', 16], ['100.100.100.200', 32], ['fd00:ec2::254', 128]]);
const privateNetworks = subnets(new BlockList(), [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3], ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]);
const trackers = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com', 'googletagmanager.com',
  'googletagservices.com', 'adservice.google.com', 'amazon-adsystem.com', 'adnxs.com', 'adsrvr.org', 'criteo.com',
  'criteo.net', 'taboola.com', 'outbrain.com', 'rubiconproject.com', 'pubmatic.com', 'openx.net', 'casalemedia.com',
  'moatads.com', 'scorecardresearch.com', 'quantserve.com', 'hotjar.com', 'mixpanel.com', 'segment.io', 'fullstory.com',
  'clarity.ms', 'connect.facebook.net', 'ads-twitter.com', 'ads.linkedin.com', 'bat.bing.com', 'yieldmo.com',
  'sharethrough.com', 'teads.tv', 'media.net', 'smartadserver.com', 'bidswitch.net', '3lift.com', 'indexww.com',
];

export const isTracker = host => trackers.some(domain => host === domain || host.endsWith(`.${domain}`));

export function classify(address) {
  const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
  if (metadata.check(address, family)) return 'metadata';
  return privateNetworks.check(address, family) ? 'private' : null;
}

// Resolves once and returns the vetted address, so a rebinding DNS answer cannot reach a different host later.
export async function vet(host, port, { allow = [], adblock = true } = {}) {
  host = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (adblock && isTracker(host)) return { denied: 'tracker' };
  const allowed = allow.includes(`${host}:${port}`);
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) return { denied: 'unresolved' };
  for (const { address } of addresses) {
    const category = classify(address);
    if (category === 'metadata' || (category && !allowed)) return { denied: category };
  }
  return { address: addresses[0].address };
}

export function startGuard(policy) {
  const denials = [];
  let trackersBlocked = 0;
  const deny = (host, reason) => {
    if (reason === 'tracker') trackersBlocked += 1;
    else if (denials.length < 50) denials.push(`${host} (${reason})`);
  };
  const server = createServer(async (incoming, outgoing) => {
    const target = URL.canParse(incoming.url) ? new URL(incoming.url) : null;
    const port = Number(target?.port || 80);
    const vetted = target?.protocol === 'http:' ? await vet(target.hostname, port, policy) : { denied: 'unsupported' };
    if (vetted.denied) {
      deny(target?.host ?? 'invalid', vetted.denied);
      return outgoing.writeHead(403).end();
    }
    const upstream = request({ host: vetted.address, port, method: incoming.method, path: target.pathname + target.search,
      headers: incoming.headers, setHost: false }, response => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  server.on('connect', async (incoming, socket, head) => {
    socket.on('error', () => {});
    const [host, port] = [incoming.url.slice(0, incoming.url.lastIndexOf(':')), Number(incoming.url.split(':').pop())];
    const vetted = await vet(host, port, policy);
    if (vetted.denied) {
      deny(incoming.url, vetted.denied);
      return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
    const upstream = connect(port, vetted.address, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    drain: () => {
      const report = { denied: denials.splice(0), trackers: trackersBlocked };
      trackersBlocked = 0;
      return report;
    },
    close: () => server.close(),
  })));
}

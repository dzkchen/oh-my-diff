import { openSync, readSync, closeSync } from 'node:fs';

let result = { error: 'endpoint_missing' };
let fd;
try {
  fd = openSync(process.argv[2], 'r');
  const bytes = Buffer.alloc(8193);
  const size = readSync(fd, bytes);
  if (size <= 8192) {
    const endpoint = JSON.parse(bytes.subarray(0, size).toString('utf8'));
    const url = new URL(endpoint.url);
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && typeof endpoint.viewer === 'string' && endpoint.viewer.startsWith('/')) {
      result = { url: endpoint.url, viewer: endpoint.viewer };
    }
  }
} catch {} finally {
  if (fd !== undefined) closeSync(fd);
}
process.stdout.write(`${JSON.stringify(result)}\n`);

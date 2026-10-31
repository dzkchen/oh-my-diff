import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sealKey = token => createHash('sha256').update(`omd-handoff\0${token}`).digest();
const digest = value => createHash('sha256').update(JSON.stringify([value, process.execPath, createHash('sha256').update(readFileSync(process.argv[1])).digest('hex')])).digest('hex');

function seal(token, text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(token), iv);
  const data = Buffer.concat([cipher.update(text), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

function unseal(token, text) {
  const bytes = Buffer.from(text, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', sealKey(token), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
}

// Concurrent sessions share the store's fixed port: during the host's 3 s readiness window a later transport hands the owner its readiness nonce sealed with the shared local token, so only a token holder can read it, and takes the port once the owner has drained and exited. A holder that never serves the nonce fails the start.
export async function claim(server, port, token, ready, identity) {
  const from = digest(identity);
  const handoff = Date.now() + 3_000;
  let handedOff = false;
  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      return;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
    if (Date.now() < handoff) {
      await fetch(`http://127.0.0.1:${port}/_omd/nonce`, { method: 'POST', body: seal(token, `${ready} ${from} ${Date.now()}`), signal: AbortSignal.timeout(500) }).catch(() => {});
      handedOff ||= await fetch(`http://127.0.0.1:${port}/_omd/ready`, { signal: AbortSignal.timeout(500) }).then(reply => reply.text(), () => '') === `OMD_READY:${ready}`;
    } else if (!handedOff) throw new Error('provider_port_in_use');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

export function handoff(token, ready, identity, stop) {
  const own = digest(identity);
  let nonce = ready;
  return async (request, response) => {
    if (request.method === 'GET' && request.url === '/_omd/ready') { response.writeHead(200).end(`OMD_READY:${nonce}`); return true; }
    if (request.method !== 'POST' || request.url !== '/_omd/nonce') return false;
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024) { response.writeHead(413).end(); request.destroy(); return true; }
        chunks.push(chunk);
      }
    } catch {
      response.destroy();
      return true;
    }
    let handed;
    let from;
    let at;
    try { [handed, from, at] = unseal(token, Buffer.concat(chunks).toString()).split(' '); } catch { response.writeHead(401).end(); return true; }
    if (!(Math.abs(Date.now() - Number(at)) <= 5_000)) { response.writeHead(401).end(); return true; }
    nonce = handed.slice(0, 256);
    response.writeHead(204).end();
    // A transport started after setup changed the key or route takes the port once this one drains.
    if (from !== own) stop();
    return true;
  };
}

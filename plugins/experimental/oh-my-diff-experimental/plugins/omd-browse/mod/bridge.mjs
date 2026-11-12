import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = join(process.env.OMD_BROWSE_DATA || join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'omd-browse'), 'live');
const say = message => process.stdout.write(`${JSON.stringify(message)}\n`);
let socket = null;
let box = null;

function newest() {
  const servers = (existsSync(dir) ? readdirSync(dir) : []).filter(name => name.endsWith('.json')).flatMap(name => {
    try {
      const entry = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      process.kill(entry.pid, 0);
      return [entry];
    } catch {
      return [];
    }
  });
  return servers.sort((a, b) => b.used - a.used)[0] ?? null;
}

function attach() {
  const server = newest();
  if (!server) {
    say({ status: { waiting: true } });
    setTimeout(attach, 2000);
    return;
  }
  socket = connect(server.socket);
  let buffer = '';
  socket.on('connect', () => {
    if (box) socket.write(`${JSON.stringify(box)}\n`);
  });
  socket.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line) process.stdout.write(`${line}\n`);
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    socket = null;
    setTimeout(attach, 1000);
  });
}

globalThis.omdLines(line => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.box) box = message;
  if (socket?.writable) socket.write(`${JSON.stringify(message)}\n`);
});
attach();

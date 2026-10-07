import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';

test('tool bridge preserves UTF-8 split across TCP chunks', async () => {
  const server = net.createServer(socket => {
    socket.once('data', () => {
      const bytes = Buffer.from(JSON.stringify({ ok: true, result: '雪😀café' }) + '\n');
      const cut = bytes.indexOf(Buffer.from('雪')) + 1;
      socket.write(bytes.subarray(0, cut));
      setTimeout(() => socket.end(bytes.subarray(cut)), 30);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const child = spawn(process.env.OMD_TEST_BUN ?? process.execPath, [new URL('../plugins/bundled/oh-my-diff/plugins/omd-code-execution/kernels/bun.mjs', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const lines = readline.createInterface({ input: child.stdout });
    child.stdin.write(JSON.stringify({ port: server.address().port, token: 'fixture', code: 'console.log(await tool("read", {}))' }) + '\n');
    const [line] = await once(lines, 'line');
    const result = JSON.parse(line.replace('CODE_KERNEL_RESULT:', ''));
    assert.equal(result.ok, true);
    assert.equal(result.output, '雪😀café\n');
    lines.close();
  } finally {
    child.stdin.end();
    await once(child, 'exit');
    server.close();
    await once(server, 'close');
  }
});

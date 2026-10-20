import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';

for (const language of ['python', 'javascript']) {
  test(`${language} kernel preserves state and isolates late calls, denials and disconnects`, { timeout: 15_000 }, async t => {
    const calls = [];
    const server = net.createServer(socket => {
      let input = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        input += chunk;
        if (!input.includes('\n')) return;
        const request = JSON.parse(input);
        calls.push(request);
        if (request.name === 'disconnect') return socket.end();
        const result = request.token !== 'fixture' ? { ok: false, error: 'bridge authentication failed' }
          : request.name !== 'read' ? { ok: false, error: 'tool was not enabled for this cell' }
            : { ok: true, result: [2, 4, 3] };
        socket.end(JSON.stringify(result) + '\n');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const python = language === 'python';
    const script = new URL(`../plugins/bundled/oh-my-diff/plugins/omd-code-execution/kernels/${python ? 'python.py' : 'bun.mjs'}`, import.meta.url).pathname;
    const child = spawn(python ? 'python3' : process.env.OMD_TEST_BUN ?? process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    t.after(async () => {
      child.kill();
      await exited;
      server.close();
      await once(server, 'close');
    });
    const cell = async code => {
      child.stdin.write(JSON.stringify({ port: server.address().port, token: 'fixture', code }) + '\n');
      const { value, done } = await lines.next();
      assert.equal(done, false);
      assert.ok(value.startsWith('CODE_KERNEL_RESULT:'), value);
      return JSON.parse(value.slice('CODE_KERNEL_RESULT:'.length));
    };
    assert.deepEqual(await cell(python ? 'values = tool("read"); print(values)' : 'globalThis.values = await tool("read"); console.log(values)'),
      { ok: true, output: python ? '[2, 4, 3]\n' : '[2,4,3]\n', bridge_failed: false });
    assert.deepEqual(await cell(python ? 'print(sum(values))' : 'console.log(values.reduce((a, b) => a + b, 0))'),
      { ok: true, output: '9\n', bridge_failed: false });
    const noisy = await cell(python ? 'import sys, os\nprint("e", file=sys.stderr)\nos.system("echo y")\nprint("CODE_KERNEL_RESULT:{}")' : 'console.error("e"); process.stdout.write("y\\n"); process.stderr.write("z\\n"); console.log("CODE_KERNEL_RESULT:{}")');
    assert.equal(noisy.ok, true);
    assert.deepEqual(noisy.output.split('\n').sort(), python ? ['', 'CODE_KERNEL_RESULT:{}', 'e', 'y'] : ['', 'CODE_KERNEL_RESULT:{}', 'e', 'y', 'z']);
    const started = await cell(python ? `import threading, contextvars
release = threading.Event()
def late_call():
    global late_error
    release.wait()
    try: tool("read")
    except Exception as error: late_error = str(error)
context = contextvars.copy_context()
worker = threading.Thread(target=lambda: context.run(late_call))
worker.start()` : `globalThis.late = new Promise(resolve => { globalThis.release = resolve; }).then(async () => {
  try { await tool("read"); } catch (error) { globalThis.lateError = String(error); }
});`);
    assert.equal(started.ok, true);
    const late = await cell(python ? 'release.set(); worker.join(); print(late_error)' : 'release(); await late; console.log(lateError)');
    assert.equal(late.ok, true);
    assert.match(late.output, /no active kernel cell/);
    assert.equal(calls.length, 1, 'old cells must not send calls through a later cell');
    const denied = await cell(python ? 'tool("unlisted")' : 'await tool("unlisted")');
    assert.equal(denied.ok, false);
    assert.equal(denied.bridge_failed, false);
    assert.match(denied.error, /not enabled/);
    const disconnected = await cell(python ? 'tool("disconnect")' : 'await tool("disconnect")');
    assert.equal(disconnected.ok, false);
    assert.equal(disconnected.bridge_failed, true);
    assert.match(disconnected.error, /disconnected/);
    const recovered = await cell(python ? 'print(tool("read"))' : 'console.log(await tool("read"))');
    assert.equal(recovered.ok, true);
    assert.equal(recovered.bridge_failed, false);
    assert.deepEqual(calls.map(call => [call.token, call.name]), [['fixture', 'read'], ['fixture', 'unlisted'], ['fixture', 'disconnect'], ['fixture', 'read']]);
  });
}

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

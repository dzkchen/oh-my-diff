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
    assert.equal(noisy.output, python ? 'e\ny\nCODE_KERNEL_RESULT:{}\n' : 'e\ny\nz\nCODE_KERNEL_RESULT:{}\n');
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

for (const language of ['python', 'javascript']) {
  test(`${language} kernel keeps output written outside a cell off the result line and caps floods`, { timeout: 30_000 }, async t => {
    const python = language === 'python';
    const script = new URL(`../plugins/bundled/oh-my-diff/plugins/omd-code-execution/kernels/${python ? 'python.py' : 'bun.mjs'}`, import.meta.url).pathname;
    const child = spawn(python ? 'python3' : process.env.OMD_TEST_BUN ?? process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    t.after(async () => {
      child.kill();
      await exited;
    });
    const cell = async code => {
      child.stdin.write(JSON.stringify({ port: 1, token: 'fixture', code }) + '\n');
      const { value } = await lines.next();
      assert.ok(value.startsWith('CODE_KERNEL_RESULT:'), value.slice(0, 200));
      return JSON.parse(value.slice('CODE_KERNEL_RESULT:'.length));
    };
    const flood = "yes x | head -c 3000000";
    await cell(python
      ? 'import threading, time, os\nthreading.Thread(target=lambda: (time.sleep(0.3), print("late"), os.write(1, b"raw\\n"), os.write(2, b"err\\n"))).start()'
      : 'const { spawn } = await import("node:child_process");\nspawn("sh", ["-c", "sleep 0.3; echo late; echo err >&2"], { stdio: "inherit" }).unref();');
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.deepEqual(await cell(python ? 'print("next")' : 'console.log("next")'), { ok: true, output: 'next\n', bridge_failed: false });
    assert.deepEqual(await cell(python
      ? 'import os\nprint("a")\nos.system("echo b")\nprint("c")'
      : 'console.log("a");\n(await import("node:child_process")).execSync("echo b", { stdio: "inherit" });\nconsole.log("c");'),
    { ok: true, output: 'a\nb\nc\n', bridge_failed: false });
    const flooded = await cell(python
      ? `import os, stat\nregular = stat.S_ISREG(os.fstat(1).st_mode)\nos.system("${flood}")\nraise RuntimeError("boom")`
      : `try { (await import("node:child_process")).execSync("${flood}", { stdio: "inherit" }); } catch {}\nthrow new Error("boom");`);
    assert.equal(flooded.ok, false);
    assert.match(flooded.error, /boom/);
    assert.match(flooded.error, /output limit exceeded/);
    assert.ok(Buffer.byteLength(flooded.output) <= 65536);
    assert.deepEqual(await cell(python ? 'print(regular)' : 'console.log("after")'), { ok: true, output: python ? 'False\n' : 'after\n', bridge_failed: false });
  });
}

test('javascript kernel survives a background child writing while the result frame is sent', { timeout: 30_000 }, async t => {
  const child = spawn(process.env.OMD_TEST_BUN ?? process.execPath, [new URL('../plugins/bundled/oh-my-diff/plugins/omd-code-execution/kernels/bun.mjs', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  t.after(async () => {
    child.kill();
    await exited;
  });
  const cell = async code => {
    child.stdin.write(JSON.stringify({ port: 1, token: 'fixture', code }) + '\n');
    const { value } = await Promise.race([lines.next(), exited.then(() => assert.fail('kernel exited'))]);
    assert.ok(value.startsWith('CODE_KERNEL_RESULT:'), value.slice(0, 200));
    return JSON.parse(value.slice('CODE_KERNEL_RESULT:'.length));
  };
  const spawnNoise = delay => `const { spawn } = await import("node:child_process");\nglobalThis.noise = [1, 2, 3].map(() => spawn("sh", ["-c", "sleep ${delay}; exec yes noise"], { stdio: "inherit" }));\nconsole.log("x".repeat(60000));`;
  const stopNoise = 'noise.forEach(child => child.kill());\nawait new Promise(resolve => setTimeout(resolve, 300));';
  for (let round = 0; round < 10; round++) {
    const overlapped = await cell(spawnNoise(0) + '\nawait new Promise(resolve => setTimeout(resolve, 300));');
    assert.equal(overlapped.ok, false);
    assert.match(overlapped.error, /output limit exceeded/);
    await cell(stopNoise);
  }
  assert.deepEqual(await cell(spawnNoise(0.05)), { ok: true, output: 'x'.repeat(60000) + '\n', bridge_failed: false });
  await new Promise(resolve => setTimeout(resolve, 200));
  await cell(stopNoise);
  assert.deepEqual(await cell('console.log("next")'), { ok: true, output: 'next\n', bridge_failed: false });
});

test('javascript kernel waits out a full stdout pipe instead of dropping output or exiting', { timeout: 30_000 }, async t => {
  const child = spawn(process.env.OMD_TEST_BUN ?? process.execPath, [new URL('../plugins/bundled/oh-my-diff/plugins/omd-code-execution/kernels/bun.mjs', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  t.after(async () => {
    child.kill('SIGCONT');
    child.kill();
    await exited;
  });
  child.stdin.write(JSON.stringify({ port: 1, token: 'fixture', code: 'await new Promise(resolve => setTimeout(resolve, 300));\nconsole.log("x".repeat(65499));' }) + '\n');
  await new Promise(resolve => setTimeout(resolve, 100));
  child.kill('SIGSTOP');
  await new Promise(resolve => setTimeout(resolve, 700));
  child.kill('SIGCONT');
  const { value } = await Promise.race([lines.next(), exited.then(() => assert.fail('kernel exited'))]);
  assert.deepEqual(JSON.parse(value.slice('CODE_KERNEL_RESULT:'.length)), { ok: true, output: 'x'.repeat(65499) + '\n', bridge_failed: false });
});

for (const language of ['python', 'javascript']) {
  test(`${language} kernel survives stray errors and exit requests`, { timeout: 30_000 }, async t => {
    const python = language === 'python';
    const script = new URL(`../plugins/bundled/oh-my-diff/plugins/omd-code-execution/kernels/${python ? 'python.py' : 'bun.mjs'}`, import.meta.url).pathname;
    const child = spawn(python ? 'python3' : process.env.OMD_TEST_BUN ?? process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    t.after(async () => {
      child.kill();
      await exited;
    });
    const cell = async code => {
      child.stdin.write(JSON.stringify({ port: 1, token: 'fixture', code }) + '\n');
      const { value, done } = await Promise.race([lines.next(), exited.then(() => assert.fail('kernel exited'))]);
      assert.equal(done, false, 'kernel exited');
      assert.ok(value.startsWith('CODE_KERNEL_RESULT:'), value.slice(0, 200));
      return JSON.parse(value.slice('CODE_KERNEL_RESULT:'.length));
    };
    const alive = async () => assert.deepEqual(await cell(python ? 'print("alive")' : 'console.log("alive")'), { ok: true, output: 'alive\n', bridge_failed: false });
    if (python) {
      for (const [code, name] of [['exit()', 'SystemExit'], ['import sys\nsys.exit(3)', 'SystemExit: 3'], ['raise KeyboardInterrupt', 'KeyboardInterrupt']]) {
        const result = await cell(code);
        assert.equal(result.ok, false);
        assert.match(result.error, new RegExp(name));
        await alive();
      }
      return;
    }
    await cell('globalThis.timer = setInterval(() => console.log("x".repeat(40000)), 10);');
    const flooded = await cell('await new Promise(resolve => setTimeout(resolve, 300));');
    assert.equal(flooded.ok, false);
    assert.match(flooded.error, /output limit exceeded/);
    await cell('clearInterval(timer);');
    await alive();
    await cell('setTimeout(() => Promise.reject(new Error("stray")), 20);\nsetTimeout(() => { throw new Error("thrown"); }, 20);');
    await new Promise(resolve => setTimeout(resolve, 200));
    await alive();
    const reported = await cell('setTimeout(() => Promise.reject(new Error("stray")), 20);\nawait new Promise(resolve => setTimeout(resolve, 200));');
    assert.equal(reported.ok, false);
    assert.match(reported.error, /stray/);
    await alive();
  });
}

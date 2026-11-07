import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';

const RESULT = 'CODE_KERNEL_RESULT:fixture:';

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
    const script = new URL(`../plugins/experimental/oh-my-diff-experimental/plugins/omd-code-execution/kernels/${python ? 'python.py' : 'bun.mjs'}`, import.meta.url).pathname;
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
      assert.ok(value.startsWith(RESULT), value);
      return JSON.parse(value.slice(RESULT.length));
    };
    assert.deepEqual(await cell(python ? 'values = tool("read"); print(values)' : 'globalThis.values = await tool("read"); console.log(values)'),
      { ok: true, output: python ? '[2, 4, 3]\n' : '[2,4,3]\n', bridge_failed: false });
    assert.deepEqual(await cell(python ? 'print(sum(values))' : 'console.log(values.reduce((a, b) => a + b, 0))'),
      { ok: true, output: '9\n', bridge_failed: false });
    const noisy = await cell(python ? 'import sys, os\nprint("e", file=sys.stderr)\nos.system("echo y")\nprint("CODE_KERNEL_RESULT:fixture:{\\"ok\\":false}")' : 'console.error("e"); process.stdout.write("y\\n"); process.stderr.write("z\\n"); console.log("CODE_KERNEL_RESULT:fixture:{\\"ok\\":false}")');
    assert.equal(noisy.ok, true);
    assert.equal(noisy.output, python ? 'e\ny\nCODE_KERNEL_RESULT:fixture:{"ok":false}\n' : 'e\ny\nz\nCODE_KERNEL_RESULT:fixture:{"ok":false}\n');
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
  const child = spawn(process.env.OMD_TEST_BUN ?? process.execPath, [new URL('../plugins/experimental/oh-my-diff-experimental/plugins/omd-code-execution/kernels/bun.mjs', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const lines = readline.createInterface({ input: child.stdout });
    child.stdin.write(JSON.stringify({ port: server.address().port, token: 'fixture', code: 'console.log(await tool("read", {}))' }) + '\n');
    const [line] = await once(lines, 'line');
    const result = JSON.parse(line.slice(RESULT.length));
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
    const script = new URL(`../plugins/experimental/oh-my-diff-experimental/plugins/omd-code-execution/kernels/${python ? 'python.py' : 'bun.mjs'}`, import.meta.url).pathname;
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
      assert.ok(value.startsWith(RESULT), value.slice(0, 200));
      return JSON.parse(value.slice(RESULT.length));
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

for (const language of ['python', 'javascript']) {
  test(`${language} kernel discards output an older cell writes during a later one`, { timeout: 30_000 }, async t => {
    const python = language === 'python';
    const script = new URL(`../plugins/experimental/oh-my-diff-experimental/plugins/omd-code-execution/kernels/${python ? 'python.py' : 'bun.mjs'}`, import.meta.url).pathname;
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
      assert.ok(value.startsWith(RESULT), value.slice(0, 200));
      return JSON.parse(value.slice(RESULT.length));
    };
    await cell(python
      ? 'import os, subprocess, sys, threading\nfrom concurrent.futures import ThreadPoolExecutor\nrelease = threading.Event()\ndone = threading.Event()\ndef old():\n    release.wait()\n    print("OLD CELL OUTPUT")\n    os.write(1, b"OLD RAW\\n")\n    sys.__stdout__.write("OLD DUNDER\\n")\n    subprocess.run(["echo", "OLD SPAWNED"])\n    os.system("echo OLD SYSTEM")\n    subprocess.run(["sh", "-c", "echo OLD DUNDER CHILD"], stdout=sys.__stdout__)\n    global mine\n    read, write = os.pipe()\n    os.waitpid(os.posix_spawnp("sh", ["sh", "-c", "echo mine"], os.environ, file_actions=[(os.POSIX_SPAWN_DUP2, write, 1)]), 0)\n    os.close(write)\n    mine = os.read(read, 100)\n    done.set()\nthreading.Thread(target=old).start()\nimport _thread\nraw = threading.Event()\n_thread.start_new_thread(lambda: (release.wait(), print("OLD RAW THREAD"), raw.set()), ())\npool = ThreadPoolExecutor(1)\npool.submit(print, "first").result()\nshell = subprocess.Popen(["sh", "-c", "read line; echo OLD CHILD"], stdin=subprocess.PIPE)'
      : 'const { spawn } = await import("node:child_process");\nglobalThis.shell = spawn("sh", ["-c", "read line; echo OLD CHILD; echo OLD RAW >&2"], { stdio: ["pipe", "inherit", "inherit"] });\nglobalThis.done = new Promise(resolve => { globalThis.release = resolve; }).then(() => new Promise(resolve => setTimeout(resolve, 10))).then(async () => {\n  console.log("OLD CELL OUTPUT");\n  fs.writeSync(1, "OLD WRITE\\n");\n  (await import("node:fs")).writeSync(2, "OLD NAMED\\n");\n  const { execSync, spawn } = await import("node:child_process");\n  execSync("echo OLD SYNC", { stdio: "inherit" });\n  await new Promise(resolve => spawn("sh", ["-c", "echo OLD SPAWNED"], { stdio: "inherit" }).on("close", resolve));\n  if (globalThis.Bun) await Bun.spawn(["sh", "-c", "echo OLD BUN >&2"], { stdout: "inherit" }).exited;\n  console.dir("OLD DIR"); console.table(["OLD TABLE"]); console.trace("OLD TRACE");\n  fs.writeFileSync(1, "OLD FILE\\n"); await new Promise(resolve => fs.write(2, "OLD ASYNC\\n", resolve));\n  (await import("node:child_process")).spawnSync("sh", ["-c", "echo OLD CROSSED >&2"], { stdio: ["pipe", "pipe", 1] });\n  if (globalThis.Bun) { await Bun.write(Bun.stdout, "OLD BUN WRITE\\n"); await Bun.$`echo OLD SHELL`; Bun.spawnSync(["echo", "OLD FD"], { stdout: 1 }); }\n});');
    const result = await cell(python
      ? 'release.set(); done.wait(); raw.wait()\nshell.communicate(b"go\\n")\npool.submit(print, "POOL OUTPUT").result()\nprint(mine)\nprint("NEW CELL OUTPUT")'
      : 'release(); await done;\nshell.stdin.end("go\\n"); await new Promise(resolve => shell.on("close", resolve));\nconsole.log("NEW CELL OUTPUT");');
    const expected = python ? "POOL OUTPUT\nb'mine\\n'\nNEW CELL OUTPUT\n" : 'NEW CELL OUTPUT\n';
    assert.deepEqual(result, { ok: true, output: expected, bridge_failed: false });
  });
}

test('python kernel keeps its standard streams usable inside a cell', { timeout: 30_000 }, async t => {
  const script = new URL('../plugins/experimental/oh-my-diff-experimental/plugins/omd-code-execution/kernels/python.py', import.meta.url).pathname;
  const child = spawn('python3', [script], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  t.after(async () => {
    child.kill();
    await exited;
  });
  child.stdin.write(JSON.stringify({ port: 1, token: 'fixture', code: `import concurrent.futures, faulthandler, math, os, subprocess, sys
print("fileno", sys.__stdout__.fileno(), sys.__stdout__.encoding)
subprocess.run(["echo", "via dunder"], stdout=sys.__stdout__)
faulthandler.enable(file=sys.__stderr__)
read, write = os.pipe()
os.waitpid(os.posix_spawnp("sh", ["sh", "-c", "echo mine"], os.environ, file_actions=[(os.POSIX_SPAWN_DUP2, write, 1)]), 0)
os.close(write)
print(os.read(read, 100))
pools = getattr(concurrent.futures, "InterpreterPoolExecutor", concurrent.futures.ThreadPoolExecutor)
print(pools(1).submit(math.sqrt, 16).result())` }) + '\n');
  const { value } = await lines.next();
  assert.deepEqual(JSON.parse(value.slice(RESULT.length)), { ok: true, output: "fileno 1 utf-8\nvia dunder\nb'mine\\n'\n4.0\n", bridge_failed: false });
});

test('javascript kernel survives a background child writing while the result frame is sent', { timeout: 30_000 }, async t => {
  const child = spawn(process.env.OMD_TEST_BUN ?? process.execPath, [new URL('../plugins/experimental/oh-my-diff-experimental/plugins/omd-code-execution/kernels/bun.mjs', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  t.after(async () => {
    child.kill();
    await exited;
  });
  const cell = async code => {
    child.stdin.write(JSON.stringify({ port: 1, token: 'fixture', code }) + '\n');
    const { value } = await Promise.race([lines.next(), exited.then(() => assert.fail('kernel exited'))]);
    assert.ok(value.startsWith(RESULT), value.slice(0, 200));
    return JSON.parse(value.slice(RESULT.length));
  };
  const spawnNoise = delay => `const { spawn } = await import("node:child_process");\nglobalThis.noise = [1, 2, 3].map(() => spawn("sh", ["-c", "sleep ${delay}; exec yes noise"], { stdio: "inherit" }));\nconsole.log("x".repeat(60000));`;
  const stopNoise = 'noise.forEach(child => child.kill());\nawait new Promise(resolve => setTimeout(resolve, 300));';
  for (let round = 0; round < 10; round++) {
    const overlapped = await cell(spawnNoise(0) + '\nawait new Promise(resolve => setTimeout(resolve, 300));');
    assert.equal(overlapped.ok, false);
    assert.match(overlapped.error, /output limit exceeded/);
    await cell(stopNoise);
  }
  assert.deepEqual(await cell(spawnNoise(0.5)), { ok: true, output: 'x'.repeat(60000) + '\n', bridge_failed: false });
  await new Promise(resolve => setTimeout(resolve, 800));
  await cell(stopNoise);
  assert.deepEqual(await cell('console.log("next")'), { ok: true, output: 'next\n', bridge_failed: false });
});

test('javascript kernel waits out a full stdout pipe instead of dropping output or exiting', { timeout: 30_000 }, async t => {
  const child = spawn(process.env.OMD_TEST_BUN ?? process.execPath, [new URL('../plugins/experimental/oh-my-diff-experimental/plugins/omd-code-execution/kernels/bun.mjs', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  assert.deepEqual(JSON.parse(value.slice(RESULT.length)), { ok: true, output: 'x'.repeat(65499) + '\n', bridge_failed: false });
});

for (const language of ['python', 'javascript']) {
  test(`${language} kernel survives stray errors and exit requests`, { timeout: 30_000 }, async t => {
    const python = language === 'python';
    const script = new URL(`../plugins/experimental/oh-my-diff-experimental/plugins/omd-code-execution/kernels/${python ? 'python.py' : 'bun.mjs'}`, import.meta.url).pathname;
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
      assert.ok(value.startsWith(RESULT), value.slice(0, 200));
      return JSON.parse(value.slice(RESULT.length));
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
    const flooded = await cell('globalThis.timer = setInterval(() => console.log("x".repeat(40000)), 10);\nawait new Promise(resolve => setTimeout(resolve, 300));');
    assert.equal(flooded.ok, false);
    assert.match(flooded.error, /output limit exceeded/);
    assert.deepEqual(await cell('await new Promise(resolve => setTimeout(resolve, 300));'), { ok: true, output: '', bridge_failed: false }, 'an older cell\'s timer writes nowhere');
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

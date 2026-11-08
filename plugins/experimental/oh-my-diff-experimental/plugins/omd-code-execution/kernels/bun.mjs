import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";

async function worker() {
  const net = await import("node:net");
  const readline = await import("node:readline");
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const frame = process.env.OMD_KERNEL_FRAME;
  delete process.env.OMD_KERNEL_FRAME;
  const bridgeContext = new AsyncLocalStorage();
  let bridgeFailed = false;
  let outputBytes = 0;
  let strays;
  let current;
  const owned = () => current !== undefined && bridgeContext.getStore() === current;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const writeSync = fs.writeSync;
  const stdioTarget = (target) => target === 1 || target === 2 || globalThis.Bun && (target === Bun.stdout || target === Bun.stderr);
  const size = (data) => Array.isArray(data) ? data.reduce((total, part) => total + size(part), 0) : typeof data === "string" ? Buffer.byteLength(data) : data?.byteLength ?? 0;
  for (const name of ["writeSync", "writevSync", "writeFileSync", "appendFileSync"]) {
    const original = fs[name];
    fs[name] = (fd, data, ...rest) => stdioTarget(fd) && !owned() ? size(data) : original(fd, data, ...rest);
  }
  for (const name of ["write", "writev", "writeFile", "appendFile"]) {
    const original = fs[name];
    fs[name] = (fd, data, ...rest) => {
      if (!stdioTarget(fd) || owned()) return original(fd, data, ...rest);
      const done = rest.at(-1);
      if (typeof done === "function") queueMicrotask(() => name.endsWith("File") ? done(null) : done(null, size(data), data));
    };
  }
  const writeAll = (fd, text) => {
    for (let data = Buffer.from(text); data.length;) {
      try {
        data = data.subarray(writeSync(fd, data));
      } catch (error) {
        if (error.code !== "EAGAIN") throw error;
        Atomics.wait(pause, 0, 0, 1);
      }
    }
  };

  globalThis.tool = async (name, args = {}) => {
    const bridge = bridgeContext.getStore();
    if (!bridge?.active) throw new Error("no active kernel cell");
    const payload = JSON.stringify({ token: bridge.token, name, arguments: args }) + "\n";
    if (Buffer.byteLength(payload) > 65536) throw new Error("tool request limit exceeded");
    return await new Promise((resolve, reject) => {
      const connection = net.createConnection({ host: "127.0.0.1", port: bridge.port });
      let response = Buffer.alloc(0);
      let reachable = false;
      connection.setTimeout(120000, () => { reachable = true; connection.destroy(new Error("tool bridge timeout")); });
      connection.on("connect", () => connection.write(payload));
      connection.on("data", (data) => {
        response = Buffer.concat([response, data]);
        if (response.length > 262144) {
          reachable = true;
          connection.destroy(new Error("tool response limit exceeded"));
        } else if (response.includes("\n")) {
          connection.end();
          try {
            const result = JSON.parse(response.subarray(0, response.indexOf("\n")).toString('utf8'));
            if (result.ok) resolve(result.result);
            else reject(new Error(result.error || "tool call failed"));
          } catch (error) {
            reject(error);
          }
        }
      });
      connection.on("error", (error) => { if (!reachable) bridgeFailed = true; reject(error); });
      connection.on("end", () => { if (!response.includes("\n")) { bridgeFailed = true; reject(new Error("tool bridge disconnected")); } });
    });
  };

  const record = (text) => {
    if (!owned()) return;
    const size = Buffer.byteLength(text);
    if (outputBytes + size > 65536) throw new Error("kernel output limit exceeded");
    outputBytes += size;
    writeAll(1, text);
  };
  const capture = (...values) => record(values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ") + "\n");
  const captureWrite = (chunk, encoding, callback) => {
    record(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    (typeof encoding === "function" ? encoding : callback)?.();
    return true;
  };
  for (const name of Object.getOwnPropertyNames(console)) {
    const original = console[name];
    if (typeof original !== "function") continue;
    console[name] = ["log", "error", "warn", "info", "debug"].includes(name) ? capture : (...args) => owned() ? original.apply(console, args) : undefined;
  }
  process.stdout.write = process.stderr.write = captureWrite;
  const ffi = globalThis.Bun ? await import("bun:ffi") : null;
  const libc = ffi?.dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
    pipe: { args: [ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
    dup: { args: [ffi.FFIType.i32], returns: ffi.FFIType.i32 },
    dup2: { args: [ffi.FFIType.i32, ffi.FFIType.i32], returns: ffi.FFIType.i32 },
  }).symbols;
  const out = libc ? libc.dup(1) : 1;
  const quiet = libc ? fs.openSync("/dev/null", "w") : -1;
  const marker = Buffer.from((await import("node:crypto")).randomBytes(16).toString("hex"));
  const { Worker } = await import("node:worker_threads");
  const drainer = `const { workerData: { reader, out, marker }, parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const tag = Buffer.from(marker);
const chunk = Buffer.alloc(65536);
const pause = new Int32Array(new SharedArrayBuffer(4));
let held = Buffer.alloc(0);
let sent = 0;
let done = false;
for (;;) {
  let size;
  try { size = fs.readSync(reader, chunk); } catch (error) { if (error.code === "EAGAIN") { Atomics.wait(pause, 0, 0, 1); continue; } break; }
  if (!size) break;
  if (done) continue;
  held = Buffer.concat([held, chunk.subarray(0, size)]);
  const at = held.indexOf(tag);
  const cut = at >= 0 ? at : Math.max(held.length - tag.length + 1, 0);
  for (let data = held.subarray(0, Math.min(cut, Math.max(65537 - sent, 0))); data.length;) {
    try { const written = fs.writeSync(out, data); sent += written; data = data.subarray(written); } catch (error) { if (error.code !== "EAGAIN") throw error; Atomics.wait(pause, 0, 0, 1); }
  }
  held = held.subarray(cut);
  if (at >= 0) { done = true; held = Buffer.alloc(0); parentPort.postMessage("ended"); }
}
fs.closeSync(reader);`;
  // Under Bun each cell's fd 1 and 2 are its own pipe, so children and raw writes outliving the cell write nowhere.
  const redirect = () => {
    if (!libc) return async () => {};
    const fds = new Int32Array(2);
    if (libc.pipe(ffi.ptr(fds)) !== 0) throw new Error("kernel output pipe failed");
    const [reader, writer] = fds;
    libc.dup2(writer, 1);
    libc.dup2(writer, 2);
    const drain = new Worker(drainer, { eval: true, workerData: { reader, out, marker: marker.toString() } });
    drain.unref();
    const ended = new Promise((resolve) => { drain.once("message", resolve); drain.once("exit", resolve); });
    return async () => {
      libc.dup2(quiet, 1);
      libc.dup2(quiet, 2);
      writeAll(writer, marker);
      fs.closeSync(writer);
      await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 5000))]);
    };
  };

  const childProcess = require("node:child_process");
  const inherited = (stdio) => stdio === "inherit" || stdio === 1 || stdio === 2 || stdio === process.stdout || stdio === process.stderr;
  const children = [["spawn", true, () => ["pipe", "pipe", "pipe"], true], ["spawnSync", true, () => ["pipe", "pipe", "pipe"]],
    ["fork", true, (settings) => settings.silent ? ["pipe", "pipe", "pipe", "ipc"] : [0, 1, 2, "ipc"], true],
    ["execFileSync", true, () => ["pipe", "pipe", "pipe"]], ["execSync", false, () => ["pipe", "pipe", "inherit"]]];
  for (const [name, listed, fallback, lasting] of children) {
    const original = childProcess[name];
    childProcess[name] = (...argv) => {
      const at = listed && (Array.isArray(argv[1]) || argv[1] == null) ? 2 : 1;
      const settings = { ...argv[at] };
      const stdio = typeof settings.stdio === "string" ? [settings.stdio, settings.stdio, settings.stdio, ...name === "fork" ? ["ipc"] : []] : [...settings.stdio ?? fallback(settings)];
      const inherits = [1, 2].filter((fd) => inherited(stdio[fd]));
      if (!inherits.length || owned() && (libc || !lasting)) return original(...argv);
      const forwarded = owned() ? inherits : [];
      for (const fd of inherits) stdio[fd] = forwarded.length ? "pipe" : "ignore";
      const next = [...argv];
      if (at === 2) next[1] = argv[1] ?? [];
      next[at] = { ...settings, stdio };
      const started = original(...next);
      for (const fd of forwarded) started.stdio[fd].on("data", (chunk) => { if (owned()) writeAll(1, chunk); });
      return started;
    };
  }
  if (globalThis.Bun) {
    for (const name of ["spawn", "spawnSync"]) {
      const original = Bun[name];
      Bun[name] = (command, options) => {
        if (owned()) return original(command, options);
        const object = !Array.isArray(command) && typeof command === "object";
        const settings = { ...object ? command : options };
        const quiet = (value) => value === "inherit" || stdioTarget(value) ? "ignore" : value;
        if (settings.stdio) settings.stdio = settings.stdio.map((value, fd) => fd === 1 || fd === 2 ? quiet(value) : value);
        else Object.assign(settings, { stdout: quiet(settings.stdout), stderr: quiet(settings.stderr ?? "inherit") });
        return object ? original(settings) : original(command, settings);
      };
    }
    const write = Bun.write;
    Bun.write = (destination, data, ...rest) => stdioTarget(destination) && !owned() ? Promise.resolve(size(data)) : write(destination, data, ...rest);
    Bun.$ = new Proxy(Bun.$, { apply: (shell, self, args) => owned() ? Reflect.apply(shell, self, args) : Reflect.apply(shell, self, args).quiet() });
  }

  const stray = (error) => { strays?.push(String(error)); };
  process.on("uncaughtException", stray);
  process.on("unhandledRejection", stray);

  for await (const line of readline.createInterface({ input: process.stdin })) {
    const settle = redirect();
    outputBytes = 0;
    bridgeFailed = false;
    strays = [];
    let response;
    let bridge;
    try {
      const request = JSON.parse(line);
      if (request.shutdown === true) process.exit(0);
      bridge = { port: request.port, token: request.token, active: true };
      current = bridge;
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      await bridgeContext.run(bridge, () => new AsyncFunction(request.code)());
      response = strays.length ? { ok: false, error: strays[0], bridge_failed: bridgeFailed } : { ok: true, bridge_failed: bridgeFailed };
    } catch (error) {
      response = { ok: false, error: String(error), bridge_failed: bridgeFailed };
    } finally {
      if (bridge) bridge.active = false;
      current = undefined;
      strays = undefined;
    }
    await settle();
    writeAll(3, frame + JSON.stringify(response) + "\n");
    writeAll(out, frame + "\n");
  }
}

const frame = randomUUID() + ":";
const limit = "kernel output limit exceeded";
const child = spawn("/bin/sh", ["-c", 'exec "$@" 2>&1', "sh", process.execPath, "-e", `(${worker})()`], {
  env: { ...process.env, OMD_KERNEL_FRAME: frame },
  stdio: ["pipe", "pipe", "ignore", "pipe"],
});
let extra = Buffer.alloc(0);
let overflow = false;
let held = Buffer.alloc(0);
let ended = false;
let response;
let token = "";
const keep = (chunk) => {
  const room = 65536 - extra.length;
  if (chunk.length > room) overflow = true;
  extra = Buffer.concat([extra, chunk.subarray(0, room)]);
};
const finish = () => {
  if (!ended || !response) return;
  response.output = extra.toString("utf8");
  if (overflow && !String(response.error).includes(limit)) {
    response.error = response.ok ? `Error: ${limit}` : `${response.error}\nError: ${limit}`;
    response.ok = false;
  }
  process.stdout.write(`CODE_KERNEL_RESULT:${token}:` + JSON.stringify(response) + "\n");
  response = undefined;
};
child.stdout.on("data", (chunk) => {
  if (ended) return;
  held = Buffer.concat([held, chunk]);
  const start = held.indexOf(frame + "\n");
  if (start >= 0) {
    keep(held.subarray(0, start));
    held = held.subarray(start + frame.length + 1);
    ended = true;
    finish();
    return;
  }
  const cut = Math.max(held.length - frame.length, 0);
  keep(held.subarray(0, cut));
  held = held.subarray(cut);
});
readline.createInterface({ input: child.stdio[3] }).on("line", (line) => {
  if (!line.startsWith(frame)) return;
  response = JSON.parse(line.slice(frame.length));
  finish();
});
child.on("exit", (code) => process.exit(code ?? 1));
process.on("exit", () => child.kill("SIGKILL"));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  extra = held = Buffer.alloc(0);
  overflow = false;
  ended = false;
  response = undefined;
  try {
    token = String(JSON.parse(line).token ?? "");
  } catch {
    token = "";
  }
  child.stdin.write(line + "\n");
}).on("close", () => child.stdin.end());

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
    const size = Buffer.byteLength(text);
    if (outputBytes + size > 65536) throw new Error("kernel output limit exceeded");
    outputBytes += size;
    fs.writeSync(1, text);
  };
  const capture = (...values) => record(values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ") + "\n");
  const captureWrite = (chunk, encoding, callback) => {
    record(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    (typeof encoding === "function" ? encoding : callback)?.();
    return true;
  };
  const hooks = [...["log", "error", "warn", "info", "debug"].map((name) => [console, name, capture]), [process.stdout, "write", captureWrite], [process.stderr, "write", captureWrite]];

  for await (const line of readline.createInterface({ input: process.stdin })) {
    outputBytes = 0;
    bridgeFailed = false;
    let response;
    let bridge;
    try {
      const request = JSON.parse(line);
      if (request.shutdown === true) process.exit(0);
      bridge = { port: request.port, token: request.token, active: true };
      const prior = hooks.map(([target, name]) => target[name]);
      for (const [target, name, replacement] of hooks) target[name] = replacement;
      try {
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        await bridgeContext.run(bridge, () => new AsyncFunction(request.code)());
        response = { ok: true, bridge_failed: bridgeFailed };
      } finally {
        hooks.forEach(([target, name], index) => { target[name] = prior[index]; });
      }
    } catch (error) {
      response = { ok: false, error: String(error), bridge_failed: bridgeFailed };
    } finally {
      if (bridge) bridge.active = false;
    }
    fs.writeSync(3, frame + JSON.stringify(response) + "\n");
    fs.writeSync(1, frame + "\n");
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
  process.stdout.write("CODE_KERNEL_RESULT:" + JSON.stringify(response) + "\n");
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
  child.stdin.write(line + "\n");
}).on("close", () => child.stdin.end());

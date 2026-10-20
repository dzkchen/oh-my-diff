import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

async function worker() {
  const net = await import("node:net");
  const readline = await import("node:readline");
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const frame = process.env.OMD_KERNEL_FRAME;
  delete process.env.OMD_KERNEL_FRAME;
  const bridgeContext = new AsyncLocalStorage();
  let bridgeFailed = false;
  let output = [];
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
    output.push(text);
  };
  const capture = (...values) => record(values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ") + "\n");
  const captureWrite = (chunk, encoding, callback) => {
    record(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    (typeof encoding === "function" ? encoding : callback)?.();
    return true;
  };
  const hooks = [...["log", "error", "warn", "info", "debug"].map((name) => [console, name, capture]), [process.stdout, "write", captureWrite], [process.stderr, "write", captureWrite]];

  for await (const line of readline.createInterface({ input: process.stdin })) {
    output = [];
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
        response = { ok: true, output: output.join(""), bridge_failed: bridgeFailed };
      } finally {
        hooks.forEach(([target, name], index) => { target[name] = prior[index]; });
      }
    } catch (error) {
      response = { ok: false, output: output.join(""), error: String(error), bridge_failed: bridgeFailed };
    } finally {
      if (bridge) bridge.active = false;
    }
    process.stdout.write(frame + JSON.stringify(response) + "\n");
  }
}

const frame = randomUUID() + ":";
const child = spawn("/bin/sh", ["-c", 'exec "$@" 2>&1', "sh", process.execPath, "-e", `(${worker})()`], {
  env: { ...process.env, OMD_KERNEL_FRAME: frame },
  stdio: ["pipe", "pipe", "ignore"],
});
let extra = Buffer.alloc(0);
let overflow = false;
let held = Buffer.alloc(0);
const keep = (chunk) => {
  const room = 65536 - extra.length;
  if (chunk.length > room) overflow = true;
  extra = Buffer.concat([extra, chunk.subarray(0, room)]);
};
child.stdout.on("data", (chunk) => {
  held = Buffer.concat([held, chunk]);
  for (let start; (start = held.indexOf(frame)) >= 0;) {
    const end = held.indexOf("\n", start);
    keep(held.subarray(0, start));
    if (end < 0) { held = held.subarray(start); return; }
    const response = JSON.parse(held.subarray(start + frame.length, end).toString("utf8"));
    held = held.subarray(end + 1);
    const room = 65536 - Buffer.byteLength(response.output);
    if (overflow || extra.length > room) {
      response.ok = false;
      response.error = "Error: kernel output limit exceeded";
    }
    response.output += extra.subarray(0, room).toString("utf8");
    process.stdout.write("CODE_KERNEL_RESULT:" + JSON.stringify(response) + "\n");
  }
  keep(held.subarray(0, Math.max(held.length - frame.length + 1, 0)));
  held = held.subarray(Math.max(held.length - frame.length + 1, 0));
});
child.on("exit", (code) => process.exit(code ?? 1));
process.on("exit", () => child.kill("SIGKILL"));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  extra = held = Buffer.alloc(0);
  overflow = false;
  child.stdin.write(line + "\n");
}).on("close", () => child.stdin.end());

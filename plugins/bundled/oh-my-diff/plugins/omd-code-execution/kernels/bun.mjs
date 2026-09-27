import net from "node:net";
import readline from "node:readline";
import { AsyncLocalStorage } from "node:async_hooks";

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
    let response = "";
    let reachable = false;
    connection.setTimeout(120000, () => { reachable = true; connection.destroy(new Error("tool bridge timeout")); });
    connection.on("connect", () => connection.write(payload));
    connection.on("data", (data) => {
      response += data.toString();
      if (Buffer.byteLength(response) > 262144) {
        reachable = true;
        connection.destroy(new Error("tool response limit exceeded"));
      } else if (response.includes("\n")) {
        connection.end();
        try {
          const result = JSON.parse(response.slice(0, response.indexOf("\n")));
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

const capture = (...values) => {
  const text = values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ");
  const size = Buffer.byteLength(text) + 1;
  if (outputBytes + size > 65536) throw new Error("kernel output limit exceeded");
  outputBytes += size;
  output.push(text + "\n");
};

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
    const priorLog = console.log;
    console.log = capture;
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      await bridgeContext.run(bridge, () => new AsyncFunction(request.code)());
      response = { ok: true, output: output.join(""), bridge_failed: bridgeFailed };
    } finally {
      console.log = priorLog;
    }
  } catch (error) {
    response = { ok: false, output: output.join(""), error: String(error), bridge_failed: bridgeFailed };
  } finally {
    if (bridge) bridge.active = false;
  }
  process.stdout.write("CODE_KERNEL_RESULT:" + JSON.stringify(response) + "\n");
}

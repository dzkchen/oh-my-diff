#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";

const POLICY_LIMIT = 65_536;
const ADAPTERS = new Set(["browser", "node", "rust", "python", "java"]);
const EVENT_KINDS = new Set(["error", "exception", "log"]);

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label} has unknown field ${key}`);
}

function positive(value, label, maximum) {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) fail(`${label} is invalid`);
  return value;
}

function loadPolicy() {
  const policyPath = process.env.OMD_BRIDGE_POLICY;
  const expected = process.env.OMD_BRIDGE_POLICY_SHA256;
  if (!policyPath || !expected?.match(/^[0-9a-f]{64}$/)) fail("bridge policy binding is absent");
  const canonical = fs.realpathSync(policyPath);
  if (canonical !== path.resolve(policyPath)) fail("bridge policy path must be canonical");
  const bytes = fs.readFileSync(canonical);
  if (bytes.length > POLICY_LIMIT || sha256(bytes) !== expected) fail("bridge policy changed or exceeds its bound");
  const policy = JSON.parse(bytes);
  exactKeys(policy, new Set(["schema", "task_id", "repository_identity", "connection_file", "applications", "limits", "redact_keys"]), "policy");
  if (policy.schema !== 1 || !policy.task_id || !policy.repository_identity) fail("unsupported bridge policy identity");
  if (!path.isAbsolute(policy.connection_file)) fail("connection_file must be absolute");
  const parent = fs.realpathSync(path.dirname(policy.connection_file));
  if (parent !== path.dirname(policy.connection_file)) fail("connection_file parent must be canonical");
  if (!Array.isArray(policy.applications) || policy.applications.length === 0 || policy.applications.length > 32) fail("applications are invalid");
  const ids = new Set();
  for (const app of policy.applications) {
    exactKeys(app, new Set(["id", "adapter", "version_sha256", "reproduction_id", "origins", "exposed_state"]), "application");
    if (!app.id || ids.has(app.id) || !ADAPTERS.has(app.adapter)) fail("application identity or adapter is invalid");
    ids.add(app.id);
    if (!String(app.version_sha256).match(/^[0-9a-f]{64}$/) || !app.reproduction_id) fail("application version association is invalid");
    if (!Array.isArray(app.origins) || !Array.isArray(app.exposed_state)) fail("application origins or exposed_state is invalid");
    if (app.adapter === "browser" && app.origins.length === 0) fail("browser applications require an origin allowlist");
    if (app.origins.some(origin => !String(origin).match(/^https?:\/\/[^/]+$/))) fail("application origin is invalid");
    if (app.exposed_state.length > 32 || new Set(app.exposed_state).size !== app.exposed_state.length || app.exposed_state.some(name => !String(name).match(/^[A-Za-z0-9_.:-]{1,128}$/))) fail("application exposed_state is invalid");
  }
  exactKeys(policy.limits, new Set(["max_events", "max_total_bytes", "max_event_bytes", "max_log_chars", "max_pending_state", "state_timeout_ms"]), "limits");
  const maxima = {max_events: 4096, max_total_bytes: 16_777_216, max_event_bytes: 262_144, max_log_chars: 65_536, max_pending_state: 128, state_timeout_ms: 60_000};
  for (const [key, maximum] of Object.entries(maxima)) positive(policy.limits[key], key, maximum);
  if (policy.limits.max_event_bytes > policy.limits.max_total_bytes) fail("event byte limit exceeds total byte limit");
  if (!Array.isArray(policy.redact_keys) || policy.redact_keys.length > 64 || policy.redact_keys.some(key => !String(key).match(/^[A-Za-z0-9_.-]{1,64}$/))) fail("redact_keys is invalid");
  return {policy, policyPath: canonical, policySha256: expected};
}

class Bridge {
  constructor(loaded) {
    this.policy = loaded.policy;
    this.policyPath = loaded.policyPath;
    this.policySha256 = loaded.policySha256;
    this.token = crypto.randomBytes(32).toString("base64url");
    this.startedAt = new Date().toISOString();
    this.server = null;
    this.closed = false;
    this.sequence = 0;
    this.events = [];
    this.totalBytes = 0;
    this.dropped = {oversized: 0, capacity: 0, duplicate: 0, irrelevant: 0};
    this.instances = new Map();
    this.pending = new Map();
    this.redactKeys = new Set(["authorization", "cookie", "set-cookie", "password", "passwd", "secret", "token", "api_key", "apikey", ...this.policy.redact_keys].map(value => value.toLowerCase()));
  }

  app(id) {
    return this.policy.applications.find(app => app.id === id);
  }

  originAllowed(app, origin) {
    if (app.adapter !== "browser") return !origin;
    return Boolean(origin && app.origins.includes(origin));
  }

  redact(value, key = "") {
    if (this.redactKeys.has(String(key).toLowerCase())) return "[redacted]";
    if (typeof value === "string") {
      return value
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [redacted]")
        .replace(/\b(api[_-]?key|token|password|secret)=([^\s&]+)/gi, "$1=[redacted]");
    }
    if (Array.isArray(value)) return value.map(item => this.redact(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, this.redact(child, childKey)]));
    return value;
  }

  authorize(body, request) {
    if (!body || !crypto.timingSafeEqual(Buffer.from(String(body.token || "").padEnd(this.token.length).slice(0, this.token.length)), Buffer.from(this.token)) || String(body.token || "").length !== this.token.length) fail("unauthorized bridge request");
    const app = this.app(body.app_id);
    if (!app || body.adapter !== app.adapter || body.version_sha256 !== app.version_sha256 || body.reproduction_id !== app.reproduction_id) fail("application association mismatch");
    if (!this.originAllowed(app, request.headers.origin)) fail("application origin denied");
    return app;
  }

  register(body, request) {
    const app = this.authorize(body, request);
    const exposed = Array.isArray(body.exposed_state) ? body.exposed_state : [];
    if (exposed.length > app.exposed_state.length || exposed.some(name => !app.exposed_state.includes(name))) fail("state exposure exceeds policy");
    const instanceId = crypto.randomUUID();
    this.instances.set(instanceId, {app, exposed: new Set(exposed), commands: [], connectedAt: new Date().toISOString(), origin: request.headers.origin || null});
    return {schema: 1, instance_id: instanceId, task_id: this.policy.task_id, repository_identity: this.policy.repository_identity};
  }

  instance(body, request) {
    const app = this.authorize(body, request);
    const instance = this.instances.get(body.instance_id);
    if (!instance || instance.app.id !== app.id) fail("application instance is not active");
    return instance;
  }

  addEvent(body, request) {
    const instance = this.instance(body, request);
    if (!EVENT_KINDS.has(body.kind) || (body.kind === "log" && !["warn", "error"].includes(body.level))) {
      this.dropped.irrelevant += 1;
      return {accepted: false, reason: "irrelevant", dropped: this.dropped};
    }
    const message = String(body.message || "").slice(0, this.policy.limits.max_log_chars);
    const event = this.redact({
      schema: 1,
      task_id: this.policy.task_id,
      repository_identity: this.policy.repository_identity,
      application: instance.app.id,
      adapter: instance.app.adapter,
      version_sha256: instance.app.version_sha256,
      reproduction_id: instance.app.reproduction_id,
      instance_id: body.instance_id,
      sequence: this.sequence + 1,
      received_at: new Date().toISOString(),
      last_received_at: null,
      client_timestamp: body.client_timestamp || null,
      kind: body.kind,
      level: body.level || null,
      message,
      data: body.data ?? null,
      repeats: 1,
    });
    event.last_received_at = event.received_at;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > this.policy.limits.max_event_bytes) {
      this.dropped.oversized += 1;
      return {accepted: false, reason: "oversized", dropped: this.dropped};
    }
    const previous = this.events.at(-1);
    if (previous && previous.instance_id === event.instance_id && previous.kind === event.kind && previous.level === event.level && previous.message === event.message && JSON.stringify(previous.data) === JSON.stringify(event.data)) {
      previous.repeats += 1;
      previous.last_received_at = event.received_at;
      const updatedBytes = Buffer.byteLength(JSON.stringify(previous));
      this.totalBytes += updatedBytes - previous._bytes;
      previous._bytes = updatedBytes;
      this.dropped.duplicate += 1;
      return {accepted: true, deduplicated: true, sequence: previous.sequence, dropped: this.dropped};
    }
    while (this.events.length >= this.policy.limits.max_events || this.totalBytes + bytes > this.policy.limits.max_total_bytes) {
      const removed = this.events.shift();
      if (!removed) break;
      this.totalBytes -= removed._bytes;
      this.dropped.capacity += 1;
    }
    this.sequence += 1;
    Object.defineProperty(event, "_bytes", {value: bytes, writable: true, enumerable: false});
    this.events.push(event);
    this.totalBytes += bytes;
    return {accepted: true, deduplicated: false, sequence: event.sequence, dropped: this.dropped};
  }

  poll(body, request) {
    const instance = this.instance(body, request);
    return {commands: instance.commands.splice(0, 8)};
  }

  stateResponse(body, request) {
    this.instance(body, request);
    const pending = this.pending.get(body.request_id);
    if (!pending || pending.instanceId !== body.instance_id) fail("state request is not pending");
    this.pending.delete(body.request_id);
    clearTimeout(pending.timer);
    const result = this.redact({name: pending.name, value: body.value ?? null, error: body.error || null});
    if (Buffer.byteLength(JSON.stringify(result)) > this.policy.limits.max_event_bytes) {
      pending.resolve({name: pending.name, value: null, error: "state response exceeds byte limit"});
      return {accepted: false, reason: "oversized"};
    }
    pending.resolve(result);
    return {accepted: true};
  }

  disconnect(body, request) {
    this.instance(body, request);
    this.instances.delete(body.instance_id);
    for (const [id, pending] of this.pending) {
      if (pending.instanceId === body.instance_id) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error("application disconnected"));
      }
    }
    return {closed: true};
  }

  async requestState(appId, name, timeoutMs) {
    const app = this.app(appId);
    if (!app || !app.exposed_state.includes(name)) fail("state name is not policy-exposed");
    if (this.pending.size >= this.policy.limits.max_pending_state) fail("pending state limit reached");
    const entry = [...this.instances.entries()].find(([, instance]) => instance.app.id === appId && instance.exposed.has(name));
    if (!entry) fail("state name is not currently exposed by an active application");
    const [instanceId, instance] = entry;
    const requestId = crypto.randomUUID();
    const bounded = Math.min(positive(timeoutMs || this.policy.limits.state_timeout_ms, "timeout_ms", this.policy.limits.state_timeout_ms), this.policy.limits.state_timeout_ms);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("state request timed out"));
      }, bounded);
      this.pending.set(requestId, {instanceId, name, resolve, reject, timer});
      instance.commands.push({type: "state", request_id: requestId, name});
    });
  }

  status(adapter = null) {
    return {
      schema: 1,
      active: !this.closed,
      adapter,
      task_id: this.policy.task_id,
      repository_identity: this.policy.repository_identity,
      policy: {path: this.policyPath, sha256: this.policySha256},
      started_at: this.startedAt,
      bind: this.server ? `127.0.0.1:${this.server.address().port}` : null,
      applications: [...this.instances.entries()].filter(([, instance]) => !adapter || instance.app.adapter === adapter).map(([instance_id, instance]) => ({instance_id, id: instance.app.id, adapter: instance.app.adapter, version_sha256: instance.app.version_sha256, reproduction_id: instance.app.reproduction_id, exposed_state: [...instance.exposed], connected_at: instance.connectedAt})),
      retained: {events: this.events.length, bytes: this.totalBytes, dropped: this.dropped},
      retention: "memory-only until bridge teardown",
    };
  }

  eventsView(args, adapter = null) {
    const limit = Math.min(Math.max(Number(args.limit || 50), 1), 200);
    return {schema: 1, adapter, events: this.events.filter(event => (!adapter || event.adapter === adapter) && (!args.application || event.application === args.application) && (!args.reproduction_id || event.reproduction_id === args.reproduction_id) && event.sequence > Number(args.after_sequence || 0)).slice(-limit), dropped: this.dropped, retained_bytes: this.totalBytes};
  }

  teardown() {
    if (this.closed) return {closed: true, already_closed: true};
    this.closed = true;
    this.token = crypto.randomBytes(32).toString("base64url");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("bridge torn down"));
    }
    this.pending.clear();
    this.instances.clear();
    this.events = [];
    this.totalBytes = 0;
    try { fs.unlinkSync(this.policy.connection_file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (this.server) this.server.close();
    return {closed: true, authorization_revoked: true, connection_file_removed: true, retained_events: 0};
  }
}

function jsonResponse(response, status, value, origin) {
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": bytes.length,
    ...(origin ? {"Access-Control-Allow-Origin": origin, "Vary": "Origin"} : {}),
  });
  response.end(bytes);
}

async function readJson(request, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) fail("request exceeds byte limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function startHttp(bridge) {
  const routes = {
    "/v1/register": (body, request) => bridge.register(body, request),
    "/v1/event": (body, request) => bridge.addEvent(body, request),
    "/v1/poll": (body, request) => bridge.poll(body, request),
    "/v1/state": (body, request) => bridge.stateResponse(body, request),
    "/v1/disconnect": (body, request) => bridge.disconnect(body, request),
  };
  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    const corsOrigin = bridge.policy.applications.some(app => app.adapter === "browser" && app.origins.includes(origin)) ? origin : undefined;
    if (request.method === "OPTIONS") {
      if (!corsOrigin) return jsonResponse(response, 403, {error: "origin denied"});
      response.writeHead(204, {"Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin"});
      return response.end();
    }
    try {
      if (bridge.closed) fail("bridge is closed");
      if (request.method !== "POST" || !routes[request.url]) return jsonResponse(response, 404, {error: "not found"});
      const body = await readJson(request, bridge.policy.limits.max_event_bytes + 8192);
      const value = await routes[request.url](body, request);
      return jsonResponse(response, 200, value, corsOrigin);
    } catch (error) {
      return jsonResponse(response, error.message.includes("byte limit") ? 413 : 403, {error: error.message}, corsOrigin);
    }
  });
  server.on("connection", socket => socket.setTimeout(10_000));
  server.listen(0, "127.0.0.1", () => {
    bridge.server = server;
    const descriptor = {schema: 1, url: `http://127.0.0.1:${server.address().port}`, token: bridge.token, policy_sha256: bridge.policySha256, task_id: bridge.policy.task_id};
    const descriptorPath = bridge.policy.connection_file;
    const descriptorFd = fs.openSync(descriptorPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(descriptorFd, `${JSON.stringify(descriptor)}\n`);
    fs.fsyncSync(descriptorFd);
    fs.closeSync(descriptorFd);
  });
  return server;
}

const LEGACY_TOOLS = [{
  name: "omd_bridge",
  description: "Inspect version-bound application errors and bounded logs, request only explicitly exposed state, or tear down the authorized development bridge.",
  inputSchema: {
    type: "object",
    properties: {
      action: {type: "string", enum: ["status", "events", "request_state", "teardown"]},
      application: {type: "string"}, reproduction_id: {type: "string"}, after_sequence: {type: "integer", minimum: 0}, limit: {type: "integer", minimum: 1, maximum: 200}, state: {type: "string"}, timeout_ms: {type: "integer", minimum: 1, maximum: 60000},
    },
    required: ["action"], additionalProperties: false,
  },
}];

const ADAPTER_TOOLS = Object.fromEntries([...ADAPTERS].map(adapter => [`${adapter}_bridge`, adapter]));
const ADAPTER_TOOL_SCHEMA = {
  type: "object",
  properties: {
    action: {type: "string", enum: ["status", "events", "request_state"]},
    application: {type: "string"}, reproduction_id: {type: "string"}, after_sequence: {type: "integer", minimum: 0}, limit: {type: "integer", minimum: 1, maximum: 200}, state: {type: "string"}, timeout_ms: {type: "integer", minimum: 1, maximum: 60000},
  },
  required: ["action"], additionalProperties: false,
};
const PLUGIN_TOOLS = [
  ...Object.entries(ADAPTER_TOOLS).map(([name, adapter]) => ({
    name,
    description: `Inspect bounded ${adapter} application errors and logs or request explicitly exposed ${adapter} state.`,
    inputSchema: ADAPTER_TOOL_SCHEMA,
  })),
  {
    name: "application_bridge_control",
    description: "Inspect or explicitly tear down the authorized managed application bridge session.",
    inputSchema: {
      type: "object",
      properties: {action: {type: "string", enum: ["status", "teardown"]}},
      required: ["action"], additionalProperties: false,
    },
  },
];

async function toolCall(bridge, name, args) {
  const adapter = ADAPTER_TOOLS[name] || null;
  if (adapter && args.application) {
    const application = bridge.app(args.application);
    if (!application || application.adapter !== adapter) fail(`application is not authorized for the ${adapter} bridge`);
  }
  if (adapter && args.action === "request_state" && (!args.application || !args.state)) fail("request_state requires application and state");
  if (args.action === "status") return bridge.status(adapter);
  if (args.action === "events") return bridge.eventsView(args, adapter);
  if (args.action === "request_state") return {schema: 1, adapter, application: args.application, ...(await bridge.requestState(args.application, args.state, args.timeout_ms))};
  if ((name === "omd_bridge" || name === "application_bridge_control") && args.action === "teardown") return bridge.teardown();
  fail("unsupported bridge action");
}

function mcpResult(id, result) {
  process.stdout.write(`${JSON.stringify({jsonrpc: "2.0", id, result})}\n`);
}

function mcpError(id, error) {
  process.stdout.write(`${JSON.stringify({jsonrpc: "2.0", id, error: {code: -32000, message: error.message}})}\n`);
}

const loaded = loadPolicy();
const bridge = new Bridge(loaded);
startHttp(bridge);
const tools = process.env.OMD_BRIDGE_PLUGIN_SURFACE === "1" ? PLUGIN_TOOLS : LEGACY_TOOLS;
const toolNames = new Set(tools.map(tool => tool.name));
const lines = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
lines.on("line", async line => {
  let request;
  try {
    request = JSON.parse(line);
    if (request.method === "initialize") return mcpResult(request.id, {protocolVersion: "2025-03-26", capabilities: {tools: {}}, serverInfo: {name: "oh-my-diff-bridge", version: "1.0.0"}});
    if (request.method === "notifications/initialized") return;
    if (request.method === "tools/list") return mcpResult(request.id, {tools});
    if (request.method === "tools/call") {
      if (!toolNames.has(request.params?.name)) fail("unknown tool");
      const value = await toolCall(bridge, request.params.name, request.params.arguments || {});
      return mcpResult(request.id, {content: [{type: "text", text: JSON.stringify(value)}], isError: false});
    }
    fail("unsupported MCP method");
  } catch (error) {
    if (request?.method === "tools/call") return mcpResult(request.id, {content: [{type: "text", text: error.message}], isError: true});
    if (request?.id !== undefined) mcpError(request.id, error);
  }
});

function shutdown() {
  try { bridge.teardown(); } finally { process.exit(0); }
}

lines.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

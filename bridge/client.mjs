export class BridgeClient {
  constructor(connection, application) {
    this.url = connection.url;
    this.token = connection.token;
    this.application = application;
    this.instanceId = null;
    this.handlers = new Map();
    this.timer = null;
    this.restores = [];
  }

  body(extra = {}) {
    return {token: this.token, app_id: this.application.id, adapter: this.application.adapter, version_sha256: this.application.version_sha256, reproduction_id: this.application.reproduction_id, ...(this.instanceId ? {instance_id: this.instanceId} : {}), ...extra};
  }

  async post(route, body) {
    const response = await fetch(`${this.url}${route}`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `bridge HTTP ${response.status}`);
    return value;
  }

  expose(name, handler) {
    if (this.instanceId) throw new Error("state handlers must be exposed before connect");
    if (typeof handler !== "function") throw new Error("state handler must be a function");
    this.handlers.set(name, handler);
    return this;
  }

  async connect() {
    if (this.instanceId) return this.instanceId;
    const value = await this.post("/v1/register", this.body({exposed_state: [...this.handlers.keys()]}));
    this.instanceId = value.instance_id;
    return this.instanceId;
  }

  async event(kind, message, data = null, level = null) {
    if (!this.instanceId) throw new Error("bridge client is not connected");
    return await this.post("/v1/event", this.body({kind, level, message: String(message), data, client_timestamp: new Date().toISOString()}));
  }

  async poll() {
    if (!this.instanceId) return;
    const value = await this.post("/v1/poll", this.body());
    for (const command of value.commands) {
      const handler = this.handlers.get(command.name);
      let response;
      try {
        const state = handler ? await handler() : null;
        response = {value: state, ...(handler ? {} : {error: "state handler unavailable"})};
      } catch (error) {
        response = {error: String(error?.message || error)};
      }
      try { await this.post("/v1/state", this.body({request_id: command.request_id, ...response})); } catch {}
    }
  }

  startPolling(intervalMs = 100) {
    if (this.timer) return;
    this.timer = setInterval(() => { this.poll().catch(() => {}); }, intervalMs);
  }

  captureConsole(levels = ["warn", "error"]) {
    for (const level of levels) {
      const original = console[level];
      console[level] = (...args) => {
        original.apply(console, args);
        this.event(level === "error" ? "error" : "log", args.map(String).join(" "), null, level).catch(() => {});
      };
      this.restores.push(() => { console[level] = original; });
    }
    return this;
  }

  captureWindowErrors(target = globalThis) {
    const onError = event => this.event("error", event.message || "window error", {filename: event.filename, line: event.lineno, column: event.colno}, "error").catch(() => {});
    const onRejection = event => this.event("exception", String(event.reason?.message || event.reason), null, "error").catch(() => {});
    target.addEventListener("error", onError);
    target.addEventListener("unhandledrejection", onRejection);
    this.restores.push(() => target.removeEventListener("error", onError));
    this.restores.push(() => target.removeEventListener("unhandledrejection", onRejection));
    return this;
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const restore of this.restores.splice(0)) restore();
    if (this.instanceId) await this.post("/v1/disconnect", this.body());
    this.instanceId = null;
  }
}

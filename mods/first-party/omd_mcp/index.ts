import type { Json, ModAPI, TerminalComponent } from '../../api.d.ts';

type Server = { status: string; error: string | null; reauth: boolean; runtime: string | null; auth: string | null; http: boolean; origin: string | null; plugin: string | null; tools: string[]; count: number; tools_error: string | null; call: string | null };
type Configured = Record<string, { enabled: boolean; http: boolean; plugin?: string }>;
type Saved = { threads: Record<string, { seq: number; reload: number; servers: Record<string, Server> }>; seq: number; reload: number; expanded: boolean };
type Status = { name: string; runtimeStatus: string | null; pluginId: string | null; httpOrigin: string | null; tools: Record<string, Json>; toolsError: string | null; authStatus: string };

const NAME = /^[\w-]{1,64}$/;
const POLL_MS = 10000;
const CLOSED = 'connection closed; /mcps reload restarts it';
const EMPTY: Server = { status: 'starting', error: null, reauth: false, runtime: null, auth: null, http: false, origin: null, plugin: null, tools: [], count: 0, tools_error: null, call: null };
const USAGE = 'usage: /mcps [reload | enable NAME | disable NAME | add NAME --url URL [--bearer-token-env-var VAR] | add NAME [--env KEY=VALUE]... -- COMMAND [ARG]... | remove NAME | login NAME | logout NAME]';
const clip = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 240);
const quote = (word: string) => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

export default function activate(api: ModAPI) {
  const saved = (): Saved => ({ threads: {}, seq: 0, reload: 0, expanded: false, ...api.state.get() as unknown as Saved | null });
  const update = (thread: string, name: string, patch: Partial<Server>, configured?: Configured) => {
    const state = saved();
    const entry = state.threads[thread] ??= { seq: 0, reload: state.reload, servers: {} };
    if (entry.reload !== state.reload) {
      entry.servers = Object.fromEntries(Object.entries(entry.servers).filter(([, server]) => server.runtime === 'disabled'));
      entry.reload = state.reload;
    }
    for (const [server, { enabled, http, plugin }] of Object.entries(configured ?? {})) entry.servers[server] ??= { ...EMPTY, http, plugin: plugin ?? null, runtime: enabled ? null : 'disabled' };
    entry.seq = ++state.seq;
    if (name in entry.servers || Object.keys(entry.servers).length < 24) entry.servers[name] = { ...EMPTY, ...entry.servers[name], ...patch };
    for (const old of Object.keys(state.threads).sort((a, b) => state.threads[b].seq - state.threads[a].seq).slice(4)) delete state.threads[old];
    api.state.set(state as unknown as Json);
  };
  const reload = (state = saved()) => {
    api.state.set({ ...state, reload: state.reload + 1 } as unknown as Json);
    return api.host.tryCall('app.request', { method: 'config/mcpServer/reload', params: {} });
  };
  const known = (name: string) => Object.values(saved().threads).map(entry => entry.servers[name]).find(Boolean);
  const draft = (argv: string[], next: string) => {
    if (argv.some(word => /[\u0000-\u001f\u007f]/.test(word))) return { display: 'Arguments cannot contain control characters.' };
    const written = api.host.tryCall('composer.write', { text: `!${['codex', 'mcp', ...argv].map(quote).join(' ')}` });
    return { display: written.ok ? `Review the drafted upstream command in the composer and press Enter to run it with your own permissions. ${next}` : written.error };
  };

  api.on('app_notification', ({ method, params }) => {
    if (method === 'item/completed') {
      const { threadId, item } = params as { threadId?: string; item?: { type?: string; server?: string; status?: string; error?: { message?: string } | null } };
      if (!threadId || item?.type !== 'mcpToolCall' || !item.server) return;
      const call = item.status === 'failed' ? clip(item.error?.message ?? 'failed') : null;
      if (call !== null || saved().threads[threadId]?.servers[item.server]?.call) api.host.tryCall('events.publish', { channel: 'update', data: { thread: threadId, name: item.server, call } });
      return;
    }
    const event = params as { threadId?: string | null; name?: string; status?: string; error?: string | null; failureReason?: string | null };
    if (method !== 'mcpServer/startupStatus/updated' || !event.threadId || !event.name || !event.status) return;
    let patch: Partial<Server> = { status: event.status, error: event.error ? clip(event.error) : null, reauth: event.failureReason === 'reauthenticationRequired', call: null };
    const state = saved();
    let configured: Configured | undefined;
    if (state.threads[event.threadId]?.reload !== state.reload) {
      const read = api.host.tryCall('app.request', { method: 'config/read', params: {} });
      const config = read.ok ? (read.value as { config?: { mcp_servers?: Record<string, { enabled?: boolean; url?: string }>; plugins?: Record<string, { mcp_servers?: Record<string, { enabled?: boolean }> }> } } | null)?.config : undefined;
      if (config?.mcp_servers) configured = Object.fromEntries(Object.entries(config.mcp_servers).slice(0, 24).map(([server, entry]) => [server, { enabled: entry.enabled !== false, http: typeof entry.url === 'string' }]));
      const installed = api.host.tryCall('app.request', { method: 'plugin/installed', params: {} });
      const markets = installed.ok ? (installed.value as { marketplaces?: { name: string; path: string | null; plugins: { id: string; name: string; installed: boolean; enabled: boolean }[] }[] } | null)?.marketplaces ?? [] : [];
      for (const [market, plugin] of markets.flatMap(market => market.plugins.filter(plugin => plugin.installed && plugin.enabled).map(plugin => [market, plugin] as const)).slice(0, 8)) {
        const detail = api.host.tryCall('app.request', { method: 'plugin/read', params: { pluginName: plugin.name, ...market.path ? { marketplacePath: market.path } : { remoteMarketplaceName: market.name } } });
        for (const server of (detail.ok ? (detail.value as { plugin?: { mcpServers?: string[] } } | null)?.plugin?.mcpServers : undefined) ?? [])
          (configured ??= {})[server] ??= { enabled: config?.plugins?.[plugin.id]?.mcp_servers?.[server]?.enabled !== false, http: false, plugin: plugin.id };
      }
    }
    if (event.status !== 'starting') {
      const listed = api.host.tryCall('app.request', { method: 'mcpServerStatus/list', params: { threadId: event.threadId, serverName: event.name, detail: 'toolsAndAuthOnly' } });
      const status = listed.ok ? (listed.value as { data?: Status[] } | null)?.data?.find(item => item.name === event.name) : undefined;
      const tools = Object.keys(status?.tools ?? {}).sort();
      if (status) patch = { ...patch, runtime: status.runtimeStatus, auth: status.authStatus, http: status.httpOrigin !== null, origin: status.httpOrigin, plugin: status.pluginId, tools: tools.slice(0, 16).map(tool => tool.slice(0, 48)), count: tools.length, tools_error: status.toolsError ? clip(status.toolsError) : null };
    }
    api.host.tryCall('events.publish', { channel: 'update', data: { thread: event.threadId, name: event.name, patch, configured } as unknown as Json });
  });

  api.on('channel', ({ channel, data }) => {
    const { thread, name, patch, configured, call } = (data ?? {}) as { thread?: string; name?: string; patch?: Partial<Server>; configured?: Configured; call?: string | null };
    if (channel !== 'omd_mcp/update' || !thread || !name) return;
    if (patch) {
      update(thread, name, patch, configured);
      api.host.tryCall('events.schedule', { key: `poll:${thread}`, delay_ms: POLL_MS });
      return;
    }
    const state = saved();
    const server = state.threads[thread]?.servers[name];
    if (server && call !== undefined) {
      server.call = call;
      api.state.set(state as unknown as Json);
    }
  });

  api.on('timer', ({ key }) => {
    const thread = key.startsWith('poll:') ? key.slice(5) : '';
    const state = saved();
    const servers = state.threads[thread]?.servers ?? {};
    const names = Object.keys(servers).filter(name => servers[name].status !== 'starting' && servers[name].runtime !== 'disabled');
    if (!names.length) return;
    const start = Math.floor(Date.now() / POLL_MS) % names.length;
    let changed = false;
    for (const name of [...names, ...names].slice(start, start + Math.min(3, names.length))) {
      const listed = api.host.tryCall('app.request', { method: 'mcpServerStatus/list', params: { threadId: thread, serverName: name, detail: 'toolsAndAuthOnly' } });
      if (!listed.ok && listed.error.includes('thread not found')) return;
      const runtime = listed.ok ? (listed.value as { data?: Status[] } | null)?.data?.find(item => item.name === name)?.runtimeStatus : undefined;
      const server = servers[name];
      if (!runtime || runtime === server.runtime) continue;
      server.runtime = runtime;
      if (runtime === 'failed' && server.status === 'ready') Object.assign(server, { status: 'failed', error: CLOSED });
      if (runtime === 'connected' && server.status === 'failed') Object.assign(server, { status: 'ready', error: null });
      changed = true;
    }
    if (changed) api.state.set(state as unknown as Json);
    api.host.tryCall('events.schedule', { key, delay_ms: POLL_MS });
  });

  api.on('terminal', ({ ledger }) => {
    const { threads, expanded } = saved();
    const servers = Object.entries(threads[ledger?.thread_id ?? '']?.servers ?? {}).sort(([a], [b]) => a.localeCompare(b));
    if (!servers.length) return null;
    const children = servers.flatMap(([name, server], index): TerminalComponent[] => {
      const login = server.reauth || server.runtime === 'authenticationRequired' || server.status === 'failed' && server.auth === 'notLoggedIn' && server.error !== CLOSED;
      const state = server.runtime === 'disabled' ? 'disabled' : login ? 'login required' : server.call ? 'last call failed' : server.status === 'ready' ? `${server.count} tools` : server.status;
      const transport = server.origin ? `HTTP ${server.origin}` : server.http ? 'HTTP' : 'stdio';
      const lines: TerminalComponent[] = [{ type: 'text', id: `omd_mcp_server_${index}`, label: `MCP server ${name}`, text: `${name} · ${state}${expanded ? ` · ${transport}${server.plugin ? ` · plugin ${server.plugin}` : ''}` : ''}`,
        tone: server.status === 'failed' || login || server.call ? 'failure' : server.status === 'ready' ? 'success' : 'muted' }];
      const hint = login ? `/mcps login ${name}` : server.error ?? server.tools_error ?? server.call;
      if (hint) lines.push({ type: 'text', id: `omd_mcp_server_${index}_hint`, label: 'Next step', text: `  ${hint}`, tone: 'attention' });
      if (expanded && server.tools.length) lines.push({ type: 'text', id: `omd_mcp_server_${index}_tools`, label: 'Tools', text: `  ${server.tools.join(', ')}${server.count > server.tools.length ? ` +${server.count - server.tools.length}` : ''}`, tone: 'muted' });
      return lines;
    });
    return { sites: { sidebar: { mode: 'wrap', components: [{ type: 'pane', id: 'omd_mcp_servers', label: 'MCP servers', title: 'MCP servers', children }, { type: 'slot' }] } } };
  });

  api.command('mcps', value => {
    const [op = '', name = '', ...rest] = String(value ?? '').trim().split(/\s+/).filter(Boolean);
    if (!op) {
      const state = saved();
      api.state.set({ ...state, expanded: !state.expanded } as unknown as Json);
      return { display: state.expanded ? 'MCP sidebar collapsed.' : 'MCP sidebar shows transports, plugins and tools. Legacy SSE servers are unsupported: Codex connects to stdio and Streamable HTTP only.' };
    }
    if (op === 'reload') {
      const reloaded = reload();
      return { display: reloaded.ok ? 'Reloading MCP servers; the sidebar updates as each one starts.' : reloaded.error };
    }
    if (!NAME.test(name)) return { display: USAGE };
    if (op === 'enable' || op === 'disable') {
      const plugin = known(name)?.plugin;
      if (plugin && !/^[\w@-]+$/.test(plugin)) return { display: `Plugin id ${plugin} cannot be addressed as a config key.` };
      const keyPath = plugin ? `plugins.${plugin}.mcp_servers.${name}.enabled` : `mcp_servers.${name}.enabled`;
      const written = api.host.tryCall('app.request', { method: 'config/value/write', params: { keyPath, value: op === 'enable', mergeStrategy: 'replace' } });
      if (!written.ok || (written.value as { status?: string } | null)?.status === 'declined') return { display: written.ok ? 'Kept the configuration unchanged.' : `${written.error}${plugin ? '' : ' (only servers defined in your user config.toml can be switched here)'}` };
      const state = saved();
      for (const entry of Object.values(state.threads)) if (entry.servers[name]) entry.servers[name] = { ...entry.servers[name], runtime: op === 'disable' ? 'disabled' : null, status: 'starting', error: null, reauth: false };
      const reloaded = reload(state);
      return { display: `${op === 'enable' ? 'Enabled' : 'Disabled'} ${name} (${keyPath})${reloaded.ok ? '; reloading MCP servers.' : `; reload failed: ${reloaded.error}`}` };
    }
    if (op === 'add') {
      const split = rest.indexOf('--');
      const options = split < 0 ? rest : rest.slice(0, split);
      const command = split < 0 ? [] : rest.slice(split + 1);
      if (options.some(word => /^--(sse|transport)\b/.test(word))) return { display: 'Legacy SSE servers are unsupported; Codex connects to stdio and Streamable HTTP servers.' };
      const values = options.filter((_, index) => index % 2);
      const pairs = (flags: string[]) => options.length % 2 === 0 && options.every((word, index) => index % 2 ? !word.startsWith('--') : flags.includes(word));
      const replace = known(name) ? ` This replaces ${name} and resets its tool policies.` : '';
      if (!command.length && pairs(['--url', '--bearer-token-env-var']) && /^https?:\/\/\S+$/.test(options[options.indexOf('--url') + 1] ?? '')
        && (!options.includes('--bearer-token-env-var') || /^[A-Za-z_]\w*$/.test(options[options.indexOf('--bearer-token-env-var') + 1])))
        return draft(['add', name, ...options], `Then run /mcps reload.${replace}`);
      if (command.length && pairs(['--env']) && values.every(item => /^[A-Za-z_]\w*=/.test(item)))
        return draft(['add', name, ...options, '--', ...command], `--env values are stored in plain text in config.toml. Then run /mcps reload.${replace}`);
      return { display: USAGE };
    }
    if (op === 'remove' || op === 'login' || op === 'logout') return draft([op, name], 'Then run /mcps reload.');
    return { display: USAGE };
  }, { description: 'MCP server status, reload, enable/disable and reviewed setup through upstream `codex mcp` commands' });
}

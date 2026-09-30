import type { Json, ModAPI, RouteInfo, ToolSpec } from '../../api.d.ts';

type Spec = { role: string; prompt: string; workspace?: 'read_only' | 'isolated_worktree'; tools?: string[]; route?: string };
type Sections = { notes: Record<string, string>; memories: Record<string, string>; skills: Record<string, string>; agents: Record<string, Spec> };
type Change = { section: keyof Sections; name: string; value: string | Spec | null };
type Proposal = { changes: Change[]; reason: string; evidence: string[] };
type Harness = { version: number; pending: Proposal | null; log: { version: number; kind: 'refine' | 'rollback'; reason: string; evidence: string[] }[] };
type Kept = { sha256: string; chars: number; sources: string[] };
type Mirror = { base: Sections; thread: string | null; version: number; sections: Sections; vars: Record<string, Kept> };

const SECTIONS = ['notes', 'memories', 'skills', 'agents'] as const;
const KEEP_VERSIONS = 16;
const HARNESS_BYTES = 12_000;
const LOAD_BYTES = 96_000;
const TOOL = 'mod_omd_programmable_context';
const PYTHON_API = `import json as _json


def _call(_tool, **arguments):
    result = tool("mod_omd_programmable_context_" + _tool, {key: value for key, value in arguments.items() if value is not None})
    if isinstance(result, str):
        try:
            result = _json.loads(result)
        except ValueError:
            pass
    if isinstance(result, dict) and set(result) == {"error"}:
        raise RuntimeError(result["error"])
    return result


class Var(str):
    def __new__(cls, text, sha256, sources):
        value = super().__new__(cls, text)
        value.sha256, value.sources = sha256, tuple(sources)
        return value


class Agent:
    def __init__(self, handle, route):
        self.handle, self.route = handle, route

    def _act(self, action, **arguments):
        return _call("agent", handle=self.handle, action=action, **arguments)

    def send(self, message):
        return self._act("message", message=message)

    def wait(self, attempts=10):
        result = self._act("wait")
        while result.get("status") == "running" and attempts > 1:
            attempts -= 1
            result = self._act("wait")
        return result

    def result(self):
        return self._act("result")

    def cancel(self):
        return self._act("cancel")

    def integrate(self):
        return self._act("integrate")

    def __repr__(self):
        return f"Agent({self.handle!r}, route={self.route!r})"


class RLM:
    def load(self, *paths):
        files = _call("load", paths=list(paths))["files"]
        return {path: Var(file["text"], file["sha256"], [f"{path}@{file['sha256']}"]) if file else None for path, file in files.items()}

    def keep(self, name, value, sources=()):
        kept = _call("keep", name=name, value=str(value), sources=list(getattr(value, "sources", ())) + list(sources))
        return Var(str(value), kept["sha256"], kept["sources"])

    def vars(self):
        return _call("vars")["vars"]

    def restore(self, name):
        kept = _call("vars", name=name)
        return Var(kept["value"], kept["sha256"], kept["sources"])

    def spawn(self, prompt, role="worker", spec=None, route=None, workspace=None, tools=None):
        spawned = _call("spawn", prompt=prompt, role=role, spec=spec, route=route, workspace=workspace, tools=tools)
        return Agent(spawned["handle"], spawned["route"])

    def map(self, prompts, **options):
        agents = [self.spawn(prompt, **options) for prompt in prompts]
        return [agent.wait() for agent in agents]

    def complete(self, prompt, route=None):
        return _call("complete", prompt=prompt, route=route)["text"]

    def sh(self, cmd, max_output_tokens=4000):
        return tool("exec_command", {"cmd": cmd, "max_output_tokens": max_output_tokens})

    def harness(self):
        return _call("harness")

    def refine(self, changes, reason, evidence):
        return _call("refine", changes=changes, reason=reason, evidence=list(evidence))


rlm = RLM()
`;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const strings = (value: unknown, count: number, max: number): value is string[] => Array.isArray(value) && value.length <= count && value.every(item => text(item, max));
const empty = (): Sections => ({ notes: {}, memories: {}, skills: {}, agents: {} });
const schema = (properties: Record<string, Json>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });

function spec(value: unknown): value is Spec {
  return object(value) && Object.keys(value).every(key => ['role', 'prompt', 'workspace', 'tools', 'route'].includes(key))
    && text(value.role, 64) && text(value.prompt, 2000) && [undefined, 'read_only', 'isolated_worktree'].includes(value.workspace as string)
    && (value.tools === undefined || strings(value.tools, 16, 64)) && (value.route === undefined || text(value.route, 64));
}

function proposal(value: unknown): Proposal {
  if (!object(value) || !Array.isArray(value.changes) || !value.changes.length || value.changes.length > 4) throw new Error('refine_invalid: 1-4 changes');
  if (!text(value.reason, 400) || !strings(value.evidence, 8, 200) || !value.evidence.length) throw new Error('refine_invalid: a reason and 1-8 evidence references are required');
  for (const change of value.changes) {
    if (!object(change) || Object.keys(change).some(key => !['section', 'name', 'value'].includes(key)) || !SECTIONS.includes(change.section as keyof Sections)
      || typeof change.name !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(change.name)
      || !(change.value === null || (change.section === 'agents' ? spec(change.value) : text(change.value, 600)))) throw new Error('refine_invalid: change');
  }
  return { changes: value.changes as Change[], reason: value.reason, evidence: value.evidence };
}

function applied(sections: Sections, changes: Change[]) {
  const next: Sections = JSON.parse(JSON.stringify(sections));
  for (const { section, name, value } of changes) {
    const entries = next[section] as Record<string, string | Spec>;
    if (value === null) delete entries[name];
    else entries[name] = value;
  }
  if (JSON.stringify(next).length > HARNESS_BYTES) throw new Error('harness_limit: remove entries before adding more');
  return next;
}

const shown = (value: string | Spec) => typeof value === 'string' ? value : JSON.stringify(value).slice(0, 160);

function diff(sections: Sections, { changes, reason, evidence }: Proposal) {
  const lines = changes.map(({ section, name, value }) => {
    const before = (sections[section] as Record<string, string | Spec>)[name];
    if (value === null) return `- ${section}/${name}`;
    return before === undefined ? `+ ${section}/${name}: ${shown(value)}` : `~ ${section}/${name}: ${shown(before)} -> ${shown(value)}`;
  });
  return [...lines, `reason: ${reason}`, `evidence: ${evidence.join(', ')}`].join('\n');
}

function merged(...layers: Sections[]) {
  const result = empty();
  for (const layer of layers) for (const section of SECTIONS) Object.assign(result[section], layer[section]);
  return result;
}

function describe(sections: Sections) {
  return SECTIONS.flatMap(section => {
    const entries = Object.entries(sections[section] as Record<string, string | Spec>);
    return entries.length ? [`${section[0].toUpperCase()}${section.slice(1)}:`, ...entries.map(([name, value]) => `- ${name}: ${shown(value)}`)] : [];
  });
}

function render(mirror: Mirror, thread: string) {
  const own = mirror.thread === thread;
  const vars = Object.entries(own ? mirror.vars : {});
  return [`Programmable context (omd_programmable_context), session harness v${own ? mirror.version : 0}. It is supplemental and lower priority than user, project and system instructions.`,
    `In a code-mode python kernel cell, run exec(tool("${TOOL}_python_api", {})["source"]) once, then use rlm.load, rlm.keep, rlm.restore, rlm.spawn, rlm.map, rlm.complete, rlm.harness and rlm.refine. If the kernel or these tools are unavailable, continue with ordinary tools.`,
    ...(vars.length ? ['Kept variables (restore by name):', ...vars.map(([name, kept]) => `- ${name}: ${kept.chars} characters, sha256 ${kept.sha256.slice(0, 12)}, sources ${kept.sources.join(', ') || 'none'}`)] : []),
    ...describe(merged(mirror.base, own ? mirror.sections : empty()))].join('\n');
}

async function sha256(value: string) {
  const utf8 = Uint8Array.from(encodeURIComponent(value).replace(/%([0-9A-F]{2})/g, (_, byte) => String.fromCharCode(parseInt(byte, 16))), character => character.charCodeAt(0));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', utf8))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export default function activate(api: ModAPI) {
  const policy = String(api.settings.refine ?? 'manual');
  if (!['off', 'manual', 'auto'].includes(policy)) throw new Error('refine_policy_invalid');

  // Host replay suspensions are not Errors and must keep propagating; thrown Errors would disable the mod.
  const refusing = <T>(handler: (value: Json) => T | Promise<T>, refuse: (message: string) => T) => async (value: Json) => {
    try { return await handler(value); }
    catch (error) { if (error instanceof Error) return refuse(error.message); throw error; }
  };
  const tool = (spec: ToolSpec, handler: (value: Record<string, unknown>) => Json | Promise<Json>) =>
    api.tool(spec, refusing(value => handler(object(value) ? value : {}), (error): Json => ({ error })));
  const mirror = (): Mirror => (api.state.get() as Mirror | null) ?? { base: empty(), thread: null, version: 0, sections: empty(), vars: {} };
  const thread = () => api.host.call('task.status', null).ledger.thread_id;
  const harness = () => {
    const record = api.host.call('store.get', { key: 'harness', scope: 'thread' });
    return { revision: record?.revision ?? null, value: (record?.value ?? { version: 0, pending: null, log: [] }) as unknown as Harness };
  };
  const snapshot = (version: number): Sections => version ? api.host.call('store.get', { key: `harness.v${version}`, scope: 'thread' })?.value as unknown as Sections ?? empty() : empty();
  const layer = (scope: 'user' | 'repository'): Sections => (api.host.call('store.get', { key: 'harness', scope })?.value as unknown as Sections | undefined) ?? empty();
  const publish = (update: Partial<Mirror>) => {
    const current = mirror();
    const id = thread();
    api.state.set({ ...current, ...(current.thread === id ? {} : { version: 0, sections: empty(), vars: {} }), thread: id, ...update } as unknown as Json);
  };
  const save = (record: ReturnType<typeof harness>, value: Harness) => api.host.call('store.put', { key: 'harness', value: value as unknown as Json, expected_revision: record.revision, scope: 'thread' });

  const commit = (record: ReturnType<typeof harness>, sections: Sections, entry: Harness['log'][number]) => {
    const stale = api.host.call('store.get', { key: `harness.v${entry.version}`, scope: 'thread' });
    api.host.call('store.put', { key: `harness.v${entry.version}`, value: sections as unknown as Json, expected_revision: stale?.revision ?? null, scope: 'thread' });
    save(record, { version: entry.version, pending: null, log: [...record.value.log, entry].slice(-KEEP_VERSIONS) });
    const expired = api.host.call('store.get', { key: `harness.v${entry.version - KEEP_VERSIONS}`, scope: 'thread' });
    if (expired) api.host.call('store.delete', { key: `harness.v${entry.version - KEEP_VERSIONS}`, expected_revision: expired.revision, scope: 'thread' });
    publish({ version: entry.version, sections });
  };
  const apply = (record: ReturnType<typeof harness>, change: Proposal, before = snapshot(record.value.version)) => {
    commit(record, applied(before, change.changes), { version: record.value.version + 1, kind: 'refine', reason: change.reason, evidence: change.evidence });
    return diff(before, change);
  };

  api.on('start', () => api.state.set({ base: merged(layer('user'), layer('repository')), thread: thread(), version: 0, sections: empty(), vars: {} } as unknown as Json));
  api.on('resume', () => {
    const record = harness();
    const vars = api.host.call('store.get', { key: 'vars', scope: 'thread' })?.value as unknown as Record<string, Kept> | undefined;
    publish({ base: merged(layer('user'), layer('repository')), version: record.value.version, sections: snapshot(record.value.version), vars: vars ?? {} });
  });
  api.replace('history', event => event.agent_id ? null : { insert: [{ before: 0, role: 'developer', text: render(mirror(), event.thread_id) }] });

  tool({ name: 'python_api', description: 'Return the Python source of the rlm helper for the persistent python kernel. Run it once per kernel with exec(...).', parameters: schema({}) },
    () => ({ source: PYTHON_API }));

  tool({ name: 'load', description: 'Read up to 8 workspace files with their current SHA-256 for use as context variables.', parameters: schema({ paths: { type: 'array', items: { type: 'string' }, maxItems: 8 } }, ['paths']) }, value => {
    if (!strings(value.paths, 8, 512) || !value.paths.length) throw new Error('load_invalid: 1-8 paths');
    const files = api.host.call('workspace.read', { paths: value.paths }).files;
    let budget = LOAD_BYTES;
    return { files: Object.fromEntries(Object.entries(files).map(([path, file]) => {
      if (!file) return [path, null];
      const kept = file.text.slice(0, Math.max(0, budget));
      budget -= kept.length;
      return [path, { text: kept, sha256: file.sha256, chars: file.text.length, truncated: kept.length < file.text.length }];
    })) };
  });

  tool({ name: 'keep', description: 'Persist a named context variable (up to 32 KiB) with its sources for this session, so it survives kernel restarts and compaction.', parameters: schema({ name: { type: 'string' }, value: { type: 'string' }, sources: { type: 'array', items: { type: 'string' }, maxItems: 8 } }, ['name', 'value']) }, async value => {
    if (typeof value.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,47}$/.test(value.name) || typeof value.value !== 'string' || value.value.length > 32_768
      || !strings(value.sources ?? [], 8, 200)) throw new Error('keep_invalid: identifier name, string value up to 32 KiB and up to 8 sources');
    const sources = [...new Set((value.sources ?? []) as string[])].slice(0, 8);
    const registry = api.host.call('store.get', { key: 'vars', scope: 'thread' });
    const vars = { ...(registry?.value as unknown as Record<string, Kept> | undefined ?? {}) };
    if (!vars[value.name] && Object.keys(vars).length >= 32) throw new Error('keep_limit: 32 variables');
    const kept = { sha256: await sha256(value.value), chars: value.value.length, sources };
    const previous = api.host.call('store.get', { key: `var.${value.name}`, scope: 'thread' });
    api.host.call('store.put', { key: `var.${value.name}`, value: value.value, expected_revision: previous?.revision ?? null, scope: 'thread' });
    api.host.call('store.put', { key: 'vars', value: { ...vars, [value.name]: kept } as unknown as Json, expected_revision: registry?.revision ?? null, scope: 'thread' });
    publish({ vars: { ...vars, [value.name]: kept } });
    return kept;
  });

  tool({ name: 'vars', description: 'List kept context variables, or return one by name.', parameters: schema({ name: { type: 'string' } }) }, (value): Json => {
    const vars = (api.host.call('store.get', { key: 'vars', scope: 'thread' })?.value ?? {}) as unknown as Record<string, Kept>;
    if (value.name === undefined) return { vars: vars as unknown as Json };
    const name = String(value.name);
    const stored = vars[name] && api.host.call('store.get', { key: `var.${name}`, scope: 'thread' });
    if (!stored) throw new Error(`unknown_variable: ${name}`);
    return { value: stored.value, ...vars[name] };
  });

  const route = (requested: unknown, role: 'worker') => {
    const routes = api.host.call('routes.list', null) as RouteInfo[];
    const name = requested ?? api.settings.route;
    const selected = name ? routes.find(item => item.name === name) : routes.find(item => item.roles.includes(role) && item.available);
    if (!selected || !selected.available || !selected.roles.includes(role)) throw new Error(`route_unavailable: ${String(name ?? 'no available worker route')}`);
    return selected.name;
  };

  tool({ name: 'spawn', description: 'Start an isolated child agent on a worker route, optionally from a stored agent spec. Returns a handle.', parameters: schema({ prompt: { type: 'string' }, role: { type: 'string' }, spec: { type: 'string' }, route: { type: 'string' }, workspace: { type: 'string', enum: ['read_only', 'isolated_worktree'] }, tools: { type: 'array', items: { type: 'string' }, maxItems: 16 } }, ['prompt']) }, value => {
    if (!text(value.prompt, 16_000)) throw new Error('spawn_invalid: prompt required');
    const stored = value.spec === undefined ? undefined : merged(mirror().base, snapshot(harness().value.version)).agents[String(value.spec)];
    if (value.spec !== undefined && !stored) throw new Error(`unknown_agent_spec: ${String(value.spec)}`);
    const options = { role: value.role ?? stored?.role ?? 'worker', workspace: value.workspace ?? stored?.workspace ?? 'read_only', tools: value.tools ?? stored?.tools };
    if (!text(options.role, 64) || !['read_only', 'isolated_worktree'].includes(String(options.workspace)) || (options.tools !== undefined && !strings(options.tools, 16, 64))) throw new Error('spawn_invalid: options');
    const selected = route(value.route ?? stored?.route, 'worker');
    const agent = api.host.call('agents.spawn', { role: options.role, route: selected, prompt: stored ? `${stored.prompt}\n\n${value.prompt}` : value.prompt,
      workspace: options.workspace as 'read_only' | 'isolated_worktree', ...(options.tools ? { tools: options.tools } : {}) });
    return { handle: agent.handle, route: agent.route, workspace: agent.permissions };
  });

  tool({ name: 'agent', description: 'Act on a child agent handle: wait, result, message, cancel or integrate.', parameters: schema({ handle: { type: 'string' }, action: { type: 'string', enum: ['wait', 'result', 'message', 'cancel', 'integrate'] }, message: { type: 'string' } }, ['handle', 'action']) }, value => {
    if (!text(value.handle, 128)) throw new Error('agent_invalid: handle required');
    const handle = value.handle;
    switch (value.action) {
      case 'wait': return api.host.call('agents.wait', { handle, consume: true }) as unknown as Json;
      case 'result': return api.host.call('agents.result', { handle, consume: true }) as unknown as Json;
      case 'cancel': return api.host.call('agents.cancel', { handle });
      case 'integrate': return api.host.call('workspace.integrate', { handle }) as unknown as Json;
      case 'message':
        if (!text(value.message, 8000)) throw new Error('agent_invalid: message required');
        return api.host.call('agents.message', { handle, message: value.message });
      default: throw new Error('agent_invalid: action');
    }
  });

  tool({ name: 'complete', description: 'Run one tool-less completion on a worker route, for sub-questions over context variables.', parameters: schema({ prompt: { type: 'string' }, route: { type: 'string' } }, ['prompt']) }, value => {
    if (!text(value.prompt, 32_000)) throw new Error('complete_invalid: prompt required');
    return api.host.call('model.complete', { route: route(value.route, 'worker'), prompt: value.prompt });
  });

  tool({ name: 'harness', description: 'Show the session harness: version, notes, memories, skills, agent specs, pending refinement and history.', parameters: schema({}) }, () => {
    const record = harness();
    return { policy, version: record.value.version, sections: merged(mirror().base, snapshot(record.value.version)) as unknown as Json,
      pending: record.value.pending as unknown as Json, log: record.value.log as unknown as Json };
  });

  tool({ name: 'refine', description: 'Propose 1-4 session harness changes {section: notes|memories|skills|agents, name, value (null removes)} with a reason and evidence references. The user applies them unless the refine policy is auto.', parameters: schema({ changes: { type: 'array', maxItems: 4, items: { type: 'object' } }, reason: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' }, maxItems: 8 } }, ['changes', 'reason', 'evidence']) }, (value): Json => {
    if (policy === 'off') throw new Error('refine_disabled: the refine policy is off');
    const change = proposal(value);
    const record = harness();
    const before = snapshot(record.value.version);
    applied(before, change.changes);
    if (policy === 'auto') return { status: 'applied', version: record.value.version + 1, diff: apply(record, change, before) };
    save(record, { ...record.value, pending: change });
    return { status: 'pending', diff: diff(before, change), next: 'The user reviews it with /refine and applies it with /refine apply.' };
  });

  api.command('refine', refusing(argument => {
    const [action = 'show', target] = String(argument ?? '').trim().split(/\s+/).filter(Boolean);
    const record = harness();
    const pending = record.value.pending;
    if (action === 'show') {
      const history = record.value.log.map(entry => `v${entry.version} ${entry.kind}: ${entry.reason}`).join('\n');
      return { display: [`Refine policy: ${policy}. Session harness v${record.value.version}.`, pending ? `Pending:\n${diff(snapshot(record.value.version), pending)}` : 'No pending refinement.', history].filter(Boolean).join('\n') };
    }
    if (action === 'apply') {
      if (policy === 'off') return { display: 'The refine policy is off; nothing was applied.' };
      if (!pending) return { display: 'No pending refinement.' };
      return { display: `Applied v${record.value.version + 1}:\n${apply(record, pending)}` };
    }
    if (action === 'reject') {
      if (pending) save(record, { ...record.value, pending: null });
      return { display: pending ? 'Pending refinement rejected.' : 'No pending refinement.' };
    }
    if (action === 'rollback') {
      const version = target === undefined ? record.value.version - 1 : Number(target.replace(/^v/, ''));
      if (!Number.isInteger(version) || version < Math.max(0, record.value.version - KEEP_VERSIONS + 1) || version >= record.value.version) return { display: `Choose a version from v${Math.max(0, record.value.version - KEEP_VERSIONS + 1)} to v${record.value.version - 1}.` };
      commit(record, snapshot(version), { version: record.value.version + 1, kind: 'rollback', reason: `restore v${version}`, evidence: [`harness.v${version}`] });
      return { display: `Session harness v${record.value.version + 1} restores v${version}.` };
    }
    if (action === 'promote' && (target === 'project' || target === 'personal')) {
      const scope = target === 'project' ? 'repository' : 'user';
      const sections = snapshot(record.value.version);
      const confirmed = api.host.call('terminal.prompt', { kind: 'confirm', title: `Promote the session harness to ${target} scope?`, message: `Future sessions ${target === 'project' ? 'in this repository' : 'for this user'} will receive:\n${describe(sections).join('\n')}`.slice(0, 2000) });
      if (confirmed.status !== 'accepted') return { display: 'Promotion declined.' };
      const current = api.host.call('store.get', { key: 'harness', scope });
      api.host.call('store.put', { key: 'harness', value: sections as unknown as Json, expected_revision: current?.revision ?? null, scope });
      publish({ base: merged(layer('user'), layer('repository')) });
      return { display: `Promoted session harness v${record.value.version} to ${target} scope. Remove it with omd store reset --mod omd_programmable_context --scope ${scope}.` };
    }
    return { display: 'Usage: /refine [show | apply | reject | rollback [vN] | promote project|personal]' };
  }, error => ({ display: `Refine failed: ${error}` })), { description: 'Review, apply, reject, roll back or promote session harness refinements' });
}

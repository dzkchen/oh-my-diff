import type { AgentFailure, AgentSpawnRequest, Json, ModAPI, ReasoningEffort, RouteInfo } from '../../api.d.ts';

type Role = 'research' | 'review' | 'worker';
type Choice = { query: string; effort: ReasoningEffort | null };
type Directives = Partial<Record<Role | 'all', Choice>>;
type Named = { model: string; displayName: string; hidden?: boolean };
type Model = Named & { hidden: boolean; modelProvider?: string | null; supportedReasoningEfforts: { reasoningEffort: ReasoningEffort }[] };
type Outcome = { status: string; text?: string; error?: string; failure?: AgentFailure | null; candidate_sha256?: string; changed_paths?: string[] };
type Task = { role: string; route: string; provider: string; billing: RouteInfo['billing']; credential: string | null; model: string; isolation: 'shared' | 'worktree'; request_id?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled'; text?: string; error?: string; paths?: string[]; candidate?: string; held?: boolean; at: number;
  brief?: string; retry_at?: number; retry_of?: string };
type State = Directives & { tasks?: Record<string, Task> };
type Vitals = { windows?: Record<string, { used: number; resets: number | null; at: number }>; failed?: Record<string, { at: number; category: string }> };

const ROLES: Role[] = ['research', 'review', 'worker'];
const EFFORTS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const ROLE_WORDS: [Role, RegExp][] = [
  ['review', /\b(?:review\w*|audit\w*|critique\w*|verif\w*)\b/i],
  ['research', /\b(?:research\w*|investigat\w*|explor\w*|look (?:up|into)|find out|survey\w*)\b/i],
  ['worker', /\b(?:implement(?:s|ed|ing)?|writ(?:e|es|ing)|edit(?:s|ed|ing)?|fix(?:es|ed|ing)?|build(?:s|ing)?|cod(?:e|es|ing)|work(?:s|ed|ing|er)?)\b/i],
];
const READ_TOOLS = ['exec_command', 'write_stdin'];
const HARD_FAILURES = ['authorization', 'rate_limit', 'allowance'];
const FULL_PERCENT = 90;
const COOLDOWN_MS = 15 * 60_000;
const STALE_MS = 60 * 60_000;
const RECHECK_MS = STALE_MS / 6;
const TEXT_BYTES = 8192;
const KEEP_TASKS = 12;
const ID_BYTES = 128;
const ERROR_BYTES = 1024;
const LISTED_MODELS = 12;
const RETRY_MAX_MS = 6 * 60 * 60_000;
const RETRY_GRACE_MS = 30_000;
const RUNNING = 'Its result wakes this thread when it finishes, so end your turn.';
const DELIVERED = 'Its result was already delivered to this thread.';
const DESCRIPTION = "Start a background subagent on a worker route and collect its result. Native spawn_agent covers other providers' models and work that outlives the turn; use delegate_task only for what it alone gives: worker-only routes, a read-only sandbox (shared isolation), an isolated worktree plus the integrate action to apply its result, and retry_after_limit. start takes task, role, model, isolation (shared is read-only, or worktree), mode (async, or wait for up to 30 s) and request_id to retry safely; status, cancel and integrate (a worktree result) take a handle; targets lists routes with the isolation each allows and why one is skipped, and takes model to search. A finished task wakes this thread.";
const utf8 = new TextEncoder();
const bytes = (text: string) => utf8.encode(text).length;
const clip = (text: string, max: number) => text.slice(0, utf8.encodeInto(text, new Uint8Array(max)).read);
const truncate = (text: string, max: number) => {
  const size = bytes(text);
  const marker = `… [cut to ${max} of ${size} bytes]`;
  return size <= max ? text : clip(text, max - bytes(marker)) + marker;
};
const LEAD = /^(?:default|lead|same|inherit)/i;
const EFFORT = String.raw`(?:\s+(?:at|with)\s+(${EFFORTS.join('|')})(?:\s+effort)?)?`;
const USE = new RegExp(String.raw`\buse\s+([a-z][\w.\- ]{0,40}?)${EFFORT}\s+(?:as|for)\s+(?:the\s+)?(?:sub-?agents?|agents?|helpers?)(?:\s+(?:to|for)\s+(?:the\s+)?(\w+))?`, 'gi');
const NEGATED = /\b(?:don['’]?t|do not|doesn['’]?t|never|no|without|avoid|not|won['’]?t)\s+(?:(?:ever|really|just|please)\s+)?$/i;
const MENTION = new RegExp(String.raw`(?<![\w.])@([a-z][\w.\-]{0,40})${EFFORT}\s+for\s+(?:the\s+)?(\w+)`, 'gi');

const roleOf = (word: string | undefined): Role | 'all' => ROLE_WORDS.find(([, pattern]) => pattern.test(word ?? ''))?.[0] ?? 'all';
const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim().split(' ').filter(Boolean);

function directives(text: string) {
  const found: { role: Role | 'all'; choice: Choice; warn: boolean }[] = [];
  for (const [pattern, warn] of [[USE, true], [MENTION, false]] as const) {
    for (const { 1: query, 2: effort, 3: role, index } of text.matchAll(pattern)) if (!NEGATED.test(text.slice(0, index))) found.push({ role: roleOf(role), choice: { query: query.trim().replace(/^the\s+/i, ''), effort: (effort?.toLowerCase() ?? null) as ReasoningEffort | null }, warn });
  }
  return found;
}

function classify(spawn: AgentSpawnRequest): Role | null {
  if (spawn.definition === 'explorer') return 'research';
  if (spawn.definition === 'worker') return 'worker';
  return ROLE_WORDS.find(([, pattern]) => pattern.test(spawn.prompt))?.[0] ?? null;
}

// A task with no role words (multi-agent v2 seals it) takes the only role-specific choice, if there is exactly one.
const only = (choices: Directives) => {
  const set = ROLES.filter(role => choices[role]);
  return set.length === 1 ? choices[set[0]] : undefined;
};

function matching<T extends Named>(items: T[], query: string): T[] {
  const wanted = words(query);
  const rank = (item: T) => item.model === query ? 0 : item.hidden ? 2 : 1;
  return items.filter(item => {
    const known = words(`${item.model} ${item.model.replace(/-(\d+)-(\d+)/g, '-$1.$2')} ${item.displayName}`);
    return wanted.length > 0 && wanted.every(word => known.some(token => token.startsWith(word)));
  }).sort((a, b) => rank(a) - rank(b));
}

const resolve = <T extends Named>(items: T[], query: string): T | null => matching(items, query)[0] ?? null;

const serves = (route: RouteInfo, model: { model: string; modelProvider?: string | null }) => route.provider === model.modelProvider
  && (route.model === model.model || !route.status?.models || route.status.models.includes(model.model));
// A lead route is its own account; a worker route runs on the first lead route of its provider that serves its model.
const account = (route: RouteInfo, all: RouteInfo[]) => route.roles.includes('lead') ? route
  : all.find(lead => lead.roles.includes('lead') && serves(lead, { model: route.model, modelProvider: route.provider })) ?? route;
// Codex's limit id for an account: its route name with dashes as underscores, `codex` on the built-in OpenAI provider.
const family = (route: RouteInfo, all: RouteInfo[]) => route.provider === 'openai' ? 'codex' : account(route, all).name.replace(/-/g, '_');

function usageOf(vitals: Vitals, route: RouteInfo, all: RouteInfo[], now: number) {
  const status = account(route, all).status;
  const published = status?.usage ?? [];
  if (!status || !published.length) return vitals.windows?.[family(route, all)] ?? null;
  const live = published.filter(slot => !slot.resets_at || slot.resets_at > now);
  if (!live.length) return null;
  const top = live.reduce((a, b) => b.used_percent > a.used_percent ? b : a);
  return { used: Math.round(top.used_percent), resets: top.resets_at ?? null, at: status.checked_at };
}

function health(vitals: Vitals, route: RouteInfo, all: RouteInfo[], now: number): string | null {
  const status = account(route, all).status;
  if (status && (!status.installed || !status.signed_in || status.detail)) return status.detail ?? (status.installed ? 'not signed in' : 'not installed');
  const usage = usageOf(vitals, route, all, now);
  if (usage && usage.used >= FULL_PERCENT && (usage.resets !== null ? usage.resets > now : now - usage.at < STALE_MS)) return `${usage.used}% of its usage limit used`;
  const failure = vitals.failed?.[family(route, all)];
  return failure && now - failure.at < COOLDOWN_MS ? `${failure.category} failure ${Math.max(1, Math.round((now - failure.at) / 60_000))} min ago` : null;
}

export default function activate(api: ModAPI) {
  const defaults: Directives = {};
  for (const role of ROLES) {
    const query = api.settings[`${role}_model`];
    const effort = api.settings[`${role}_effort`];
    if (typeof query === 'string' && query.trim()) defaults[role] = { query: query.trim(), effort: EFFORTS.includes(effort as ReasoningEffort) ? effort as ReasoningEffort : null };
  }
  const spares = typeof api.settings.fallback_models === 'string' ? api.settings.fallback_models.split(',').map(query => query.trim()).filter(Boolean) : [];
  const retrying = api.settings.retry_after_limit === true;
  const current = () => api.state.get() as State | null ?? {};
  const save = (state: State) => api.state.set(state as Json);
  const fallback = (text: string) => {
    api.host.tryCall('terminal.notice', { text, kind: 'warning', placement: 'toast', id: 'fallback' });
    api.host.tryCall('terminal.notice', { text, kind: 'warning', placement: 'transcript' });
  };
  const catalog = () => {
    const listed = api.host.tryCall('app.request', { method: 'model/list', params: { includeHidden: true } });
    return listed.ok && listed.value !== null && typeof listed.value === 'object' && 'data' in listed.value ? listed.value.data as unknown as Model[] : [];
  };
  const routes = () => {
    const listed = api.host.tryCall('routes.list', null);
    return listed.ok ? listed.value : [];
  };

  const vitals = () => {
    const got = api.host.tryCall('store.get', { key: 'health', scope: 'user' });
    return got.ok && got.value ? { value: got.value.value as Vitals, revision: got.value.revision } : { value: {} as Vitals, revision: null };
  };
  const remember = (change: (value: Vitals) => Vitals | null) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { value, revision } = vitals();
      const next = change(value);
      if (!next || api.host.tryCall('store.put', { key: 'health', value: next as Json as Exclude<Json, null>, expected_revision: revision, scope: 'user' }).ok) return;
    }
  };

  api.on('app_notification', ({ method, params }) => {
    if (method !== 'account/rateLimits/updated') return;
    const limits = (params as Record<string, any> | null)?.rateLimits ?? {};
    const slots = [limits.primary, limits.secondary].filter(slot => typeof slot?.usedPercent === 'number');
    if (!slots.length) return;
    const top = slots.reduce((a, b) => b.usedPercent > a.usedPercent ? b : a);
    const resets = typeof top.resetsAt === 'number' ? (top.resetsAt < 1e12 ? top.resetsAt * 1000 : top.resetsAt) : null;
    const id = limits.limitId ?? 'codex';
    const used = Math.round(top.usedPercent);
    const now = Date.now();
    remember(value => {
      const known = value.windows?.[id];
      return known && known.used === used && known.resets === resets && now - known.at < RECHECK_MS ? null : { ...value, windows: { ...value.windows, [id]: { used, resets, at: now } } };
    });
  });

  api.intercept('input', (event, next) => {
    if (next.origin.caller !== 'user') return next(event);
    const found = directives(event.text);
    if (!found.length) return next(event);
    const models = catalog();
    const kept: Directives = {};
    for (const { role, choice, warn } of found) {
      if (LEAD.test(choice.query) || resolve(models, choice.query)) kept[role] = choice;
      else if (warn) fallback(`No model matches "${choice.query}", so ${role === 'all' ? '' : `${role} `}subagents keep the lead's model`);
    }
    if (Object.keys(kept).length) save({ ...current(), ...kept });
    return next(event);
  });

  const leads = (model: Model, available: RouteInfo[]) => available.filter(route => route.roles.includes('lead') && serves(route, model));
  const blocked = (model: Model, available: RouteInfo[], seen: Vitals) => {
    if (!model.modelProvider) return null;
    const usable = leads(model, available).filter(route => route.available);
    if (!usable.length) return 'no usable route';
    const reasons = usable.map(route => health(seen, route, available, Date.now()));
    return reasons.includes(null) ? null : reasons[0];
  };

  api.intercept('agent_spawn', (spawn, next) => {
    if (spawn.origin !== 'model') return next(spawn);
    const role = classify(spawn);
    const chosen = current();
    const choice = role ? chosen[role] ?? chosen.all ?? defaults[role] : chosen.all ?? only(chosen) ?? only(defaults);
    const kind = role ? `${role} subagent` : 'subagent';
    if (!choice || LEAD.test(choice.query)) return next(spawn);
    const models = catalog();
    if (spawn.model && models.some(model => model.model === spawn.model)) return next(spawn);
    let model = resolve(models, choice.query);
    if (!model) {
      fallback(`No model matches "${choice.query}", so this ${kind} runs on the lead's model`);
      return next({ ...spawn, model: null });
    }
    const available = routes();
    const seen = vitals().value;
    const reason = blocked(model, available, seen);
    if (reason) {
      const skipped = [`${model.displayName} is skipped (${reason})`];
      const tried = new Set([model.model]);
      let usable: Model | null = null;
      for (const query of spares) {
        const other = resolve(models, query);
        if (!other || tried.has(other.model)) continue;
        tried.add(other.model);
        const why = blocked(other, available, seen);
        if (!why) { usable = other; break; }
        skipped.push(`${other.displayName} is skipped (${why})`);
      }
      fallback(`${skipped.join('; ')}, so this ${kind} runs on ${usable ? usable.displayName : "the lead's model"}`);
      if (!usable) return next({ ...spawn, model: null });
      model = usable;
    }
    const picked = model;
    const supported = (effort: ReasoningEffort | null) => effort && picked.supportedReasoningEfforts.some(option => option.reasoningEffort === effort) ? effort : null;
    const effort = choice.effort ? supported(choice.effort) : supported(spawn.effort);
    return next({ ...spawn, model: picked.model, effort });
  });

  const runtime = (route: RouteInfo, models: Model[]) => !route.roles.includes('worker') && route.roles.includes('lead') && models.some(model => model.model === route.model && model.modelProvider === route.provider);
  const skip = (route: RouteInfo, all: RouteInfo[], models: Model[], seen: Vitals, worktree = false) => {
    if (!route.roles.includes('worker') && !runtime(route, models)) return 'not a worker route';
    if (!route.available) return 'its grant is missing or revoked';
    if (worktree && route.tools.length) return 'limited to read-only tools';
    return health(seen, route, all, Date.now());
  };

  const settle = (handle: string, outcome: Outcome, deliver = true) => {
    const state = current();
    const task = state.tasks?.[handle];
    if (!task || task.status !== 'running' || outcome.status === 'running') return;
    let next: Task;
    if (outcome.status === 'completed') {
      const consumed = api.host.tryCall('agents.result', { handle, consume: true });
      const result: Outcome = consumed.ok && consumed.value.status === 'completed' ? consumed.value : outcome;
      next = { ...task, status: 'completed', text: truncate(result.text ?? '', TEXT_BYTES), held: task.isolation === 'worktree', brief: undefined };
      if (result.candidate_sha256) next.candidate = result.candidate_sha256;
      if (result.changed_paths) next.paths = result.changed_paths.slice(0, 50);
    } else {
      next = { ...task, status: 'failed', error: clip(outcome.error ?? 'failed', ERROR_BYTES), brief: undefined };
      const category = outcome.failure?.category;
      const all = category ? routes() : [];
      const route = all.find(item => item.name === task.route);
      if (category && HARD_FAILURES.includes(category)) remember(value => ({ ...value, failed: { ...value.failed, [route ? family(route, all) : task.route.replace(/-/g, '_')]: { at: Date.now(), category } } }));
      const now = Date.now();
      const usage = route && retrying && category === 'rate_limit' && task.brief && !task.retry_of ? usageOf(vitals().value, route, all, now) : null;
      if (usage && usage.used >= FULL_PERCENT && usage.resets !== null && usage.resets > now && usage.resets - now <= RETRY_MAX_MS) {
        next = { ...next, brief: task.brief, retry_at: usage.resets + RETRY_GRACE_MS };
        save({ ...state, tasks: { ...state.tasks, [handle]: next } });
        rearm();
        return;
      }
      api.host.tryCall('agents.cancel', { handle, deliver });
    }
    save({ ...state, tasks: { ...state.tasks, [handle]: next } });
  };

  const rearm = () => {
    const due = Object.values(current().tasks ?? {}).flatMap(task => task.retry_at ? [task.retry_at] : []);
    if (due.length) api.host.tryCall('events.schedule', { key: 'retry', delay_ms: Math.min(Math.max(Math.min(...due) - Date.now(), 1000), 24 * 60 * 60_000) });
  };

  const retry = () => {
    const now = Date.now();
    const due = Object.entries(current().tasks ?? {}).filter(([, task]) => task.retry_at && task.retry_at <= now + 1000);
    if (!due.length) return rearm();
    const models = catalog();
    const seen = vitals().value;
    const available = routes();
    for (const [handle, task] of due) {
      const route = available.find(item => item.name === task.route);
      const key = route ? family(route, available) : '';
      const failure = seen.failed?.[key];
      const cleared = failure && failure.at < task.retry_at! - RETRY_GRACE_MS ? { ...seen, failed: { ...seen.failed, [key]: { ...failure, at: 0 } } } : seen;
      const moved = route && (route.provider !== task.provider || route.billing !== task.billing || route.credential !== task.credential);
      const reason = !retrying ? 'retry_after_limit is off' : !route ? 'its route is gone'
        : moved ? `route ${task.route} now uses a different provider, account or billing; start the task again to run it there`
        : skip(route, available, models, cleared, task.isolation === 'worktree');
      const launched = route && !reason ? launch({ role: task.role, route: task.route, provider: task.provider, model: task.model, isolation: task.isolation, retry_of: handle }, route, task.brief ?? '') : null;
      const restarted = typeof launched === 'string';
      const cancelled = api.host.tryCall('agents.cancel', { handle, deliver: !restarted });
      const state = current();
      const error = restarted ? `${task.error}; restarted as ${launched} after the usage limit reset` : `${task.error}; not restarted (${reason ?? (launched as { error: string }).error})`;
      if (!restarted && !(cancelled.ok && cancelled.value.delivered)) fallback(clip(`${handle} could not be delivered and is only in status: ${error}`, ERROR_BYTES));
      save({ ...state, tasks: { ...state.tasks, [handle]: { ...state.tasks![handle], retry_at: undefined, brief: undefined, error: clip(error, ERROR_BYTES) } } });
      if (restarted) {
        const early = api.host.tryCall('agents.result', { handle: launched });
        if (early.ok) settle(launched, early.value);
      }
    }
    rearm();
  };

  const report = (handle: string): Json => {
    const state = current();
    const task = state.tasks?.[handle];
    if (!task) return { status: 'unknown', error: `No delegated task ${handle}` };
    const { status, route, model } = task;
    if (status === 'running') return { handle, status, route, model, text: RUNNING };
    if (task.retry_at) return { handle, status: 'waiting', route, model, text: `Its provider hit its usage limit; it restarts at ${new Date(task.retry_at).toISOString()} as a new task, whose result wakes this thread. Cancel stops the restart.` };
    return status === 'completed'
      ? { handle, status, route, model, result: task.text ?? '', ...task.isolation === 'worktree' ? { changed_paths: task.paths ?? [], candidate_sha256: task.candidate ?? null, ...task.held ? { note: 'Call delegate_task integrate to apply it, or cancel to discard it' } : {} } : {} }
      : { handle, status, route, model, error: task.error ?? 'cancelled' };
  };

  const start = (input: Record<string, Json>): Json => {
    const state = current();
    const id = typeof input.request_id === 'string' ? clip(input.request_id, ID_BYTES) : '';
    const known = id ? Object.keys(state.tasks ?? {}).find(handle => state.tasks?.[handle].request_id === id) : undefined;
    if (known) return report(known);
    const task = typeof input.task === 'string' ? input.task.trim() : '';
    if (!task || bytes(task) > 8000) return { status: 'refused', error: 'task must be a brief of 1 to 8000 bytes' };
    const role = ROLES.includes(input.role as Role) ? input.role as Role : 'general';
    const worktree = input.isolation === 'worktree';
    const lead = api.session().model;
    const preferred = role === 'general' ? state.all : state[role] ?? state.all ?? defaults[role];
    const asked = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : preferred?.query ?? '';
    const wanted = [asked, ...spares, lead ?? ''].map(query => LEAD.test(query) ? lead ?? '' : query).filter((query, index, all) => query && all.indexOf(query) === index);
    const models = catalog();
    const seen = vitals().value;
    const named = routes().map(route => ({ ...route, displayName: route.name }));
    const skipped: string[] = [];
    const passed = new Set<string>();
    let picked: { route: RouteInfo; model: string } | undefined;
    for (const query of wanted) {
      const options = [...matching(named, query).map(route => ({ route, model: route.model })),
        ...matching(models.filter(model => !model.hidden), query).flatMap(model => leads(model, named).filter(route => runtime(route, models)).map(route => ({ route, model: model.model })))]
        .filter((option, index, all) => all.findIndex(other => other.route.name === option.route.name && other.model === option.model) === index);
      if (!options.length) skipped.push(`${query}: no route matches`);
      for (const option of options) {
        if (passed.has(option.route.name)) continue;
        const reason = skip(option.route, named, models, seen, worktree);
        if (!reason) { picked = option; break; }
        passed.add(option.route.name);
        skipped.push(`${option.route.name}: ${reason}`);
      }
      if (picked) break;
    }
    if (!picked) return { status: 'refused', error: `Cannot delegate: ${skipped.join('; ') || 'no worker route is configured'}. Use native spawn_agent, or call delegate_task targets.` };
    const launched = launch({ role, route: picked.route.name, provider: picked.route.provider, model: picked.model, isolation: worktree ? 'worktree' : 'shared',
      ...id ? { request_id: id } : {}, ...retrying ? { brief: task } : {} }, picked.route, task);
    if (typeof launched !== 'string') return launched;
    const handle = launched;
    if (skipped.length) fallback(`${skipped.join('; ')}, so this ${role} task runs on ${picked.route.name}`);
    const early = input.mode === 'wait'
      ? api.host.tryCall('agents.wait', { handle })
      : api.host.tryCall('agents.result', { handle, claim: true });
    if (early.ok) settle(handle, early.value, false);
    const reported = report(handle) as Record<string, Json>;
    if (early.ok && 'delivered' in early.value && early.value.delivered !== undefined) {
      const { result: _result, error: _error, ...shown } = reported;
      return { ...shown, text: DELIVERED, ...skipped.length ? { skipped } : {} };
    }
    return skipped.length ? { ...reported, skipped } : reported;
  };

  const launch = (base: Omit<Task, 'status' | 'at' | 'billing' | 'credential'>, route: RouteInfo, prompt: string): string | { status: 'refused'; error: string } => {
    const worktree = base.isolation === 'worktree';
    const spawned = api.host.tryCall('agents.spawn', { role: base.role, route: route.name, prompt, workspace: worktree ? 'isolated_worktree' : 'read_only', ...base.brief ? { hold_failure: true } : {},
      ...base.model === route.model ? {} : { model: base.model }, ...!worktree && !route.tools.length ? { tools: route.billing === 'provider_billed' ? [...READ_TOOLS, 'web_search'] : READ_TOOLS } : {} });
    if (!spawned.ok) return { status: 'refused', error: spawned.error };
    const handle = spawned.value.handle;
    const state = current();
    const tasks = { ...state.tasks, [handle]: { ...base, billing: route.billing, credential: route.credential, status: 'running', at: Date.now() } as Task };
    const evictable = Object.keys(tasks).filter(name => tasks[name].status !== 'running' && !tasks[name].held && !tasks[name].retry_at)
      .sort((a, b) => tasks[a].at - tasks[b].at);
    for (const old of evictable) if (Object.keys(tasks).length > KEEP_TASKS) delete tasks[old];
    save({ ...state, tasks });
    return handle;
  };

  const poll = (handle: string, claim = false) => {
    const result = api.host.tryCall('agents.result', claim ? { handle, claim } : { handle });
    settle(handle, result.ok ? result.value : { status: 'failed', error: result.error }, !claim);
    return result.ok && 'delivered' in result.value && result.value.delivered !== undefined;
  };

  const status = (handle: string): Json => {
    const tasks = current().tasks ?? {};
    if (handle) {
      if (tasks[handle]?.status === 'running' && poll(handle, true)) {
        const { result: _result, error: _error, ...shown } = report(handle) as Record<string, Json>;
        return { ...shown, text: DELIVERED };
      }
      return report(handle);
    }
    for (const name of Object.keys(tasks)) if (tasks[name].status === 'running') poll(name);
    return { tasks: Object.entries(current().tasks ?? {}).map(([name, task]) => ({ handle: name, role: task.role, route: task.route, status: task.retry_at ? 'waiting' : task.status })) };
  };

  const cancel = (handle: string): Json => {
    const state = current();
    const task = state.tasks?.[handle];
    if (!task) return { status: 'unknown', error: `No delegated task ${handle}` };
    if (task.status === 'running' || task.held || task.retry_at) {
      api.host.tryCall('agents.cancel', { handle });
      save({ ...state, tasks: { ...state.tasks, [handle]: { ...task, status: 'cancelled', held: false, retry_at: undefined, brief: undefined } } });
    }
    return report(handle);
  };

  const integrate = (handle: string): Json => {
    const state = current();
    const task = state.tasks?.[handle];
    if (!task?.held) return { status: 'refused', error: `${handle || 'No handle'} is not a finished worktree task waiting to be integrated` };
    const applied = api.host.tryCall('workspace.integrate', { handle });
    if (!applied.ok) return { status: 'refused', error: applied.error };
    if (applied.value.status === 'refused') return { status: 'refused', error: 'The contract still lacks required receipts', missing: applied.value.missing as unknown as Json };
    api.host.tryCall('agents.cancel', { handle });
    save({ ...state, tasks: { ...state.tasks, [handle]: { ...task, held: false } } });
    return { handle, status: 'integrated', changed_paths: applied.value.changed_paths, candidate_sha256: applied.value.candidate_sha256 };
  };

  const targets = (query: string): Json => {
    const models = catalog();
    const seen = vitals().value;
    const all = routes();
    const listed = all.flatMap(route => {
      const runs = runtime(route, models) ? models.filter(model => !model.hidden && model.model !== route.model && serves(route, model)) : [];
      const hits = query ? matching(runs, query).map(model => model.model) : runs.map(model => model.model);
      if (query && !hits.length && !matching([{ model: route.model, displayName: route.name }], query).length) return [];
      const reason = skip(route, all, models, seen);
      const others = hits.slice(0, LISTED_MODELS);
      return [{ route: route.name, model: route.model, ...others.length ? { models: others } : {}, ...hits.length > others.length ? { more_models: hits.length - others.length } : {},
        provider: route.provider, billing: route.billing, isolation: route.tools.length ? ['shared'] : ['shared', 'worktree'], usable: !reason, ...reason ? { skipped: reason } : {} }];
    });
    return { targets: listed };
  };

  api.tool({ name: 'delegate_task', description: DESCRIPTION, parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['start', 'status', 'cancel', 'integrate', 'targets'] },
    task: { type: 'string', description: 'The brief; the subagent sees only this' },
    role: { type: 'string', enum: [...ROLES, 'general'] },
    model: { type: 'string' },
    mode: { type: 'string', enum: ['async', 'wait'] },
    request_id: { type: 'string', maxLength: ID_BYTES },
    isolation: { type: 'string', enum: ['shared', 'worktree'] },
    handle: { type: 'string' },
  } } }, value => {
    const input = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const handle = typeof input.handle === 'string' ? input.handle : '';
    switch (input.action) {
      case 'start': return start(input);
      case 'status': return status(handle);
      case 'cancel': return cancel(handle);
      case 'integrate': return integrate(handle);
      case 'targets': return targets(typeof input.model === 'string' ? input.model.trim() : '');
      default: return { status: 'refused', error: 'action must be start, status, cancel, integrate or targets' };
    }
  });

  api.on('start', () => rearm());
  api.on('resume', () => rearm());

  api.on('agent_end', event => settle(event.handle, event));

  api.on('timer', ({ key }) => {
    if (key === 'retry') retry();
  });
}

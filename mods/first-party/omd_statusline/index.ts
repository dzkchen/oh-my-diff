import type { Json, ModAPI, TerminalComponent, TerminalListRow, TerminalPatch, TerminalRenderSite } from '../../api.d.ts';
import { DEFAULTS, EMPTY, SEGMENTS, charge, githubKey, layout, render, scripts, settings, visible } from './segments.ts';
import type { Charge, Data, Settings } from './segments.ts';
import { GITHUB_ORIGIN, GITHUB_QUERY, GIT_SCRIPT, ansi, parseGit, parseGithub, payload } from './sources.ts';

type Editor = { open: boolean; draft: Settings; selected: string | null; notice: string | null };
type Seen = Data['seen'][string];

const COMMAND = 'omd_statusline:edit';
const BEAT_MS = 150_000;
const PREVIEW_COLUMNS = 64;

export default function activate(api: ModAPI) {
  const config = settings(api.settings);
  const configured = scripts(config.scripts);
  api.builtins({ surfaces: { disable: ['status_line'] }, commands: { replace: { statusline: 'edit' } } });

  const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const saved = (): Data => {
    const stored = object(api.state.get());
    const data = { ...EMPTY, ...stored } as Record<string, any>;
    for (const [key, fallback] of Object.entries(EMPTY)) if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) data[key] = { ...fallback, ...object(stored[key]) };
    return data as Data;
  };
  // A settings change reaches the session's host only at its next turn, so drawing follows the editor's last apply
  // while this host still runs with settings that apply superseded.
  const effective = (data: Data): Settings => data.pending?.from.includes(JSON.stringify(config)) ? data.pending.to : config;
  const update = (change: (data: Data) => void) => {
    const data = saved();
    const before = JSON.stringify(data);
    change(data);
    if (JSON.stringify(data) !== before) api.state.set(data as unknown as Json);
  };

  const refreshGit = () => {
    const run = api.host.tryCall('exec.run', { program: 'sh', argv: ['-c', GIT_SCRIPT], timeout_ms: 3000, max_output_bytes: 65_536 });
    update(data => {
      const key = data.cwd ?? '';
      data.git = !run.ok ? { ...parseGit(key, ''), error: visible(run.error, 80) }
        : run.value.exit_code !== 0 || run.value.timed_out ? { ...parseGit(key, ''), error: run.value.timed_out ? 'timed out' : 'not a repository' }
        : parseGit(key, run.value.stdout);
    });
  };
  const gitSoon = api.time.after('git_soon', 1000, refreshGit);

  const pollGithub = (force = false) => {
    const now = Date.now();
    const data = saved();
    const key = config.github ? githubKey(data.git) : null;
    if (!key || !data.git?.remote || !data.git.branch) {
      if (data.github.status !== 'idle') update(next => { next.github = { ...EMPTY.github }; });
      return;
    }
    const github = data.github.key === key ? data.github : { ...EMPTY.github, key, status: 'loading' as const };
    if ((!force || github.status === 'rate_limited') && github.key === data.github.key && now < github.next) return;
    const profiles = api.host.tryCall('credentials.list', null);
    const profile = profiles.ok ? profiles.value.find(item => item.kind === 'secret' && item.origin === GITHUB_ORIGIN && item.status === 'ready') : undefined;
    const backoff = (failures: number) => now + Math.min(900_000, 60_000 * 2 ** failures);
    let result = github;
    if (!profile) result = { ...github, status: 'auth', next: github.status === 'auth' ? github.next : now + 60_000, detail: profiles.ok ? null : visible(profiles.error, 80) };
    else {
      const { owner, repo } = data.git.remote;
      const branch = data.git.branch;
      const response = api.host.tryCall('http.request', { url: `${GITHUB_ORIGIN}/graphql`, method: 'POST', credential: profile.id, timeout_ms: 10_000,
        headers: { 'content-type': 'application/json', 'user-agent': 'omd-statusline' },
        body: JSON.stringify({ query: GITHUB_QUERY, variables: { owner, name: repo, branch, ref: `refs/heads/${branch}` } }) });
      const failed = (status: 'offline' | 'error' | 'rate_limited' | 'auth', detail: string | null, next = backoff(github.failures)) =>
        ({ ...github, status, detail, next, failures: github.failures + 1, at: github.at });
      if (!response.ok) result = failed(/grant|denied|credential/.test(response.error) ? 'error' : 'offline', visible(response.error, 80));
      else {
        const { status, headers, body } = response.value;
        const header = (name: string) => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
        const reset = Number(header('x-ratelimit-reset'));
        const retry = Number(header('retry-after'));
        if (status === 401) result = failed('auth', 'token rejected', now + 300_000);
        else if (status === 429 || status === 403 && (header('x-ratelimit-remaining') === '0' || retry > 0)) {
          result = failed('rate_limited', null, retry > 0 ? now + retry * 1000 : reset > 0 ? Math.max(now + 60_000, reset * 1000) : backoff(github.failures));
        } else if (status >= 400) result = failed('error', `HTTP ${status}`);
        else {
          const parsed = parseGithub(body ?? '', owner, repo, branch);
          result = 'error' in parsed ? failed(parsed.rate_limited ? 'rate_limited' : 'error', parsed.error)
            : { key, status: 'ok', at: now, next: now + (parsed.ci?.pending ? 60_000 : 180_000), failures: 0, pr: parsed.pr, ci: parsed.ci, detail: null };
        }
      }
    }
    update(next => { if (githubKey(next.git) === key) next.github = result; });
  };

  const runScript = (id: string, force = false) => {
    const script = configured.scripts.find(item => item.id === id);
    if (!script) return;
    const now = Date.now();
    const spec = JSON.stringify(script);
    const data = saved();
    const last = data.scripts[id];
    if (!force && last?.spec === spec && now - last.at < script.interval_s * 500) return;
    const stdin = JSON.stringify(payload(data, config, id, now, data.viewport)).slice(0, 65_536);
    const run = api.host.tryCall('exec.run', { program: script.command[0], argv: script.command.slice(1), stdin, timeout_ms: script.timeout_ms, max_output_bytes: 8192 });
    const spans = run.ok && run.value.exit_code === 0 && !run.value.timed_out ? ansi(run.value.stdout) : [];
    const status = !run.ok || run.value.exit_code !== 0 && !run.value.timed_out ? 'failed' : run.value.timed_out ? 'timeout' : spans.length ? 'ok' : 'empty';
    update(next => { next.scripts[id] = { spec, at: now, status, spans }; });
  };

  const timers = [
    api.time.every('git', config.refresh_s * 1000, refreshGit),
    api.time.every('github', 30_000, () => pollGithub()),
    api.time.every('tick', 60_000, () => {
      const data = saved();
      const now = Date.now();
      const drawn = (at: number) => JSON.stringify(render(data, effective(data), { now: at, columns: 1000, cwd: data.cwd, settled: null }));
      if (drawn(now) !== drawn(now - 60_000)) update(next => { next.tick += 1; next.beat = now; });
    }),
    ...configured.scripts.map(script => api.time.every(`script_${script.id}`, script.interval_s * 1000, () => runScript(script.id))),
  ];
  const armedFor = JSON.stringify(config);
  const arm = (force = false) => {
    const { beat, armed } = saved();
    if (!force && beat !== null && Date.now() - beat < BEAT_MS && armed === armedFor) return;
    for (const timer of timers) timer.start();
    update(data => { data.beat = Date.now(); data.armed = armedFor; });
  };
  const refreshAll = () => {
    refreshGit();
    pollGithub(true);
    for (const script of configured.scripts) runScript(script.id, true);
  };
  // Subprocess and network refreshes wait until startup has settled so they never compete with the first commands.
  const settle = api.time.after('settle', 2000, () => {
    const rates = api.usage.rateLimits();
    if (rates.available) update(data => limits(data, rates.value));
    refreshAll();
  });

  const limits = (data: Data, value: unknown) => {
    const snapshot = object(object(value).rateLimits);
    const windows: Data['limits'] = [];
    for (const name of ['primary', 'secondary']) {
      const slot = object(snapshot[name]);
      const used = number(slot.usedPercent);
      if (used === null) continue;
      const at = number(slot.resetsAt);
      windows.push({ minutes: number(slot.windowDurationMins), used, resets: at === null ? null : at < 1e12 ? at * 1000 : at });
    }
    if (windows.length) data.limits = windows;
    const credits = object(snapshot.credits);
    if (Object.keys(credits).length) data.credits = credits.unlimited ? 'unlimited' : credits.hasCredits ? 'credits' : 'none';
  };
  const configure = () => {
    const session = api.host.tryCall('session.info', null);
    const read = api.host.tryCall('app.request', { method: 'config/read', params: {} });
    const values = object(read.ok ? object(read.value).config : null);
    update(data => {
      if (session.ok) {
        if (data.thread !== session.value.thread_id) data.started = Date.now();
        data.thread = session.value.thread_id;
        data.cwd = session.value.cwd;
        data.model = { ...data.model, requested: session.value.model ?? data.model.requested, provider: session.value.provider };
      }
      if (data.started === null) data.started = Date.now();
      if (typeof values.model_reasoning_effort === 'string') data.model.effort = values.model_reasoning_effort;
      data.context.window = number(values.model_context_window) ?? data.context.window;
    });
    arm(true);
    settle.start();
  };
  api.on('start', configure);
  api.on('resume', configure);
  api.on('session', ({ phase }) => { if (phase === 'idle') arm(); });

  const apply = (data: Data, entry: Seen, sign: number) => {
    const [input, output, reasoning, cached, write, kind, amount] = entry;
    Object.assign(data.tokens, { input: data.tokens.input + sign * input, output: data.tokens.output + sign * output, reasoning: data.tokens.reasoning + sign * reasoning,
      cached: data.tokens.cached + sign * cached, write: data.tokens.write + sign * write, requests: data.tokens.requests + sign });
    if (kind !== 'none') data.cost[kind] += sign * (kind === 'billed' || kind === 'estimate' ? amount : 1);
  };
  api.on('model_response', response => {
    const summary = api.usage.summarize(response);
    const usage = object(response.usage);
    const reported = object(usage.omd_reported_cost);
    const [kind, amount] = charge(response.cost.basis, response.cost.microusd, number(reported.usd) !== null && typeof reported.basis === 'string' ? { usd: reported.usd, basis: reported.basis } : null);
    const tokens = summary.measured ? summary.tokens : null;
    const now = Date.now();
    update(data => {
      const key = `${response.request_id}#${response.attempt}`;
      const entry: Seen = [tokens?.input ?? 0, tokens?.output ?? 0, tokens?.reasoning ?? 0, tokens?.cached ?? 0, tokens?.cache_write ?? 0, kind as Charge, amount];
      if (data.seen[key]) apply(data, data.seen[key], -1);
      apply(data, entry, 1);
      delete data.seen[key];
      data.seen[key] = entry;
      for (const old of Object.keys(data.seen).slice(0, -64)) delete data.seen[old];
      if (response.scope.kind !== 'main' || response.scope.agent_id || data.thread && response.scope.thread_id !== data.thread) return;
      data.model = { ...data.model, requested: response.requested_model, served: response.served_model, provider: response.provider, billing: kind };
      const used = summary.context?.used ?? (tokens ? (tokens.input ?? 0) + (tokens.output ?? 0) : null);
      if (used !== null) data.context = { ...data.context, used, window: summary.context?.window ?? response.context_window ?? data.context.window, at: now, switched: false };
      const ttl = number(usage.omd_cache_ttl_seconds);
      if (tokens?.input) data.cache = { ratio: (tokens.cached ?? 0) / tokens.input, expires: ttl !== null && (tokens.cached || tokens.cache_write) ? now + ttl * 1000 : data.cache.expires };
    });
    arm();
  });
  api.on('turn_end', () => {
    update(data => {
      data.tools = {};
      if (data.pending && JSON.stringify(config) === JSON.stringify(data.pending.to)) data.pending = null;
    });
    arm();
    refreshGit();
    pollGithub();
    for (const script of configured.scripts) runScript(script.id);
  });
  api.on('compaction_end', ({ outcome }) => {
    if (outcome === 'compacted' || outcome === 'replaced') update(data => { data.context.compactions += 1; data.context.compacted = Date.now(); });
  });
  api.on('agent', ({ agent }) => update(data => {
    data.agents[agent.agent_id ?? agent.thread_id] = agent.status;
    for (const id of Object.keys(data.agents).slice(0, -16)) delete data.agents[id];
  }));
  api.on('tool_call', ({ call_id }) => update(data => {
    data.tools[call_id] = Date.now();
    for (const id of Object.keys(data.tools).slice(0, -16)) delete data.tools[id];
  }));
  api.on('tool_result', ({ call_id, tool }) => {
    update(data => { delete data.tools[call_id]; });
    if (/patch|edit|write|exec|shell/.test(tool)) gitSoon.start();
  });
  api.on('app_notification', ({ method, params, thread_id }) => {
    const update_ = object(params);
    if (method === 'account/updated') return update(data => { data.limits = []; data.credits = null; });
    if (method === 'account/rateLimits/updated') return update(data => limits(data, update_));
    const thread = thread_id ?? update_.threadId ?? null;
    const current = saved().thread;
    if (current !== null && thread !== null && thread !== current) return;
    if (method === 'thread/settings/updated') {
      const next = object(update_.threadSettings);
      let moved = false;
      update(data => {
        const model = typeof next.model === 'string' ? next.model : data.model.requested;
        const provider = typeof next.modelProvider === 'string' ? next.modelProvider : data.model.provider;
        if (model !== data.model.requested || provider !== data.model.provider) data.context.switched = data.context.used !== null;
        data.model = { ...data.model, requested: model, provider, served: model !== data.model.requested ? null : data.model.served, effort: typeof next.effort === 'string' ? next.effort : data.model.effort };
        if (typeof next.cwd === 'string' && next.cwd !== data.cwd) { data.cwd = next.cwd; moved = true; }
      });
      if (moved) refreshAll();
    } else if (method === 'thread/tokenUsage/updated') {
      const size = number(object(update_.tokenUsage).modelContextWindow);
      if (size !== null) update(data => { data.context.window = size; });
    } else if (method === 'thread/reverted') update(data => { data.context.reverted = Date.now(); });
    else if (method === 'turn/plan/updated' && Array.isArray(update_.plan)) {
      const steps = update_.plan.map(object);
      const active = steps.find(step => step.status === 'inProgress' && typeof step.step === 'string');
      update(data => { data.plan = steps.length ? { done: steps.filter(step => step.status === 'completed').length, total: steps.length, step: active ? visible(active.step, 60) : null } : null; });
    }
  });
  api.on('channel', ({ channel, data, publisher }) => {
    if (channel !== 'omd_statusline/refresh') return;
    const sent = object(data);
    if (publisher === 'omd_statusline' && 'pending' in sent) {
      const pending = object(sent.pending);
      update(next => { next.pending = Array.isArray(pending.from) ? { from: pending.from.filter((item: unknown) => typeof item === 'string').slice(-8), to: settings(object(pending.to)) } : null; });
    }
    arm(true);
    refreshAll();
  });

  const editor = (): Editor => {
    const stored = object(api.uiState.get());
    return { open: stored.open === true, draft: settings(object(stored.draft)), selected: typeof stored.selected === 'string' ? stored.selected : null, notice: typeof stored.notice === 'string' ? stored.notice : null };
  };
  const ids = () => [...SEGMENTS, ...configured.scripts.map(script => `script:${script.id}`)];
  const flatten = (draft: Settings) => layout(draft, configured.scripts.map(script => script.id));
  const custom = (draft: Settings): [Settings, string[][]] => [{ ...draft, preset: 'custom', hidden: '' }, flatten(draft)];
  const joined = (lines: string[][]) => lines.filter(line => line.length).map(line => line.join(' ')).join('; ');
  const edit = (state: Editor, verb: string, rest: string[]): Editor => {
    const [first = '', second = ''] = rest;
    if (verb === 'set') {
      const value = rest.slice(1).join(' ');
      const raw: Record<string, Json> = { ...state.draft, [first]: first === 'bars' || first === 'github' ? value === 'true' : first === 'refresh_s' ? Number(value) : value };
      return { ...state, draft: settings(raw), notice: null };
    }
    if (verb === 'pick') return { ...state, selected: ids().includes(first) ? first : state.selected };
    if (verb === 'reset') return { ...state, draft: { ...DEFAULTS }, notice: 'Defaults restored in the preview' };
    const direction = verb === 'move' && (first === 'up' || first === 'down') ? first : second;
    const segment = (direction === first ? '' : first) || state.selected;
    if (!segment || !ids().includes(segment)) return state;
    const [draft, lines] = custom(state.draft);
    const line = lines.findIndex(entry => entry.includes(segment));
    if (verb === 'toggle') {
      if (line >= 0) lines[line] = lines[line].filter(id => id !== segment);
      else (lines.at(-1) ?? (lines[0] = [])).push(segment);
    } else if (verb === 'move' && line >= 0) {
      const index = lines[line].indexOf(segment);
      const target = index + (direction === 'up' ? -1 : 1);
      if (target >= 0 && target < lines[line].length) [lines[line][index], lines[line][target]] = [lines[line][target], lines[line][index]];
    } else if (verb === 'line' && line >= 0) {
      lines[line] = lines[line].filter(id => id !== segment);
      const target = (line + 1) % Math.min(4, Math.max(lines.length, line + 2));
      (lines[target] ??= []).push(segment);
    } else return state;
    return { ...state, draft: { ...draft, layout: joined(lines) }, selected: segment, notice: null };
  };
  const button = (verb: string, text: string): TerminalComponent => ({ type: 'button', id: `omd_statusline_${verb.replace(' ', '_')}`, label: text, text, action: { command: COMMAND, args: verb } });
  const select = (key: keyof Settings, label: string, value: string, options: string[]): TerminalComponent =>
    ({ type: 'select', id: `omd_statusline_${key}`, label, value, options: options.map(option => ({ value: option, label: option })), action: { command: COMMAND, args: `set ${key}` } });
  const dialog = (state: Editor, data: Data, now: number, cwd: string | null): TerminalComponent => {
    const preview = render(data, state.draft, { now, columns: PREVIEW_COLUMNS, cwd, settled: null });
    const lines = flatten(state.draft);
    const rows: TerminalListRow[] = ids().map(id => {
      const at = lines.findIndex(line => line.includes(id));
      return { value: id, label: id, spans: [{ text: at >= 0 ? '● ' : '○ ', tone: at >= 0 ? 'success' : 'muted' }, { text: id }, ...at >= 0 ? [{ text: `  line ${at + 1}`, tone: 'muted' as const }] : []] };
    });
    const problem = configured.error ?? state.notice;
    return { type: 'dialog', id: 'omd_statusline_dialog', label: 'Status line', title: 'Status line', children: [
      { type: 'text', id: 'omd_statusline_preview_label', label: 'Preview', text: `${problem ? `${visible(problem, 200)} · ` : ''}Preview (${state.draft.placement} the composer)`, tone: problem ? 'attention' : 'muted' },
      // One document keeps the dialog's component ids, and so its keyboard focus, stable as the line count changes.
      { type: 'document', id: 'omd_statusline_preview', label: 'Preview', height: Math.max(1, preview.length),
        lines: preview.length ? preview.map(spans => spans.map(({ link: _link, ...span }) => span)) : [[{ text: 'Nothing to show yet: segments appear once their data arrives', tone: 'muted' }]] },
      select('placement', 'Placement', state.draft.placement, ['below', 'above']),
      select('preset', 'Preset', state.draft.preset, ['compact', 'detailed', 'custom']),
      { type: 'list', id: 'omd_statusline_segments', label: 'Segments', rows, selected: state.selected ?? undefined, height: 8, action: { command: COMMAND, args: 'pick' } },
      { type: 'box', id: 'omd_statusline_order', label: 'Order', style: { direction: 'row', gap: 1 }, children: [button('toggle', 'Show/hide'), button('move up', 'Earlier'), button('move down', 'Later'), button('line', 'Next line')] },
      select('glyphs', 'Glyphs', state.draft.glyphs, ['unicode', 'ascii']),
      select('bars', 'Progress bars', String(state.draft.bars), ['true', 'false']),
      { type: 'input', id: 'omd_statusline_thresholds', label: 'Thresholds (warn,alert)', value: state.draft.thresholds, action: { command: COMMAND, args: 'set thresholds' } },
      { type: 'box', id: 'omd_statusline_actions', label: 'Actions', style: { direction: 'row', gap: 1 }, children: [button('apply', 'Apply'), button('cancel', 'Cancel'), button('reset', 'Reset')] },
    ] };
  };

  const HELP = 'usage: /statusline [apply|cancel|reset|github|refresh|toggle SEGMENT|move SEGMENT up|down|line SEGMENT|set KEY VALUE]';
  api.command('edit', input => {
    const [verb = '', ...rest] = String(input ?? '').trim().split(/\s+/).filter(Boolean);
    const state = editor();
    if (verb === 'github') {
      const listed = api.host.tryCall('credentials.list', null);
      const owned = listed.ok ? listed.value.find(item => item.kind === 'secret' && item.origin === GITHUB_ORIGIN) : undefined;
      const asked = api.host.tryCall('credentials.request', owned ? { action: 'refresh', profile: owned.id } : { action: 'enroll', kind: 'secret', label: 'GitHub (status line)', origin: GITHUB_ORIGIN });
      api.host.tryCall('events.publish', { channel: 'refresh', data: null });
      return { display: !asked.ok ? `GitHub token not saved: ${asked.error}` : asked.value.status === 'completed' ? 'GitHub token saved; pull request and CI status refresh now' : 'GitHub token not saved' };
    }
    if (verb === 'refresh') {
      const asked = api.host.tryCall('events.publish', { channel: 'refresh', data: null });
      return { display: asked.ok ? 'Status line refreshing' : `Status line refresh unavailable: ${asked.error}` };
    }
    const show = (next: Editor, display?: string) => {
      api.uiState.set(next as unknown as Json);
      const data = saved();
      return { ...display ? { display } : {}, terminal: contribution(data, next, data.viewport?.columns ?? 120, data.cwd, null) };
    };
    const closed: Editor = { ...state, open: false, notice: null };
    if ((verb === 'cancel' || verb === 'apply') && !state.open) return { display: 'The status line editor is not open; run /statusline' };
    if (verb === 'cancel') return show(closed);
    if (verb === 'apply') {
      const data = saved();
      const current = effective(data);
      const values = Object.fromEntries(Object.entries(state.draft).filter(([key, value]) => current[key as keyof Settings] !== value));
      if (!Object.keys(values).length) return show(closed, 'Status line unchanged');
      const superseded = (data.pending?.from ?? []).filter(item => item !== JSON.stringify(config));
      // The session records the apply through this mod's own channel; writing this mod's settings reloads it,
      // so no host call, durable state or command view may follow a successful write.
      api.host.tryCall('events.publish', { channel: 'refresh', data: { pending: { from: [...superseded, JSON.stringify(config)].slice(-8), to: state.draft } } });
      const written = api.host.tryCall('settings.write', { values });
      if (!written.ok) {
        api.host.tryCall('events.publish', { channel: 'refresh', data: { pending: data.pending } as unknown as Json });
        return show({ ...state, notice: `Not saved: ${written.error}` });
      }
      api.uiState.set(closed as unknown as Json);
      return { display: 'Status line saved' };
    }
    if (verb && !['open', 'set', 'pick', 'toggle', 'move', 'line', 'reset'].includes(verb)) return { display: HELP };
    const base: Editor = state.open ? state : { open: true, draft: effective(saved()), selected: null, notice: null };
    const next = verb && verb !== 'open' ? edit(base, verb, rest) : base;
    // Returning a view reopens the dialog and moves focus to its first control, so an open editor only updates its state.
    if (state.open) {
      api.uiState.set(next as unknown as Json);
      return null;
    }
    return show(next);
  },{ description: 'Edit the status line: placement, preset, segments and order with a live preview', args_hint: '[apply|cancel|reset|github|refresh]' });
  api.on('component_event', event => {
    if (!event.component.startsWith('omd_statusline_')) return;
    const state = editor();
    if (!state.open) return;
    if (event.kind === 'close') return api.uiState.set({ open: false });
    if (event.kind !== 'change' || typeof event.value !== 'string') return;
    const key = event.component.slice('omd_statusline_'.length);
    if (['placement', 'preset', 'glyphs', 'bars', 'thresholds'].includes(key)) api.uiState.set(edit(state, 'set', [key, event.value]) as unknown as Json);
  });

  function contribution(data: Data, state: Editor, columns: number, cwd: string | null, settled: number | null): TerminalPatch {
    const now = Date.now();
    const current = effective(data);
    const lines = render(data, current, { now, columns: columns - 4, cwd, settled }).map((spans, index): TerminalComponent =>
      ({ type: 'line', id: `omd_statusline_line_${index}`, label: 'Status line', spans }));
    const below = current.placement === 'below';
    const box: TerminalComponent[] = lines.length ? [{ type: 'box', id: 'omd_statusline', label: 'Status line', style: { border: 'none', padding: [0, 2] }, children: lines }] : [];
    const site: TerminalRenderSite = { mode: 'wrap', components: below ? [...box, { type: 'slot' }] : [{ type: 'slot' }, ...box] };
    const patch: TerminalPatch = { sites: below ? { below_composer: site } : { above_composer: site } };
    if (state.open) patch.sites!.dialog = { mode: 'wrap', components: [{ type: 'slot' }, dialog(state, data, now, cwd)] };
    return patch;
  }
  api.on('terminal', input => {
    const data = saved();
    const columns = number(input.client?.columns) ?? 120;
    const rows = number(input.client?.rows);
    // Drawing writes durable state only when something it caches changed: mod counts or the viewport.
    // Thread-scoped state can't be written before the session has a thread (the startup event has no ledger).
    const viewport = rows !== null ? { columns, rows } : data.viewport;
    const mods = input.identity?.mods ?? data.mods;
    const changed = JSON.stringify([viewport, mods]) !== JSON.stringify([data.viewport, data.mods]);
    Object.assign(data, { viewport, mods });
    if (changed && input.ledger?.thread_id) api.state.set(data as unknown as Json);
    const settled = number(object(input.ledger?.cost).settled_task_charge_microusd);
    return contribution(data, editor(), columns, input.ledger?.cwd ?? data.cwd, settled === null ? null : settled / 1e6);
  });
}

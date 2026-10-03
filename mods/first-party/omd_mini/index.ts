import type { Json, ModAPI, TerminalPatch } from '../../api.d.ts';

type Mode = 'mini' | 'full';
type Usage = { seq: number; context?: number; window?: number | null };
type Saved = {
  mode: Mode | null; launch: string | null; busy: boolean; started: number | null; took: number | null;
  threads: Record<string, Usage>; seq: number; limit: { used: number; minutes: number | null } | null;
};

const LAUNCH = /^([0-9a-f]{16})\.(\d{1,4})$/;
const THREAD = /^[\w-]{1,64}$/;

export default function activate(api: ModAPI) {
  const saved = (): Saved => ({ mode: null, launch: null, busy: false, started: null, took: null, threads: {}, seq: 0, limit: null, ...api.state.get() as unknown as Saved | null });
  const save = (patch: Partial<Saved>) => api.state.set({ ...saved(), ...patch } as unknown as Json);
  const fit = (text: string, max: number) => [...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text;
  const duration = (ms: number) => {
    const seconds = Math.round(ms / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
  };
  const requestKey = (launch: string | null) => {
    const match = launch ? LAUNCH.exec(launch) : null;
    return match ? { key: `switch_${match[1]}`, run: Number(match[2]) } : null;
  };

  const detect = () => {
    const env = api.host.tryCall('exec.run', { program: 'env', timeout_ms: 2000, max_output_bytes: 8192 });
    const vars = Object.fromEntries((env.ok && env.value.exit_code === 0 ? env.value.stdout : '').split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    const mode = vars.OH_MY_DIFF_PRESENTATION === 'mini' || vars.OH_MY_DIFF_PRESENTATION === 'full' ? vars.OH_MY_DIFF_PRESENTATION : null;
    const launch = mode && LAUNCH.test(vars.OH_MY_DIFF_LAUNCH ?? '') ? vars.OH_MY_DIFF_LAUNCH : null;
    save({ mode, launch, busy: false, started: null });
    // The launcher acts on a request after the run that wrote it exits, so a request left from an earlier run is spent.
    const request = requestKey(launch);
    const old = request ? api.host.tryCall('store.get', { key: request.key, scope: 'user' }) : null;
    if (request && old?.ok && old.value && (old.value.value as { run?: number } | null)?.run !== request.run) api.host.tryCall('store.delete', { key: request.key, expected_revision: old.value.revision, scope: 'user' });
  };
  api.on('start', detect);
  api.on('resume', detect);

  api.on('turn_start', () => { if (saved().mode) save({ busy: true, started: Date.now() }); });
  api.on('turn_end', () => {
    const state = saved();
    if (state.mode) save({ busy: false, started: null, took: state.started === null ? state.took : Date.now() - state.started });
  });

  api.on('app_notification', ({ method, params, thread_id }) => {
    const state = saved();
    if (state.mode !== 'mini') return;
    const update = params as {
      threadId?: string;
      tokenUsage?: { last?: { totalTokens?: number }; modelContextWindow?: number | null };
      rateLimits?: { primary?: { usedPercent?: number; windowDurationMins?: number | null } | null };
    };
    if (method === 'account/rateLimits/updated') {
      const primary = update.rateLimits?.primary;
      if (typeof primary?.usedPercent === 'number') save({ limit: { used: primary.usedPercent, minutes: primary.windowDurationMins ?? null } });
      return;
    }
    const thread = thread_id ?? update.threadId;
    if (!thread || !update.tokenUsage) return;
    const threads = { ...state.threads };
    const usage = threads[thread] = { ...threads[thread], seq: state.seq + 1 };
    Object.assign(usage, { context: update.tokenUsage.last?.totalTokens, window: update.tokenUsage.modelContextWindow ?? null });
    for (const old of Object.keys(threads).sort((a, b) => threads[b].seq - threads[a].seq).slice(8)) delete threads[old];
    save({ threads, seq: state.seq + 1 });
  });

  api.on('terminal', ({ ledger }): TerminalPatch | null => {
    const state = saved();
    if (state.mode !== 'mini') return null;
    const usage = ledger ? state.threads[ledger.thread_id] : undefined;
    const percent = usage?.context && usage.window ? Math.round(usage.context / usage.window * 100) : null;
    const paid = (ledger?.cost as { settled_task_charge_microusd?: number } | null)?.settled_task_charge_microusd;
    const spend = typeof paid === 'number' && paid > 0 ? `$${(paid / 1e6).toFixed(2)}`
      : state.limit ? `${state.limit.minutes ? `${Math.round(state.limit.minutes / 60)}h` : 'limit'} ${state.limit.used}%` : null;
    const line = [state.busy ? 'working' : state.took === null ? null : duration(state.took), percent === null ? null : `ctx ${percent}%`, spend].filter(Boolean).join(' · ');
    return { inline_sites: 'hidden', completed_tools: 'compact', placeholder: 'Ask anything · /omd_mini:switch opens the full UI', status: line ? [fit(line, 40)] : [] };
  });

  api.command('switch', () => {
    const state = saved();
    const target: Mode = state.mode === 'mini' ? 'full' : 'mini';
    if (state.busy) return { display: 'A turn is running; switch once it finishes or after interrupting it with Esc.' };
    const before = api.host.call('store.get', { key: 'thread', scope: 'thread' });
    api.host.call('store.put', { key: 'thread', value: true, expected_revision: before?.revision ?? null, scope: 'thread' });
    const thread = api.host.call('store.get', { key: 'thread', scope: 'thread' })?.provenance.thread_id ?? null;
    if (!thread || !THREAD.test(thread)) return { display: 'This session has no thread to resume yet; send a message first.' };
    const request = requestKey(state.launch);
    if (!request) return { display: `This session was not started by \`omd mini\`. Quit, then run \`${target === 'mini' ? 'omd mini' : 'codex'} resume ${thread}\`.` };
    const old = api.host.call('store.get', { key: request.key, scope: 'user' });
    if ((old?.value as { run?: number } | null)?.run === request.run) {
      api.host.call('store.delete', { key: request.key, expected_revision: old!.revision, scope: 'user' });
      return { display: 'Switch cancelled; quitting now ends `omd mini`.' };
    }
    api.host.call('store.put', { key: request.key, value: { run: request.run, target, thread }, expected_revision: old?.revision ?? null, scope: 'user' });
    return { display: `Quit (/quit or Ctrl+C twice) and \`omd mini\` reopens this session in the ${target} interface. /omd_mini:switch again cancels.` };
  }, { description: 'Switch this session between the mini and the full interface at the next quit' });
}

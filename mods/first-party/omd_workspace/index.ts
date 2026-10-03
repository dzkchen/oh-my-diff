import type { Json, Ledger, ModAPI, TerminalComponent, TerminalRenderSite, TerminalView } from '../../api.d.ts';

type Density = 'full' | 'compact';
type Side = 'left' | 'right';
type Usage = { seq: number; model?: string; effort?: string | null; context?: number; window?: number | null };
type Saved = { activity: string[]; dialog: boolean; turns: number; open: boolean; model: string | null; effort: string | null; usage: Record<string, Usage>; seq: number };

const DENSITIES: Density[] = ['full', 'compact'];
const SIDES: Side[] = ['left', 'right'];
const DEFAULT_REVIEW = 'Review the current candidate and list the remaining risks.';
const KEYS = 'F6 review draft · F7 workspace settings';
const HINTS = 'Tab panels · Enter folds · F6 review · F7 layout';

export default function activate(api: ModAPI) {
  const record = (object: Json | undefined, key: string): Json | undefined =>
    object && typeof object === 'object' && !Array.isArray(object) ? object[key] : undefined;

  const trim = (text: string, width: number) => {
    const chars = [...text];
    return chars.length > width ? `${chars.slice(0, width - 1).join('')}…` : text;
  };

  const saved = (): Saved => {
    const stored = api.state.get();
    return {
      activity: Array.isArray(record(stored, 'activity')) ? (record(stored, 'activity') as Json[]).filter((item): item is string => typeof item === 'string') : [],
      dialog: record(stored, 'dialog') === true,
      turns: typeof record(stored, 'turns') === 'number' ? record(stored, 'turns') as number : 0,
      open: record(stored, 'open') === true,
      model: typeof record(stored, 'model') === 'string' ? record(stored, 'model') as string : null,
      effort: typeof record(stored, 'effort') === 'string' ? record(stored, 'effort') as string : null,
      usage: (record(stored, 'usage') ?? {}) as Record<string, Usage>,
      seq: typeof record(stored, 'seq') === 'number' ? record(stored, 'seq') as number : 0,
    };
  };
  const save = (state: Saved) => api.state.set(state as unknown as Json);

  const setting = <T extends string>(key: string, allowed: T[], fallback: T): T =>
    allowed.find(value => value === api.settings[key]) ?? fallback;
  const review = () => typeof api.settings.review_prompt === 'string' && api.settings.review_prompt.trim() ? api.settings.review_prompt : DEFAULT_REVIEW;

  const note = (state: Saved, entry: string) => ({ ...state, activity: [...state.activity, trim(entry, 60)].slice(-24) });

  const line = (id: string, label: string, text: string, tone: 'normal' | 'accent' | 'success' | 'attention' | 'failure' | 'muted' = 'normal'): TerminalComponent =>
    ({ type: 'text', id, label, text, tone });

  const pane = (id: string, title: string, children: TerminalComponent[], collapsed = false): TerminalComponent =>
    ({ type: 'pane', id, label: `${title} panel`, title, collapsed, children });

  const cost = (ledger: Ledger | null): string | null => {
    const paid = record(ledger?.cost ?? undefined, 'settled_task_charge_microusd');
    const subscription = record(ledger?.cost ?? undefined, 'subscription_list_equivalent_microusd');
    if (typeof paid === 'number' && paid > 0) return `Paid API $${(paid / 1e6).toFixed(2)}`;
    if (typeof subscription === 'number' && subscription > 0) return `Subscription use ≈ $${(subscription / 1e6).toFixed(2)}`;
    return null;
  };

  const dialogSite = (density: Density, side: Side): TerminalRenderSite => ({
    mode: 'replace',
    components: [{
      type: 'dialog',
      id: 'workspace_settings_dialog',
      label: 'Workspace settings',
      title: 'Workspace settings',
      children: [
        { type: 'select', id: 'workspace_density', label: 'Sidebar size', value: density, options: [{ value: 'full', label: 'full' }, { value: 'compact', label: 'compact' }], action: { command: 'omd_workspace:layout', args: 'density' } },
        { type: 'select', id: 'workspace_side', label: 'Sidebar side', value: side, options: SIDES.map(value => ({ value, label: value })), action: { command: 'omd_workspace:layout', args: 'side' } },
        { type: 'input', id: 'workspace_review', label: 'Review prompt (F6)', value: review(), placeholder: DEFAULT_REVIEW, action: { command: 'omd_workspace:layout', args: 'review' } },
        { type: 'text', id: 'workspace_keys', label: 'Workspace keys', text: KEYS, tone: 'muted' },
        { type: 'button', id: 'workspace_close', label: 'Close workspace settings', text: 'Close', action: { command: 'omd_workspace:layout', args: 'close' } },
      ],
    }],
  });

  const tokens = (count: number) => count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);

  const view = (event: string, ledger: Ledger | null): TerminalView => {
    const state = saved();
    const density = setting('density', DENSITIES, 'full');
    const side = setting('side', SIDES, 'left');
    const width = density === 'compact' ? 24 : 36;
    const activity = state.activity.length ? state.activity : ['Waiting for the first turn'];
    const spent = cost(ledger);
    const usage = ledger ? state.usage[ledger.thread_id] : undefined;
    const model = usage?.model ?? state.model;
    const effort = usage?.model ? usage.effort : state.effort;
    const percent = usage?.context && usage.window ? Math.round(usage.context / usage.window * 100) : null;
    const session = [
      ...(model ? [line('workspace_model', 'Model and reasoning', trim(`${model}${effort ? ` · ${effort}` : ''}`, width))] : []),
      ...(percent === null ? [] : [line('workspace_context', 'Context used', `Context ${percent}% of ${tokens(usage?.window ?? 0)}`, percent >= 90 ? 'failure' : percent >= 70 ? 'attention' : 'muted')]),
      ...(spent ? [line('workspace_task_cost', 'Session cost', spent, 'muted')] : []),
    ];
    const sidebar = [
      ...(session.length ? [pane('workspace_task', 'Session', session)] : []),
      pane('workspace_activity', 'Activity', activity.slice(-(density === 'compact' ? 6 : 10)).map((entry, index) => line(`workspace_activity_${index}`, `Activity ${index + 1}`, entry, 'muted')), density === 'compact'),
    ];
    const working = state.open || event === 'turn_start';
    const sites: Partial<Record<'sidebar' | 'header' | 'dialog', TerminalRenderSite>> = {
      sidebar: { mode: 'replace', components: sidebar },
      header: { mode: 'replace', components: [{ type: 'line', id: 'workspace_header', label: 'Session state and shortcuts', spans: [
        { text: working ? 'Working' : 'Ready', tone: working ? 'accent' : 'muted', bold: true }, { text: `  ${HINTS}`, tone: 'muted' }] }] },
    };
    if (state.dialog) sites.dialog = dialogSite(density, side);
    return {
      title: 'Oh My Diff',
      sidebar_side: side,
      sidebar_width: density === 'compact' ? 28 : 40,
      sites,
      keybindings: {
        F6: { insert: review() },
        F7: { command: 'omd_workspace:layout', args: 'dialog' },
      },
    };
  };

  api.replace('terminal', ({ event, ledger }) => view(event, ledger));

  const write = (values: { [key: string]: Json }, done: string) => {
    const written = api.host.tryCall('settings.write', { values });
    return { display: written.ok ? done : `Workspace settings unchanged: ${written.error}` };
  };

  api.command(
    'layout',
    argument => {
      const requested = typeof argument === 'string' ? argument.trim() : '';
      const state = saved();
      const density = setting('density', DENSITIES, 'full');
      const side = setting('side', SIDES, 'left');
      if (requested === 'dialog') {
        save({ ...state, dialog: !state.dialog });
        return null;
      }
      if (requested === 'close') {
        save({ ...state, dialog: false });
        return null;
      }
      if (requested.startsWith('review ')) {
        const text = requested.slice('review '.length).trim();
        return text ? write({ review_prompt: text }, 'Review prompt saved') : { display: 'The review prompt cannot be empty' };
      }
      // Dialog selects send `density VALUE`/`side VALUE`; a bare `density`/`side` toggles.
      const [head, choice] = requested.split(/\s+/, 2);
      const pick = <T extends string>(key: string, allowed: T[], current: T): T | undefined =>
        head === key
          ? allowed.find(value => choice === undefined ? value !== current : value === choice)
          : choice === undefined ? allowed.find(value => value === head) : undefined;
      const nextDensity = pick('density', DENSITIES, density);
      if (nextDensity) return write({ density: nextDensity }, `Sidebar size: ${nextDensity}`);
      const nextSide = pick('side', SIDES, side);
      if (nextSide) return write({ side: nextSide }, `Sidebar on the ${nextSide}`);
      return { display: `usage: /omd_workspace:layout full|compact|left|right|dialog|close|review TEXT (now ${density}, ${side})` };
    },
    { description: 'Change the workspace sidebar or open its settings (F7)' },
  );

  api.command(
    'activity',
    () => ({ display: saved().activity.slice(-12).join('\n') || 'No activity in this session yet' }),
    { description: 'Show this session\'s workspace activity' },
  );

  const configured = (state: Saved): Saved => {
    const config = api.host.tryCall('app.request', { method: 'config/read', params: {} });
    const values = config.ok ? (config.value as { config?: { model?: string; model_reasoning_effort?: string } }).config : undefined;
    return { ...state, model: values?.model ?? null, effort: values?.model_reasoning_effort ?? null };
  };
  api.on('start', () => save(note(configured(saved()), 'Session started')));
  api.on('resume', () => save(note(configured(saved()), 'Session resumed')));
  api.on('app_notification', ({ method, params, thread_id }) => {
    const update = params as { threadId?: string; threadSettings?: { model?: string; effort?: string | null }; tokenUsage?: { last?: { totalTokens?: number }; modelContextWindow?: number | null } };
    const thread = thread_id ?? update.threadId;
    if (!thread || !update.threadSettings && !update.tokenUsage) return;
    const state = saved();
    const usage = { ...state.usage };
    const entry = usage[thread] = { ...usage[thread], seq: state.seq + 1 };
    if (method === 'thread/settings/updated' && update.threadSettings) Object.assign(entry, { model: update.threadSettings.model, effort: update.threadSettings.effort ?? null });
    if (method === 'thread/tokenUsage/updated' && update.tokenUsage) Object.assign(entry, { context: update.tokenUsage.last?.totalTokens, window: update.tokenUsage.modelContextWindow ?? null });
    for (const old of Object.keys(usage).sort((a, b) => usage[b].seq - usage[a].seq).slice(8)) delete usage[old];
    save({ ...state, usage, seq: state.seq + 1 });
  });
  api.on('turn_start', () => {
    const state = saved();
    const interrupted = state.open ? note(state, `◂ Turn ${state.turns} interrupted`) : state;
    save({ ...note(interrupted, `▸ Turn ${state.turns + 1} started`), turns: state.turns + 1, open: true });
  });
  api.on('turn_end', ({ outcome }) => {
    const state = saved();
    const word = outcome === 'aborted' ? 'interrupted' : outcome === 'error' ? 'failed' : 'completed';
    save({ ...note(state, `◂ Turn ${state.turns} ${word}`), open: false });
  });
  api.on('tool_result', event => {
    const tool = record(event, 'tool');
    save(note(saved(), `  ran ${typeof tool === 'string' ? tool : 'a tool'}`));
  });
  api.on('agent_end', ({ role, status }) => save(note(saved(), `  ${role} agent ${status}`)));
  api.on('compaction_end', () => save(note(saved(), '  conversation compacted')));
}

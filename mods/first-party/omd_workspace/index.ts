import type { Json, ModAPI, TerminalComponent, TerminalRenderSite, TerminalView } from '../../api.d.ts';

type Density = 'full' | 'compact';
type Side = 'left' | 'right';
type Saved = { activity: string[]; density: Density | null; side: Side | null; dialog: boolean; review: string | null };

const DENSITIES: Density[] = ['full', 'compact'];
const SIDES: Side[] = ['left', 'right'];

export default function activate(api: ModAPI) {
  const record = (object: Json | undefined, key: string): Json | undefined =>
    object && typeof object === 'object' && !Array.isArray(object) ? object[key] : undefined;

  const texts = (value: Json | undefined): string[] =>
    Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];

  const trim = (text: string, width: number) =>
    text.length > width ? `${text.slice(0, width - 1)}…` : text;

  const saved = (): Saved => {
    const stored = api.state.get();
    return {
      activity: texts(record(stored, 'activity')),
      density: DENSITIES.find(value => value === record(stored, 'density')) ?? null,
      side: SIDES.find(value => value === record(stored, 'side')) ?? null,
      dialog: record(stored, 'dialog') === true,
      review: typeof record(stored, 'review') === 'string' ? String(record(stored, 'review')) : null,
    };
  };

  const setting = <T extends string>(key: string, allowed: T[]): T | null =>
    allowed.find(value => value === api.settings[key]) ?? null;

  const note = (entry: string) => {
    const state = saved();
    api.state.set({ ...state, activity: [...state.activity, trim(entry, 60)].slice(-24) });
  };

  const line = (id: string, label: string, text: string, tone: 'normal' | 'accent' | 'success' | 'attention' | 'failure' | 'muted' = 'normal'): TerminalComponent =>
    ({ type: 'text', id, label, text, tone });

  const pane = (id: string, title: string, children: TerminalComponent[], collapsed = false): TerminalComponent =>
    ({ type: 'pane', id, label: `${title} panel`, title, collapsed, children });

  const taskPane = (checkpoint: Json): TerminalComponent => {
    const status = record(checkpoint, 'task_status');
    const objective = record(checkpoint, 'objective');
    const live = record(record(checkpoint, 'live'), 'workspace_sha256');
    return pane('workspace_task', 'Task', [
      line('workspace_task_status', 'Task status', `status  ${typeof status === 'string' ? status : 'no active task'}`, 'accent'),
      line('workspace_task_goal', 'Task objective', `goal    ${trim(typeof objective === 'string' ? objective : 'none', 52)}`),
      line('workspace_task_tree', 'Workspace version', `tree    ${typeof live === 'string' ? live.slice(0, 12) : 'unknown'}`, 'muted'),
    ]);
  };

  const remainingPane = (checkpoint: Json): TerminalComponent => {
    const remaining = texts(record(checkpoint, 'remaining_work'));
    const done = record(checkpoint, 'completed_acceptance');
    const count = Array.isArray(done) ? done.length : 0;
    return pane(
      'workspace_remaining',
      `Remaining (${remaining.length} open, ${count} accepted)`,
      remaining.length
        ? remaining.slice(0, 8).map((item, index) => line(`workspace_remaining_${index}`, `Remaining item ${index + 1}`, `· ${trim(item, 54)}`))
        : [line('workspace_remaining_empty', 'No remaining work', '· nothing outstanding', 'success')],
    );
  };

  const workerPane = (checkpoint: Json): TerminalComponent => {
    const workers = record(checkpoint, 'workers');
    const archived = record(checkpoint, 'archived_workers');
    const live = Array.isArray(workers) ? workers : [];
    const children = live.length
      ? live.slice(0, 8).map((worker, index) => {
          const role = record(worker, 'objective') ?? record(worker, 'role');
          const status = record(worker, 'status');
          return line(
            `workspace_worker_${index}`,
            `Worker ${index + 1}`,
            `· ${trim(`${typeof status === 'string' ? status : '?'} ${typeof role === 'string' ? role : ''}`, 54)}`,
            status === 'failed' ? 'failure' : status === 'completed' ? 'success' : 'normal',
          );
        })
      : [line('workspace_workers_empty', 'No live workers', '· none spawned', 'muted')];
    return pane('workspace_workers', `Workers (${live.length} live, ${typeof archived === 'number' ? archived : 0} archived)`, children);
  };

  const allowancePane = (checkpoint: Json): TerminalComponent => {
    const allowance = record(checkpoint, 'allowance');
    const requests = record(allowance, 'requests_remaining');
    const seconds = record(allowance, 'seconds_remaining');
    const exposure = record(allowance, 'exposure_remaining_microusd');
    return pane('workspace_allowance', 'Allowance', [
      line('workspace_allowance_requests', 'Requests remaining', `requests ${typeof requests === 'number' ? requests : '—'}`),
      line('workspace_allowance_seconds', 'Seconds remaining', `seconds  ${typeof seconds === 'number' ? seconds : '—'}`),
      line('workspace_allowance_budget', 'Budget remaining', `budget   ${typeof exposure === 'number' ? `$${(exposure / 1_000_000).toFixed(2)}` : '—'}`),
    ]);
  };

  const dialogSite = (density: Density, side: Side, review: string): TerminalRenderSite => ({
    mode: 'replace',
    components: [{
      type: 'dialog',
      id: 'workspace_settings_dialog',
      label: 'Workspace settings',
      title: 'Workspace settings',
      children: [{
        type: 'box',
        id: 'workspace_settings_box',
        label: 'Workspace layout controls',
        title: 'Layout',
        children: [
          { type: 'select', id: 'workspace_density', label: 'Workspace density', value: density, options: DENSITIES.map(value => ({ value, label: value })), action: { command: 'omd_workspace:layout', args: 'density' } },
          { type: 'select', id: 'workspace_side', label: 'Sidebar side', value: side, options: SIDES.map(value => ({ value, label: value })), action: { command: 'omd_workspace:layout', args: 'side' } },
          { type: 'input', id: 'workspace_review', label: 'Review prompt', value: review, placeholder: 'Review the current candidate', action: { command: 'omd_workspace:layout', args: 'review' } },
          { type: 'button', id: 'workspace_copy_keys', label: 'Copy workspace shortcuts', text: 'Copy shortcuts', action: { copy: 'F6 draft · Alt+r send · Alt+w density · Alt+s side · F8 settings', label: 'workspace shortcuts' } },
          { type: 'button', id: 'workspace_close', label: 'Close workspace settings', text: 'Close', action: { command: 'omd_workspace:layout', args: 'close' } },
        ],
      },
      { type: 'markdown', id: 'workspace_settings_help', label: 'Workspace settings help', text: '**Keyboard:** Tab moves focus, arrows change a selector, Enter activates, and native cancellation keys remain reserved.' },
      { type: 'code', id: 'workspace_settings_example', label: 'Workspace settings example', language: 'json', text: `{"density":"${density}","side":"${side}"}` },
      ],
    }],
  });

  const view = (event: string, checkpoint: Json): TerminalView => {
    const state = saved();
    const density = state.density ?? setting('density', DENSITIES) ?? 'full';
    const side = state.side ?? setting('side', SIDES) ?? 'left';
    const activity = state.activity.length ? state.activity : ['· waiting for the first turn'];
    const review = state.review ?? (typeof api.settings.review_prompt === 'string'
      ? api.settings.review_prompt
      : 'Review the current candidate and list the remaining risks.');
    const sidebar = density === 'compact'
      ? [taskPane(checkpoint), pane('workspace_activity', 'Activity', activity.slice(-6).map((entry, index) => line(`workspace_activity_${index}`, `Activity ${index + 1}`, entry, 'muted')), true)]
      : [
          taskPane(checkpoint),
          remainingPane(checkpoint),
          workerPane(checkpoint),
          allowancePane(checkpoint),
          pane('workspace_activity', 'Activity', activity.slice(-10).map((entry, index) => line(`workspace_activity_${index}`, `Activity ${index + 1}`, entry, 'muted')), true),
        ];
    const sites: Partial<Record<'sidebar' | 'header' | 'above_composer' | 'dialog', TerminalRenderSite>> = {
      sidebar: { mode: 'replace', components: sidebar },
      header: { mode: 'replace', components: [line('workspace_header', 'Workspace state', `${density} · ${side} sidebar · ${trim(event, 24)}`, 'accent')] },
      above_composer: { mode: 'replace', components: [line('workspace_shortcuts', 'Workspace shortcuts', 'F6 draft · Alt+r send · Alt+w density · Alt+s side · F8 settings', 'muted')] },
    };
    if (state.dialog) sites.dialog = dialogSite(density, side, review);
    return {
      title: 'Oh My Diff workspace',
      sidebar_side: side,
      sidebar_width: density === 'compact' ? 28 : 40,
      sites,
      status: [`omd:${density}`],
      keybindings: {
        F6: review,
        F8: { command: 'omd_workspace:layout', args: 'dialog' },
        'Alt+r': { submit: review },
        'Alt+w': { command: 'omd_workspace:layout', args: 'density' },
        'Alt+s': { command: 'omd_workspace:layout', args: 'side' },
      },
      message_template: '│ {text}',
      tool_template: '› {text}',
    };
  };

  api.replace('terminal', ({ event, checkpoint }) => view(event, checkpoint));

  api.command(
    'layout',
    argument => {
      const requested = typeof argument === 'string' ? argument.trim() : '';
      const state = saved();
      const density = state.density ?? setting('density', DENSITIES) ?? 'full';
      const side = state.side ?? setting('side', SIDES) ?? 'left';
      if (requested === 'dialog') {
        api.state.set({ ...state, dialog: !state.dialog });
        return { display: `workspace settings ${state.dialog ? 'closed' : 'opened'}` };
      }
      if (requested === 'close') {
        api.state.set({ ...state, dialog: false });
        return { display: 'workspace settings closed' };
      }
      if (requested.startsWith('review ')) {
        const review = requested.slice('review '.length).trim();
        if (!review) return { display: 'review prompt cannot be empty' };
        api.state.set({ ...state, review });
        return { display: 'workspace review prompt updated' };
      }
      if (requested === 'density' || DENSITIES.some(value => value === requested)) {
        const next = requested === 'density' ? (density === 'full' ? 'compact' : 'full') : requested as Density;
        api.state.set({ ...state, density: next });
        return { display: `workspace density is now ${next}` };
      }
      if (requested === 'side' || SIDES.some(value => value === requested)) {
        const next = requested === 'side' ? (side === 'left' ? 'right' : 'left') : requested as Side;
        api.state.set({ ...state, side: next });
        return { display: `workspace sidebar is now on the ${next}` };
      }
      return { display: `usage: /omd_workspace:layout full|compact|left|right|density|side|dialog|close|review TEXT (now ${density}, ${side})` };
    },
    { description: 'Switch the workspace layout or open its settings' },
  );

  api.command(
    'activity',
    () => ({ display: saved().activity.slice(-12).join('\n') || 'no activity recorded yet' }),
    { description: 'Show the workspace activity this mod recorded' },
  );

  api.on('start', () => note('· session started'));
  api.on('resume', () => note('· session resumed'));
  api.on('turn_start', ({ turn_id }) => note(`▸ turn ${turn_id.slice(0, 8)}`));
  api.on('turn_end', ({ turn_id, outcome }) => note(`◂ turn ${turn_id.slice(0, 8)} ${outcome}`));
  api.on('tool_result', event => {
    const tool = record(event, 'tool');
    note(`  ran ${typeof tool === 'string' ? tool : 'tool'}`);
  });
  api.on('agent_end', ({ role, status }) => note(`  agent ${role} ${status}`));
  api.on('compaction_end', ({ trigger }) => note(`  compacted (${trigger})`));
}

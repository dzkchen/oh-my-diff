import type { Json, ModAPI, Panel, TerminalView } from '../../api.d.ts';

type Density = 'full' | 'compact';
type Side = 'left' | 'right';
type Saved = { activity: string[]; density: Density | null; side: Side | null };

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
    };
  };

  const setting = <T extends string>(key: string, allowed: T[]): T | null =>
    allowed.find(value => value === api.settings[key]) ?? null;

  const note = (entry: string) => {
    const state = saved();
    api.state.set({ ...state, activity: [...state.activity, trim(entry, 60)].slice(-24) });
  };

  const taskPanel = (checkpoint: Json): Panel => {
    const status = record(checkpoint, 'task_status');
    const objective = record(checkpoint, 'objective');
    const live = record(record(checkpoint, 'live'), 'workspace_sha256');
    return {
      title: 'Task',
      lines: [
        `status  ${typeof status === 'string' ? status : 'no active task'}`,
        `goal    ${trim(typeof objective === 'string' ? objective : 'none', 52)}`,
        `tree    ${typeof live === 'string' ? live.slice(0, 12) : 'unknown'}`,
      ],
    };
  };

  const remainingPanel = (checkpoint: Json): Panel => {
    const remaining = texts(record(checkpoint, 'remaining_work'));
    const done = record(checkpoint, 'completed_acceptance');
    const count = Array.isArray(done) ? done.length : 0;
    return {
      title: `Remaining (${remaining.length} open, ${count} accepted)`,
      lines: remaining.length
        ? remaining.slice(0, 8).map(item => `· ${trim(item, 54)}`)
        : ['· nothing outstanding'],
    };
  };

  const workerPanel = (checkpoint: Json): Panel => {
    const workers = record(checkpoint, 'workers');
    const archived = record(checkpoint, 'archived_workers');
    const live = Array.isArray(workers) ? workers : [];
    return {
      title: `Workers (${live.length} live, ${typeof archived === 'number' ? archived : 0} archived)`,
      lines: live.length
        ? live.slice(0, 8).map(worker => {
            const role = record(worker, 'objective') ?? record(worker, 'role');
            const status = record(worker, 'status');
            return `· ${trim(`${typeof status === 'string' ? status : '?'} ${typeof role === 'string' ? role : ''}`, 54)}`;
          })
        : ['· none spawned'],
    };
  };

  const allowancePanel = (checkpoint: Json): Panel => {
    const allowance = record(checkpoint, 'allowance');
    const requests = record(allowance, 'requests_remaining');
    const seconds = record(allowance, 'seconds_remaining');
    const exposure = record(allowance, 'exposure_remaining_microusd');
    return {
      title: 'Allowance',
      lines: [
        `requests ${typeof requests === 'number' ? requests : '—'}`,
        `seconds  ${typeof seconds === 'number' ? seconds : '—'}`,
        `budget   ${typeof exposure === 'number' ? `$${(exposure / 1_000_000).toFixed(2)}` : '—'}`,
      ],
    };
  };

  const view = (event: string, checkpoint: Json): TerminalView => {
    const state = saved();
    const density = state.density ?? setting('density', DENSITIES) ?? 'full';
    const side = state.side ?? setting('side', SIDES) ?? 'left';
    const activity = state.activity.length ? state.activity : ['· waiting for the first turn'];
    const panels =
      density === 'compact'
        ? [taskPanel(checkpoint), { title: 'Activity', lines: activity.slice(-6) }]
        : [
            taskPanel(checkpoint),
            remainingPanel(checkpoint),
            workerPanel(checkpoint),
            allowancePanel(checkpoint),
            { title: 'Activity', lines: activity.slice(-10) },
          ];
    const review =
      typeof api.settings.review_prompt === 'string'
        ? api.settings.review_prompt
        : 'Review the current candidate and list the remaining risks.';
    return {
      title: 'Oh My Diff workspace',
      sidebar_side: side,
      sidebar_width: density === 'compact' ? 28 : 40,
      panels,
      header: { title: 'Workspace', lines: [`${density} · ${side} sidebar · ${trim(event, 24)}`] },
      footer: { title: 'Keys', lines: ['F6 draft review · Alt+r send review · Alt+w toggle density'] },
      status: [`omd:${density}`],
      theme: {
        accent: 81,
        user_message_background: '#1f2a33',
        success: 78,
        attention: 214,
        failure: '#ff5f5f',
        ...(typeof api.settings.syntax === 'string' ? { syntax: api.settings.syntax } : {}),
      },
      keybindings: {
        F6: review,
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
      if (requested === 'density' || DENSITIES.some(value => value === requested)) {
        const next =
          requested === 'density' ? (density === 'full' ? 'compact' : 'full') : (requested as Density);
        api.state.set({ ...state, density: next });
        return { display: `workspace density is now ${next}` };
      }
      if (requested === 'side' || SIDES.some(value => value === requested)) {
        const next = requested === 'side' ? (side === 'left' ? 'right' : 'left') : (requested as Side);
        api.state.set({ ...state, side: next });
        return { display: `workspace sidebar is now on the ${next}` };
      }
      return { display: `usage: /omd_workspace:layout full|compact|left|right|density|side (now ${density}, ${side})` };
    },
    { description: 'Switch the workspace sidebar density or side' },
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

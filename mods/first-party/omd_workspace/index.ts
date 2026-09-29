import type { Json, Ledger, ModAPI, TerminalComponent, TerminalRenderSite, TerminalView } from '../../api.d.ts';

type Density = 'full' | 'compact';
type Side = 'left' | 'right';
type Saved = { activity: string[]; density: Density | null; side: Side | null; dialog: boolean; review: string | null };

const DENSITIES: Density[] = ['full', 'compact'];
const SIDES: Side[] = ['left', 'right'];

export default function activate(api: ModAPI) {
  const record = (object: Json | undefined, key: string): Json | undefined =>
    object && typeof object === 'object' && !Array.isArray(object) ? object[key] : undefined;

  const trim = (text: string, width: number) =>
    text.length > width ? `${text.slice(0, width - 1)}…` : text;

  const saved = (): Saved => {
    const stored = api.state.get();
    return {
      activity: Array.isArray(record(stored, 'activity')) ? (record(stored, 'activity') as Json[]).filter((item): item is string => typeof item === 'string') : [],
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

  const taskPane = (ledger: Ledger | null): TerminalComponent => pane('workspace_task', 'Session', [
    line('workspace_task_thread', 'Session thread', `thread  ${ledger?.thread_id?.slice(0, 12) ?? 'unavailable'}`, 'accent'),
    line('workspace_task_cost', 'Session cost', `cost    ${ledger?.cost === null || ledger?.cost === undefined ? 'unavailable' : trim(JSON.stringify(ledger.cost), 52)}`, 'muted'),
  ]);

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

  const view = (event: string, ledger: Ledger | null): TerminalView => {
    const state = saved();
    const density = state.density ?? setting('density', DENSITIES) ?? 'full';
    const side = state.side ?? setting('side', SIDES) ?? 'left';
    const activity = state.activity.length ? state.activity : ['· waiting for the first turn'];
    const review = state.review ?? (typeof api.settings.review_prompt === 'string'
      ? api.settings.review_prompt
      : 'Review the current candidate and list the remaining risks.');
    const sidebar = [taskPane(ledger), pane('workspace_activity', 'Activity', activity.slice(-(density === 'compact' ? 6 : 10)).map((entry, index) => line(`workspace_activity_${index}`, `Activity ${index + 1}`, entry, 'muted')), density === 'compact')];
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

  api.replace('terminal', ({ event, ledger }) => view(event, ledger));

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
      // Keybindings send a bare `density`/`side` to toggle; dialog selects send `density VALUE`/`side VALUE`.
      const [head, choice] = requested.split(/\s+/, 2);
      const pick = <T extends string>(key: string, allowed: T[], current: T): T | undefined =>
        head === key
          ? allowed.find(value => choice === undefined ? value !== current : value === choice)
          : choice === undefined ? allowed.find(value => value === head) : undefined;
      const nextDensity = pick('density', DENSITIES, density);
      if (nextDensity) {
        api.state.set({ ...state, density: nextDensity });
        return { display: `workspace density is now ${nextDensity}` };
      }
      const nextSide = pick('side', SIDES, side);
      if (nextSide) {
        api.state.set({ ...state, side: nextSide });
        return { display: `workspace sidebar is now on the ${nextSide}` };
      }
      return { display: `usage: /omd_workspace:layout full|compact|left|right|density [full|compact]|side [left|right]|dialog|close|review TEXT (now ${density}, ${side})` };
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

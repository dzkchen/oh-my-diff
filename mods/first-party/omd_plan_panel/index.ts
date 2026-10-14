import type { Json, ModAPI, TerminalComponent, TerminalPatch, TerminalTone } from '../../api.d.ts';

type Status = 'pending' | 'inProgress' | 'completed';
type Step = { step: string; status: Status };
type State = { plans: Record<string, { steps: Step[]; seq: number }>; seq: number };
type View = { collapsed: boolean; all: boolean };

const THREADS = 16;
const STEPS = 40;
const GLYPH: Record<Status, string> = { pending: '○', inProgress: '◐', completed: '✓' };
const TONE: Record<Status, TerminalTone> = { pending: 'normal', inProgress: 'accent', completed: 'muted' };

function fit(steps: Step[], rows: number): { shown: Step[]; hidden: Step[] } {
  if (steps.length <= rows) return { shown: steps, hidden: [] };
  const room = Math.max(1, rows - 1);
  const dropped = new Set(steps.filter(step => step.status === 'completed').slice(0, steps.length - room));
  const shown = steps.filter(step => !dropped.has(step)).slice(0, room);
  return { shown, hidden: steps.filter(step => !shown.includes(step)) };
}

export default function activate(api: ModAPI) {
  const load = (): State => ({ plans: {}, seq: 0, ...(api.state.get() as Partial<State> | null) });
  const save = (state: State) => api.state.set(state as unknown as Json);
  const view = (): View => ({ collapsed: false, all: false, ...(api.uiState.get() as Partial<View> | null) });
  const rows = Math.max(2, Math.min(40, Number(api.settings.rows) || 8));

  api.on('app_notification', ({ method, params, thread_id }) => {
    const update = params as { threadId?: string; plan?: { step?: unknown; status?: unknown }[] };
    const thread = thread_id ?? update.threadId;
    if (!thread) return;
    const state = load();
    if (method === 'turn/plan/updated') {
      const steps = (update.plan ?? []).slice(0, STEPS).map(item => ({
        step: [...String(item.step ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')].slice(0, 120).join(''),
        status: (Object.hasOwn(GLYPH, String(item.status)) ? item.status : 'pending') as Status,
      }));
      state.plans[thread] = { steps, seq: ++state.seq };
      for (const old of Object.keys(state.plans).sort((a, b) => state.plans[b].seq - state.plans[a].seq).slice(THREADS)) delete state.plans[old];
    } else if (method === 'turn/started' && state.plans[thread]?.steps.every(step => step.status === 'completed')) delete state.plans[thread];
    else return;
    save(state);
  });

  api.command('todos', value => {
    const current = view();
    if (String(value ?? '').trim() === 'toggle') current.collapsed = !current.collapsed;
    else current.all = !current.all;
    api.uiState.set(current as unknown as Json);
    return null;
  }, { description: 'Toggle the plan panel between its row limit and every step (Alt+p collapses it)' });

  api.on('terminal', ({ ledger }): TerminalPatch | null => {
    const steps = ledger ? load().plans[ledger.thread_id]?.steps ?? [] : [];
    const state = view();
    if (!steps.length) return null;
    const done = steps.filter(step => step.status === 'completed').length;
    const line = (id: string, label: string, spans: { text: string; tone?: TerminalTone }[]): TerminalComponent => ({ type: 'line', id: `omd_plan_panel_${id}`, label, spans });
    const open = done < steps.length;
    const components = [line('heading', 'Plan progress', [{ text: `${open ? '●' : '○'} Plan (${done}/${steps.length})`, tone: open ? 'accent' : 'muted' }])];
    if (state.collapsed) components.push(line('hint', 'Collapsed plan', [{ text: '└─ Alt+p to expand', tone: 'muted' }]));
    else {
      const { shown, hidden } = fit(steps, state.all ? STEPS : rows);
      const closed = hidden.filter(step => step.status === 'completed').length;
      const rest = hidden.length ? [{ step: `+${hidden.length} more (${closed} completed, ${hidden.length - closed} pending)`, status: 'more' as const }] : [];
      [...shown, ...rest].forEach((step, index, all) => {
        const prefix = index === all.length - 1 ? '└─ ' : '├─ ';
        components.push(line(`step_${index}`, `Step ${index + 1}`, step.status === 'more'
          ? [{ text: `${prefix}${step.step}`, tone: 'muted' }]
          : [{ text: `${prefix}${GLYPH[step.status]} `, tone: TONE[step.status] }, { text: step.step, tone: step.status === 'pending' ? 'normal' : TONE[step.status] }]));
      });
    }
    return { sites: { above_composer: { mode: 'wrap', components: [...components, { type: 'slot' }] } }, keybindings: { 'Alt+p': { command: 'omd_plan_panel:todos', args: 'toggle' } } };
  });
}

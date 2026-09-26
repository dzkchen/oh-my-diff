import type { Json, ModAPI, TerminalSelectionEvent, TerminalSelectionPolicy, TerminalSelectionSource } from '../../api.d.ts';

type Saved = { copy: boolean | null; sources: TerminalSelectionSource[] | null; min: number | null; last: string | null; detail: string | null };

const SOURCES: TerminalSelectionSource[] = ['transcript', 'composer', 'pager'];
const SHORT: Record<string, string> = { policy_off: 'off here', too_short: 'too short', clipboard_unavailable: 'unconfirmed', clipboard_failed: 'failed' };
const REASONS: Record<string, string> = {
  policy_off: 'not copied (off here)',
  too_short: 'not copied (too short)',
  clipboard_unavailable: 'copy unconfirmed',
  clipboard_failed: 'copy failed',
};

export default function activate(api: ModAPI) {
  const field = (object: Json, key: string): Json | undefined =>
    object && typeof object === 'object' && !Array.isArray(object) ? object[key] : undefined;

  const saved = (): Saved => {
    const stored = api.state.get();
    const sources = field(stored, 'sources');
    const min = field(stored, 'min');
    const copy = field(stored, 'copy');
    const last = field(stored, 'last');
    const detail = field(stored, 'detail');
    return {
      copy: typeof copy === 'boolean' ? copy : null,
      sources: Array.isArray(sources) ? SOURCES.filter(source => sources.includes(source)) : null,
      min: typeof min === 'number' ? min : null,
      last: typeof last === 'string' ? last : null,
      detail: typeof detail === 'string' ? detail : null,
    };
  };

  const clamp = (value: number) => Math.min(10_000, Math.max(1, Math.floor(value)));

  const policy = (): Required<TerminalSelectionPolicy> => {
    const state = saved();
    const setting = typeof api.settings.min_chars === 'number' ? api.settings.min_chars : 1;
    return {
      copy_on_release: state.copy ?? api.settings.copy_on_release !== false,
      sources: state.sources ?? [],
      min_chars: clamp(state.min ?? setting),
    };
  };

  const describe = (current: Required<TerminalSelectionPolicy>) => {
    if (!current.copy_on_release) return 'copy-on-highlight off';
    const where = current.sources.length ? current.sources.join(', ') : 'everywhere';
    return `copy-on-highlight on (${where}, at least ${current.min_chars} ${current.min_chars === 1 ? 'character' : 'characters'})`;
  };

  api.on('terminal', () => {
    const current = policy();
    const last = saved().last;
    return { selection: current, status: [!current.copy_on_release ? 'copy off' : last ?? 'copy on'] };
  });

  api.on('selection', (event: TerminalSelectionEvent) => {
    const state = saved();
    const summary = event.copied ? `copy ok ${event.chars}` : `copy ${SHORT[event.reason ?? ''] ?? 'skipped'}`;
    api.state.set({ ...state, last: summary, detail: event.copied ? `copied ${event.chars} ${event.chars === 1 ? 'character' : 'characters'} from the ${event.source}` : `${REASONS[event.reason ?? ''] ?? 'not copied'} in the ${event.source}` });
  });

  api.command(
    'policy',
    argument => {
      const words = (typeof argument === 'string' ? argument.trim() : '').split(/\s+/).filter(Boolean);
      const state = saved();
      const [head, value] = words;
      if (head === 'on' || head === 'off') {
        api.state.set({ ...state, copy: head === 'on', last: null });
      } else if (head === 'min' && value !== undefined && Number.isFinite(Number(value))) {
        api.state.set({ ...state, min: clamp(Number(value)), last: null });
      } else if (head === 'sources' && value !== undefined) {
        const chosen = value === 'all' ? [] : value.split(',').map(item => item.trim());
        if (chosen.some(item => !SOURCES.includes(item as TerminalSelectionSource))) {
          return { display: `sources must be all or a comma list of ${SOURCES.join(', ')}` };
        }
        api.state.set({ ...state, sources: chosen, last: null });
      } else if (head === 'reset') {
        api.state.set({ copy: null, sources: null, min: null, last: null, detail: null });
      } else if (head !== undefined && head !== 'status') {
        return { display: 'usage: /omd_selection_copy:policy status | on | off | min N | sources all|transcript,composer,pager | reset' };
      }
      const detail = saved().detail;
      return { display: detail ? `${describe(policy())}\nlast release: ${detail}` : describe(policy()) };
    },
    { description: 'Show or change copy-on-highlight for released mouse selections' },
  );
}

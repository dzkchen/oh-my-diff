import type { Json, ModAPI } from '../../api.d.ts';

type Check = 'python' | 'typescript' | 'rust';
type Cache = Record<string, Check[]>;

const CHECKS: Record<Check, { name: string; description: string; command: string[] }> = {
  python: { name: 'check_python', description: 'Run the selected Python check; defaults to pytest.', command: ['python3', '-m', 'pytest', '-q'] },
  typescript: { name: 'check_typescript', description: 'Run the selected TypeScript check; defaults to pnpm check.', command: ['pnpm', 'check'] },
  rust: { name: 'check_rust', description: 'Run the selected Rust check; defaults to locked Cargo tests.', command: ['cargo', 'test', '--locked'] },
};
const ORDER: Check[] = ['python', 'typescript', 'rust'];

function selected(work: string[]): Check[] {
  const text = work.join(' ').toLowerCase();
  return [
    ...(/\b(?:python|pytest)\b|\.py\b/.test(text) ? ['python' as Check] : []),
    ...(/\b(?:typescript|javascript|pnpm)\b|\.(?:ts|tsx|js)\b/.test(text) ? ['typescript' as Check] : []),
    ...(/\b(?:rust|cargo)\b|\.rs\b/.test(text) ? ['rust' as Check] : []),
  ];
}

function cache(value: Json): Cache {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value).filter(([thread, names]) => thread.length > 0 && thread.length <= 256
    && Array.isArray(names) && names.length <= 3 && names.every(name => ORDER.includes(name as Check)));
  return Object.fromEntries(entries) as Cache;
}

function command(value: Json | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length === 0 || value.length > 8
      || !value.every(part => typeof part === 'string' && part.length > 0 && part.length <= 256 && !part.includes('\0'))) throw new Error('check_command_invalid');
  return value as string[];
}

export default function activate(api: ModAPI) {
  const current = () => {
    const thread = api.host.call('task.status', null).ledger.thread_id;
    if (typeof thread !== 'string' || thread.length === 0 || thread.length > 256) throw new Error('task_thread_unavailable');
    const status = api.services.call('omd.workflow', 'status', null);
    if (!status || typeof status !== 'object' || Array.isArray(status) || status.schema !== 1
        || !Array.isArray(status.remaining_work) || status.remaining_work.length > 32
        || !status.remaining_work.every(item => typeof item === 'string' && item.length <= 512)) throw new Error('workflow_checkpoint_unavailable');
    return { thread, names: selected(status.remaining_work as string[]) };
  };
  const refresh = () => {
    try {
      const { thread, names } = current();
      const previous = cache(api.state.get());
      api.state.set(Object.fromEntries([...Object.entries(previous).filter(([key]) => key !== thread).slice(-15), [thread, names]]));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      api.state.set({});
    }
  };
  const parameters = { type: 'object' as const, properties: {}, additionalProperties: false };
  for (const kind of ORDER) {
    const check = CHECKS[kind];
    api.tool({ name: check.name, description: check.description, parameters, task_scoped: true }, () => {
      if (!current().names.includes(kind)) throw new Error('check_not_selected_for_current_workflow');
      const argv = command(api.settings[`${kind}_command`], check.command);
      return api.host.call('exec.run', { program: argv[0], argv: argv.slice(1), write: true, timeout_ms: 120000, max_output_bytes: 65_536 });
    });
  }
  api.on('turn_start', refresh);
  api.on('tool_result', refresh);
  api.on('tool_exposure', event => {
    const names = typeof event.thread_id === 'string' ? cache(api.state.get())[event.thread_id] ?? [] : [];
    return { enable: names.map(kind => CHECKS[kind].name).filter(name => event.available.includes(name)) };
  });
  api.on('context', event => {
    const names = cache(api.state.get())[event.thread_id] ?? [];
    return names.length ? { text: `Optional task checks selected: ${names.map(kind => CHECKS[kind].name).join(', ')}. Run only if the repository supplies that command; host execution approval applies.` } : null;
  });
}

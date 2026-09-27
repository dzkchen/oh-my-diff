import type { Json, ModAPI } from '../../api-0.1.d.ts';

type Check = 'python' | 'typescript' | 'rust';

const CHECKS: Record<Check, { name: string; description: string; command: string[] }> = {
  python: { name: 'check_python', description: 'Run the selected Python check; defaults to pytest.', command: ['python3', '-m', 'pytest', '-q'] },
  typescript: { name: 'check_typescript', description: 'Run the selected TypeScript check; defaults to pnpm check.', command: ['pnpm', 'check'] },
  rust: { name: 'check_rust', description: 'Run the selected Rust check; defaults to locked Cargo tests.', command: ['cargo', 'test', '--locked'] },
};

function remaining(checkpoint: Json): string[] {
  if (checkpoint === null || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return [];
  const value = checkpoint.remaining_work;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function selected(checkpoint: Json): Check[] {
  const work = remaining(checkpoint).join(' ').toLowerCase();
  return [
    ...(/\b(?:python|pytest)\b|\.py\b/.test(work) ? ['python' as Check] : []),
    ...(/\b(?:typescript|javascript|pnpm)\b|\.(?:ts|tsx|js)\b/.test(work) ? ['typescript' as Check] : []),
    ...(/\b(?:rust|cargo)\b|\.rs\b/.test(work) ? ['rust' as Check] : []),
  ];
}

export default function activate(api: ModAPI) {
  const parameters = { type: 'object' as const, properties: {}, additionalProperties: false };
  for (const [kind, check] of Object.entries(CHECKS) as [Check, typeof CHECKS[Check]][]) {
    api.tool({ name: check.name, description: check.description, parameters, task_scoped: true },
      () => {
        const setting = api.settings[`${kind}_command`];
        const command = Array.isArray(setting) && setting.length > 0 && setting.length <= 8 && setting.every(part => typeof part === 'string' && part.length > 0 && part.length <= 256)
          ? setting as string[] : check.command;
        return api.host.call('tools.exec', command);
      });
  }
  api.on('tool_exposure', ({ checkpoint, available }) => ({
    enable: selected(checkpoint).map(kind => CHECKS[kind].name).filter(name => available.includes(name)),
  }));
  api.on('context', ({ checkpoint }) => {
    const names = selected(checkpoint).map(kind => CHECKS[kind].name);
    return names.length ? { text: `Optional task checks selected: ${names.join(', ')}. Run only if the repository supplies that command; native execution approval applies.` } : null;
  });
}

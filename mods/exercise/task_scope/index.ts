import type { Json, ModAPI } from '@oh-my-diff/mod-api';

const CHECKS: Record<string, { area: string; program: string; argv: string[] }> = {
  check_python: { area: 'scripts/', program: 'python3', argv: ['-m', 'py_compile', 'scripts/mod_conformance.py'] },
  check_typescript: { area: 'mods/', program: 'pnpm', argv: ['--dir', 'mods', 'check'] },
};

export default function activate(api: ModAPI) {
  const scope = (): string[] => {
    const stored = api.state.get();
    return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string') : [];
  };
  const selected = () => Object.keys(CHECKS).filter(name => scope().some(path => path.includes(CHECKS[name].area)));
  const parameters = { type: 'object' as const, properties: {}, additionalProperties: false };
  for (const [name, check] of Object.entries(CHECKS)) {
    api.tool({ name, description: `Run ${check.program} ${check.argv.join(' ')}.`, parameters, task_scoped: true },
      (): Json => api.host.call('exec.run', { program: check.program, argv: check.argv, timeout_ms: 120_000 }) as unknown as Json);
  }
  api.command('scope', text => {
    const paths = String(text ?? '').split(/\s+/).filter(Boolean).slice(0, 16);
    api.state.set(paths);
    return { display: paths.length ? `Task scope: ${paths.join(', ')}` : 'Task scope cleared.' };
  }, { description: 'Set the paths this task touches; matching checks become available' });
  api.on('tool_exposure', ({ available }) => ({ enable: selected().filter(name => available.includes(name)) }));
  api.on('context', () => {
    const enabled = selected();
    return enabled.length ? { text: `Optional task checks available: ${enabled.join(', ')}. Native tool authorization still applies.` } : null;
  });
}

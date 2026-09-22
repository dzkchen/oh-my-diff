import type { Json, ModAPI } from '@oh-my-diff/mod-api';

type Checkpoint = { remaining_work?: Json };

function paths(value: Json): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const remaining = (value as Checkpoint).remaining_work;
  return Array.isArray(remaining) ? remaining.filter((item): item is string => typeof item === 'string') : [];
}

function selected(checkpoint: Json): string[] {
  const work = paths(checkpoint);
  return [
    ...(work.some(item => item.includes('scripts/')) ? ['check_python'] : []),
    ...(work.some(item => item.includes('mods/')) ? ['check_typescript'] : []),
  ];
}

export default function activate(api: ModAPI) {
  const parameters = { type: 'object' as const, properties: {}, additionalProperties: false };
  api.tool({ name: 'check_python', description: 'Check the CAI Python conformance script syntax.', parameters, task_scoped: true },
    () => api.host.call('tools.exec', ['python3', '-m', 'py_compile', 'scripts/mod_conformance.py']));
  api.tool({ name: 'check_typescript', description: 'Typecheck the CAI mod author package.', parameters, task_scoped: true },
    () => api.host.call('tools.exec', ['pnpm', '--dir', 'mods', 'check']));
  api.on('tool_exposure', ({ checkpoint, available }) => ({
    enable: selected(checkpoint).filter(name => available.includes(name)),
  }));
  api.on('context', ({ checkpoint }) => {
    const enabled = selected(checkpoint);
    return enabled.length ? { text: `Optional task checks available: ${enabled.join(', ')}. Native tool authorization still applies.` } : null;
  });
}

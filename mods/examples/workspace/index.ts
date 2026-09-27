import type { Json, ModAPI } from '@oh-my-diff/mod-api';

type Move = { old_path: string; new_path: string; rewrites: Record<string, string> };

function input(value: Json): Move {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_move');
  const old_path = value.old_path;
  const new_path = value.new_path;
  const rewrites = value.rewrites;
  if (typeof old_path !== 'string' || typeof new_path !== 'string' || !rewrites || typeof rewrites !== 'object' || Array.isArray(rewrites) || Object.values(rewrites).some(text => typeof text !== 'string')) throw new Error('invalid_move');
  return { old_path, new_path, rewrites: rewrites as Record<string, string> };
}

export default function activate(api: ModAPI) {
  api.on('workspace_write', event => {
    api.state.set({ last_write: { status: event.status, changes: event.changes } });
  });
  api.on('workspace_pre_rename', event => {
    const configured = api.settings.companions;
    const companions = Array.isArray(configured) && configured.every(value => typeof value === 'string') ? configured as string[] : [];
    const paths = [...new Set([event.old, event.new, ...companions])];
    const read = api.host.tryCall('workspace.read', { paths });
    if (!read.ok) return { status: 'fallback', reason: read.error };
    if (read.value.files[event.old]?.sha256 !== event.expected[event.old] || read.value.files[event.new] !== null) return { status: 'fallback', reason: 'rename_input_stale' };
    const expected: Record<string, string | null> = { ...event.expected };
    const writes: Record<string, string> = {};
    const before = event.old.split('/').at(-1)?.replace(/\.[^.]+$/, '');
    const after = event.new.split('/').at(-1)?.replace(/\.[^.]+$/, '');
    if (!before || !after) return { status: 'fallback', reason: 'rename_name_missing' };
    for (const path of companions) {
      const file = read.value.files[path];
      if (!file || !file.text.includes(before)) return { status: 'fallback', reason: 'companion_stale' };
      expected[path] = file.sha256;
      writes[path] = file.text.replaceAll(before, after);
    }
    return { status: 'ready', expected, writes };
  });
  api.tool({
    name: 'request_rename',
    description: 'Request a file rename with the selected pre-rename subscriber proposal.',
    parameters: { type: 'object', properties: { old: { type: 'string' }, new: { type: 'string' } }, required: ['old', 'new'], additionalProperties: false },
  }, value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.old !== 'string' || typeof value.new !== 'string') throw new Error('rename_paths_required');
    return api.host.call('workspace.request_rename', { old: value.old, new: value.new });
  });
  api.tool({
    name: 'move',
    description: 'Move one source file and apply explicitly supplied companion rewrites with exact hashes.',
    parameters: {
      type: 'object',
      properties: {
        old_path: { type: 'string' },
        new_path: { type: 'string' },
        rewrites: { type: 'object' },
      },
      required: ['old_path', 'new_path', 'rewrites'],
      additionalProperties: false,
    },
  }, async value => {
    const move = input(value);
    const paths = [...new Set([move.old_path, move.new_path, ...Object.keys(move.rewrites)])];
    const read = api.host.call('workspace.read', { paths });
    if (!read.files[move.old_path] || read.files[move.new_path] !== null) throw new Error('move_source_or_destination_changed');
    const expected: Record<string, string | null> = {};
    for (const path of paths) expected[path] = read.files[path]?.sha256 ?? null;
    return api.host.call('workspace.transaction', {
      expected,
      writes: move.rewrites,
      renames: [{ old: move.old_path, new: move.new_path }],
    });
  });
}

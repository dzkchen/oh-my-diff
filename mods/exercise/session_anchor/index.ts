import type { Json, ModAPI } from '@oh-my-diff/mod-api';

function entries(checkpoint: Json, key: string): string[] {
  if (checkpoint === null || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return [];
  const value = checkpoint[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 8) : [];
}

export default function activate(api: ModAPI) {
  api.replace('compaction', ({ token_limit }) => ({
    threshold: typeof token_limit === 'number' ? Math.max(4096, Math.floor(token_limit * 0.8)) : 8192,
    prompt: 'Summarize the current task from verified host checkpoints. Preserve exact remaining acceptance work and evidence references. Mark uncertain or stale facts explicitly.',
  }));
  api.on('compaction_end', () => {
    const previous = api.state.get();
    const count = typeof previous === 'number' && Number.isSafeInteger(previous) ? previous : 0;
    api.state.set(count + 1);
  });
  api.on('context', ({ checkpoint }) => {
    const remaining = entries(checkpoint, 'remaining_work');
    const completed = entries(checkpoint, 'completed_steering');
    if (!remaining.length && !completed.length) return null;
    const count = api.state.get();
    const total = typeof count === 'number' ? count : 0;
    return { text: `Host checkpoint anchor after ${total} local ${total === 1 ? 'compaction' : 'compactions'}. Remaining: ${remaining.join('; ') || 'none recorded'}. Completed steering: ${completed.join('; ') || 'none recorded'}. Recheck evidence before completion.` };
  });
}

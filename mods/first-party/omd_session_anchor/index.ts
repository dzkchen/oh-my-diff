import type { ModAPI } from '../../api.d.ts';

export default function activate(api: ModAPI) {
  api.on('start', () => api.state.set(0));
  api.replace('compaction', ({ token_limit }) => ({
    threshold: typeof token_limit === 'number' ? Math.max(4096, Math.floor(token_limit * 0.8)) : 8192,
    prompt: 'Preserve the current task, remaining acceptance work, candidate and check evidence, and unresolved failures. Revalidate each detail against available evidence and mark uncertain facts explicitly.',
  }));
  api.on('compaction_end', () => {
    const previous = api.state.get();
    const count = typeof previous === 'number' && Number.isSafeInteger(previous) && previous >= 0 ? previous : 0;
    api.state.set(count + 1);
  });
  api.on('context', () => {
    const stored = api.state.get();
    const count = typeof stored === 'number' && Number.isSafeInteger(stored) ? stored : 0;
    if (count === 0) return null;
    return { text: `Checkpoint ${count} compactions. Verified host checkpoint fields are unavailable through mod API 0.2. Recheck remaining work, accepted criteria, candidate and check evidence, and unresolved failures before completion.` };
  });
}

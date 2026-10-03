import type { Json, ModAPI } from '@oh-my-diff/mod-api';

type Anchor = { compactions: number; remaining: string[]; completed: string[] };

export default function activate(api: ModAPI) {
  const held = (): Anchor => {
    const stored = api.state.get();
    const record = stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    const list = (value: Json | undefined) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 8) : [];
    return { compactions: typeof record.compactions === 'number' ? record.compactions : 0, remaining: list(record.remaining), completed: list(record.completed) };
  };
  const save = (anchor: Anchor) => api.state.set(anchor as unknown as Json);
  api.replace('compaction', ({ token_limit }) => ({
    threshold: typeof token_limit === 'number' ? Math.max(4096, Math.floor(token_limit * 0.8)) : 8192,
    prompt: 'Summarize the current task from the session anchor. Preserve exact remaining acceptance work and evidence references. Mark uncertain or stale facts explicitly.',
  }));
  api.on('compaction_end', () => save({ ...held(), compactions: held().compactions + 1 }));
  api.command('anchor', text => {
    const [kind, ...rest] = String(text ?? '').trim().split(/\s+/);
    const item = rest.join(' ');
    const anchor = held();
    if (kind === 'remaining' && item) save({ ...anchor, remaining: [...anchor.remaining, item].slice(-8) });
    else if (kind === 'done' && item) save({ ...anchor, remaining: anchor.remaining.filter(entry => entry !== item), completed: [...anchor.completed, item].slice(-8) });
    else return { display: 'usage: /session_anchor:anchor remaining TEXT | done TEXT' };
    return { display: `Anchored ${kind}: ${item}` };
  }, { description: 'Record remaining or completed work that survives compaction' });
  api.on('context', () => {
    const { compactions, remaining, completed } = held();
    if (!remaining.length && !completed.length) return null;
    return { text: `Session anchor after ${compactions} local ${compactions === 1 ? 'compaction' : 'compactions'}. Remaining: ${remaining.join('; ') || 'none recorded'}. Completed: ${completed.join('; ') || 'none recorded'}. Recheck evidence before completion.` };
  });
}

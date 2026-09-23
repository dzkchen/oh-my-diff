import type { Json, ModAPI } from '../../api.d.ts';

function strings(checkpoint: Json, key: string): string[] {
  if (checkpoint === null || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return [];
  const value = checkpoint[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 1).map(item => item.slice(0, 64)) : [];
}

function lastHash(checkpoint: Json, key: string): string {
  if (checkpoint === null || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return 'none recorded';
  const values = checkpoint[key];
  if (!Array.isArray(values)) return 'none recorded';
  const last = values.at(-1);
  if (last === null || typeof last !== 'object' || Array.isArray(last)) return 'none recorded';
  return typeof last.sha256 === 'string' && /^[a-f0-9]{64}$/.test(last.sha256) ? last.sha256 : 'none recorded';
}

function accepted(checkpoint: Json): string[] {
  if (checkpoint === null || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return [];
  const values = checkpoint.completed_acceptance;
  if (!Array.isArray(values)) return [];
  return values.slice(-1).flatMap(item => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
    return typeof item.criterion === 'string' ? [item.criterion.slice(0, 64)] : [];
  });
}

export default function activate(api: ModAPI) {
  api.on('start', () => api.state.set(0));
  api.replace('compaction', ({ token_limit }) => ({
    threshold: typeof token_limit === 'number' ? Math.max(4096, Math.floor(token_limit * 0.8)) : 8192,
    prompt: 'Preserve the current task from verified host checkpoints. Include exact remaining acceptance work, candidate and check evidence, and unresolved failures. Mark uncertain facts explicitly.',
  }));
  api.on('compaction_end', () => {
    const previous = api.state.get();
    const count = typeof previous === 'number' && Number.isSafeInteger(previous) && previous >= 0 ? previous : 0;
    api.state.set(count + 1);
  });
  api.on('context', ({ checkpoint }) => {
    const stored = api.state.get();
    const count = typeof stored === 'number' && Number.isSafeInteger(stored) ? stored : 0;
    if (count === 0) return null;
    const remaining = strings(checkpoint, 'remaining_work');
    const completed = strings(checkpoint, 'completed_steering');
    const failures = strings(checkpoint, 'failed_hypotheses');
    const criteria = accepted(checkpoint);
    const candidate = lastHash(checkpoint, 'candidate_versions');
    const check = lastHash(checkpoint, 'check_versions');
    if (!remaining.length && !completed.length && !failures.length && !criteria.length && candidate === 'none recorded') return null;
    return { text: `Checkpoint ${count} compactions; remaining: ${remaining.join('; ') || 'none'}; accepted: ${criteria.join('; ') || 'none'}; completed: ${completed.join('; ') || 'none'}; failed: ${failures.join('; ') || 'none'}; candidate SHA-256: ${candidate}; check SHA-256: ${check}. Revalidate host evidence.` };
  });
}

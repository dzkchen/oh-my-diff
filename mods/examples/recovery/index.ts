import type { ModAPI } from '@oh-my-diff/mod-api';
export default function activate(api: ModAPI) {
  api.replace('compaction', ({ token_limit, context_window }) => ({
    threshold: Math.min(16000, token_limit ?? context_window ?? 16000),
    prompt: 'Summarize the conversation for continuation. Keep failed hypotheses, remaining acceptance criteria, and exact file paths.',
  }));
  api.replace('context', ({ checkpoint }) => ({ text: `Recovery policy: inspect the preserved checkpoint before repeating failed work. ${JSON.stringify(checkpoint).slice(0, 800)}` }));
  api.tool({ name: 'checkpoint', description: 'Read authoritative native recovery state', parameters: { type: 'object', properties: {} } }, () => api.host.call('checkpoint.read', null));
}

import type { ModAPI } from '@oh-my-diff/mod-api';
export default function activate(api: ModAPI) {
  api.replace('compaction', ({ token_limit, context_window }) => ({
    threshold: Math.min(16000, token_limit ?? context_window ?? 16000),
    prompt: 'Summarize the conversation for continuation. Keep failed hypotheses, remaining acceptance criteria, and exact file paths.',
  }));
  api.replace('context', () => ({ text: 'Recovery policy: revalidate failed hypotheses and remaining acceptance work before retrying.' }));
}

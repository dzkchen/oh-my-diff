import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('worktree_task', text => {
    const [cwd, ...prompt] = String(text).split(/\s+/);
    const started = api.host.call('app.request', { method: 'thread/start', params: { cwd } }) as { thread?: { id?: string } };
    const thread = started.thread?.id;
    if (!thread) return { display: 'Thread start declined' };
    if (prompt.length) api.host.call('app.request', { method: 'turn/start', params: { threadId: thread, input: [{ type: 'text', text: prompt.join(' ') }] } });
    api.host.call('terminal.show_thread', { thread_id: thread });
    return { display: `Started ${thread} in ${cwd}` };
  });
}

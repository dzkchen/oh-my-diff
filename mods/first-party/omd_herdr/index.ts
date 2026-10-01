import type { ModAPI } from '../../api.d.ts';

type Status = { type: 'idle' | 'systemError' | 'notLoaded' } | { type: 'active'; activeFlags: ('waitingOnApproval' | 'waitingOnUserInput')[] };
type Pane = { id: string; bin: string };

const SOURCE = ['--source', 'omd', '--agent', 'codex'];

export default function activate(api: ModAPI) {
  const children = (): string[] => (api.state.get() as { children?: string[] } | null)?.children ?? [];
  const pane = (): Pane | null => {
    const env = api.host.tryCall('exec.run', { program: 'env', timeout_ms: 2000, max_output_bytes: 8192 });
    if (!env.ok || env.value.exit_code !== 0) return null;
    const vars = Object.fromEntries(env.value.stdout.split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    return vars.HERDR_ENV === '1' && /^[\w.:-]{1,128}$/.test(vars.HERDR_PANE_ID ?? '') && vars.HERDR_BIN_PATH?.startsWith('/') && vars.HERDR_SOCKET_PATH?.startsWith('/')
      ? { id: vars.HERDR_PANE_ID, bin: vars.HERDR_BIN_PATH } : null;
  };
  const herdr = (target: Pane, argv: string[], resume: string[] = []) => {
    api.host.tryCall('exec.run', { program: target.bin, argv: ['pane', ...argv, '--seq', String(Date.now()), ...resume], unix_sockets: ['HERDR_SOCKET_PATH'], timeout_ms: 2000, max_output_bytes: 4096 });
  };

  api.on('app_notification', ({ method, params }) => {
    if (method === 'thread/started') {
      const thread = (params as { thread?: { id?: string; parentThreadId?: string | null; ephemeral?: boolean } }).thread;
      if (thread?.id && (thread.parentThreadId || thread.ephemeral)) api.state.set({ children: [...children(), thread.id].slice(-64) });
      return;
    }
    const { threadId, status } = params as { threadId?: string; status?: Status };
    if (method !== 'thread/status/changed' || !threadId || !/^[\w-]{1,64}$/.test(threadId) || !status || status.type === 'notLoaded' || children().includes(threadId)) return;
    const target = pane();
    if (!target) return;
    const flags = status.type === 'active' ? status.activeFlags : [];
    const state = [target.id, ...SOURCE, '--state', flags.length ? 'blocked' : status.type === 'active' ? 'working' : 'idle',
      ...flags.length ? ['--message', flags.includes('waitingOnApproval') ? 'waiting for approval' : 'waiting for input'] : []];
    herdr(target, ['report-agent', ...state, '--agent-session-id', threadId], ['--', 'codex', 'resume', threadId]);
  });

  api.on('stop', () => {
    const target = pane();
    if (target) herdr(target, ['release-agent', target.id, ...SOURCE]);
  });

  api.command('herdr', () => {
    const target = pane();
    return { display: target ? `Reporting to Herdr pane ${target.id} as source omd; resume runs \`codex resume <session>\`.` : 'Not inside a Herdr pane (HERDR_ENV, HERDR_PANE_ID, HERDR_BIN_PATH and HERDR_SOCKET_PATH are required); omd_herdr stays inert.' };
  }, { description: 'Show whether this session reports its state to a Herdr pane' });
}

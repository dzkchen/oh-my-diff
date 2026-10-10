import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('locale', args => {
    const locale = typeof args === 'string' && args.trim() ? args.trim() : null;
    api.host.call('environment.set', { name: 'LANG', value: locale });
    return { display: `Future child locale: ${locale ?? 'unset'}` };
  });
  api.command('remote_heads', args => {
    const remote = typeof args === 'string' && args.trim() ? args.trim() : 'origin';
    const run = api.host.call('exec.run', { program: 'git', argv: ['ls-remote', '--heads', remote], sandbox: 'none', timeout_ms: 30_000 });
    return { display: run.exit_code === 0 ? run.stdout : `git ls-remote failed (${run.exit_code}): ${run.stderr}` };
  }, { description: 'List remote branches with your own Git credentials and network' });
}

import type { ModAPI } from '../../api.d.ts';

const emoji: Record<string, string> = { bug: '🐛', check: '✅', eyes: '👀', fire: '🔥', rocket: '🚀', smile: '😄', tada: '🎉', warning: '⚠️' };

// `:name` completes emoji and `#` completes issue numbers mentioned in recent commit subjects.
export default function activate(api: ModAPI) {
  api.completion({ trigger: ':' }, event => ({
    items: Object.keys(emoji).filter(name => name.startsWith(event.query)).map(name => ({ insert: emoji[name] })),
  }));
  api.completion({ trigger: '#' }, event => {
    const log = api.host.call('exec.run', { program: 'git', argv: ['log', '--format=%s', '-n', '200'], timeout_ms: 5000 });
    const issues = [...new Set([...log.stdout.matchAll(/#(\d+)/g)].map(match => match[1]))];
    return { items: issues.filter(issue => issue.startsWith(event.query)).map(issue => ({ insert: `#${issue}` })) };
  });
}

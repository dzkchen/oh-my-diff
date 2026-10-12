import type { ModAPI } from '../../api.d.ts';

// Keeps secret files out of `@` mentions and reads a build output's TypeScript source instead.
export default function activate(api: ModAPI) {
  api.intercept('mention', { match: { path: /(^|\/)(\.env[^/]*|[^/]+\.pem|id_[a-z0-9]+)$/ } }, () => ({ deny: 'secret files are not read into prompts' }));
  api.intercept('mention', { match: { path: /^dist\/.+\.js$/ } }, (event, next) => {
    const source = event.path.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');
    const stat = api.host.call('workspace.stat', { paths: [source] });
    return next(stat.files[source]?.kind === 'file' ? { ...event, path: source } : event);
  });
}

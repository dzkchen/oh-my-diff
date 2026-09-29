import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('profiles', () => ({ display: api.host.call('credentials.list', null).map(profile => `${profile.id} ${profile.label} (${profile.kind})`).join('\n') }));
  api.command('use_route', route => {
    const selected = api.host.call('routes.select', { route: String(route), scope: 'thread' });
    return { display: `Next requests use ${selected.route.name} (${selected.route.credential ?? 'session credential'})` };
  });
  api.command('add_key', label => api.host.call('credentials.request', { action: 'enroll', kind: 'api_key', label: String(label) }).status);
}

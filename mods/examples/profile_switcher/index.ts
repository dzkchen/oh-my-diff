import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('profiles', () => ({ display: api.host.call('credentials.list', null).map(profile => `${profile.id} ${profile.label} (${profile.kind})`).join('\n') }));
  // Slash commands can't select routes, so the command hops to this mod's own native channel handler.
  api.command('use_route', route => {
    const asked = api.host.tryCall('events.publish', { channel: 'use_route', data: String(route) });
    return { display: asked.ok ? `Switching to ${String(route)} at the next request` : 'Route switching is unavailable here' };
  });
  api.on('channel', ({ channel, data }) => {
    if (channel === 'profile_switcher/use_route' && typeof data === 'string') api.host.tryCall('routes.select', { route: data, scope: 'thread' });
  });
  api.command('add_key', label => api.host.call('credentials.request', { action: 'enroll', kind: 'api_key', label: String(label) }).status);
}

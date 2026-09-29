import type { ModAPI } from '@oh-my-diff/mod-api';
export default function activate(api: ModAPI) {
  api.replace('routing', ({ routes }) => {
    if (typeof api.settings.route !== 'string') return null;
    const selected = routes.find(route => route.name === api.settings.route && route.available && route.billing === 'included_subscription');
    if (!selected) throw new Error('configured_included_route_unavailable');
    return { route: selected.name };
  });
}

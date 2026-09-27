import type { ModAPI } from '@oh-my-diff/mod-api/0.1';
export default function activate(api: ModAPI) {
  api.replace('routing', ({ routes }) => routes.find(route => route.name === api.settings.route)?.name ?? routes[0].name);
}

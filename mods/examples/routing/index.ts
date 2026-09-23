import type { ModAPI } from '@oh-my-diff/mod-api';
export default function activate(api: ModAPI) {
  api.replace('routing', ({ routes }) => routes.find(route => route.name === api.settings.route)?.name ?? routes[0].name);
}

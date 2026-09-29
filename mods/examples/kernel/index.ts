import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.middleware('model_request', event => {
    const astra = event.routes.find(route => route.name === 'astra' && route.available && route.billing === 'included_subscription');
    return astra ? { route: astra.name } : null;
  });
  api.middleware('response_stream', event => {
    if (event.protected || event.text === null) return null;
    return { text: event.text.replaceAll('experimental', 'preview') };
  });
  api.middleware('tool_result', () => undefined);
}

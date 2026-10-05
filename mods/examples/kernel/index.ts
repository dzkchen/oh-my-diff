import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.intercept('model_request', (event, next) => {
    const astra = event.routes.find(route => route.name === 'astra' && route.available && route.billing === 'included_subscription');
    return next(astra ? { ...event, route: astra.name } : event);
  });
  api.intercept('response_stream', { match: { kind: 'text' } }, (event, next) =>
    next(event.kind === 'text' ? { ...event, text: event.text.replaceAll('experimental', 'preview') } : event));
  api.middleware('tool_result', () => undefined);
}

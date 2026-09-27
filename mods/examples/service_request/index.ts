import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.tool({ name: 'probe', description: 'Invoke an explicitly granted test service.', parameters: { type: 'object', properties: {}, additionalProperties: false } }, () => {
    const result = api.host.tryCall('sidecars.invoke', { id: 'example_echo', input: { text: 'extension-owned request' } });
    api.state.set(result);
    return result;
  });
}

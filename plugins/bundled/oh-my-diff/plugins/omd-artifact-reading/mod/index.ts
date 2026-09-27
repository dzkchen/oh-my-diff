import type { Json, ModAPI, VirtualReadResponse } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.virtualRead({ scheme: 'github', version: '1.0.0' }, request => {
    const result = api.host.tryCall('sidecars.invoke', { id: 'omd_github_read', input: request as unknown as Json });
    if (!result.ok) throw new Error(result.error);
    const value = result.value.result;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('github_response_invalid');
    if (typeof value.error === 'string') throw new Error(value.error);
    return value as unknown as VirtualReadResponse;
  });
}

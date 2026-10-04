import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.intercept('admission', { required: true }, (event, next) => {
    const capabilities = event.package.capabilities;
    if (capabilities.includes('os') && capabilities.includes('http')) return { deny: 'unsandboxed processes with network access need a manual review' };
    if (capabilities.includes('http')) return { withhold: ['exec', 'process', 'sidecars'] };
    return next(event);
  });
  api.intercept('host_operation', { match: { namespace: 'http' } }, (event, next) => {
    const url = String((event.arguments as { url?: string }).url ?? '');
    return url.startsWith('https://') ? next(event) : { error: 'admission_guard allows only https requests' };
  });
}

import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('format', input => api.services.call<string>('example.formatter', 'format', input));
}

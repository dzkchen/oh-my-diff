import type { ModAPI } from '../../api.d.ts';

export default function activate(api: ModAPI) {
  api.command('format', input => api.services.call<string>('example.formatter', 'format', input));
}

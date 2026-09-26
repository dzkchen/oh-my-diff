import type { ModAPI } from '../../api.d.ts';

export default function activate(api: ModAPI) {
  const layout = api.settings.layout === 'native' ? 'native' : 'compact';
  const brand = typeof api.settings.brand === 'string' ? api.settings.brand.trim().slice(0, 24) : 'oh my diff';
  api.on('terminal', () => ({ theme: { picker: brand ? { layout, brand } : { layout } } }));
}

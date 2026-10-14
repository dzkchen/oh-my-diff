import type { ModAPI } from '@oh-my-diff/mod-api';
export default function activate(api: ModAPI) {
  api.on('context', () => ({ text: 'Use concise progress updates. Revalidate remaining work and evidence from the live task.' }));
}

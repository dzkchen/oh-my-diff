import type { ModAPI } from '@oh-my-diff/mod-api/0.1';
export default function activate(api: ModAPI) {
  api.on('context', ({ checkpoint }) => ({
    text: `Use concise progress updates. Preserve the host checkpoint: ${JSON.stringify(checkpoint)}`,
  }));
}

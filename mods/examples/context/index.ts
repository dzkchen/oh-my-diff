import type { ModAPI } from '@oh-my-diff/mod-api';
export default function activate(api: ModAPI) {
  api.on('context', ({ checkpoint }) => ({
    text: `Use concise progress updates. Preserve the host checkpoint: ${JSON.stringify(checkpoint)}`,
  }));
}

import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.on('tool_output', event => {
    if (event.tool !== 'apply_patch' || !/error|conflict/i.test(event.text)) return null;
    return { append: 'Note: the patch reported a problem; re-read the file before retrying.' };
  });
}

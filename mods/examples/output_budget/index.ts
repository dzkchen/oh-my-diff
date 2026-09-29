import type { ModAPI } from '@oh-my-diff/mod-api';

const LIMIT = 4000;

export default function activate(api: ModAPI) {
  api.replace('tool_output', event => {
    if (event.bytes <= LIMIT) return null;
    const head = event.text.slice(0, LIMIT / 2);
    const tail = (event.tail ?? event.text).slice(-LIMIT / 4);
    return { text: `${head}\n… output folded from ${event.bytes} bytes; original kept as ${event.original?.reference} …\n${tail}` };
  });
}

import type { ModAPI } from '@oh-my-diff/mod-api';

const KEEP = 40;
const LARGE = 16_384;

export default function activate(api: ModAPI) {
  api.replace('history', event => {
    const cutoff = (event.items.at(-1)?.index ?? 0) + 1 - KEEP;
    const replace = event.items
      .filter(item => item.index < cutoff && item.editable && item.type.endsWith('_output') && item.bytes > LARGE)
      .map(item => ({ index: item.index, text: `[folded ${item.bytes} bytes of ${item.call_id ?? 'tool'} output]` }));
    return replace.length ? { replace } : null;
  });
}

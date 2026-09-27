import type { ModAPI } from '@oh-my-diff/mod-api/0.1';

export default function activate(api: ModAPI) {
  api.virtualRead({ scheme: 'fixture', version: '1.0.0' }, request => {
    if (request.uri !== 'fixture://manual/intro' || request.cursor) throw new Error('resource_unavailable');
    const text = 'A resource supplied by an independent extension.';
    if (text.length > (request.max_bytes ?? 16384)) throw new Error('resource_exceeds_page');
    return {
      canonical_uri: request.uri,
      canonical_url: 'https://example.invalid/manual/intro',
      identity: 'manual/intro',
      revision: 'manual-v1',
      text,
      anchors: ['intro:1'],
      cursor: null,
      truncated: false,
    };
  });
}

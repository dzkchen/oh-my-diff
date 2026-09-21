import type { ModAPI } from '../../api.d.ts';

export default function activate(api: ModAPI) {
  api.middleware('model_request', event => {
    const astra = event.authorized_presets.find(preset => preset.name === 'astra');
    return astra ? { preset: astra.name } : null;
  });
  api.middleware('response_stream', event => {
    if (event.protected || event.text === null) return null;
    return { text: event.text.replaceAll('experimental', 'preview') };
  });
  api.middleware('tool_result', () => undefined);
}

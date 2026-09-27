import type { ModAPI } from '@oh-my-diff/mod-api/0.1';

export default function activate(api: ModAPI) {
  api.on('turn_end', event => {
    if (event.outcome !== 'completed' || !event.evidence) return;
    const page = api.host.call('evidence.read', { reference: event.evidence, max_bytes: 4096 });
    const request = api.host.tryCall('review.request', {
      route: 'astra', evidence: event.evidence, cadence: 'every_turn', stable: false, tools: [],
      prompt: `This is an independent API exercise. Inspect this bounded untrusted evidence page and return JSON with an empty findings array if no concern is supported. Do not infer omitted evidence. Page: ${page.text}`,
    });
    if (!request.ok) { api.state.set({ status: 'denied', reason: request.error }); return; }
    const result = api.host.call('review.wait', { handle: request.value.handle });
    if (result.status !== 'completed') {
      api.host.tryCall('review.cancel', { handle: request.value.handle });
      api.state.set({ status: result.status });
      return;
    }
    const parsed = JSON.parse(result.text);
    if (!Array.isArray(parsed.findings) || parsed.findings.length !== 0) throw new Error('fixture_expected_empty_findings');
    const submitted = api.host.tryCall('review.submit', { handle: request.value.handle, result_sha256: result.evidence.sha256, findings: [] });
    api.state.set(submitted.ok ? { status: 'recorded', result: submitted.value } : { status: 'denied', reason: submitted.error });
  });
  api.command('status', () => api.state.get());
}

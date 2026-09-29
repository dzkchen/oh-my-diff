import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.on('turn_end', event => {
    if (event.outcome !== 'completed' || !event.evidence) return;
    const page = api.host.call('evidence.read', { reference: event.evidence, max_bytes: 4096 });
    const candidate = api.host.call('workspace.snapshot', {});
    const started = api.host.tryCall('agents.spawn', {
      role: 'turn_review', route: 'reviewer', workspace: 'read_only', snapshot: candidate.snapshot,
      evidence: event.evidence, tools: [],
      prompt: `Independently inspect this frozen candidate and bounded untrusted evidence page. Return JSON with an empty findings array only when supported. Do not infer omitted evidence. Page: ${page.text}`,
    });
    if (!started.ok) { api.state.set({ status: 'denied', reason: started.error }); return; }
    const result = api.host.call('agents.wait', { handle: started.value.handle });
    if (result.status !== 'completed') {
      api.host.tryCall('agents.cancel', { handle: started.value.handle });
      api.state.set({ status: result.status });
      return;
    }
    const parsed = JSON.parse(result.text);
    if (!Array.isArray(parsed.findings) || parsed.findings.length !== 0) throw new Error('fixture_expected_empty_findings');
    const submitted = api.host.tryCall('receipts.submit', {
      kind: 'turn_review', candidate_sha256: candidate.candidate_sha256, outcome: 'pass',
      evidence: result.evidence, agent: started.value.handle, findings: [],
    });
    api.host.tryCall('agents.cancel', { handle: started.value.handle });
    api.state.set(submitted.ok ? { status: 'recorded', receipt: submitted.value } : { status: 'denied', reason: submitted.error });
  });
  api.command('status', () => api.state.get());
}

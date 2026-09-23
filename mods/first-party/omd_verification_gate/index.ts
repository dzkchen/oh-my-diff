import type { Json, ModAPI } from '../../api.d.ts';

const CONTRACT = 'omd_verification_gate';

function record(value: Json): Record<string, Json> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export default function activate(api: ModAPI) {
  api.contract({
    schema: 1,
    id: CONTRACT,
    version: 1,
    requirements: {
      delegation: true,
      child_agents: true,
      opposite_lead: true,
      escalation: true,
      checkpoints: true,
      milestone_review: true,
      final_review: 'separate',
      completion: 'adversarial_separate',
    },
  });
  api.tool({
    name: 'seal_candidate',
    description: 'After the selected workflow has recorded acceptance evidence for this exact candidate, close delegation and child-agent spawning for final verification. Native review, escalation and completion stay active.',
    parameters: {
      type: 'object',
      properties: { candidate_sha256: { type: 'string' } },
      required: ['candidate_sha256'],
      additionalProperties: false,
    },
  }, input => {
    const candidate = record(input).candidate_sha256;
    if (typeof candidate !== 'string' || !/^[a-f0-9]{64}$/.test(candidate)) throw new Error('exact candidate SHA-256 required');
    const active = record(api.host.call('workflow.status', null));
    const contract = record(record(active.provenance).contract);
    if (contract.id !== CONTRACT) throw new Error('select omd_verification_gate through the native workflow surface first');
    const checkpoint = record(api.host.call('checkpoint.read', null));
    const versions = checkpoint.candidate_versions;
    const criteria = checkpoint.acceptance_criteria;
    const acceptance = checkpoint.completed_acceptance;
    const current = Array.isArray(versions) ? record(versions.at(-1) ?? null).sha256 : null;
    if (current !== candidate || !Array.isArray(criteria) || criteria.length === 0 || !Array.isArray(acceptance)
        || acceptance.length !== criteria.length || !criteria.every(criterion => acceptance.some(entry => record(entry).criterion === criterion))) {
      throw new Error('current candidate and all acceptance evidence are required before sealing');
    }
    return api.host.call('workflow.restrict', {
      operations: ['delegate', 'spawn_child_agent'],
      reason: `Candidate ${candidate} entered final verification with recorded acceptance evidence`,
    });
  });
  api.command('policy', () => api.host.call('workflow.status', null), {
    description: 'Show the selected workflow contract and any recorded verification restrictions',
  });
}

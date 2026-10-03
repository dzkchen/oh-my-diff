import type { ContractRequirement, Json, ModAPI } from '../../api.d.ts';

const CONTRACT = 'omd_verification_gate';
const required = (receipt: string, producer: ContractRequirement['producer']): ContractRequirement => ({ receipt, producer, bind: ['candidate', 'acceptance'], blocking_findings: 'reject' });
const object = (value: Json): Record<string, Json> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};

export default function activate(api: ModAPI) {
  // Expected refusals return as values; a non-Error throw is the host suspending the callback.
  const refuse = <T>(run: () => T | Promise<T>, value: (reason: string) => T): T | Promise<T> => {
    const refused = (error: unknown) => {
      if (!(error instanceof Error)) throw error;
      return value(error.message);
    };
    try {
      const result = run();
      return result instanceof Promise ? result.catch(refused) : result;
    } catch (error) {
      return refused(error);
    }
  };
  const tool: ModAPI['tool'] = (spec, handler) => api.tool(spec, input => refuse(() => handler(input), reason => ({ status: 'refused', reason })));
  const command: ModAPI['command'] = (name, handler, options) => api.command(name, input => refuse(() => handler(input), reason => ({ display: `Refused: ${reason}` })), options);
  api.contract({ schema: 2, id: CONTRACT, version: 1, description: 'Reviewed workflow with explicit candidate sealing', assurance: 'independently-verified', gates: {
    complete: [required('checks', 'host'), required('final_review', 'separate_agent'), required('adversarial_verification', 'separate_agent')],
    integrate: [required('contribution_checks', 'host'), required('contribution_review', 'separate_agent')],
  } });
  tool({ name: 'seal_candidate', description: 'Close writable delegation and integration after all acceptance assessments cover the exact candidate; read-only reviewers remain available',
    parameters: { type: 'object', properties: { candidate_sha256: { type: 'string' } }, required: ['candidate_sha256'], additionalProperties: false },
  }, input => {
    const candidate = object(input).candidate_sha256;
    if (typeof candidate !== 'string' || !/^[a-f0-9]{64}$/.test(candidate)) throw new Error('exact candidate SHA-256 required');
    const contract = api.host.call('contract.status', null);
    if (contract.status !== 'active' || contract.active?.id !== CONTRACT) throw new Error('select omd_verification_gate first');
    const task = object(api.services.call('omd.workflow', 'status', null));
    const acceptance = object(task.completed_acceptance ?? null);
    const criteria = task.acceptance_criteria;
    const assessments = acceptance.assessments;
    if (task.pending || acceptance.candidate_sha256 !== candidate || !Array.isArray(criteria) || !criteria.length || !Array.isArray(assessments)
        || assessments.length !== criteria.length || !criteria.every(criterion => assessments.some(item => object(item).criterion === criterion && object(item).verdict === 'pass'))) throw new Error('current complete acceptance assessments required before sealing');
    api.host.call('workspace.fingerprint', { expected: candidate });
    return api.host.call('contract.restrict', { operations: ['workspace.integrate'], scoped: [{ operation: 'agents.spawn', when: { '/workspace': 'isolated_worktree' } }],
      reason: `Candidate ${candidate} entered final verification` });
  });
  command('gate', () => ({ display: 'omd_verification_gate requires checks, a final review and adversarial verification by a separate agent on the exact candidate, plus checked and reviewed contributions before integration. seal_candidate closes writable delegation and integration once acceptance covers the candidate. Select it with /omd_workflow:contract omd_verification_gate@1; /inspect shows the active contract.' }), { description: 'Explain the verification gate contract' });
}

import type { ContractDocument, ModAPI } from '@oh-my-diff/mod-api';

const contract: ContractDocument = {
  schema: 2,
  id: 'paired_review',
  version: 1,
  description: 'Require checkpoint, exact-candidate checks, integration, and separate-agent review before completion',
  assurance: 'independent-review-candidate',
  gates: {
    complete: [
      { receipt: 'checkpoint', producer: 'lead', bind: ['acceptance'] },
      { receipt: 'checks', producer: 'host', bind: ['candidate', 'acceptance'] },
      { receipt: 'workspace_integration', producer: 'integration', bind: ['candidate', 'acceptance'] },
      { receipt: 'milestone_review', producer: 'separate_agent', bind: ['candidate', 'acceptance'], blocking_findings: 'reject' },
      { receipt: 'final_review', producer: 'separate_agent', bind: ['candidate', 'acceptance'], blocking_findings: 'reject' },
      { receipt: 'adversarial_verification', producer: 'separate_agent', bind: ['candidate', 'acceptance'], blocking_findings: 'reject' },
    ],
  },
};

export default function activate(api: ModAPI) {
  api.contract(contract);
  api.command('workflow', () => api.host.call('contract.status', null), {
    description: 'Show the active workflow contract, its assurance label, and its provenance',
  });
  api.command('no_delegation', () => api.host.call('contract.restrict', {
    operations: ['agents.spawn'],
    reason: 'this repository reviews every change in a pair instead of delegating',
  }), { description: 'Remove delegation authority for the rest of this task' });
}

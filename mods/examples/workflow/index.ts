import type { ModAPI } from '@oh-my-diff/mod-api/0.1';
export default function activate(api: ModAPI) {
  api.contract({
    schema: 1,
    id: 'paired_review',
    version: 1,
    requirements: {
      delegation: false,
      child_agents: false,
      opposite_lead: true,
      escalation: true,
      checkpoints: true,
      milestone_review: true,
      final_review: 'separate',
      completion: 'adversarial_separate',
    },
  });
  api.on('workflow', event => {
    api.state.set(event);
  });
  api.command('workflow', () => api.host.call('workflow.status', null), {
    description: 'Show the active workflow contract, its assurance label, and its provenance',
  });
  api.command('no_delegation', () => api.host.call('workflow.restrict', {
    operations: ['delegate', 'spawn_child_agent'],
    reason: 'this repository reviews every change in a pair instead of delegating',
  }), { description: 'Remove delegation authority for the rest of this task' });
}

import type { ModAPI } from '@oh-my-diff/mod-api';

const CHECKS = /^(cargo (check|test|clippy|fmt)|pnpm (test|run (check|lint|test)))\b/;

export default function activate(api: ModAPI) {
  api.middleware('approval', event => {
    if (event.kind !== 'exec' || event.host_decision === 'forbidden') return null;
    const command = (event.details as { command?: string[] }).command ?? [];
    const script = command.length >= 3 && /sh$/.test(command[0]) ? command[2] : command.join(' ');
    return CHECKS.test(script) && !/[;&|`$<>]/.test(script) ? { approve: `routine check: ${script}` } : null;
  });
}

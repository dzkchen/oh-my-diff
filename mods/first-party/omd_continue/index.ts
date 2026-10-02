import type { ModAPI, TurnActivity } from '../../api.d.ts';

const INSTRUCTION = 'Resume the interrupted task. First check the workspace, conversation and running processes to find the last completed step, partial edits and side effects. Continue from the first unfinished step without redoing or reverting finished work, then run the relevant verification.';

function list(values: string[]): string {
  const unique = [...new Set(values)];
  const shown = unique.slice(0, 8).join(', ');
  return unique.length > 8 ? `${shown} (+${unique.length - 8} more)` : shown;
}

function summary(turn: TurnActivity): string {
  const clip = (text: string) => text.replace(/\s+/g, ' ').slice(0, 120);
  const lines = [`- Last turn: ${turn.outcome}${turn.reason ? ` (${clip(turn.reason)})` : ''}`];
  const unfinished = turn.tool_calls.filter(call => call.finished_at === null || call.outcome === 'aborted')
    .map(call => `${call.tool} (${call.outcome ?? 'no recorded result'})`);
  const running = turn.processes.filter(item => item.running === true).map(item => `${item.kind} ${clip(item.command)}`);
  const files = turn.files.map(file => file.path);
  if (unfinished.length) lines.push(`- Unfinished tool calls: ${list(unfinished)}`);
  if (running.length) lines.push(`- Still running: ${list(running)}`);
  if (files.length) lines.push(`- Files changed in that turn: ${list(files)}`);
  if (turn.truncated) lines.push('- The host activity record for that turn is truncated.');
  return `Host-observed interruption summary:\n${lines.join('\n')}`;
}

export default function activate(api: ModAPI) {
  api.command('continue', value => {
    const note = typeof value === 'string' ? value.trim() : '';
    const activity = api.host.tryCall('turns.activity', { last: 1 });
    if (!activity.ok) return { display: `/continue is unavailable: ${activity.error}` };
    const turn = activity.value.turns[0];
    if (turn?.outcome === 'running') return { display: 'A turn is running. Use /continue after it stops.' };
    const interrupted = turn !== undefined && turn.outcome !== 'completed';
    if (!interrupted && !note) return { display: 'No interrupted or failed turn to continue. Use /continue <note> to continue anyway.' };
    return { submit: [INSTRUCTION, note && `Note: ${note}`, interrupted && summary(turn)].filter(Boolean).join('\n\n') };
  }, { description: 'Resume the interrupted task in this session' });
}

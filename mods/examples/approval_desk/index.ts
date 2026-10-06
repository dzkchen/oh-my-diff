import type { ModAPI, TerminalComponent, TerminalListRow, TerminalPatch } from '@oh-my-diff/mod-api';

const KINDS = ['exec', 'patch', 'network', 'mcp_tool', 'permissions'];
type Entry = { id: string; kind: string; summary: string; decision: string | null; source: string | null };
type State = { entries: Entry[]; kinds: string[]; note: string; inspected: string | null };

export default function activate(api: ModAPI) {
  const read = (): State => ({ entries: [], kinds: KINDS, note: '', inspected: null, ...(api.state.get() as Partial<State> | null) });
  const write = (patch: Partial<State>) => api.state.set({ ...read(), ...patch });

  api.middleware('approval', event => {
    const details = event.details as { command?: string[]; files?: string[]; host?: string };
    const summary = details.command?.join(' ') ?? details.files?.join(', ') ?? details.host ?? event.kind;
    const entries = read().entries.filter(entry => entry.id !== event.id);
    write({ entries: [{ id: event.id, kind: event.kind, summary: summary.slice(0, 200), decision: null, source: null }, ...entries].slice(0, 20) });
    return null;
  });

  api.on('approval_result', ({ id, decision, source }) => {
    write({ entries: read().entries.map(entry => (entry.id === id ? { ...entry, decision, source } : entry)) });
    api.host.tryCall('terminal.notice', { id: 'approval_desk', text: `Approval ${decision} by ${source}`, kind: decision.startsWith('approved') ? 'info' : 'warning', placement: 'toast', ttl_ms: 4000 });
  });

  api.on('terminal', (): TerminalPatch => {
    const s = read();
    const shown = s.entries.filter(entry => s.kinds.includes(entry.kind));
    const rows: TerminalListRow[] = shown.map(entry => ({ value: entry.id, label: entry.summary,
      spans: [{ text: entry.decision ?? 'pending', bold: true, tone: entry.decision === null ? 'attention' : entry.decision.startsWith('approved') ? 'success' : 'failure' },
        { text: ` ${entry.kind} ${entry.summary}`.slice(0, 200) }] }));
    const components: TerminalComponent[] = [
      { type: 'multiselect', id: 'desk_kinds', label: 'Kinds', value: s.kinds, hotkey: 'Alt+k',
        options: KINDS.map(kind => ({ value: kind, label: kind })), action: { command: 'approval_desk:kinds' } },
      { type: 'input', id: 'desk_note', label: 'Note', value: s.note, placeholder: 'note for reviewers', action: { command: 'approval_desk:note' } },
      { type: 'list', id: 'desk_log', label: 'Approvals', height: 6, rows, action: { command: 'approval_desk:inspect' } },
      { type: 'line', id: 'desk_help', label: 'Help', spans: [{ text: `${shown.length} shown; ` }, { text: 'approvals reference', link: 'https://developers.openai.com/codex/security', underline: true }] },
    ];
    const inspected = s.entries.find(entry => entry.id === s.inspected);
    if (inspected) components.push({ type: 'text', id: 'desk_detail', label: 'Detail', text: `${inspected.kind} ${inspected.summary}\n${inspected.decision ?? 'pending'}${inspected.source ? ` by ${inspected.source}` : ''}${s.note ? `\nnote: ${s.note}` : ''}` });
    return { sites: { sidebar: { mode: 'wrap', components: [...components, { type: 'slot' }] } } };
  });

  api.command('kinds', value => {
    const kinds = (Array.isArray(value) ? value : JSON.parse(String(value || '[]'))).filter((kind: unknown) => KINDS.includes(String(kind)));
    write({ kinds });
    return { display: `Showing ${kinds.join(', ') || 'no kinds'}` };
  });

  api.command('note', value => {
    write({ note: String(value ?? '').slice(0, 200) });
    return { display: 'Note saved' };
  });

  api.command('inspect', id => {
    const entry = read().entries.find(item => item.id === String(id));
    if (!entry) return { display: 'Approval not found' };
    write({ inspected: entry.id });
    return { display: `${entry.kind}: ${entry.decision ?? 'pending'}` };
  });

  api.on('component_event', ({ component, kind, values }) => {
    if (component === 'desk_kinds' && kind === 'change' && Array.isArray(values)) write({ kinds: values.filter(value => KINDS.includes(String(value))).map(String) });
  });
}

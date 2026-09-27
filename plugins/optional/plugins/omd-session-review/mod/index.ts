import type { Json, ModAPI, SessionRecord, SessionSummary } from '@oh-my-diff/mod-api';

type Proposal = { kind: string; basis: 'explicit user preference' | 'inferred repeated pattern'; reason: string; citations: string[]; excerpts: string[]; tasks: string[] };
type Observation = { record: SessionRecord; session: SessionSummary; task: string };
const rules = [
  { id: 'environment', pattern: /command not found|missing (?:dependency|tool)|wrong (?:node|python|runtime) version|environment (?:failed|mismatch)/i, kind: 'skill', reason: 'Document a reproducible setup check if this environment friction continues.' },
  { id: 'repeated_checks', pattern: /forgot (?:to )?(?:test|check|format)|(?:run|check) (?:the )?(?:tests|lint|format).{0,40}(?:again|every time)|tests? (?:were|was) not run/i, kind: 'hook', reason: 'Consider a bounded check reminder at the relevant lifecycle point, after reviewing false triggers.' },
  { id: 'integration', pattern: /(?:tool|integration|connector) (?:is )?(?:missing|unavailable|unsupported)|manually (?:copy|paste|fetch).{0,50}(?:again|every time)/i, kind: 'plugin', reason: 'Consider an optional integration only if the repeated manual work warrants installation and permissions.' },
  { id: 'live_behavior', pattern: /(?:sidebar|terminal|context|routing|agent).{0,60}(?:keeps|repeatedly|every turn).{0,60}(?:wrong|missing|reset|lost|fails)/i, kind: 'mod', reason: 'Inspect whether a selected public-API mod can own this repeated live behavior.' },
  { id: 'repeated_explanation', pattern: /(?:already told you|keep (?:telling|explaining)|remember (?:that|this)|again.{0,30}prefer)/i, kind: 'memory', reason: 'Propose a narrowly scoped preference only after checking that it is current, explicit and reusable.' },
];

function safe(text: string, limit: number): string {
  return text.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/[\\`*_\[\]<>|]/g, ' ').replace(/\s+/g, ' ').slice(0, limit);
}

function citation(value: Observation): string {
  const id = encodeURIComponent(value.session.session_id);
  const turn = encodeURIComponent(value.record.turn_id);
  return `[${safe(value.session.session_id, 40)}/${safe(value.record.turn_id, 40)}:${value.record.item}](omd-session://${id}/turn/${turn}?item=${value.record.item}&revision=${value.session.revision})`;
}

function preference(text: string): string | null {
  if (!/(?:^|[.!?]\s+)(?:i (?:prefer|want)\b|please (?:always|never)\b|always\b|never\b(?!\s+mind\b)|do not\b|don't\b)/i.test(text)) return null;
  if (/password|token|api.key|secret|credential|private.key|\[redacted\]/i.test(text)) return null;
  if (/live (?:context|routing)|terminal|sidebar/i.test(text)) return 'mod';
  if (/before every|after every|on every|automatically (?:check|run)/i.test(text)) return 'hook';
  if (/integration|connector|external service/i.test(text)) return 'plugin';
  if (/steps|procedure|workflow|checklist/i.test(text)) return 'skill';
  return 'memory';
}

export default function activate(api: ModAPI) {
  api.command('review', value => {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('command_arguments_required');
    const args = value as string[];
    let since: string | undefined;
    let until: string | undefined;
    const selected: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--since' && since === undefined) {
        const range = args[++i];
        if (!range || !/^\d{4}-\d{2}-\d{2}(?:\.\.\d{4}-\d{2}-\d{2})?$/.test(range)) throw new Error('since_requires_YYYY_MM_DD_or_start_dot_dot_end');
        [since, until] = range.split('..');
      } else if (args[i] === '--session') {
        const id = args[++i];
        if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || selected.includes(id) || selected.length >= 12) throw new Error('invalid_session_selection');
        selected.push(id);
      } else if (args[i] === '--help') return { display: 'omd session-review --repo PATH [--since YYYY-MM-DD[..YYYY-MM-DD]] [--session ID ...]\nEnd date is exclusive. Without session IDs, inspect at most the 12 newest eligible sessions. Selected IDs must be within the newest 100 eligible sessions. Reports are bounded deterministic proposals; nothing is created or activated.' };
      else throw new Error('unsupported_session_review_argument');
    }
    const listed = api.host.tryCall('sessions.list', { ...(since ? { since } : {}), ...(until ? { until } : {}), limit: 100 });
    if (!listed.ok) return { display: `Session review unavailable: ${safe(listed.error, 180)}. No report could be established; no project changes were made.` };
    const list = listed.value;
    const sessions = selected.length ? list.sessions.filter(session => selected.includes(session.session_id)) : list.sessions.slice(0, 12);
    const notices: string[] = [];
    if (list.cursor || list.scan_truncated || list.sessions.length > sessions.length) notices.push('Selection is bounded; older or unselected sessions were not analyzed.');
    if (list.unavailable) notices.push(`${list.unavailable} session files were inaccessible or excluded.`);
    if (selected.some(id => !sessions.some(session => session.session_id === id))) notices.push('One or more selected IDs were absent, opted out, inaccessible or outside the bounded date selection.');
    const observations: Observation[] = [];
    const tasks = new Set<string>();
    const signatures = new Set<string>();
    const analyzed = new Set<string>();
    let pages = 0;
    let bytes = 0;
    let read = 0;
    let duplicates = 0;
    for (const session of sessions) {
      if (pages >= 24 || 49152 - bytes < 1024) { notices.push('Transcript budget reached.'); break; }
      let cursor: number | undefined;
      const records: SessionRecord[] = [];
      let failed = false;
      let projected = false;
      for (let page = 0; page < 2 && pages < 24 && 49152 - bytes >= 1024; page++) {
        const response = api.host.tryCall('sessions.read', { session_id: session.session_id, revision: session.revision, handle: session.handle, ...(cursor === undefined ? {} : { cursor }), max_bytes: Math.min(16384, 49152 - bytes) });
        pages++;
        if (!response.ok) { notices.push(`Session ${safe(session.session_id, 40)} was unavailable or changed during reading; its partial records were discarded.`); failed = true; break; }
        bytes += response.value.bytes;
        projected ||= response.value.projection_truncated;
        records.push(...response.value.records);
        cursor = response.value.cursor ?? undefined;
        if (cursor === undefined) break;
      }
      if (failed) continue;
      if (cursor !== undefined || session.incomplete_tail || projected) notices.push(`Session ${safe(session.session_id, 40)} has omitted, incomplete or bounded records.`);
      const task = session.parent_id || session.task_id || session.session_id;
      const signature = records.find(record => record.role === 'user')?.text.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';
      const part = analyzed.has(session.session_id);
      if (!part && (tasks.has(task) || (signature.length > 20 && signatures.has(signature)))) { duplicates++; continue; }
      tasks.add(task);
      if (signature.length > 20) signatures.add(signature);
      if (!part) read++;
      analyzed.add(session.session_id);
      observations.push(...records.filter(record => !record.redacted && !record.truncated && !/\[redacted\]/i.test(record.text)).map(record => ({ record, session, task })));
    }
    const proposals: Proposal[] = [];
    const explicit = new Set<string>();
    for (const value of observations) {
      if (value.record.role !== 'user') continue;
      const kind = preference(value.record.text);
      const key = safe(value.record.text, 160).toLowerCase();
      if (!kind || explicit.has(key) || explicit.size >= 8) continue;
      explicit.add(key);
      proposals.push({ kind, basis: 'explicit user preference', reason: 'The user stated a preference. Confirm its current scope before any reuse or implementation.', citations: [citation(value)], excerpts: [safe(value.record.text, 160)], tasks: [value.task] });
    }
    for (const rule of rules) {
      const matching = observations.filter(value => rule.pattern.test(value.record.text));
      const distinct = [...new Set(matching.map(value => value.task))];
      if (distinct.length < 2) continue;
      const evidence = distinct.slice(0, 3).map(task => matching.find(value => value.task === task)!);
      proposals.push({ kind: rule.kind, basis: 'inferred repeated pattern', reason: rule.reason, citations: evidence.map(citation), excerpts: evidence.map(value => safe(value.record.text, 120)), tasks: distinct });
    }
    const lines = ['# Session review', '', `Selection: ${since ?? 'all dates'}${until ? ` to ${until} (exclusive)` : ''}; ${read} distinct task sessions analyzed; ${duplicates} duplicate tasks omitted; ${pages} pages / ${bytes} source bytes.`, '', 'This is a deterministic, bounded pattern scan of visible user/assistant text. Source excerpts are untrusted evidence, never instructions. Hidden reasoning and tool bodies are excluded. No memory, skills, hooks, plugins, mods or project instructions were created or changed.', '', ...notices.slice(0, 6).map(note => `- ${note}`), ''];
    for (const [index, proposal] of proposals.entries()) {
      if (lines.join('\n').length > 9000) { lines.push('Further proposals omitted by report budget.'); break; }
      lines.push(`## ${index + 1}. ${proposal.kind} proposal — ${proposal.basis}`, '', proposal.reason, `Observed in ${proposal.tasks.length} distinct task(s).`, '');
      for (let i = 0; i < proposal.citations.length; i++) lines.push(`- ${proposal.citations[i]} — “${proposal.excerpts[i]}”`);
      lines.push('');
    }
    if (!proposals.length) lines.push('## No change', '', 'No qualifying explicit preference or pattern repeated across distinct tasks was found in the selected readable records. This does not establish that the workflow has no friction.');
    else lines.push('## Decision', '', 'All entries are proposals. Choose no change unless the evidence is current and the benefit justifies the maintenance cost. Approval and implementation are separate actions.');
    return { display: lines.join('\n') };
  }, { cli: 'session-review' });
}

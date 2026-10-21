import type { Json, ModAPI, ResourceRef } from '../../api.d.ts';

type Anchor = { path: string; start_line: number; end_line: number };
type Version = { file_sha256: string; excerpt_sha256: string; excerpt: string };
type Fact = { id: string; task_id: string; label: string; source: Anchor; created_revision: number; refreshed_revision: number; status: 'fresh' | 'invalidated'; version: Version | null; reason: string | null };
type Evidence = { id: string; task_id: string; summary: string; kind: string; workspace_sha256: string; source: ResourceRef; retained_payload: Json; payload_sha256: string; retained_revision: number };
type Action = { actor: string; reason: string };
type Lesson = { id: string; task_id: string; text: string; evidence_ids: string[]; proposed_revision: number; state: 'candidate' | 'approved'; action: Action | null; approved_revision: number | null };
type Body = { schema: 2; repository_identity: string; generation: number; revision: number; facts: Fact[]; evidence: Evidence[]; lessons: Lesson[] };
type State = Body & { integrity_sha256: string };

const KEY = 'source_knowledge.facts.v1';
const SHA = /^[0-9a-f]{64}$/;
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const IDENTITY = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,255}$/;
const MAX_FACTS = 16;
const MAX_EVIDENCE = 8;
const MAX_LESSONS = 8;
const MAX_EVIDENCE_BYTES = 8192;
const MAX_FILE_BYTES = 48 * 1024;
const MAX_EXCERPT_BYTES = 32768;
const MAX_CONTEXT_BYTES = 131072;
const MAX_STORE_BYTES = 32 * 1024;

function object(input: Json): Record<string, Json> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('knowledge_input_invalid');
  return input;
}

function text(value: Json, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > max || secret(value)) throw new Error(`${label}_invalid`);
  return value;
}

function identity(input: Json): string {
  const value = text(object(input).repository_identity, 256, 'knowledge_identity');
  if (!IDENTITY.test(value) || value.split('/').some(part => part === '.' || part === '..')) throw new Error('knowledge_identity_invalid');
  return value;
}

function pathValid(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.startsWith('/') && !path.includes('\\')
    && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

function anchor(input: Json): Anchor {
  const value = object(input);
  const path = value.path;
  const start = value.start_line;
  const end = value.end_line;
  if (!pathValid(path) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 1
    || (end as number) < (start as number) || (end as number) - (start as number) >= 200) throw new Error('knowledge_anchor_invalid');
  return { path, start_line: start as number, end_line: end as number };
}

function token(input: Json, label: string): string {
  const value = text(input, 128, label);
  if (!TOKEN.test(value)) throw new Error(`${label}_invalid`);
  return value;
}

function reference(input: Json): ResourceRef {
  const value = object(input);
  if (typeof value.reference !== 'string' || !SHA.test(value.reference) || value.reference !== value.sha256) throw new Error('knowledge_reference_invalid');
  return { reference: value.reference, sha256: value.reference };
}

function revision(input: Json, current: number): void {
  if (!Number.isSafeInteger(input) || (input as number) < 0) throw new Error('knowledge_revision_invalid');
  if (input !== current) throw new Error('knowledge_revision_stale');
}

function used(state: State, id: string): boolean {
  return [...state.facts, ...state.evidence, ...state.lessons].some(item => item.id === id);
}

function action(input: Json): Action {
  const value = object(input);
  if (Object.keys(value).sort().join(',') !== 'actor,reason') throw new Error('knowledge_action_invalid');
  return { actor: text(value.actor, 256, 'knowledge_actor'), reason: text(value.reason, 4096, 'knowledge_reason') };
}

function command(input: Json, fields: string): Record<string, Json> {
  let payload = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length < 2 || trimmed.length > 8192 || /[\r\n]/.test(trimmed)) throw new Error('knowledge_command_invalid');
    try { payload = JSON.parse(trimmed) as Json; } catch { throw new Error('knowledge_command_invalid'); }
    if (JSON.stringify(payload) !== trimmed) throw new Error('knowledge_command_noncanonical');
  }
  const value = object(payload);
  if (Object.keys(value).sort().join(',') !== fields) throw new Error('knowledge_command_invalid');
  return value;
}

function secret(value: string): boolean {
  let privateKey = false;
  return value.split(/\r?\n/).some(line => {
    const lower = line.toLowerCase();
    if (lower.includes('-----begin') && lower.includes('private key-----')) privateKey = true;
    const sensitive = privateKey
      || ['authorization:', 'authorization=', 'bearer ', 'api_key', 'api-key', 'apikey', 'access_token', 'refresh_token', 'client_secret', 'password=', 'password:', 'password"', 'secret=', 'secret:'].some(needle => lower.includes(needle))
      || /(^|[^a-z0-9])(sk-|ghp_|gho_|github_pat_|xoxb-|xoxp-)/.test(lower);
    if (lower.includes('-----end') && lower.includes('private key-----')) privateKey = false;
    return sensitive;
  });
}

function bytes(value: string): Uint8Array {
  const encoded = encodeURIComponent(value).replace(/%([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Uint8Array.from(encoded, character => character.charCodeAt(0));
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes(value) as BufferSource);
  return Array.from(new Uint8Array(hash), item => item.toString(16).padStart(2, '0')).join('');
}

function canonical(input: Json): Json {
  if (Array.isArray(input)) return input.map(canonical);
  if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => [key, canonical(value)]));
  return input;
}

async function hashJson(input: Json): Promise<string> { return digest(JSON.stringify(canonical(input))); }

function body(state: State): Body {
  return { schema: 2, repository_identity: state.repository_identity, generation: state.generation, revision: state.revision,
    facts: state.facts, evidence: state.evidence, lessons: state.lessons };
}

async function seal(body: Body): Promise<State> {
  const result = { ...body, integrity_sha256: await hashJson(body as unknown as Json) };
  if (bytes(JSON.stringify(result)).length > MAX_STORE_BYTES) throw new Error('knowledge_state_limit');
  return result;
}

async function stored(api: ModAPI, repository_identity: string): Promise<{ state: State; store_revision: number | null }> {
  const entry = api.host.call('store.get', { key: KEY, scope: 'repository' });
  if (!entry) return { state: await seal({ schema: 2, repository_identity, generation: 0, revision: 0, facts: [], evidence: [], lessons: [] }), store_revision: null };
  const value = entry.value as unknown as State;
  if (!value || value.schema !== 2 || value.repository_identity !== repository_identity || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Number.isSafeInteger(value.generation) || value.generation < 0
    || !Array.isArray(value.facts) || value.facts.length > MAX_FACTS
    || value.facts.some(fact => !fact || !TOKEN.test(fact.id) || !TOKEN.test(fact.task_id) || typeof fact.label !== 'string' || fact.label.length > 1024
      || secret(fact.label) || !pathValid(fact.source?.path) || !Number.isSafeInteger(fact.source.start_line)
      || !Number.isSafeInteger(fact.source.end_line) || !Number.isSafeInteger(fact.created_revision) || !Number.isSafeInteger(fact.refreshed_revision)
      || fact.created_revision < 1 || fact.refreshed_revision < fact.created_revision || fact.refreshed_revision > value.revision
      || !['fresh', 'invalidated'].includes(fact.status) || (fact.status === 'fresh' && (!fact.version || !SHA.test(fact.version.file_sha256)
        || !SHA.test(fact.version.excerpt_sha256) || typeof fact.version.excerpt !== 'string' || secret(fact.version.excerpt)))
      || (fact.status === 'invalidated' && fact.version !== null))
    || !Array.isArray(value.evidence) || value.evidence.length > MAX_EVIDENCE
    || value.evidence.some(item => !item || !TOKEN.test(item.id) || !TOKEN.test(item.task_id) || typeof item.summary !== 'string'
      || item.summary.length > 1024 || secret(item.summary) || !TOKEN.test(item.kind) || !SHA.test(item.workspace_sha256)
      || !item.source || item.source.reference !== item.source.sha256 || !SHA.test(item.source.sha256)
      || !SHA.test(item.payload_sha256) || !Number.isSafeInteger(item.retained_revision) || item.retained_revision < 1
      || item.retained_revision > value.revision || bytes(JSON.stringify(item.retained_payload)).length > MAX_EVIDENCE_BYTES
      || secret(JSON.stringify(item.retained_payload)))
    || !Array.isArray(value.lessons) || value.lessons.length > MAX_LESSONS
    || value.lessons.some(item => !item || !TOKEN.test(item.id) || !TOKEN.test(item.task_id) || typeof item.text !== 'string'
      || item.text.length > 4096 || secret(item.text) || !Array.isArray(item.evidence_ids) || item.evidence_ids.length < 1
      || item.evidence_ids.length > MAX_EVIDENCE || item.evidence_ids.some(id => !TOKEN.test(id))
      || new Set(item.evidence_ids).size !== item.evidence_ids.length || !Number.isSafeInteger(item.proposed_revision)
      || item.proposed_revision < 1 || item.proposed_revision > value.revision || !['candidate', 'approved'].includes(item.state)
      || (item.state === 'candidate' && (item.action !== null || item.approved_revision !== null))
      || (item.state === 'approved' && (!item.action || typeof item.action.actor !== 'string' || typeof item.action.reason !== 'string'
        || !Number.isSafeInteger(item.approved_revision) || item.approved_revision! <= item.proposed_revision || item.approved_revision! > value.revision)))
    || new Set([...value.facts, ...value.evidence, ...value.lessons].map(item => item.id)).size !== value.facts.length + value.evidence.length + value.lessons.length
    || value.integrity_sha256 !== await hashJson(body(value) as unknown as Json)) throw new Error('knowledge_state_invalid');
  for (const item of value.evidence) if (item.payload_sha256 !== await hashJson(item.retained_payload)) throw new Error('knowledge_state_invalid');
  return { state: value, store_revision: entry.revision };
}

async function sourceVersion(source_anchor: Anchor, stat: { kind: 'file' | 'dir' | 'symlink'; size: number } | null,
  file: { text: string; sha256: string } | null): Promise<{ version: Version | null; reason: string | null }> {
  if (!stat) return { version: null, reason: 'source_missing' };
  if (stat.kind !== 'file' || !Number.isSafeInteger(stat.size) || stat.size > MAX_FILE_BYTES) return { version: null, reason: 'source_unavailable' };
  if (!file) return { version: null, reason: 'source_missing' };
  if (!SHA.test(file.sha256) || bytes(file.text).length !== stat.size || await digest(file.text) !== file.sha256) throw new Error('knowledge_source_stale');
  const lines = file.text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (source_anchor.end_line > lines.length) return { version: null, reason: 'source_range_missing' };
  const excerpt = lines.slice(source_anchor.start_line - 1, source_anchor.end_line).join('\n');
  if (!excerpt.trim() || excerpt.trim() !== excerpt || bytes(excerpt).length > MAX_EXCERPT_BYTES || secret(excerpt)) return { version: null, reason: 'source_excluded' };
  return { version: { file_sha256: file.sha256, excerpt_sha256: await digest(excerpt), excerpt }, reason: null };
}

async function source(api: ModAPI, source_anchor: Anchor): Promise<{ version: Version | null; reason: string | null }> {
  const stat = api.host.call('workspace.stat', { paths: [source_anchor.path] }).files[source_anchor.path];
  const file = stat?.kind === 'file' && stat.size <= MAX_FILE_BYTES
    ? api.host.call('workspace.read', { paths: [source_anchor.path] }).files[source_anchor.path] : null;
  const result = await sourceVersion(source_anchor, stat, file);
  if (result.version) {
    const after = api.host.call('workspace.stat', { paths: [source_anchor.path], hash: true }).files[source_anchor.path];
    if (after?.kind !== 'file' || after.size !== stat?.size || after.sha256 !== file?.sha256) throw new Error('knowledge_source_stale');
    api.host.call('workspace.check_access', { paths: [source_anchor.path] });
  }
  return result;
}

async function retain(api: ModAPI, input: Json): Promise<Json> {
  const value = object(input);
  const repository_identity = identity(input);
  const id = text(value.id, 128, 'knowledge_id');
  const task_id = text(value.task_id, 128, 'knowledge_task');
  const label = text(value.label, 1024, 'knowledge_label');
  if (!TOKEN.test(id) || !TOKEN.test(task_id)) throw new Error('knowledge_token_invalid');
  const source_anchor = anchor(value.source);
  if (!Number.isSafeInteger(value.expected_revision) || (value.expected_revision as number) < 0) throw new Error('knowledge_revision_invalid');
  const { state, store_revision } = await stored(api, repository_identity);
  if (value.expected_revision !== state.revision) throw new Error('knowledge_revision_stale');
  if (state.facts.length >= MAX_FACTS || used(state, id)) throw new Error('knowledge_fact_unavailable');
  const before = api.host.call('workspace.fingerprint', {});
  if (!SHA.test(before.candidate_sha256)) throw new Error('knowledge_candidate_invalid');
  const current = await source(api, source_anchor);
  if (!current.version) throw new Error(`knowledge_${current.reason}`);
  api.host.call('workspace.fingerprint', { expected: before.candidate_sha256 });
  const revision = state.revision + 1;
  const fact: Fact = { id, task_id, label, source: source_anchor, created_revision: revision, refreshed_revision: revision,
    status: 'fresh', version: current.version, reason: null };
  const saved = await seal({ ...body(state), revision, facts: [...state.facts, fact].sort((a, b) => a.id < b.id ? -1 : 1) });
  api.host.call('store.put', { key: KEY, scope: 'repository', expected_revision: store_revision, value: saved as unknown as Exclude<Json, null> });
  return { fact, revision, candidate_sha256: before.candidate_sha256 } as Json;
}

async function retainEvidence(api: ModAPI, input: Json): Promise<Json> {
  const value = object(input);
  const repository_identity = identity(input);
  const id = token(value.id, 'knowledge_id');
  const task_id = token(value.task_id, 'knowledge_task');
  const summary = text(value.summary, 1024, 'knowledge_summary');
  const kind = token(value.kind, 'knowledge_kind');
  const source = reference(value.reference);
  const { state, store_revision } = await stored(api, repository_identity);
  revision(value.expected_revision, state.revision);
  if (state.evidence.length >= MAX_EVIDENCE || used(state, id)) throw new Error('knowledge_evidence_unavailable');
  const before = api.host.call('workspace.fingerprint', {});
  if (!SHA.test(before.candidate_sha256)) throw new Error('knowledge_candidate_invalid');
  const page = api.host.call('evidence.read', { reference: source, max_bytes: MAX_EVIDENCE_BYTES });
  if (page.reference.reference !== source.reference || page.reference.sha256 !== source.sha256 || page.cursor !== null
    || typeof page.text !== 'string' || !Number.isSafeInteger(page.bytes) || page.bytes < 1 || page.bytes > MAX_EVIDENCE_BYTES
    || bytes(page.text).length !== page.bytes || secret(page.text)) throw new Error('knowledge_evidence_invalid');
  let retained_payload: Json;
  try { retained_payload = JSON.parse(page.text) as Json; } catch { throw new Error('knowledge_evidence_invalid'); }
  if (retained_payload === null || typeof retained_payload !== 'object') throw new Error('knowledge_evidence_invalid');
  api.host.call('workspace.fingerprint', { expected: before.candidate_sha256 });
  const next = state.revision + 1;
  const item: Evidence = { id, task_id, summary, kind, workspace_sha256: before.candidate_sha256, source,
    retained_payload, payload_sha256: await hashJson(retained_payload), retained_revision: next };
  const saved = await seal({ ...body(state), revision: next, evidence: [...state.evidence, item].sort((a, b) => a.id < b.id ? -1 : 1) });
  api.host.call('store.put', { key: KEY, scope: 'repository', expected_revision: store_revision, value: saved as unknown as Exclude<Json, null> });
  return { evidence: item, revision: next, candidate_sha256: before.candidate_sha256 } as Json;
}

async function proposeLesson(api: ModAPI, input: Json): Promise<Json> {
  const value = object(input);
  const repository_identity = identity(input);
  const id = token(value.id, 'knowledge_id');
  const task_id = token(value.task_id, 'knowledge_task');
  const lesson_text = text(value.text, 4096, 'knowledge_lesson');
  if (!Array.isArray(value.evidence_ids) || value.evidence_ids.length < 1 || value.evidence_ids.length > MAX_EVIDENCE) throw new Error('knowledge_evidence_ids_invalid');
  const evidence_ids = value.evidence_ids.map(id => token(id, 'knowledge_evidence_id'));
  if (new Set(evidence_ids).size !== evidence_ids.length) throw new Error('knowledge_evidence_ids_invalid');
  const { state, store_revision } = await stored(api, repository_identity);
  revision(value.expected_revision, state.revision);
  if (state.lessons.length >= MAX_LESSONS || used(state, id)
    || evidence_ids.some(id => !state.evidence.some(item => item.id === id))) throw new Error('knowledge_lesson_unavailable');
  const next = state.revision + 1;
  const lesson: Lesson = { id, task_id, text: lesson_text, evidence_ids, proposed_revision: next, state: 'candidate', action: null, approved_revision: null };
  const saved = await seal({ ...body(state), revision: next, lessons: [...state.lessons, lesson].sort((a, b) => a.id < b.id ? -1 : 1) });
  api.host.call('store.put', { key: KEY, scope: 'repository', expected_revision: store_revision, value: saved as unknown as Exclude<Json, null> });
  return { lesson, revision: next } as Json;
}

async function approveLesson(api: ModAPI, input: Json): Promise<Json> {
  const value = command(input, 'action,expected_revision,lesson_id,repository_identity');
  const repository_identity = identity(value as Json);
  const lesson_id = token(value.lesson_id, 'knowledge_lesson_id');
  const approved = action(value.action);
  const { state, store_revision } = await stored(api, repository_identity);
  revision(value.expected_revision, state.revision);
  const target = state.lessons.find(item => item.id === lesson_id);
  if (!target || target.state !== 'candidate' || target.evidence_ids.some(id => !state.evidence.some(item => item.id === id))) throw new Error('knowledge_approval_unavailable');
  const next = state.revision + 1;
  const lessons = state.lessons.map(item => item.id === lesson_id ? { ...item, state: 'approved' as const, action: approved, approved_revision: next } : item);
  const saved = await seal({ ...body(state), revision: next, lessons });
  api.host.call('store.put', { key: KEY, scope: 'repository', expected_revision: store_revision, value: saved as unknown as Exclude<Json, null> });
  return { display: `Knowledge lesson ${lesson_id} approved at revision ${next}` };
}

async function remove(api: ModAPI, input: Json): Promise<Json> {
  const value = command(input, 'action,expected_revision,id,kind,repository_identity');
  const repository_identity = identity(value as Json);
  const id = token(value.id, 'knowledge_id');
  action(value.action);
  if (value.kind !== 'fact' && value.kind !== 'evidence' && value.kind !== 'lesson') throw new Error('knowledge_kind_invalid');
  const { state, store_revision } = await stored(api, repository_identity);
  revision(value.expected_revision, state.revision);
  const field = value.kind === 'fact' ? state.facts : value.kind === 'evidence' ? state.evidence : state.lessons;
  if (!field.some(item => item.id === id)) throw new Error('knowledge_record_missing');
  const next = state.revision + 1;
  const lessons = value.kind === 'evidence' ? state.lessons.map(item => item.evidence_ids.includes(id)
    ? { ...item, state: 'candidate' as const, action: null, approved_revision: null } : item) : state.lessons;
  const saved = await seal({ ...body(state), revision: next, lessons, [value.kind === 'fact' ? 'facts' : value.kind === 'evidence' ? 'evidence' : 'lessons']:
    field.filter(item => item.id !== id) });
  api.host.call('store.put', { key: KEY, scope: 'repository', expected_revision: store_revision, value: saved as unknown as Exclude<Json, null> });
  return { display: `Knowledge ${value.kind} ${id} removed at revision ${next}` };
}

async function reset(api: ModAPI, input: Json): Promise<Json> {
  const value = command(input, 'action,expected_revision,repository_identity');
  const repository_identity = identity(value as Json);
  action(value.action);
  const { state, store_revision } = await stored(api, repository_identity);
  revision(value.expected_revision, state.revision);
  const next = state.revision + 1;
  const generation = state.generation + 1;
  const saved = await seal({ schema: 2, repository_identity, generation, revision: next, facts: [], evidence: [], lessons: [] });
  api.host.call('store.put', { key: KEY, scope: 'repository', expected_revision: store_revision, value: saved as unknown as Exclude<Json, null> });
  return { display: `Knowledge reset to generation ${generation} at revision ${next}` };
}

async function session(api: ModAPI, input: Json, inspect: boolean): Promise<Json> {
  const value = object(input);
  const repository_identity = identity(input);
  const mode = inspect ? 'reuse' : value.mode;
  if (mode !== 'cold' && mode !== 'reuse') throw new Error('knowledge_mode_invalid');
  const max_context_bytes = value.max_context_bytes === undefined ? MAX_CONTEXT_BYTES : value.max_context_bytes;
  if (typeof max_context_bytes !== 'number' || !Number.isSafeInteger(max_context_bytes) || max_context_bytes < 1 || max_context_bytes > MAX_CONTEXT_BYTES) throw new Error('knowledge_context_limit_invalid');
  const { state, store_revision } = await stored(api, repository_identity);
  if (mode === 'cold') return { schema: 2, mode, repository_identity, generation: state.generation, revision: state.revision,
    refreshed_fact_ids: [], invalidated_ids: [], facts: [], approved_lessons: [] } as Json;
  const before = api.host.call('workspace.fingerprint', {});
  if (!SHA.test(before.candidate_sha256)) throw new Error('knowledge_candidate_invalid');
  const facts: Fact[] = [];
  const refreshed: string[] = [];
  const invalidated: string[] = [];
  const paths = [...new Set(state.facts.map(fact => fact.source.path))];
  const stats = paths.length ? api.host.call('workspace.stat', { paths }).files : {};
  let budget = MAX_FILE_BYTES;
  const readable = paths.filter(path => stats[path]?.kind === 'file' && stats[path]!.size <= budget && (budget -= stats[path]!.size) >= 0);
  const files = readable.length ? api.host.call('workspace.read', { paths: readable }).files : {};
  if (readable.length) {
    const final = api.host.call('workspace.stat', { paths: readable, hash: true }).files;
    for (const path of readable) if (final[path]?.kind !== 'file' || final[path]?.size !== stats[path]?.size
      || final[path]?.sha256 !== files[path]?.sha256) throw new Error('knowledge_source_stale');
    api.host.call('workspace.check_access', { paths: readable });
  }
  for (const fact of state.facts) {
    const current = stats[fact.source.path] && !readable.includes(fact.source.path) ? { version: null, reason: 'source_unavailable' }
      : await sourceVersion(fact.source, stats[fact.source.path] || null, files[fact.source.path] || null);
    const status = current.version ? 'fresh' : 'invalidated';
    const changed = fact.status !== status || JSON.stringify(canonical(fact.version)) !== JSON.stringify(canonical(current.version)) || fact.reason !== current.reason;
    if (changed) refreshed.push(fact.id);
    if (!current.version) invalidated.push(fact.id);
    facts.push({ ...fact, status, version: current.version, reason: current.reason,
      refreshed_revision: changed ? state.revision + 1 : fact.refreshed_revision });
  }
  api.host.call('workspace.fingerprint', { expected: before.candidate_sha256 });
  const revision = state.revision + (refreshed.length ? 1 : 0);
  const visible = facts.filter(fact => inspect || fact.status === 'fresh');
  const approved_lessons = state.lessons.filter(lesson => (inspect || lesson.state === 'approved')
    && (inspect || lesson.evidence_ids.every(id => state.evidence.some(item => item.id === id))));
  const result = { schema: 2, mode, repository_identity, generation: state.generation, revision, refreshed_fact_ids: refreshed, invalidated_ids: invalidated,
    facts: visible, approved_lessons: inspect ? state.lessons.filter(lesson => lesson.state === 'approved') : approved_lessons,
    ...(inspect ? { evidence: state.evidence, lessons: state.lessons } : {}), candidate_sha256: before.candidate_sha256 };
  if (bytes(JSON.stringify(result)).length > max_context_bytes) throw new Error('knowledge_context_limit');
  if (refreshed.length) {
    const saved = await seal({ ...body(state), revision, facts });
    api.host.call('store.put', { key: KEY, scope: 'repository', expected_revision: store_revision, value: saved as unknown as Exclude<Json, null> });
  }
  return result as Json;
}

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
  const common = { repository_identity: { type: 'string' } };
  tool({ name: 'retain_source', description: 'Retain a bounded source-backed fact with an exact file and line range.',
    parameters: { type: 'object', properties: { ...common, expected_revision: { type: 'integer' }, id: { type: 'string' }, task_id: { type: 'string' },
      label: { type: 'string' }, source: { type: 'object' } }, required: ['repository_identity', 'expected_revision', 'id', 'task_id', 'label', 'source'], additionalProperties: false } },
  input => retain(api, input));
  tool({ name: 'retain_evidence', description: 'Retain a bounded copy of current-thread evidence for repository reuse.',
    parameters: { type: 'object', properties: { ...common, expected_revision: { type: 'integer' }, id: { type: 'string' }, task_id: { type: 'string' },
      summary: { type: 'string' }, kind: { type: 'string' }, reference: { type: 'object' } },
      required: ['repository_identity', 'expected_revision', 'id', 'task_id', 'summary', 'kind', 'reference'], additionalProperties: false } },
  input => retainEvidence(api, input));
  tool({ name: 'propose_lesson', description: 'Propose an inert lesson backed by retained evidence.',
    parameters: { type: 'object', properties: { ...common, expected_revision: { type: 'integer' }, id: { type: 'string' }, task_id: { type: 'string' },
      text: { type: 'string' }, evidence_ids: { type: 'array', items: { type: 'string' } } },
      required: ['repository_identity', 'expected_revision', 'id', 'task_id', 'text', 'evidence_ids'], additionalProperties: false } },
  input => proposeLesson(api, input));
  tool({ name: 'session', description: 'Return cold or refreshed reusable source facts; invalidated facts never enter reuse context.',
    parameters: { type: 'object', properties: { ...common, mode: { type: 'string', enum: ['cold', 'reuse'] }, max_context_bytes: { type: 'integer' } },
      required: ['repository_identity', 'mode'], additionalProperties: false } }, input => session(api, input, false));
  tool({ name: 'inspect', description: 'Inspect current source facts, including invalidation status and provenance.',
    parameters: { type: 'object', properties: { ...common, max_context_bytes: { type: 'integer' } }, required: ['repository_identity'], additionalProperties: false } },
  input => session(api, input, true));
  command('approve_lesson', input => approveLesson(api, input), { description: 'Approve an exact retained lesson with an explicit action and revision' });
  command('forget', input => remove(api, input), { description: 'Remove an exact retained record with an explicit action and revision' });
  command('discard', input => reset(api, input), { description: 'Reset retained knowledge with an explicit action and revision' });
}

import type { Json, ModAPI, ResourceRef } from '../../api.d.ts';

type Rule = { id: string; text: string };
type Variant = { kind: 'full_checklist'; checklist: Rule[] } | { kind: 'tiny_core'; core: Rule[]; selected_rules: Rule[] };
type Evidence = { task_id: string; reference: ResourceRef; split: 'development' | 'validation' };
type Proposal = { schema: 1; version: string; replaces: string | null; rationale: string; variant: Variant; development_evidence: Evidence[] };
type Validation = { schema: 1; id: string; proposal_version: string; proposal_sha256: string; validator: string; outcome: 'passed' | 'failed'; summary: string; validation_evidence: Evidence[] };
type Selection = { version: string; proposal_sha256: string };
type Action = { actor: string; reason: string };
type ProposalEntry = { proposal: Proposal; sha256: string; receipt: ResourceRef; candidate_sha256: string };
type ValidationEntry = { validation: Validation; sha256: string; receipt: ResourceRef; candidate_sha256: string };
type Transition = { revision: number; kind: 'promotion' | 'rollback'; from: Selection | null; to: Selection | null; validation_id: string | null; validation_sha256: string | null; maintainer: Action };
type Body = { schema: 1; revision: number; proposals: ProposalEntry[]; validations: ValidationEntry[]; active: Selection | null; rollback: (Selection | null)[]; transitions: Transition[] };
type State = Body & { integrity_sha256: string };

const KEY = 'guideline.governance.v1';
const SHA = /^[0-9a-f]{64}$/;
const TOKEN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_PROPOSALS = 8;
const MAX_VALIDATIONS = 16;
const MAX_HISTORY = 32;
const MAX_RECORD_BYTES = 16 * 1024;

function object(input: Json): Record<string, Json> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('guideline_input_invalid');
  return input;
}

function string(input: Json, max: number, label: string): string {
  if (typeof input !== 'string' || !input || input.trim() !== input || input.length > max || /[\r\n]/.test(input)) throw new Error(`${label}_invalid`);
  return input;
}

function token(input: Json, label: string): string {
  const value = string(input, 64, label);
  if (!TOKEN.test(value)) throw new Error(`${label}_invalid`);
  return value;
}

function bytes(input: string): Uint8Array {
  const encoded = encodeURIComponent(input).replace(/%([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Uint8Array.from(encoded, character => character.charCodeAt(0));
}

function canonical(input: Json): Json {
  if (Array.isArray(input)) return input.map(canonical);
  if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => [key, canonical(value)]));
  return input;
}

async function digest(input: Json): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes(JSON.stringify(canonical(input))) as BufferSource);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function bounded(input: Json): void {
  if (bytes(JSON.stringify(input)).length > MAX_RECORD_BYTES) throw new Error('guideline_record_limit');
}

function reference(input: Json): ResourceRef {
  const value = object(input);
  if (typeof value.reference !== 'string' || !SHA.test(value.reference) || value.sha256 !== value.reference) throw new Error('guideline_evidence_reference_invalid');
  return { reference: value.reference, sha256: value.reference };
}

function evidence(input: Json, split: 'development' | 'validation'): Evidence[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 8) throw new Error('guideline_evidence_count');
  const result = input.map(item => {
    const value = object(item);
    if (value.split !== split) throw new Error('guideline_evidence_split');
    return { task_id: token(value.task_id, 'guideline_task'), reference: reference(value.reference), split };
  });
  if (new Set(result.map(item => `${item.task_id}:${item.reference.sha256}`)).size !== result.length) throw new Error('guideline_evidence_duplicate');
  return result;
}

function rules(input: Json, min: number, max: number): Rule[] {
  if (!Array.isArray(input) || input.length < min || input.length > max) throw new Error('guideline_rule_count');
  const result = input.map(item => {
    const value = object(item);
    return { id: token(value.id, 'guideline_rule_id'), text: string(value.text, 240, 'guideline_rule_text') };
  });
  if (new Set(result.map(item => item.id)).size !== result.length) throw new Error('guideline_rule_duplicate');
  return result;
}

function variant(input: Json): Variant {
  const value = object(input);
  if (value.kind === 'full_checklist') return { kind: 'full_checklist', checklist: rules(value.checklist, 4, 16) };
  if (value.kind === 'tiny_core') {
    const core = rules(value.core, 1, 4);
    const selected_rules = rules(value.selected_rules, 1, 12);
    if (selected_rules.some(item => core.some(other => other.id === item.id))) throw new Error('guideline_rule_duplicate');
    return { kind: 'tiny_core', core, selected_rules };
  }
  throw new Error('guideline_variant_invalid');
}

function proposal(input: Json): Proposal {
  const value = object(input);
  if (value.schema !== 1) throw new Error('guideline_schema_invalid');
  const result: Proposal = { schema: 1, version: token(value.version, 'guideline_version'),
    replaces: value.replaces === null ? null : token(value.replaces, 'guideline_replaces'),
    rationale: string(value.rationale, 4096, 'guideline_rationale'), variant: variant(value.variant),
    development_evidence: evidence(value.development_evidence, 'development') };
  bounded(result as unknown as Json);
  return result;
}

function validation(input: Json): Validation {
  const value = object(input);
  if (value.schema !== 1 || (value.outcome !== 'passed' && value.outcome !== 'failed') || !SHA.test(value.proposal_sha256 as string)) throw new Error('guideline_validation_invalid');
  const result: Validation = { schema: 1, id: token(value.id, 'guideline_validation_id'), proposal_version: token(value.proposal_version, 'guideline_version'),
    proposal_sha256: value.proposal_sha256 as string, validator: string(value.validator, 256, 'guideline_validator'),
    outcome: value.outcome, summary: string(value.summary, 4096, 'guideline_summary'), validation_evidence: evidence(value.validation_evidence, 'validation') };
  bounded(result as unknown as Json);
  return result;
}

function selection(input: Json): Selection {
  const value = object(input);
  if (!SHA.test(value.proposal_sha256 as string) || Object.keys(value).sort().join(',') !== 'proposal_sha256,version') throw new Error('guideline_selection_invalid');
  return { version: token(value.version, 'guideline_version'), proposal_sha256: value.proposal_sha256 as string };
}

function action(input: Json): Action {
  const value = object(input);
  if (Object.keys(value).sort().join(',') !== 'actor,reason') throw new Error('guideline_action_invalid');
  return { actor: string(value.actor, 256, 'guideline_actor'), reason: string(value.reason, 4096, 'guideline_reason') };
}

function command(input: Json, kind: 'promote' | 'rollback'): Record<string, Json> {
  let payload = input;
  if (typeof input === 'string') {
    const text = input.trim();
    if (text.length < 2 || text.length > 8192 || /[\r\n]/.test(text)) throw new Error('guideline_command_invalid');
    try { payload = JSON.parse(text) as Json; } catch { throw new Error('guideline_command_invalid'); }
    if (JSON.stringify(payload) !== text) throw new Error('guideline_command_noncanonical');
  }
  const value = object(payload);
  const keys = kind === 'promote'
    ? 'expected_active,expected_revision,maintainer,proposal,validation_id,validation_sha256'
    : 'expected_active,expected_revision,maintainer';
  if (Object.keys(value).sort().join(',') !== keys) throw new Error('guideline_command_invalid');
  return value;
}

function equal(left: Selection | null, right: Selection | null): boolean {
  return left === null || right === null ? left === right : left.version === right.version && left.proposal_sha256 === right.proposal_sha256;
}

function render(value: Variant): string {
  const lines = value.kind === 'full_checklist'
    ? ['Apply the complete short simplicity checklist:', ...value.checklist.map(rule => `- [${rule.id}] ${rule.text}`)]
    : ['Apply the tiny shared simplicity core:', ...value.core.map(rule => `- [${rule.id}] ${rule.text}`),
      'Apply these selected one-line rules:', ...value.selected_rules.map(rule => `- [${rule.id}] ${rule.text}`)];
  return `${lines.join('\n')}\n`;
}

async function seal(body: Body): Promise<State> {
  return { ...body, integrity_sha256: await digest(body as unknown as Json) };
}

function body(state: State): Body {
  return { schema: state.schema, revision: state.revision, proposals: state.proposals, validations: state.validations,
    active: state.active, rollback: state.rollback, transitions: state.transitions };
}

async function load(api: ModAPI): Promise<{ state: State; store_revision: number | null }> {
  const entry = api.host.call('store.get', { key: KEY, scope: 'repository' });
  if (!entry) return { state: await seal({ schema: 1, revision: 0, proposals: [], validations: [], active: null, rollback: [], transitions: [] }), store_revision: null };
  const state = entry.value as unknown as State;
  if (!state || state.schema !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0
    || !Array.isArray(state.proposals) || state.proposals.length > MAX_PROPOSALS || !Array.isArray(state.validations) || state.validations.length > MAX_VALIDATIONS
    || !Array.isArray(state.transitions) || state.transitions.length > MAX_HISTORY || !Array.isArray(state.rollback) || state.rollback.length > MAX_HISTORY
    || state.revision !== state.transitions.length || !SHA.test(state.integrity_sha256)
    || state.integrity_sha256 !== await digest(body(state) as unknown as Json)) throw new Error('guideline_state_invalid');
  for (const item of state.proposals) {
    if (await digest(proposal(item.proposal as unknown as Json) as unknown as Json) !== await digest(item.proposal as unknown as Json)
      || item.sha256 !== await digest(item.proposal as unknown as Json)
      || !SHA.test(item.candidate_sha256) || !SHA.test(item.receipt?.sha256) || item.receipt.reference !== item.receipt.sha256) throw new Error('guideline_state_invalid');
  }
  for (const item of state.validations) {
    if (await digest(validation(item.validation as unknown as Json) as unknown as Json) !== await digest(item.validation as unknown as Json)
      || item.sha256 !== await digest(item.validation as unknown as Json)
      || !SHA.test(item.candidate_sha256) || !SHA.test(item.receipt?.sha256) || item.receipt.reference !== item.receipt.sha256) throw new Error('guideline_state_invalid');
    const source = state.proposals.find(proposed => proposed.proposal.version === item.validation.proposal_version);
    if (!source || source.sha256 !== item.validation.proposal_sha256
      || item.validation.validation_evidence.some(record => source.proposal.development_evidence.some(development => development.task_id === record.task_id))) throw new Error('guideline_state_invalid');
  }
  if (new Set(state.proposals.map(item => item.proposal.version)).size !== state.proposals.length
    || new Set(state.validations.map(item => `${item.validation.proposal_version}:${item.validation.id}`)).size !== state.validations.length
    || (state.active && !state.proposals.some(item => equal(state.active, { version: item.proposal.version, proposal_sha256: item.sha256 })))) throw new Error('guideline_state_invalid');
  let active: Selection | null = null;
  const rollback: (Selection | null)[] = [];
  for (const [index, item] of state.transitions.entries()) {
    if (item.revision !== index + 1 || !equal(item.from, active)) throw new Error('guideline_state_invalid');
    action(item.maintainer as unknown as Json);
    if (item.kind === 'promotion') {
      if (!item.to || !item.validation_id || !item.validation_sha256) throw new Error('guideline_state_invalid');
      const accepted = state.validations.find(record => record.validation.id === item.validation_id && record.validation.proposal_version === item.to?.version
        && record.sha256 === item.validation_sha256 && record.validation.outcome === 'passed' && record.validation.proposal_sha256 === item.to?.proposal_sha256);
      if (!accepted) throw new Error('guideline_state_invalid');
      rollback.push(active);
      active = item.to;
    } else if (item.kind === 'rollback') {
      const prior = rollback.pop();
      if (prior === undefined || !equal(item.to, prior) || item.validation_id !== null || item.validation_sha256 !== null) throw new Error('guideline_state_invalid');
      active = prior;
    } else throw new Error('guideline_state_invalid');
  }
  if (!equal(active, state.active) || rollback.length !== state.rollback.length || rollback.some((item, index) => !equal(item, state.rollback[index]))) throw new Error('guideline_state_invalid');
  return { state, store_revision: entry.revision };
}

function expected(input: Record<string, Json>, revision: number): void {
  if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision !== revision) throw new Error('guideline_revision_stale');
}

function snapshot(api: ModAPI): string {
  const value = api.host.call('workspace.fingerprint', {}).candidate_sha256;
  if (!SHA.test(value)) throw new Error('guideline_candidate_invalid');
  return value;
}

function fresh(api: ModAPI, candidate: string): void {
  api.host.call('workspace.fingerprint', { expected: candidate });
}

function checkEvidence(api: ModAPI, items: Evidence[]): void {
  for (const item of items) api.host.call('evidence.read', { reference: item.reference, max_bytes: 1 });
}

async function save(api: ModAPI, state: Body, store_revision: number | null): Promise<void> {
  const value = await seal(state);
  api.host.call('store.put', { key: KEY, scope: 'repository', expected_revision: store_revision, value: value as unknown as Json });
}

async function propose(api: ModAPI, input: Json): Promise<Json> {
  const supplied = object(input);
  const item = proposal(supplied.proposal);
  const { state, store_revision } = await load(api);
  expected(supplied, state.revision);
  if (state.proposals.length >= MAX_PROPOSALS || state.proposals.some(entry => entry.proposal.version === item.version)
    || (item.replaces && !state.proposals.some(entry => entry.proposal.version === item.replaces))) throw new Error('guideline_proposal_unavailable');
  const candidate = snapshot(api);
  checkEvidence(api, item.development_evidence);
  fresh(api, candidate);
  const receipt = api.host.call('evidence.write', { media_type: 'application/json', label: 'Guideline development proposal', content: item as unknown as Json });
  const sha256 = await digest(item as unknown as Json);
  fresh(api, candidate);
  await save(api, { ...body(state), proposals: [...state.proposals, { proposal: item, sha256, receipt, candidate_sha256: candidate }] }, store_revision);
  return { selection: { version: item.version, proposal_sha256: sha256 }, receipt, candidate_sha256: candidate, active: state.active } as Json;
}

async function validate(api: ModAPI, input: Json): Promise<Json> {
  const supplied = object(input);
  const item = validation(supplied.validation);
  const { state, store_revision } = await load(api);
  expected(supplied, state.revision);
  const proposed = state.proposals.find(entry => entry.proposal.version === item.proposal_version && entry.sha256 === item.proposal_sha256);
  if (!proposed || state.validations.length >= MAX_VALIDATIONS
    || state.validations.some(entry => entry.validation.proposal_version === item.proposal_version && entry.validation.id === item.id)) throw new Error('guideline_validation_unavailable');
  if (item.validation_evidence.some(evidence => proposed.proposal.development_evidence.some(development => development.task_id === evidence.task_id))) throw new Error('guideline_validation_task_overlap');
  const candidate = snapshot(api);
  checkEvidence(api, item.validation_evidence);
  fresh(api, candidate);
  const receipt = api.host.call('evidence.write', { media_type: 'application/json', label: 'Guideline separate validation', content: item as unknown as Json });
  const sha256 = await digest(item as unknown as Json);
  fresh(api, candidate);
  await save(api, { ...body(state), validations: [...state.validations, { validation: item, sha256, receipt, candidate_sha256: candidate }] }, store_revision);
  return { validation_id: item.id, validation_sha256: sha256, receipt, candidate_sha256: candidate, outcome: item.outcome } as Json;
}

async function promote(api: ModAPI, input: Json): Promise<Json> {
  const supplied = command(input, 'promote');
  const { state, store_revision } = await load(api);
  expected(supplied, state.revision);
  const expected_active = supplied.expected_active === null ? null : selection(supplied.expected_active);
  const selected = selection(supplied.proposal);
  const maintainer = action(supplied.maintainer);
  const validation_id = token(supplied.validation_id, 'guideline_validation_id');
  const validation_sha256 = supplied.validation_sha256;
  if (!SHA.test(validation_sha256 as string) || !equal(expected_active, state.active)) throw new Error('guideline_active_stale');
  const proposed = state.proposals.find(item => item.proposal.version === selected.version && item.sha256 === selected.proposal_sha256);
  const checked = state.validations.find(item => item.validation.proposal_version === selected.version && item.validation.id === validation_id
    && item.sha256 === validation_sha256 && item.validation.proposal_sha256 === selected.proposal_sha256 && item.validation.outcome === 'passed');
  if (!proposed || !checked || state.transitions.length >= MAX_HISTORY) throw new Error('guideline_promotion_unavailable');
  const revision = state.revision + 1;
  const transition: Transition = { revision, kind: 'promotion', from: state.active, to: selected, validation_id, validation_sha256: validation_sha256 as string, maintainer };
  await save(api, { ...body(state), revision, active: selected, rollback: [...state.rollback, state.active], transitions: [...state.transitions, transition] }, store_revision);
  return { display: `Guideline ${selected.version} promoted at revision ${revision}` } as Json;
}

async function rollback(api: ModAPI, input: Json): Promise<Json> {
  const supplied = command(input, 'rollback');
  const { state, store_revision } = await load(api);
  expected(supplied, state.revision);
  const expected_active = selection(supplied.expected_active);
  const maintainer = action(supplied.maintainer);
  if (!equal(expected_active, state.active) || !state.rollback.length || state.transitions.length >= MAX_HISTORY) throw new Error('guideline_rollback_unavailable');
  const prior = state.rollback.at(-1)!;
  const revision = state.revision + 1;
  const transition: Transition = { revision, kind: 'rollback', from: state.active, to: prior, validation_id: null,
    validation_sha256: null, maintainer };
  await save(api, { ...body(state), revision, active: prior, rollback: state.rollback.slice(0, -1), transitions: [...state.transitions, transition] }, store_revision);
  return { display: prior ? `Guideline ${prior.version} restored at revision ${revision}` : `Guideline cleared at revision ${revision}` } as Json;
}

async function active(api: ModAPI): Promise<Json> {
  const { state } = await load(api);
  const proposed = state.proposals.find(item => item.proposal.version === state.active?.version && item.sha256 === state.active?.proposal_sha256);
  if (state.active && !proposed) throw new Error('guideline_state_invalid');
  return { schema: 1, revision: state.revision, active: state.active, rendered: proposed ? render(proposed.proposal.variant) : null,
    proposal_count: state.proposals.length, validation_count: state.validations.length, transitions: state.transitions } as Json;
}

export default function activate(api: ModAPI) {
  api.tool({ name: 'propose', description: 'Record a bounded guideline candidate from development evidence without activating it.',
    parameters: { type: 'object', properties: { expected_revision: { type: 'integer' }, proposal: { type: 'object' } },
      required: ['expected_revision', 'proposal'], additionalProperties: false } }, input => propose(api, input));
  api.tool({ name: 'validate', description: 'Record a separate-task validation result bound to the exact proposal hash.',
    parameters: { type: 'object', properties: { expected_revision: { type: 'integer' }, validation: { type: 'object' } },
      required: ['expected_revision', 'validation'], additionalProperties: false } }, input => validate(api, input));
  api.tool({ name: 'active', description: 'Inspect the current explicitly selected guideline and transition history.',
    parameters: { type: 'object', properties: {}, additionalProperties: false } }, () => active(api));
  api.command('promote', input => promote(api, input), { description: 'Explicitly promote an exact passed guideline validation with an expected active selection' });
  api.command('rollback', input => rollback(api, input), { description: 'Explicitly restore the prior guideline selection with an expected active selection' });
}

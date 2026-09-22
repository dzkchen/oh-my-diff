export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Capability = 'context' | 'tools' | 'commands' | 'lifecycle' | 'state' | 'task' | 'agents' | 'review' | 'recovery' | 'execution' | 'interception' | 'routing' | 'terminal' | 'compaction' | 'providers' | 'sidecars' | 'pi_resources' | 'input' | 'workflow' | 'middleware' | 'services';
export type FieldPolicy = 'observe_only' | 'alterable' | 'replaceable';
export type JsonKind = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object' | 'json';
export type Stability = 'stable' | 'deprecated' | 'experimental';
export interface ServiceMethod { input: JsonKind; output: JsonKind }
export interface ServiceContract { name: `${string}.${string}`; version: `${number}.${number}.${number}`; stability?: Stability; deprecated_since?: string; replacement?: `${string}.${string}`; methods: Record<string, ServiceMethod> }
export interface RequestPreset { name: string; model: string; provider: string; reasoning: string }
export interface ModelRequestEvent {
  request_id: string;
  scope: { thread_id: string; agent_id: string | null; kind: 'main' | 'subagent' };
  authorized_presets: RequestPreset[];
  original: RequestPreset;
  effective: RequestPreset;
  provenance: Json[];
}
export interface ResponseStreamEvent {
  kind: string;
  raw_sha256: string;
  raw_usage: Json;
  opaque_reasoning: boolean;
  protected: boolean;
  text: string | null;
  original?: string | null;
  effective?: string | null;
  provenance?: Json[];
  fallback?: Json[];
}
export interface ToolSpec {
  name: string;
  label?: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, Json>; required?: string[]; additionalProperties?: boolean };
  task_scoped?: boolean;
}
export interface Context { thread_id: string; turn_id: string; checkpoint: Json }
export interface ContextResult { text: string }
export interface Route { name: 'sol' | 'astra'; model: string; provider: string; reasoning: string }
export type LeadRoutingDecision = 'sol' | 'astra' | { route: 'sol' | 'astra'; policy: 'fixed' | 'task_entry' } | null;
export type WorkerContextMode = 'focused_brief' | 'shared_task_packet' | 'parent_history';
export interface WorkerContextInput { available: WorkerContextMode[]; native_fallback: WorkerContextMode; active: WorkerContextMode }
export interface WorkerContextDecision { mode: WorkerContextMode }
export interface Agent { handle: string; route: string; permissions: 'read_only' }
export type AgentResult = { status: 'running' } | { status: 'failed'; error: string } | { status: 'completed'; text: string; consumed: boolean };
export type Letter = 'a'|'b'|'c'|'d'|'e'|'f'|'g'|'h'|'i'|'j'|'k'|'l'|'m'|'n'|'o'|'p'|'q'|'r'|'s'|'t'|'u'|'v'|'w'|'x'|'y'|'z';
export type KeyName = 'F2'|'F3'|'F4'|'F5'|'F6'|'F7'|'F8'|'F9'|'F10'|'F11'|'F12' | `Ctrl+${Exclude<Letter, 'c'|'d'|'z'|'h'|'i'|'j'|'m'>}` | `Alt+${Letter}`;
export type KeyAction = string | { insert: string } | { submit: string } | { command: string; args?: string } | { focus: string } | { copy: string; label: string };
export type ThemeColor = number | `#${string}`;
export interface Panel { title: string; lines: string[] }
export type TerminalTone = 'normal' | 'accent' | 'success' | 'attention' | 'failure' | 'muted';
export interface TerminalCommandAction { command: string; args?: string }
export type TerminalComponentAction = TerminalCommandAction | { copy: string; label: string };
export interface TerminalSelectOption { value: string; label: string }
export type TerminalComponent =
  | { type: 'box'; id: string; label: string; title?: string; children?: TerminalComponent[] }
  | { type: 'text'; id: string; label: string; text: string; tone?: TerminalTone }
  | { type: 'button'; id: string; label: string; text: string; action: TerminalComponentAction }
  | { type: 'input'; id: string; label: string; value?: string; placeholder?: string; action: TerminalCommandAction }
  | { type: 'select'; id: string; label: string; value: string; options: TerminalSelectOption[]; action: TerminalCommandAction }
  | { type: 'markdown'; id: string; label: string; text: string }
  | { type: 'code'; id: string; label: string; text: string; language?: string }
  | { type: 'pane'; id: string; label: string; title?: string; collapsed?: boolean; scroll?: number; children?: TerminalComponent[] }
  | { type: 'dialog'; id: string; label: string; title: string; children?: TerminalComponent[] }
  | { type: 'slot' };
export type TerminalSiteName = 'sidebar' | 'header' | 'above_composer' | 'dialog';
export interface TerminalRenderSite { mode?: 'replace' | 'wrap'; components?: TerminalComponent[] }
export interface TerminalTheme {
  accent?: ThemeColor;
  user_message_background?: ThemeColor;
  syntax?: string;
  success?: ThemeColor;
  attention?: ThemeColor;
  failure?: ThemeColor;
  diff_added?: ThemeColor;
  diff_removed?: ThemeColor;
  muted?: ThemeColor;
  border?: 'plain' | 'rounded' | 'double';
  density?: 'compact' | 'comfortable';
  icons?: 'unicode' | 'ascii';
}
export interface TerminalView {
  title?: string;
  foreground?: number;
  background?: number;
  sidebar_width?: number;
  sidebar_side?: 'left' | 'right';
  panels?: Panel[];
  header?: Panel;
  footer?: Panel;
  sites?: Partial<Record<TerminalSiteName, TerminalRenderSite>>;
  status?: string[];
  keybindings?: Partial<Record<KeyName, KeyAction>>;
  theme?: TerminalTheme;
  completed_tools?: 'normal' | 'compact';
  message_template?: string;
  tool_template?: string;
}
export interface TerminalPatch {
  title?: string;
  foreground?: number;
  background?: number;
  sidebar_width?: number;
  sidebar_side?: 'left' | 'right';
  sites?: Partial<Record<TerminalSiteName, TerminalRenderSite>>;
  status?: string[];
  keybindings?: Partial<Record<KeyName, KeyAction>>;
  theme?: TerminalTheme;
  completed_tools?: 'normal' | 'compact';
  message_template?: string;
  tool_template?: string;
}
export type CommandResult = Json | { display?: string; insert?: string; submit?: string };
export type CompactionDecision = number | { threshold?: number; prompt?: string } | null;
export type InputDecision = null | { text: string } | { deny: string };
export type AssuranceLabel = 'unreviewed' | 'self_reviewed' | 'independently_reviewed' | 'independently_verified';
export type FinalReview = 'none' | 'self_review' | 'separate';
export type CompletionMode = 'none' | 'self_verified' | 'adversarial_separate';
export type ContractOperation = 'delegate' | 'spawn_child_agent' | 'opposite_lead_advice' | 'escalate' | 'checkpoint' | 'milestone_review' | 'final_review' | 'completion';
export type RestrictableOperation = Extract<ContractOperation, 'delegate' | 'spawn_child_agent' | 'opposite_lead_advice' | 'escalate'>;
export interface ContractRequirements {
  delegation: boolean;
  child_agents: boolean;
  opposite_lead: boolean;
  escalation: boolean;
  checkpoints: boolean;
  milestone_review: boolean;
  final_review: FinalReview;
  completion: CompletionMode;
}
export interface WorkflowContract { schema: 1; id: string; version: number; requirements: ContractRequirements }
export interface VersionMarker { label: string; sha256: string; evidence: string; evidence_sha256: string }
export interface CheckpointUpdate {
  completed_acceptance: { criterion: string; evidence: VersionMarker[] }[];
  completed_steering: string[];
  remaining_work: string[];
  failed_hypotheses: string[];
  candidate_versions: VersionMarker[];
  check_versions: VersionMarker[];
}
export interface ReviewRequest { cadence: 'stable_milestone' | 'risk_triggered' | 'every_turn' | 'final'; candidate_sha256: string; stable: boolean; risk?: string }
export interface CompletionRequest { candidate_sha256: string; contract_sha256: string }
export type FailureClass = 'environment' | 'edit' | 'diagnosis' | 'model';
export type RecoveryAction = 'opposite_lead' | 'pause';
export interface ContributionRequest { brief?: string; selected_evidence?: string[]; outage_action?: RecoveryAction }
export interface EscalationRequest { failure_class: FailureClass; summary: string; call_ids: string[]; advisory_route?: Extract<RecoveryAction, 'opposite_lead'> }
export interface HostOperations {
  'task.status': { arguments: null; result: Json };
  'routes.list': { arguments: null; result: Route[] };
  'checkpoint.read': { arguments: null; result: Json };
  'checkpoint.update': { arguments: CheckpointUpdate; result: Json };
  'agents.spawn': { arguments: { role: string; route: string; prompt: string }; result: Agent };
  'agents.message': { arguments: { handle: string; message: string }; result: { delivered: boolean } };
  'agents.cancel': { arguments: { handle: string }; result: { cancelled: boolean } };
  'agents.result': { arguments: { handle: string; consume?: boolean }; result: AgentResult };
  'agents.wait': { arguments: { handle: string; consume?: boolean }; result: AgentResult };
  'agents.list': { arguments: null; result: { handle: string; finished: boolean; consumed: boolean }[] };
  'review.run': { arguments: ReviewRequest; result: Json };
  'review.complete': { arguments: CompletionRequest; result: Json };
  'delegation.contribute': { arguments: ContributionRequest; result: Json };
  'recovery.escalate': { arguments: EscalationRequest; result: Json };
  'tools.exec': { arguments: string[]; result: Json };
  'pi.discover': { arguments: null; result: Json };
  'pi.expand': { arguments: { name: string; args?: string }; result: { name: string; path: string; sha256: string; text: string } };
  'providers.unregister': { arguments: { id: string }; result: Json };
  'providers.register': { arguments: { id: string }; result: Json };
  'sidecars.start': { arguments: { id: string }; result: Json };
  'sidecars.status': { arguments: { id: string }; result: Json };
  'sidecars.stop': { arguments: { id: string }; result: Json };
  'workflow.status': { arguments: null; result: Json };
  'workflow.restrict': { arguments: { operations: RestrictableOperation[]; reason: string }; result: Json };
}
export interface Events {
  context: { input: Context; output: ContextResult | null };
  migrate: { input: { from: number; to: number }; output: void };
  routing: { input: { routes: Route[]; model: string | null; provider: string; reasoning: string | null; native_fallback?: { policy: 'fixed' | 'task_entry'; route: 'sol' | 'astra' | null } }; output: LeadRoutingDecision };
  worker_context: { input: WorkerContextInput; output: WorkerContextDecision | null };
  compaction: { input: { token_limit: number | null; context_window: number | null }; output: CompactionDecision };
  input: { input: { text: string; attachments: number }; output: InputDecision };
  tool_before: { input: { tool: string; arguments: Json; call_id: string }; output: { deny: string } | { arguments: Json; tool?: string } | null };
  tool_exposure: { input: { thread_id: string | null; checkpoint: Json; available: string[] }; output: { enable: string[] } };
  terminal: { input: { event: string; checkpoint: Json }; output: TerminalView | TerminalPatch | null };
  start: { input: Json; output: void };
  resume: { input: Json; output: void };
  idle: { input: Json; output: void };
  stop: { input: Json; output: void };
  tool_result: { input: Json; output: void };
  turn_start: { input: { turn_id: string }; output: void };
  turn_end: { input: { turn_id: string; outcome: 'completed' | 'aborted' | 'error'; reason?: string; error?: string }; output: void };
  compaction_start: { input: { turn_id: string; trigger: 'manual' | 'auto' }; output: void };
  compaction_end: { input: { turn_id: string; trigger: 'manual' | 'auto' }; output: void };
  agent_end: { input: { handle: string; role: string; status: 'completed' | 'failed'; error?: string }; output: void };
  workflow: { input: Json; output: void };
  model_request: { input: ModelRequestEvent; output: { preset: string } | null };
  response_stream: { input: ResponseStreamEvent; output: { text: string } | null };
  prompt: { input: { thread_id: string; turn_id: string; original: string; effective: string; provenance: Json[] }; output: void };
  session: { input: { phase: 'start' | 'resume' | 'idle' | 'stop'; thread_id: string; cause?: string }; output: void };
  agent: { input: { phase: 'start' | 'end'; agent_id: string; parent_agent_id: string | null; role: string; status: string }; output: void };
  tool_call: { input: { call_id: string; agent_id: string | null; tool: string; arguments: Json }; output: void };
  host_operation: { input: { phase: 'before' | 'after'; caller: string; operation: keyof HostOperations; arguments?: Json; result?: Json; error?: string }; output: void };
}
export interface ModAPI {
  readonly version: '0.1.0-experimental.8';
  readonly fieldPolicies: Readonly<Record<string, Readonly<Record<string, FieldPolicy>>>>;
  readonly settings: Readonly<Record<string, Json>>;
  readonly host: { call<K extends keyof HostOperations>(operation: K, arguments_: HostOperations[K]['arguments']): HostOperations[K]['result'] };
  readonly services: { call<T extends Json = Json>(name: string, method: string, input?: Json): T };
  on<K extends keyof Events>(event: K, handler: (event: Events[K]['input']) => Events[K]['output'] | Promise<Events[K]['output']>): void;
  middleware<K extends 'model_request' | 'response_stream' | 'prompt' | 'session' | 'agent' | 'tool_call' | 'tool_result' | 'host_operation'>(event: K, handler: (event: Events[K]['input']) => Events[K]['output'] | Promise<Events[K]['output']>): void;
  replace<K extends 'context' | 'routing' | 'worker_context' | 'compaction' | 'tool_before' | 'terminal' | 'input'>(point: K, handler: (event: Events[K]['input']) => Events[K]['output'] | Promise<Events[K]['output']>): void;
  contract(definition: WorkflowContract): void;
  provide(contract: ServiceContract, handlers: Record<string, (input: Json) => Json | Promise<Json>>): void;
  tool(spec: ToolSpec, handler: (arguments_: Json) => Json | Promise<Json>): void;
  command(name: string, handler: (arguments_: Json) => CommandResult | Promise<CommandResult>, options?: { description?: string }): void;
  progress(text: string): void;
  readonly state: { get(): Json; set(value: Json): void };
  unsupported(operation: string): never;
}
export default function activate(api: ModAPI): void | Promise<void>;

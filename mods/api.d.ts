export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Capability = 'context' | 'tools' | 'commands' | 'lifecycle' | 'state' | 'task' | 'agents' | 'review' | 'recovery' | 'execution' | 'interception' | 'routing' | 'terminal' | 'compaction' | 'providers' | 'sidecars' | 'pi_resources' | 'input' | 'workflow';
export interface ToolSpec {
  name: string;
  label?: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, Json>; required?: string[]; additionalProperties?: boolean };
}
export interface Context { thread_id: string; turn_id: string; checkpoint: Json }
export interface ContextResult { text: string }
export interface Route { name: 'sol' | 'astra'; model: string; provider: string; reasoning: string }
export interface Agent { handle: string; route: string; permissions: 'read_only' }
export type AgentResult = { status: 'running' } | { status: 'failed'; error: string } | { status: 'completed'; text: string; consumed: boolean };
export type Letter = 'a'|'b'|'c'|'d'|'e'|'f'|'g'|'h'|'i'|'j'|'k'|'l'|'m'|'n'|'o'|'p'|'q'|'r'|'s'|'t'|'u'|'v'|'w'|'x'|'y'|'z';
export type KeyName = 'F2'|'F3'|'F4'|'F5'|'F6'|'F7'|'F8'|'F9'|'F10'|'F11'|'F12' | `Ctrl+${Exclude<Letter, 'c'|'d'|'z'|'h'|'i'|'j'|'m'>}` | `Alt+${Letter}`;
export type KeyAction = string | { insert: string } | { submit: string } | { command: string; args?: string };
export type ThemeColor = number | `#${string}`;
export interface Panel { title: string; lines: string[] }
export interface TerminalView {
  title?: string;
  foreground?: number;
  background?: number;
  sidebar_width?: number;
  sidebar_side?: 'left' | 'right';
  panels?: Panel[];
  header?: Panel;
  footer?: Panel;
  status?: string[];
  keybindings?: Partial<Record<KeyName, KeyAction>>;
  theme?: { accent?: ThemeColor; user_message_background?: ThemeColor; syntax?: string; success?: ThemeColor; attention?: ThemeColor; failure?: ThemeColor };
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
export interface ContributionRequest { brief?: string; selected_evidence?: string[] }
export interface EscalationRequest { failure_class: 'environment' | 'edit' | 'diagnosis' | 'model'; summary: string; call_ids: string[] }
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
  routing: { input: { routes: Route[]; model: string | null; provider: string; reasoning: string | null }; output: 'sol' | 'astra' | null };
  compaction: { input: { token_limit: number | null; context_window: number | null }; output: CompactionDecision };
  input: { input: { text: string; attachments: number }; output: InputDecision };
  tool_before: { input: { tool: string; arguments: Json; call_id: string }; output: { deny: string } | { arguments: Json; tool?: string } | null };
  terminal: { input: { event: string; checkpoint: Json }; output: TerminalView | null };
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
}
export interface ModAPI {
  readonly version: '0.1.0-experimental.4';
  readonly settings: Readonly<Record<string, Json>>;
  readonly host: { call<K extends keyof HostOperations>(operation: K, arguments_: HostOperations[K]['arguments']): HostOperations[K]['result'] };
  on<K extends keyof Events>(event: K, handler: (event: Events[K]['input']) => Events[K]['output'] | Promise<Events[K]['output']>): void;
  replace<K extends 'context' | 'routing' | 'compaction' | 'tool_before' | 'terminal' | 'input'>(point: K, handler: (event: Events[K]['input']) => Events[K]['output'] | Promise<Events[K]['output']>): void;
  contract(definition: WorkflowContract): void;
  tool(spec: ToolSpec, handler: (arguments_: Json) => Json | Promise<Json>): void;
  command(name: string, handler: (arguments_: Json) => CommandResult | Promise<CommandResult>, options?: { description?: string }): void;
  progress(text: string): void;
  readonly state: { get(): Json; set(value: Json): void };
  unsupported(operation: string): never;
}
export default function activate(api: ModAPI): void | Promise<void>;

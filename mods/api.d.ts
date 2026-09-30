export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Capability =
  | 'context' | 'tools' | 'commands' | 'lifecycle' | 'input' | 'interception' | 'compaction' | 'middleware' | 'services' | 'virtual_reads' | 'terminal'
  | 'exec' | 'fs.read' | 'fs.write' | 'network' | 'model' | 'agents' | 'store' | 'sessions' | 'contracts' | 'builtins'
  | 'threads' | 'config' | 'config.write' | 'inventory' | 'account' | 'packages' | 'approvals' | 'events' | 'credentials' | 'composer'
  | 'pty' | 'history' | 'outputs';
export type FieldPolicy = 'observe_only' | 'alterable' | 'replaceable';
export type JsonKind = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object' | 'json';
export type Stability = 'stable' | 'deprecated' | 'experimental';
export type ServiceMethod = { input: JsonKind; output: JsonKind };
export type ServiceContract = { name: `${string}.${string}`; version: `${number}.${number}.${number}`; stability?: Stability; deprecated_since?: string; replacement?: `${string}.${string}`; methods: Record<string, ServiceMethod> };
export type ResourceRef = { reference: string; sha256: string };
export type HostEvidence = { path: string; sha256: string };

export type RouteInfo = { name: string; model: string; provider: string; reasoning: string; roles: ('lead' | 'worker')[]; billing: 'included_subscription' | 'explicit_paid_api_grant'; tools: string[]; available: boolean; credential: string | null };
export type ModelRequestEvent = { request_id: string; scope: { thread_id: string; agent_id: string | null; kind: 'main' | 'subagent' }; routes: RouteInfo[]; original: RouteInfo; effective: RouteInfo; provenance: Json[] };
export type ResponseStreamEvent = { kind: string; raw_sha256: string; raw_usage: Json; opaque_reasoning: boolean; protected: boolean; text: string | null; boundary: boolean; attempt: number; original?: string | null; effective?: string | null; provenance?: Json[] };
export type StreamDecision = { text: string } | { stop: { reason: string } } | { stop: { reason: string }; retry: { inject: string } } | null;

export type ToolSpec = { name: string; label?: string; description: string; parameters: { type: 'object'; properties: Record<string, Json>; required?: string[]; additionalProperties?: boolean }; task_scoped?: boolean };
export type VirtualReadRequest = { uri: string; cursor?: string; expected_revision?: string; max_bytes?: number };
export type VirtualReadResponse = { canonical_uri: string; canonical_url: string; identity: string; revision: string; text: string; anchors: string[]; cursor: string | null; truncated: boolean };
export type SessionSummary = { session_id: string; task_id: string; parent_id: string | null; timestamp: string; revision: string; handle: string; history_mode: string; inherited_history: boolean; incomplete_tail: boolean };
export type SessionRecord = { session_id: string; turn_id: string; item: number; role: 'user' | 'assistant'; text: string; truncated: boolean; redacted: boolean; timestamp: string | null; untrusted: true };
export type Ledger = { thread_id: string; cwd: string; cost: Json | null };
export type Context = { thread_id: string; turn_id: string; ledger: Ledger };
export type ContextResult = { text: string };
export type Agent = { handle: string; route: string; permissions: 'read_only' | 'isolated_worktree'; parent_history?: { sha256: string; bytes: number; items: number; revision: number } | null };
export type AgentFailure = { category: 'transport' | 'rate_limit' | 'authorization' | 'sandbox' | 'allowance' | 'invalid_request' | 'unknown'; code: Json; message: string };
export type AgentResult = { status: 'running' } | { status: 'failed'; error: string; failure?: AgentFailure | null } | { status: 'completed'; text: string; consumed: boolean; evidence: ResourceRef; candidate_sha256?: string; changed_paths?: string[] };

export type Letter = 'a'|'b'|'c'|'d'|'e'|'f'|'g'|'h'|'i'|'j'|'k'|'l'|'m'|'n'|'o'|'p'|'q'|'r'|'s'|'t'|'u'|'v'|'w'|'x'|'y'|'z';
export type FunctionKey = 'F2'|'F3'|'F4'|'F5'|'F6'|'F7'|'F8'|'F9'|'F10'|'F11'|'F12';
export type KeymapKey = FunctionKey | `Ctrl+${Exclude<Letter, 'c'|'d'|'z'|'h'|'i'|'j'|'m'>}` | `Alt+${Letter}`;
export type Digit = '0'|'1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9';
export type NamedKey = 'Up'|'Down'|'Left'|'Right'|'Home'|'End'|'PageUp'|'PageDown'|'Delete'|'Insert'|'Tab'|'Enter'|'Esc'|'Backspace'|'Space';
export type KeyModifiers = 'Ctrl+' | 'Alt+' | 'Ctrl+Alt+' | 'Ctrl+Shift+' | 'Alt+Shift+' | 'Ctrl+Alt+Shift+';
export type KeyName = FunctionKey | `${KeyModifiers}${Letter | Digit | NamedKey}` | `Shift+${NamedKey}`;
export type KeyAction = string | { insert: string } | { submit: string } | { command: string; args?: string } | { focus: string } | { copy: string; label: string };
export type ThemeColor = number | `#${string}`;
export type Panel = { title: string; lines: string[] };
export type TerminalTone = 'normal' | 'accent' | 'success' | 'attention' | 'failure' | 'muted';
export type TerminalCommandAction = { command: string; args?: string };
export type TerminalComponentAction = TerminalCommandAction | { copy: string; label: string } | { insert: string };
export type TerminalSelectOption = { value: string; label: string };
export type TerminalSpan = { text: string; tone?: TerminalTone; bold?: boolean; italic?: boolean; underline?: boolean; fg?: ThemeColor; bg?: ThemeColor };
export type TerminalListRow = { value: string; spans: TerminalSpan[]; label: string };
export type TerminalComponent =
  | { type: 'box'; id: string; label: string; title?: string; children?: TerminalComponent[]; min_width?: number; max_width?: number }
  | { type: 'line'; id: string; label: string; spans: TerminalSpan[] }
  | { type: 'text'; id: string; label: string; text: string; tone?: TerminalTone }
  | { type: 'button'; id: string; label: string; text: string; action: TerminalComponentAction }
  | { type: 'input'; id: string; label: string; value?: string; placeholder?: string; action: TerminalCommandAction }
  | { type: 'select'; id: string; label: string; value: string; options: TerminalSelectOption[]; action: TerminalCommandAction }
  | { type: 'list'; id: string; label: string; rows: TerminalListRow[]; selected?: string; height?: number; action: TerminalCommandAction }
  | { type: 'markdown'; id: string; label: string; text: string }
  | { type: 'code'; id: string; label: string; text: string; language?: string }
  | { type: 'pane'; id: string; label: string; title?: string; collapsed?: boolean; scroll?: number; keys?: boolean; children?: TerminalComponent[] }
  | { type: 'dialog'; id: string; label: string; title: string; children?: TerminalComponent[] }
  | { type: 'document'; id: string; label: string; lines?: TerminalSpan[][]; source?: ResourceRef; anchors?: string[]; selected?: TerminalRange; find?: { query: string; regex?: boolean; case?: boolean }; height?: number; action?: TerminalCommandAction }
  | { type: 'diff'; id: string; label: string; unified: string; selected?: TerminalRange; height?: number; action?: TerminalCommandAction }
  | { type: 'image'; id: string; label: string; image: ResourceRef; alt: string; height?: number }
  | { type: 'terminal'; id: string; label: string; session: string; height?: number }
  | { type: 'slot' };
export type TerminalRange = { start: number; end: number };
export type TerminalSiteName = 'sidebar' | 'header' | 'above_composer' | 'dialog' | 'welcome' | `${string}/${string}`;
export type LayoutNode =
  | { content: 'transcript' | 'composer' | `site:${TerminalSiteName}` }
  | { split: 'horizontal' | 'vertical'; ratio?: number[]; children: LayoutNode[] }
  | { tabs: { title: string; node: LayoutNode }[]; active?: number };
export type BackdropTransform = { position?: 'center' | 'fill' | 'fit' | 'tile'; dim?: number; scale?: number; tint?: ThemeColor; opacity?: number; offset?: { x: number; y: number } };
export type AsciiBackdrop = BackdropTransform & { text: string };
export type TerminalBackdrop =
  | { ascii: AsciiBackdrop }
  | { image: BackdropTransform & { resource: ResourceRef; overlay?: TerminalSurfacePaint }; fallback?: { ascii: AsciiBackdrop } };
export type TerminalSurfacePaint = { top?: ThemeColor; bottom?: ThemeColor; foreground?: ThemeColor; border?: ThemeColor; opacity?: number };
export type TerminalRenderSite = { mode?: 'replace' | 'wrap'; components?: TerminalComponent[] };
export type TerminalWelcome = { show_while_composing?: boolean };
/** Host startup selection uses a null thread_id; live acceptance/resume supplies the real thread. */
export type TerminalPresentation = { thread_id: string | null; phase: 'fresh' | 'started' | 'resumed' };
export interface TerminalTheme {
  accent?: ThemeColor; user_message_background?: ThemeColor; syntax?: string; success?: ThemeColor; attention?: ThemeColor; failure?: ThemeColor;
  diff_added?: ThemeColor; diff_removed?: ThemeColor; muted?: ThemeColor; border?: 'plain' | 'rounded' | 'double'; density?: 'compact' | 'comfortable'; icons?: 'unicode' | 'ascii';
  glyphs?: Record<string, string>;
}
export type TerminalListEvent = { view_id: string; title: string; subtitle: string | null; width: number; items: { label: string; description: string | null; current: boolean; disabled: boolean; order: number }[]; selected: number | null };
export type TerminalIdentity = { codex_version: string; install_profile: 'full' | 'platform_only' | 'private' | 'unknown' | 'unreported'; mode: 'omd'; mods: { installed: number; enabled: number; active: number } };
export interface TerminalView {
  welcome?: TerminalWelcome; session_title_suffix?: string; greeting?: string;
  title?: string; foreground?: number; background?: number; sidebar_width?: number; sidebar_side?: 'left' | 'right'; panels?: Panel[]; header?: Panel; footer?: Panel;
  sites?: Partial<Record<TerminalSiteName, TerminalRenderSite>>; status?: string[]; keybindings?: Partial<Record<KeyName, KeyAction>>; theme?: TerminalTheme;
  completed_tools?: 'normal' | 'compact'; message_template?: string; tool_template?: string; placeholder?: string;
  layout?: LayoutNode; backdrop?: TerminalBackdrop; surface_styles?: { composer?: TerminalSurfacePaint; backdrop?: TerminalSurfacePaint };
}
export type TerminalPatch = Omit<TerminalView, 'panels' | 'header' | 'footer'>;
export type CommandResult = Json | { display?: string; insert?: string; submit?: string };
export type CompactionDecision = number | { threshold?: number; prompt?: string } | null;
export type InputDecision = null | { text: string } | { deny: string };

export type ExecResult = { exit_code: number | null; signal: string | null; stdout: string; stdout_sha256: string; stdout_bytes: number; output_artifact: ResourceRef | null; stderr: string; stdout_truncated: boolean; stdout_preview_truncated: boolean; stderr_truncated: boolean; stderr_preview_truncated: boolean; timed_out: boolean; duration_ms: number; program: { path: string; sha256: string }; guards_verified: number };
export type ExecGuard = { program: string; sha256?: string; argv?: string[]; cwd?: string; env?: Record<string, string>; stdout_sha256: string };
export type Fingerprint = string | { size: number; mtime_ms: number } | null;
export type FileStat = { kind: 'file' | 'dir' | 'symlink'; size: number; mtime_ms: number; sha256?: string };
export type StoreProvenance = { mod: string; source_sha256: string; thread_id: string | null; origin: 'user_command' | 'tool' | 'event' | 'cli'; at: string };
export type StoreScope = 'repository' | 'user' | 'thread';

export type ContractRequirement = { receipt: string; producer?: 'any' | 'lead' | 'separate_agent' | 'host' | 'integration'; bind?: ('candidate' | 'acceptance')[]; blocking_findings?: 'reject' | 'allow' };
export type ContractDocument = { schema: 2; id: string; version: number; description: string; assurance: string; gates: { complete?: ContractRequirement[]; integrate?: ContractRequirement[] }; restrict?: string[] };
export type ReceiptFinding = { fingerprint: string; severity: 'advice' | 'warning' | 'blocking'; summary: string; paths: string[] };
export type ReceiptProducer = { kind: 'lead' | 'agent' | 'host' | 'integration'; handle: string | null };
export type Receipt = { kind: string; candidate_sha256: string; acceptance_sha256: string | null; outcome: 'pass' | 'fail'; evidence: ResourceRef; producer: ReceiptProducer; findings: ReceiptFinding[]; resolves?: string[]; submitted_by: string; at: number };
export type FindingLedgerEntry = { finding: ReceiptFinding; reported_candidate_sha256: string; acceptance_sha256: string; reported_producer: ReceiptProducer; report_receipt_index: number; resolution: { candidate_sha256: string; producer: ReceiptProducer; receipt_index: number } | null };
export type ContractRestriction = { operation: string; when: Record<string, string | number | boolean | null> };
export type ContractStatus = { status: 'none' | 'active' | 'unavailable'; active: ContractDocument | null; provenance: Json; receipts: Receipt[]; finding_ledger: Record<string, FindingLedgerEntry>; restrictions: string[]; scoped_restrictions: ContractRestriction[] };

export type InvocationContext = 'user' | 'event';
export type AppRoute = { method: string; class: Capability; contexts: InvocationContext[]; confirm: boolean };
export type CredentialProfile = { id: string; label: string; kind: 'chatgpt' | 'api_key' | 'provider' | 'secret'; provider: string | null; origin: string | null; status: 'ready' | 'not_enrolled'; default: boolean };
export type HistoryItem = { index: number; type: string; role: string | null; call_id: string | null; editable: boolean; images: number; text: string | null; bytes: number };
export type HistoryEdit = { drop?: number[]; replace?: { index: number; text: string }[]; insert?: { before: number; role: 'user' | 'developer'; text: string }[] };
export type PtyRequest = { action: 'start'; session: string; cwd?: string; program?: string; argv?: string[]; sha256?: string; write?: boolean } | { action: 'write'; session: string; text: string } | { action: 'read'; session: string } | { action: 'stop'; session: string };
export type TurnActivity = {
  turn_id: string; started_at: string | null; ended_at: string | null;
  outcome: 'completed' | 'aborted' | 'error' | 'interrupted' | 'running' | 'unknown'; reason: string | null; unrecorded_end: boolean;
  tool_calls: { call_id: string; tool: string; started_at: string; finished_at: string | null; outcome: string | null; output_replaced?: { mod: string; original_sha256: string; replacement_sha256: string } }[];
  processes: { id: string; kind: 'exec' | 'managed'; command: string; running: boolean | null; exit_code: number | null }[];
  files: { path: string; before: string | null; after: string | null; source: 'tool' | 'transaction' | 'exec' | 'rescan' | 'external' }[];
  truncated: boolean;
};
export type PackageState = { id: string; kind: 'mod'; version: string; scope: 'user' | 'project'; source: 'local' | 'repository' | 'package'; installed: boolean; enabled: boolean; effective: boolean; pending: 'reload' | null; failed: string | null; api: string; compatible: boolean; grants: string[]; conflicts: string[] };
export type PackageSource = { kind: 'local'; path: string } | { kind: 'repository'; repository: string; revision: string; subdirectory?: string } | { kind: 'package'; index: string; id: string; version: string };
export type PackageRequest = { action: 'install' | 'update' | 'remove' | 'rollback' | 'enable' | 'disable'; id?: string; source?: PackageSource; index?: string; scope?: 'user' | 'project' };
export type KeymapAction = `${string}.${string}`;
export type Declined = { status: 'declined' };
export interface HostOperations {
  'exec.run': { arguments: { program: string; sha256?: string; argv?: string[]; cwd?: string; env?: Record<string, string>; stdin?: string; timeout_ms?: number; max_output_bytes?: number; output_artifact?: boolean; write?: boolean; network?: 'none' | 'loopback'; snapshot?: ResourceRef; guards?: ExecGuard[]; required_access?: { write: string[] } }; result: ExecResult & { candidate_sha256?: string; evidence?: ResourceRef } };
  'exec.output_page': { arguments: { artifact: ResourceRef; cursor?: number; max_bytes?: number }; result: { text: string; cursor: number | null; bytes: number; sha256: string } };
  'workspace.read': { arguments: { paths: string[] }; result: { files: Record<string, { text: string; sha256: string } | null> } };
  'workspace.list': { arguments: { path?: string; recursive?: boolean; include_ignored?: boolean; max_entries?: number }; result: { entries: ({ path: string } & FileStat)[]; truncated: boolean } };
  'workspace.stat': { arguments: { paths: string[]; hash?: boolean }; result: { files: Record<string, FileStat | null> } };
  'workspace.check_access': { arguments: { paths: string[]; write?: boolean }; result: { paths: string[]; write: boolean } };
  'workspace.snapshot': { arguments: { agent?: string; expected?: string }; result: { snapshot: ResourceRef; candidate_sha256: string } };
  'workspace.fingerprint': { arguments: { agent?: string; expected?: string }; result: { candidate_sha256: string } };
  'workspace.transaction': { arguments: { expected: Record<string, Fingerprint>; writes?: Record<string, string>; deletes?: string[]; renames?: { old: string; new: string }[]; backup?: boolean }; result: { files: Record<string, string | null>; backup: ResourceRef | null } };
  'workspace.backup': { arguments: { expected: Record<string, Fingerprint> }; result: { backup: ResourceRef } };
  'workspace.restore': { arguments: { backup: ResourceRef; expected: Record<string, Fingerprint> }; result: { files: Record<string, string | null> } };
  'workspace.request_rename': { arguments: { old: string; new: string }; result: { status: 'renamed'; files: Record<string, string | null> } | { status: 'fallback'; reason: string } };
  'workspace.integrate': { arguments: { handle: string; acceptance_sha256?: string }; result: { status: 'integrated'; candidate_sha256: string; parent_candidate_sha256: string; changed_paths: string[]; evidence: HostEvidence; receipt_error?: string } | { status: 'refused'; candidate_sha256: string; missing: ContractRequirement[] } };
  'store.get': { arguments: { key: string; scope?: StoreScope }; result: { value: Json; revision: number; provenance: StoreProvenance } | null };
  'store.put': { arguments: { key: string; value: Json; expected_revision: number | null; scope?: StoreScope }; result: { revision: number } };
  'store.delete': { arguments: { key: string; expected_revision: number; scope?: StoreScope }; result: { deleted: boolean } };
  'store.list': { arguments: { prefix?: string; cursor?: string; limit?: number; scope?: StoreScope }; result: { keys: { key: string; revision: number; bytes: number; provenance: StoreProvenance }[]; cursor: string | null } };
  'store.export': { arguments: { scope?: StoreScope; cursor?: string }; result: { schema: 1; owner: string; scope: StoreScope; generation: number; entries: Record<string, { value: Json; revision: number; provenance: StoreProvenance }>; cursor: string | null } };
  'store.reset': { arguments: { expected_generation: number; scope?: StoreScope }; result: { generation: number } };
  'evidence.write': { arguments: { media_type: 'application/json' | 'text/plain'; content: Json; label?: string } | { media_type: 'image/png' | 'image/jpeg' | 'application/octet-stream'; base64: string; label?: string }; result: ResourceRef };
  'evidence.read': { arguments: { reference: ResourceRef; cursor?: number; max_bytes?: number }; result: { reference: ResourceRef; text: string; cursor: number | null; bytes: number } };
  'sessions.list': { arguments: { since?: string; until?: string; cursor?: string; limit?: number }; result: { sessions: SessionSummary[]; cursor: string | null; revision: string; scan_truncated: boolean; unavailable: number; projection: string } };
  'sessions.read': { arguments: { session_id: string; revision: string; handle: string; cursor?: number; max_bytes?: number }; result: { session: SessionSummary; records: SessionRecord[]; cursor: number | null; bytes: number; projection: string; projection_truncated: boolean } };
  'sessions.snapshot': { arguments: { call_ids?: string[] }; result: { evidence: ResourceRef; provenance: { sha256: string; bytes: number; items: number; revision: number } } };
  'routes.list': { arguments: null; result: RouteInfo[] };
  'task.status': { arguments: null; result: { ledger: Ledger; limits: Json; worker_limits: Json } };
  'task.complete': { arguments: { candidate_sha256: string; acceptance_sha256?: string }; result: { status: 'completed'; receipts: Receipt[] } | { status: 'refused'; missing: ContractRequirement[] } | { status: 'refused'; reason: 'unresolved_blocking_findings'; outstanding_findings: string[] } };
  'receipts.submit': { arguments: { kind: string; candidate_sha256: string; acceptance_sha256?: string; outcome: 'pass' | 'fail'; evidence: ResourceRef; agent?: string; execution?: boolean; findings?: ReceiptFinding[]; resolves?: string[] }; result: Receipt };
  'contract.status': { arguments: null; result: ContractStatus };
  'contract.restrict': { arguments: { operations?: string[]; scoped?: ContractRestriction[]; reason: string }; result: { restrictions: string[]; scoped_restrictions: ContractRestriction[] } };
  'agents.spawn': { arguments: { role: string; route: string; prompt: string; workspace?: 'read_only' | 'isolated_worktree'; tools?: string[]; evidence?: ResourceRef; snapshot?: ResourceRef; parent_history?: boolean; resolution_context?: { acceptance_sha256: string; findings: string[] } }; result: Agent };
  'agents.message': { arguments: { handle: string; message: string }; result: { delivered: boolean } };
  'agents.cancel': { arguments: { handle: string }; result: { cancelled: boolean } };
  'agents.result': { arguments: { handle: string; consume?: boolean }; result: AgentResult };
  'agents.wait': { arguments: { handle: string; consume?: boolean }; result: AgentResult };
  'agents.list': { arguments: null; result: { handle: string; finished: boolean; consumed: boolean }[] };
  'process.which': { arguments: { names: string[] }; result: { found: { name: string; path: string; sha256: string }[] } };
  'process.start': { arguments: { session: string; name: string; path: string; sha256: string; arguments?: string[]; environment?: Record<string, string>; framing?: 'content-length' | 'ndjson'; network?: 'none' | 'loopback'; notify?: ('output' | 'exit')[] }; result: { session: string; running: true } };
  'process.exchange': { arguments: { session: string; send?: Json[]; wait_ms?: number }; result: { session: string; messages: Json[]; running: true } };
  'process.status': { arguments: { session: string }; result: { session: string; running: true; idle_ms: number } };
  'process.stop': { arguments: { session: string }; result: { stopped: boolean } };
  'providers.register': { arguments: { id: string }; result: Json };
  'providers.unregister': { arguments: { id: string }; result: Json };
  'sidecars.invoke': { arguments: { id: string; input: Json }; result: { provider: string; program_sha256: string; source_hashes: Record<string, string>; result: Json; untrusted: true } };
  'sidecars.start': { arguments: { id: string; credential?: string; secrets?: string[] }; result: Json };
  'sidecars.status': { arguments: { id: string }; result: Json };
  'sidecars.stop': { arguments: { id: string }; result: Json };
  'app.request': { arguments: { method: string; params: Json }; result: Json | Declined };
  'app.routes': { arguments: null; result: AppRoute[] };
  'workspace.watch': { arguments: { paths: string[]; recursive?: boolean; debounce_ms?: number }; result: { watch_id: string } };
  'workspace.unwatch': { arguments: { watch_id: string }; result: { stopped: boolean } };
  'events.publish': { arguments: { channel: string; data: Json; correlation?: string }; result: { delivered: number; dropped: number } };
  'events.schedule': { arguments: { key: string; delay_ms: number }; result: { key: string; delay_ms: number } };
  'events.cancel': { arguments: { key: string }; result: { cancelled: boolean } };
  'tools.define': { arguments: { name: string; description: string; parameters: Json; label?: string }; result: { name: string; effective_at: 'next_request' } };
  'tools.undefine': { arguments: { name: string }; result: { removed: boolean } };
  'credentials.list': { arguments: null; result: CredentialProfile[] };
  'credentials.request': { arguments: { action: 'enroll'; kind: 'chatgpt' | 'api_key' | 'provider'; label: string; provider?: string } | { action: 'enroll'; kind: 'secret'; label: string; origin: string } | { action: 'remove' | 'refresh'; profile: string }; result: { status: 'completed' | 'declined'; profile: CredentialProfile | null } };
  'routes.select': { arguments: { route: string; scope: 'next_request' | 'thread' }; result: { route: RouteInfo; effective_at: 'next_request' } };
  'turns.activity': { arguments: { thread_id?: string; turn_id?: string; last?: number } | null; result: { turns: TurnActivity[]; recording: boolean } };
  'terminal.notify': { arguments: { title: string; body?: string }; result: { delivered: boolean; method: 'osc9' | 'osc99' | 'osc777' | 'bel' | 'none'; reason?: string } };
  'terminal.show_thread': { arguments: { thread_id: string }; result: { shown: boolean } };
  'terminal.import_file': { arguments: { path: string; max_bytes?: number; lifetime?: 'thread' | 'package' }; result: ResourceRef | Declined };
  'terminal.image_sample': { arguments: { resource: ResourceRef; columns: number; rows: number }; result: { width: number; height: number; rgba: number[] } };
  'composer.read': { arguments: null; result: { text: string; cursor: number; attachments: { kind: 'image'; label: string }[] } };
  'composer.write': { arguments: { text?: string; insert?: string; attach?: { image: ResourceRef }[] }; result: { text: string; cursor: number } };
  'builtins.invoke': { arguments: { command: string; args?: string } | { action: KeymapAction }; result: { invoked: boolean } };
  'packages.list': { arguments: null; result: { packages: PackageState[]; generation: number } };
  'packages.preview': { arguments: PackageRequest & { expected_generation?: number }; result: { action: string; id: string; changes: Json; grants_added: string[]; conflicts: string[] } };
  'packages.apply': { arguments: PackageRequest & { expected_generation: number }; result: { status: 'applied'; generation: number } | Declined };
  'packages.reload': { arguments: null; result: { generation: number; failed: string[]; applies: 'next_boundary' } };
  'terminal.open': { arguments: { url: string } | { path: string } | { path: string; line?: number; editor: true }; result: { opened: true } | Declined };
  'terminal.prompt': { arguments: { kind: 'confirm'; title: string; message: string } | { kind: 'text'; title: string; message: string; masked?: boolean }; result: { status: 'accepted'; value?: string } | Declined };
  'terminal.pty': { arguments: PtyRequest; result: { session: string; running: true } | { written: number } | { text: string; running: boolean; exit_code: number | null } | { stopped: true } | Declined };
  'model.complete': { arguments: { route: string; prompt: string; timeout_ms?: number }; result: { text: string } };
}
export interface Events {
  context: { input: Context; output: ContextResult | null };
  migrate: { input: { from: number; to: number }; output: void };
  routing: { input: { routes: RouteInfo[]; model: string | null; provider: string; reasoning: string | null }; output: { route: string } | null };
  compaction: { input: { token_limit: number | null; context_window: number | null }; output: CompactionDecision };
  input: { input: { text: string; attachments: number }; output: InputDecision };
  tool_before: { input: { tool: string; arguments: Json; call_id: string; thread_id: string | null; schema: Json | null; raw_arguments: string; batch: { id: string; index: number; size: number } | null }; output: { deny: string } | { arguments: Json; tool?: string } | null };
  tool_exposure: { input: { thread_id: string | null; ledger: Ledger | null; available: string[] }; output: { enable: string[] } };
  terminal: { input: { event: string; ledger: Ledger | null; identity?: TerminalIdentity; presentation?: TerminalPresentation | null }; output: TerminalView | TerminalPatch | null };
  list: { input: TerminalListEvent; output: TerminalComponent[] | null };
  start: { input: Json; output: void };
  resume: { input: { thread_id: string; last_turn: { turn_id: string; status: 'completed' | 'interrupted' | 'failed' | 'in_progress' } | null; restarted: boolean }; output: void };
  idle: { input: Json; output: void };
  stop: { input: Json; output: void };
  tool_result: { input: { call_id: string; agent_id: string | null; thread_id: string | null; tool: string; outcome: 'succeeded' | 'unsuccessful' | 'blocked' | 'failed' | 'failed_before_handler' | 'aborted'; call_sha256: string | null; result_sha256: string | null; result_complete: boolean }; output: void };
  workspace_change: { input: { repository: string; source: 'tool' | 'transaction' | 'exec' | 'rescan' | 'external'; call_id: string | null; watch_id?: string; changes: { path: string; before: string | null; after: string | null }[]; status: 'observed' | 'unavailable'; reason?: string | null }; output: void };
  workspace_pre_rename: { input: { repository: string; old: string; new: string; expected: Record<string, string | null> }; output: { status: 'ready'; expected: Record<string, string | null>; writes: Record<string, string> } | { status: 'fallback'; reason: string } | void };
  turn_start: { input: { turn_id: string }; output: void };
  turn_end: { input: { turn_id: string; outcome: 'completed' | 'aborted' | 'error'; reason?: string; error?: string; evidence?: ResourceRef }; output: void };
  compaction_start: { input: { turn_id: string; trigger: 'manual' | 'auto' }; output: void };
  compaction_end: { input: { turn_id: string; trigger: 'manual' | 'auto' }; output: void };
  agent_end: { input: { handle: string; role: string; status: 'completed' | 'failed'; error?: string; failure?: AgentFailure | null; text?: string; sha256?: string }; output: void };
  contract: { input: { gate: 'complete' | 'integrate'; outcome: 'passed' | 'refused'; missing: ContractRequirement[]; candidate_sha256: string }
    | { gate: 'complete'; outcome: 'refused'; reason: 'unresolved_blocking_findings'; outstanding_findings: string[]; candidate_sha256: string }; output: void };
  model_request: { input: ModelRequestEvent; output: { route: string } | null };
  response_stream: { input: ResponseStreamEvent; output: StreamDecision };
  prompt: { input: { thread_id: string; turn_id: string; original: string; effective: string; provenance: Json[] }; output: void };
  session: { input: { phase: 'start' | 'resume' | 'idle' | 'stop'; thread_id: string; cause?: string }; output: void };
  agent: { input: { phase: 'start' | 'end'; agent_id: string; parent_agent_id: string | null; role: string; status: string }; output: void };
  tool_call: { input: { call_id: string; agent_id: string | null; tool: string; arguments: Json }; output: void };
  host_operation: { input: { phase: 'before' | 'after'; caller: string; operation: keyof HostOperations; arguments?: Json; result?: Json; error?: string }; output: void };
  app_notification: { input: { method: string; params: Json; thread_id: string | null; coalesced: number; dropped: number }; output: void };
  app_server_request: { input: { method: string; request_id: Json; phase: 'requested' | 'resolved'; params: Json; resolution: Json }; output: void };
  approval: { input: { id: string; kind: 'exec' | 'stdin' | 'execve' | 'patch' | 'mcp_tool' | 'network' | 'permissions'; thread_id: string; turn_id: string | null; agent_id: string | null; host_decision: 'ask' | 'skip'; policy: string; details: Json }; output: null | { deny: string } | { ask: string } };
  approval_result: { input: { id: string; kind: string; decision: 'approved' | 'approved_for_session' | 'amended' | 'denied' | 'aborted' | 'timed_out'; source: 'user' | 'guardian' | 'hook' | 'mod' | 'policy'; mod?: string }; output: void };
  tool_output: { input: { call_id: string; tool: string; arguments: Json; success: boolean; text: string; tail: string | null; bytes: number; original: ResourceRef | null }; output: null | { text: string } | { append: string } };
  completion: { input: { kind: 'mention'; query: string; candidates: { path: string; score: number }[] } | { kind: 'argument'; command: string; query: string; line: string }; output: null | { items: { path: string }[] } | { items: { insert: string }[] } };
  history: { input: { thread_id: string; agent_id: string | null; model: string | null; items: HistoryItem[] }; output: null | HistoryEdit };
  tool_batch: { input: { batch_id: string; thread_id: string; calls: { call_id: string; tool: string; arguments: Json; parallel_safe: boolean }[] }; output: null | { merge: { call_ids: string[]; tool: string; arguments: Json }[] } };
  tool_specs: { input: { thread_id: string; route: { name: string; model: string; provider: string } | null; tools: { name: string; description: string; parameters: Json }[] }; output: null | { hide?: string[]; describe?: Record<string, { description?: string; parameters?: Json }> } };
  process_event: { input: { session: string; kind: 'output'; bytes: number } | { session: string; kind: 'exit' }; output: void };
  timer: { input: { key: string }; output: void };
  channel: { input: { publisher: string; channel: string; data: Json; correlation: string | null; sequence: number; dropped: number }; output: void };
  component_event: { input: { component: string; kind: 'select' | 'activate' | 'find' | 'key'; range?: TerminalRange; anchor?: string | null; matches?: number; error?: string; key?: KeyName | string | null; text?: string | null }; output: void };
  view: { input: { phase: 'opened' | 'closed'; view: 'bottom_pane' | 'overlay'; view_id: string | null }; output: void };
  focus: { input: { focused: boolean }; output: void };
}
export type BuiltinControls = { commands?: { hide?: string[]; replace?: Record<string, string> }; modes?: { disable?: string[] }; keys?: Record<KeymapAction, KeymapKey | null> };
export interface ModAPI {
  readonly version: '0.2.0-experimental.5';
  readonly fieldPolicies: Readonly<Record<string, Readonly<Record<string, FieldPolicy>>>>;
  readonly settings: Readonly<Record<string, Json>>;
  readonly host: {
    call<K extends keyof HostOperations>(operation: K, arguments_: HostOperations[K]['arguments']): HostOperations[K]['result'];
    tryCall<K extends keyof HostOperations>(operation: K, arguments_: HostOperations[K]['arguments']): { ok: true; value: HostOperations[K]['result'] } | { ok: false; error: string };
  };
  readonly assets: { read(name: string): { text: string; sha256: string } };
  readonly services: { call<T extends Json = Json>(name: string, method: string, input?: Json): T };
  on<K extends keyof Events>(event: K, handler: (event: Events[K]['input']) => Events[K]['output'] | Promise<Events[K]['output']>): void;
  middleware<K extends 'model_request' | 'response_stream' | 'prompt' | 'session' | 'agent' | 'tool_call' | 'tool_result' | 'host_operation' | 'approval'>(event: K, handler: (event: Events[K]['input']) => Events[K]['output'] | Promise<Events[K]['output']>): void;
  replace<K extends 'context' | 'routing' | 'compaction' | 'tool_before' | 'terminal' | 'input' | 'list' | 'tool_output' | 'tool_batch' | 'tool_specs' | 'completion' | 'history'>(point: K, handler: (event: Events[K]['input']) => Events[K]['output'] | Promise<Events[K]['output']>): void;
  contract(document: ContractDocument): void;
  builtins(controls: BuiltinControls): void;
  provide(contract: ServiceContract, handlers: Record<string, (input: Json) => Json | Promise<Json>>): void;
  tool(spec: ToolSpec, handler: (arguments_: Json) => Json | Promise<Json>): void;
  dynamicTools(handler: (call: { name: string; arguments: Json }) => Json | Promise<Json>): void;
  virtualRead(definition: { scheme: string; version: string }, handler: (request: VirtualReadRequest) => VirtualReadResponse | Promise<VirtualReadResponse>): void;
  command(name: string, handler: (arguments_: Json) => CommandResult | Promise<CommandResult>, options?: { description?: string; cli?: string }): void;
  progress(text: string): void;
  readonly state: { get(): Json; set(value: Json): void };
  unsupported(operation: string): never;
}
export default function activate(api: ModAPI): void | Promise<void>;

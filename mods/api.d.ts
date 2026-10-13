export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Capability =
  | 'context' | 'tools' | 'commands' | 'lifecycle' | 'input' | 'interception' | 'compaction' | 'middleware' | 'services' | 'virtual_reads' | 'terminal'
  | 'exec' | 'fs.read' | 'fs.write' | 'network' | 'unix_sockets' | 'model' | 'agents' | 'store' | 'sessions' | 'sessions_tools' | 'contracts' | 'builtins'
  | 'threads' | 'config' | 'config.write' | 'inventory' | 'account' | 'packages' | 'approvals' | 'events' | 'credentials' | 'composer'
  | 'pty' | 'history' | 'outputs' | 'os' | 'approve' | 'approve.override' | 'request_policy' | 'peers' | 'autonomous' | 'history_write'
  | 'history_persist' | 'fs.external' | 'http' | 'mcp' | 'policy';
export type FieldPolicy = 'observe_only' | 'alterable' | 'replaceable';
export type JsonKind = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object' | 'json';
export type Stability = 'stable' | 'deprecated' | 'experimental';
export type ServiceMethod = { input: JsonKind; output: JsonKind };
export type ServiceContract = { name: `${string}.${string}`; version: `${number}.${number}.${number}`; stability?: Stability; deprecated_since?: string; replacement?: `${string}.${string}`; methods: Record<string, ServiceMethod> };
export type ResourceRef = { reference: string; sha256: string };
export type HostEvidence = { path: string; sha256: string };

export type RouteInfo = { name: string; model: string; provider: string; reasoning: string; roles: ('lead' | 'worker')[]; billing: 'included_subscription' | 'explicit_paid_api_grant' | 'provider_billed'; tools: string[]; available: boolean; credential: string | null };
export type ModelScope = { thread_id: string; agent_id: string | null; kind: 'main' | 'subagent' };
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
/** One classified prompt item; `group` is its message (or `instructions`), which it never leaves. */
export type PromptSection = { id: string; kind: string; role: 'system' | 'developer' | 'user' | 'tool'; group: string; protected: boolean; text: string | null; bytes: number; truncated: boolean };
export type InsertedSection = { id: `mod:${string}`; text: string };
export type ModelRequest = {
  request_id: string; attempt: number; scope: ModelScope; routes: RouteInfo[]; original: RouteInfo; route: string;
  model: string; provider: string; effort: ReasoningEffort | null; sections: PromptSection[]; tools: string[];
};
export type ModelAnswer = { response: { output: ({ type: 'message'; text: string } | { type: 'tool_call'; tool: string; namespace?: string; arguments: Json })[] } };
type StreamContext = { request_id: string; scope: ModelScope; synthetic: string | null; protected: boolean };
type ToolChunk = { index: number; item_id: string | null; call_id: string; tool: string; format: 'json' | 'freeform' };
export type StreamChunk = StreamContext & (
  | { kind: 'text' | 'message'; index: number; item_id: string | null; text: string }
  | ({ kind: 'tool_call' } & ToolChunk)
  | ({ kind: 'tool_input'; text: string } & ToolChunk)
  | ({ kind: 'tool_done'; arguments: string } & ToolChunk)
  | { kind: 'reasoning'; index: number; item_id: string | null }
  | { kind: 'stop'; index: null; status: 'completed' | 'incomplete' | 'failed'; usage: Json });
export type InjectedChunk = { kind: 'message'; text: string } | { kind: 'tool_done'; tool: string; namespace?: string; format?: 'json' | 'freeform'; arguments: string };
export type StreamStop = { stop: { reason: string }; retry?: { inject: string } };
/** One provider-bound text leaf, addressed by its JSON pointer; a piece of a longer one has `offset` and read-only `before`/`after` context. */
export type FinalRequestSegment = { id: string; kind: string; role: string; editable: boolean; text: string; bytes: number; sha256: string; offset?: number; before?: string; after?: string };
/** Replaces `text.slice(start, end)` of a segment on this page (JavaScript string indices). */
export type FinalRequestEdit = { segment: string; start: number; end: number; text: string };
export type FinalRequestPage = {
  request_id: string; attempt: number; scope: { thread_id: string | null; agent_id: string | null; kind: 'main' | 'subagent' | 'internal' };
  provider: string | null; route: string | null; model: string | null; page: number; pages: number; cached: number;
  segments: FinalRequestSegment[]; opaque: { id: string; kind: string }[]; opaque_total: number;
};
export type CostBasis = 'settled' | 'unsettled' | 'provider_reported' | 'included_subscription' | 'unpriced' | 'synthetic';
/** `route` names a configured worker route the mod may use, or `lead` for the thread's lead route when it lists the mod in `mods`. */
/** `turns_started` counts turns this process started in the thread. */
export type SessionInfo = { thread_id: string; root: string; cwd: string; codex_version: string; model: string | null; provider: string; route: string | null; turns_started: number };
export type Timer = { start(): { key: string; delay_ms: number }; cancel(): { cancelled: boolean } };
export type UsageSummary = {
  request_id: string | null; route: string | null; provider: string | null; credential: string | null; requested_model: string | null; served_model: string | null;
  /** Provider-reported token counts; `false` when the response carried none. */
  measured: boolean;
  tokens: { input: number | null; cached: number | null; cache_write: number | null; output: number | null; reasoning: number | null };
  context: { used: number; window: number; ratio: number } | null;
  /** Charges are projections from configured rates or subscription status, not provider invoices. */
  cost: { microusd: number | null; basis: CostBasis; source: 'configured_rates' | 'provider' | 'subscription' | 'none' | 'unknown' };
  timing: ModelResponse['timing'] | null; synthetic: string | null;
};
export type ModelCallOptions = {
  prompt: string; system?: string; context?: string[]; output?: { schema: Json }; effort?: ReasoningEffort;
  max_output_tokens?: number; timeout_ms?: number;
  /** Marks the prefix through `system` or through context block N as cacheable; see `model_cache_v1`. */
  cache?: { through: 'system' | number };
};
export type ModelCallResult = {
  /** `incomplete`: the provider stopped at `max_output_tokens` (or another limit in `stop_reason`); `text` is what streamed. */
  status: 'completed' | 'incomplete' | 'failed'; text: string; content: { type: 'text'; text: string }[];
  tool_calls: { call_id: string; tool: string; arguments: string; executed: false }[]; stop_reason: string | null; error: string | null;
  route: string; model: string | null; request_ids: string[]; usage: Json; cache: ModelResponse['cache'];
  cost: { microusd: number | null; basis: CostBasis | 'mixed' | 'unknown' }; timing: { duration_ms: number; first_event_ms: number | null };
};
export type ModelResponse = {
  request_id: string; attempt: number; ledger_request: number | null; scope: ModelScope; route: string; provider: string; credential: string | null;
  requested_model: string; served_model: string | null; status: 'completed' | 'incomplete' | 'failed' | 'cancelled'; stop_reason: string | null;
  output: { text: string; tool_calls: { call_id: string; tool: string }[] }; usage: Json;
  cache: { read_tokens: number | null; write_tokens: number | null }; cost: { microusd: number | null; basis: CostBasis };
  context_window: number | null; timing: { started_at_ms: number; first_event_ms: number | null; duration_ms: number };
  synthetic: string | null; error: string | null;
};

export type ToolSpec = { name: string; label?: string; description: string; parameters: { type: 'object'; properties: Record<string, Json>; required?: string[]; additionalProperties?: boolean }; task_scoped?: boolean };
/** Original argument types by tool name; a store's generated `tool-types.d.ts` fills it from the host's actual tool inventory. */
export interface ToolArguments {}
/** A tool call: any tool until `ToolArguments` lists the inventory, then exactly one of its tools. */
export type ToolCall = keyof ToolArguments extends never
  ? { tool: string; arguments: Json }
  : { [T in keyof ToolArguments]: { tool: T; arguments: ToolArguments[T] } }[keyof ToolArguments];
/** `effective` is null when a `tool_specs` interceptor hid the tool; `deferred` tools are reachable through tool search. */
export type ToolInventoryEntry = {
  name: string; kind: 'builtin' | 'mcp' | 'extension' | 'dynamic'; server: string | null;
  original: { description: string; parameters: Json | null; freeform: boolean };
  effective: { description: string; parameters: Json | null; deferred: boolean } | null;
};
export type ToolInventory = { thread_id: string; tools: ToolInventoryEntry[] };
export type VirtualReadRequest = { uri: string; cursor?: string; expected_revision?: string; max_bytes?: number };
export type VirtualReadResponse = { canonical_uri: string; canonical_url: string; identity: string; revision: string; text: string; anchors: string[]; cursor: string | null; truncated: boolean };
export type SessionSummary = { session_id: string; task_id: string; parent_id: string | null; timestamp: string; revision: string; handle: string; history_mode: string; inherited_history: boolean; incomplete_tail: boolean };
/** A record's text, or without `sessions_tools` a tool record's size and digest. */
export type SessionText<K extends string> = ({ [P in K]: string } & { truncated: boolean; redacted: boolean }) | { bytes: number; sha256: string };
export type SessionRecord = { session_id: string; turn_id: string; item: number; timestamp: string | null; untrusted: true } & (
  { kind: 'message'; role: 'user' | 'assistant'; text: string; truncated: boolean; redacted: boolean }
  | ({ kind: 'tool_call'; name: string; call_id: string } & SessionText<'arguments'>)
  | ({ kind: 'tool_result'; call_id: string } & SessionText<'output'>));
export type Ledger = { thread_id: string; cwd: string; cost: Json | null };
export type Context = { thread_id: string; turn_id: string; ledger: Ledger };
export type ContextResult = { text: string };
export type Agent = { handle: string; route: string; permissions: 'read_only' | 'isolated_worktree'; parent_history?: { sha256: string; bytes: number; items: number; revision: number } | null };
export type AgentDefinition = { name: string; description: string; instructions: string; route?: string; effort?: ReasoningEffort; tools?: string[]; offer?: boolean };
export type AgentRecord = { agent_id: string | null; thread_id: string; parent: { thread_id: string | null; agent_id: string | null }; origin: 'model' | 'mod' | 'native';
  owner: string | null; definition: { name: string; owner: string; source_sha256: string } | null; role: string | null; route?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled'; started_at_ms: number; ended_at_ms: number | null; duration_ms: number | null; turns: number;
  last_turn: { turn_id: string; outcome: 'completed' | 'aborted' | 'error'; at_ms: number; answer: string | null; error: AgentFailure | null } | null; answer: string | null;
  usage: { requests: number | null; input_tokens: number; output_tokens: number; cached_tokens: number; microusd: number | null; basis: 'unknown' | 'settled' | 'partial'; source: 'accounting' | 'engine' | null }; reason: string | null };
export type AgentSpawnRequest = { origin: 'model' | 'mod'; caller: string; thread_id: string | null; agent_id: string | null; definition: string | null; prompt: string; model: string | null; effort: ReasoningEffort | null; cwd: string | null; tools: string[] | null };
export type PeerAddress = { session: string; package: string };
export type PeerSender = { session: string; repository: string; package: string; sha256: string };
export type PeerReceipt = { id: string; status: 'queued' | 'delivered' | 'refused' | 'failed' | 'expired' | 'closed'; reason?: string | null; at_ms?: number; by?: { session: string; package: string | null }; correlation?: string | null; to?: PeerAddress };
export type TurnQueueEntry = { key: string; priority: 'high' | 'normal' | 'low'; event: string; queued_at_ms: number; deadline_ms: number | null };
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
export type TerminalInputEvent = { key: KeyName | string | null; text: string | null } | { paste: string; truncated?: boolean };
export type TerminalSpan = { text: string; tone?: TerminalTone; bold?: boolean; italic?: boolean; underline?: boolean; fg?: ThemeColor; bg?: ThemeColor; link?: string };
export type TerminalStyle = { tone?: TerminalTone; bold?: boolean; italic?: boolean; underline?: boolean; fg?: ThemeColor; bg?: ThemeColor };
export type TerminalListRow = { value: string; spans: TerminalSpan[]; label: string };
export type TerminalControl = { hotkey?: KeyName; autofocus?: boolean };
/** Cells on every side, or `[vertical, horizontal]`; each 0–4. */
export type TerminalSpacing = number | [number, number];
export type TerminalPaint = TerminalTone | ThemeColor;
/** Restyles a box while hovered or while it or a descendant has focus; never adds or removes its border. */
export type TerminalBoxAccent = { border?: TerminalBoxStyle['border']; background?: TerminalPaint; foreground?: TerminalPaint };
/** One box model for boxes, panes, dialogs, overlays, layout sites and the sidebar. The title sits in the top edge when there is a border. */
export type TerminalBoxStyle = {
  border?: 'none' | 'plain' | 'rounded' | 'double' | 'thick'; padding?: TerminalSpacing; margin?: TerminalSpacing; gap?: number;
  background?: TerminalPaint; foreground?: TerminalPaint; direction?: 'column' | 'row'; hover?: TerminalBoxAccent; focus?: TerminalBoxAccent;
};
/** Dialogs, overlays, layout sites and the sidebar take no `hover`/`focus` accents. */
export type TerminalFrameStyle = Omit<TerminalBoxStyle, 'hover' | 'focus'>;
/** `flex` (1–12) weights a child's share of a row; in a row `max_width` caps its width, elsewhere both bounds hide it outside them. */
export type TerminalBoxProps = { style?: TerminalBoxStyle; flex?: number; min_width?: number; max_width?: number; pointer?: boolean };
export type TerminalComponent =
  | ({ type: 'box'; id: string; label: string; title?: string; children?: TerminalComponent[] } & TerminalBoxProps)
  | { type: 'line'; id: string; label: string; spans: TerminalSpan[] }
  | { type: 'text'; id: string; label: string; text: string; tone?: TerminalTone }
  | ({ type: 'button'; id: string; label: string; text: string; action: TerminalComponentAction } & TerminalControl)
  | ({ type: 'input'; id: string; label: string; value?: string; placeholder?: string; action: TerminalCommandAction } & TerminalControl)
  | ({ type: 'select'; id: string; label: string; value: string; options: TerminalSelectOption[]; action: TerminalCommandAction } & TerminalControl)
  | ({ type: 'multiselect'; id: string; label: string; value?: string[]; options: TerminalSelectOption[]; action: TerminalCommandAction } & TerminalControl)
  | ({ type: 'list'; id: string; label: string; rows: TerminalListRow[]; selected?: string; height?: number; action: TerminalCommandAction } & TerminalControl)
  | { type: 'markdown'; id: string; label: string; text: string }
  | { type: 'code'; id: string; label: string; text: string; language?: string }
  | ({ type: 'pane'; id: string; label: string; title?: string; collapsed?: boolean; scroll?: number; keys?: boolean; children?: TerminalComponent[] } & TerminalBoxProps)
  | { type: 'dialog'; id: string; label: string; title: string; children?: TerminalComponent[]; style?: TerminalFrameStyle }
  | { type: 'document'; id: string; label: string; lines?: TerminalSpan[][]; source?: ResourceRef; anchors?: string[]; selected?: TerminalRange; find?: { query: string; regex?: boolean; case?: boolean }; height?: number; action?: TerminalCommandAction; keys?: boolean }
  | { type: 'diff'; id: string; label: string; unified: string; selected?: TerminalRange; height?: number; action?: TerminalCommandAction }
  | { type: 'image'; id: string; label: string; image: ResourceRef; alt: string; height?: number; pointer?: boolean }
  /** A keyed canvas of `width`×`height` cells drawn by `terminal.blit`; `alt` shows until the first frame. */
  | { type: 'raster'; id: string; label: string; alt: string; width?: number; height?: number; pointer?: boolean }
  | { type: 'terminal'; id: string; label: string; session: string; height?: number }
  /** Experimental: a region drawn by the mod's `api.component(module, ...)`; `keys` takes focus on click or Tab, `pointer` sends pointer events. */
  | { type: 'module'; id: string; label: string; module: string; props?: Json; height?: number; keys?: boolean; pointer?: boolean }
  | { type: 'slot' }
  /** The native drawing of the component a `render` hook draws; at most once per tree. */
  | { type: 'native'; style?: TerminalStyle };
export type TerminalRange = { start: number; end: number };
export type TerminalSiteName = 'sidebar' | 'header' | 'above_composer' | 'dialog' | 'welcome' | `${string}/${string}`;
export type LayoutNode =
  | { content: 'transcript' | 'composer' }
  | { content: `site:${TerminalSiteName}`; style?: TerminalFrameStyle }
  | { split: 'horizontal' | 'vertical'; ratio?: number[]; gap?: number; children: LayoutNode[] }
  | { tabs: { title: string; node: LayoutNode }[]; active?: number };
export type BackdropTransform = { position?: 'center' | 'fill' | 'fit' | 'tile'; dim?: number; scale?: number; tint?: ThemeColor; opacity?: number; offset?: { x: number; y: number } };
export type AsciiBackdrop = BackdropTransform & { text: string };
export type TerminalBackdrop =
  | { ascii: AsciiBackdrop }
  | { image: BackdropTransform & { resource: ResourceRef; overlay?: TerminalSurfacePaint }; fallback?: { ascii: AsciiBackdrop } };
export type TerminalSurfacePaint = { top?: ThemeColor; bottom?: ThemeColor; foreground?: ThemeColor; border?: ThemeColor; opacity?: number };
/** An overlay draws a `owner/name` site above the layout at its anchor's top-left plus `offset`; higher `z` draws later. */
export type TerminalOverlay = {
  anchor: 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right' | 'center' | { component: string };
  offset?: { x: number; y: number }; width: number; height: number; z?: number; clip?: 'screen' | 'anchor'; style?: TerminalFrameStyle;
};
export type TerminalRenderSite = { mode?: 'replace' | 'wrap'; components?: TerminalComponent[]; overlay?: TerminalOverlay };
export type TerminalWelcome = { show_while_composing?: boolean };
/** Host startup selection uses a null thread_id; live acceptance/resume supplies the real thread. */
export type TerminalPresentation = { thread_id: string | null; phase: 'fresh' | 'started' | 'resumed'; surface?: 'inline' | 'fullscreen' };
export interface TerminalTheme {
  accent?: ThemeColor; user_message_background?: ThemeColor; syntax?: string; success?: ThemeColor; attention?: ThemeColor; failure?: ThemeColor;
  diff_added?: ThemeColor; diff_removed?: ThemeColor; muted?: ThemeColor; border?: 'plain' | 'rounded' | 'double'; density?: 'compact' | 'comfortable'; icons?: 'unicode' | 'ascii';
  glyphs?: Record<string, string>;
}
export type TerminalClient = {
  kind: 'terminal'; graphics: 'kitty' | 'iip' | 'cells' | 'text'; pointer: 'half_cell' | 'cell' | 'none'; reduced_motion: boolean;
  cell_px: { width: number; height: number } | null; columns: number; rows: number;
};
/** An external client attached over `omd/client/attach`; `viewport` is null until the client reports one. */
export type ClientEntry = {
  id: string; name: string;
  renderer: { kind: 'terminal' | 'gui' | 'text'; formats: ('svg' | 'png' | 'jpeg' | 'cells' | 'text')[]; pointer: 'pixel' | 'cell' | 'half_cell' | 'none'; reduced_motion: boolean; cell_px?: { width: number; height: number } };
  viewport: { width: number; height: number; unit: string } | null; focused: boolean; attached_ms: number;
};
export type TerminalCell = string | [glyph: string, fg: ThemeColor | null, bg: ThemeColor | null];
export type TerminalIdentity = { codex_version: string; install_profile: 'full' | 'platform_only' | 'private' | 'unknown' | 'unreported'; mode: 'omd'; mods: { installed: number; enabled: number; active: number; failed?: number } };
export interface TerminalView {
  welcome?: TerminalWelcome; session_title_suffix?: string; greeting?: string;
  title?: string; foreground?: number; background?: number; sidebar_width?: number; sidebar_side?: 'left' | 'right'; sidebar_style?: TerminalFrameStyle; panels?: Panel[]; header?: Panel; footer?: Panel;
  sites?: Partial<Record<TerminalSiteName, TerminalRenderSite>>; status?: string[]; keybindings?: Partial<Record<KeyName, KeyAction>>; theme?: TerminalTheme;
  placeholder?: string;
  layout?: LayoutNode; backdrop?: TerminalBackdrop; surface_styles?: { composer?: TerminalSurfacePaint; backdrop?: TerminalSurfacePaint; approval?: TerminalSurfacePaint };
  inline_sites?: 'hidden';
}
/** One mod's contribution to the composed view; exclusive fields go to the first mod in composition order. */
export type TerminalPatch = TerminalView;
export type TerminalConflict = { field: string; owner: string; rejected: string; origin: string };
export type RenderToolStatus = 'running' | 'completed' | 'failed' | 'interrupted';
export type RenderParsedCommand = { type: 'read'; cmd: string; name: string; path: string } | { type: 'list_files'; cmd: string; path: string | null }
  | { type: 'search'; cmd: string; query: string | null; path: string | null } | { type: 'unknown'; cmd: string };
export type RenderExecCall = { call_id: string; kind: 'exec'; command: string; parsed: RenderParsedCommand[]; status: RenderToolStatus; exit_code: number | null; duration_ms: number | null; output_lines: number; output_tail: string | null; user_shell: boolean };
/** One agent tool row with its arguments, status and output summary. `expanded` is true while the user has the row open or reads the full transcript; return the native row then. */
export type RenderToolCall = { expanded: boolean } & (RenderExecCall
  | { call_id: string; kind: 'explore'; status: RenderToolStatus; duration_ms: number | null; calls: RenderExecCall[] }
  | { call_id: string; kind: 'patch'; status: RenderToolStatus; duration_ms: null; file_count: number; added: number; removed: number; files: { path: string; change: 'add' | 'delete' | 'update'; added: number; removed: number }[]; error: string | null }
  | { call_id: string; kind: 'web_search'; status: RenderToolStatus; duration_ms: null; action: 'search' | 'open_page' | 'find_in_page' | 'other'; query: string }
  | { call_id: string; kind: 'agent'; tool: 'spawn_agent' | 'send_input' | 'resume_agent' | 'wait' | 'close_agent' | 'agent'; status: RenderToolStatus; duration_ms: null; agents: string[]; prompt: string }
  | { call_id: string; kind: 'mcp'; server: string; tool: string; arguments: Json; status: RenderToolStatus; duration_ms: number | null; output_lines: number | null }
  | { call_id: string; kind: 'dynamic'; tool: string; arguments: Json; status: RenderToolStatus; duration_ms: number | null; output_lines: number | null }
  | { call_id: string; kind: 'image'; tool: 'view_image' | 'image_generation'; status: RenderToolStatus; duration_ms: null; path: string | null; prompt: string | null });
export type RenderQuestion = { id: string; header: string; question: string; secret: boolean; options: string[] };
export interface RenderProps {
  user_message: { text: string; images: number; spoken: boolean };
  assistant_message: { text: string; first: boolean; truncated: boolean };
  tool_call: RenderToolCall;
  tool_result: { call_id: string; tool: string; success: boolean | null; text: string };
  spinner: { header: string; elapsed_seconds: number; details: string | null; message: string | null; interrupt_hint: boolean };
  turn_duration: { seconds: number | null; completed_at_ms: number | null };
  notice: { kind: 'info' | 'warning' | 'error'; text: string; hint: string | null } | { kind: 'warning'; text: string };
  session_mode: { mode: 'plan'; label: string; cycle_hint: boolean };
  composer_hint: { slot: 'placeholder'; placeholder: string; input_enabled: boolean }
    | { slot: 'footer'; mode: 'history_search' | 'quit_reminder' | 'shortcut_overlay' | 'esc_hint' | 'composer_empty' | 'composer_draft'; text: string; task_running: boolean };
  question: { questions: RenderQuestion[]; current: number; queued: number } | { questions: RenderQuestion[]; answered: number; interrupted: boolean };
  list: { view_id: string; title: string; subtitle: string | null; items: { label: string; description: string | null; current: boolean; disabled: boolean; order: number }[]; selected: number | null };
}
export type RenderComponent = keyof RenderProps;
/** One native component instance. `props` may be rewritten through `next` only where the native drawing reads them: spinner `header`, notice `text`, session_mode `label`, composer_hint `placeholder`. */
export type RenderEvent<C extends RenderComponent = RenderComponent> = C extends RenderComponent ? {
  component: C; id: string; surface: 'inline' | 'fullscreen'; viewport: { columns: number; rows: number };
  lifecycle: 'live' | 'final'; owner: null; props: RenderProps[C];
} : never;
export type RenderTree = { tree: TerminalComponent[] };
export type ComponentKey = { kind: 'key'; key: string | null; text: string | null };
export type ComponentPointer = { kind: 'pointer'; column: number; row: number; half?: 0 | 1 | null;
  action: 'down' | 'up' | 'scroll_up' | 'scroll_down' | 'move' | 'drag' | 'enter' | 'leave'; button: 'left' | 'right' | 'middle' | null };
/** The region a component module draws: its width in cells, its height in rows (the node's `height`, 0 when it has none), the props of its `module` node, and `post`, which hands the mod's `component_post` hooks at most one value per frame. */
export type ComponentContext<P extends Json = Json> = { readonly columns: number; readonly rows: number; readonly props: P; post(data: Json): void };
/** Experimental: handlers run synchronously on the frame clock in the mod's own runner, keep `S` between frames and get no host authority; returning `undefined` keeps the state. */
export type ComponentModule<S = unknown, P extends Json = Json> = {
  init?(props: P, ui: ComponentContext<P>): S;
  view(state: S, ui: ComponentContext<P>): TerminalComponent | TerminalComponent[];
  key?(state: S, event: ComponentKey, ui: ComponentContext<P>): S | void;
  pointer?(state: S, event: ComponentPointer, ui: ComponentContext<P>): S | void;
  /** `ms` may depend on the state; `null` pauses ticks until input or new props step the module again. */
  every?: { ms: number | ((state: S) => number | null); tick(state: S, ui: ComponentContext<P>): S | void };
};
export type Widen<T extends Json> = T extends string ? string : T extends number ? number : T extends boolean ? boolean : T;
export type Atom<T extends Json = Json> = { readonly key: string; get(): T; set(value: T): void; update(change: (value: T) => T): void };
export type Derived<T extends Json = Json> = { readonly key: null; get(): T };
export type CommandResult = Json | { display?: string; insert?: string; submit?: string; terminal?: TerminalPatch | null };
export type CompactionDecision = number | { threshold?: number; prompt?: string } | null;

export type ExecResult = { exit_code: number | null; signal: string | null; stdout: string; stdout_sha256: string; stdout_bytes: number; output_artifact: ResourceRef | null; stderr: string; stdout_truncated: boolean; stdout_preview_truncated: boolean; stderr_truncated: boolean; stderr_preview_truncated: boolean; timed_out: boolean; duration_ms: number; program: { path: string; sha256: string }; guards_verified: number };
export type ExecGuard = { program: string; sha256?: string; argv?: string[]; cwd?: string; env?: Record<string, string>; stdout_sha256: string };
export type Fingerprint = string | { size: number; mtime_ms: number } | null;
export type FileStat = { kind: 'file' | 'dir' | 'symlink'; size: number; mtime_ms: number; sha256?: string };
export type StoreProvenance = { mod: string; source_sha256: string; thread_id: string | null; origin: 'user_command' | 'tool' | 'event' | 'cli'; at: number };
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
export type CompactionOccurrence = { thread_id: string; turn_id: string; trigger: 'manual' | 'auto'; reason: 'user_requested' | 'context_limit' | 'model_downshift' | 'comp_hash_changed';
  phase: 'standalone_turn' | 'pre_turn' | 'mid_turn' | 'post_turn'; implementation: 'local' | 'remote' | 'budget';
  budget: { tokens: number; auto_limit: number | null; context_window: number | null; hard: boolean }; items: number; history: HistoryItem[]; summary_prompt: string | null };
export type CompactionHistory = { keep: number[]; insert?: { before: number; role: 'user' | 'developer'; text: string }[] };
export type CompactionResult = { summary: string | null; history: HistoryItem[]; usage: Json | null; provider_call: boolean } | { summary: string } | { history: CompactionHistory };
/** One draft edit; `insert` goes at the cursor, `splice` replaces byte range `start..end`. */
export type ComposerEdit = { kind: 'fill' | 'insert' | 'append'; text: string } | { kind: 'splice'; text: string; start: number; end: number };
export type ComposerDraft = { text: string; cursor: number; selection: { start: number; end: number } | null; revision: number;
  /** `label` is the text placeholder; image resources keep mod/source/repository binding across config changes and forks; unsupported media is null. */
  attachments: { id: string; kind: 'image'; label: string; owner: string; resource: ResourceRef | null }[];
  suggestion: { owner: string; id: string } | null };
export type ClassicHook = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PostToolBatch' | 'PermissionRequest' | 'PermissionDenied'
  | 'UserPromptSubmit' | 'UserPromptExpansion' | 'SessionStart' | 'SessionEnd' | 'Setup' | 'Stop' | 'StopFailure' | 'SubagentStart' | 'SubagentStop'
  | 'TaskCreated' | 'TaskCompleted' | 'TeammateIdle' | 'PreCompact' | 'PostCompact' | 'PreModelSwitch' | 'PostModelSwitch' | 'CwdChanged'
  | 'DirectoryAdded' | 'ConfigChange' | 'InstructionsLoaded' | 'FileChanged' | 'WorktreeCreate' | 'WorktreeRemove' | 'Elicitation'
  | 'ElicitationResult' | 'MessageDisplay' | 'Notification';
/** The common envelope every classic hook receives; `event` is the native event or surface it maps to. */
export type ClassicEnvelope = { hook: ClassicHook; event: string; subject: Json; thread_id: string | null; turn_id: string | null;
  origin: Json | null; generation: string | null; original: Json; effective: Json; delivery: 'required' | 'optional' };
export type HistoryEdit = { drop?: number[]; replace?: { index: number; text: string }[]; insert?: { before: number; role: 'user' | 'developer'; text: string }[] };
export type PtyRequest = { action: 'start'; session: string; cwd?: string; program?: string; argv?: string[]; sha256?: string; write?: boolean; network?: 'loopback'; sandbox?: 'none' } | { action: 'write'; session: string; text: string } | { action: 'read'; session: string } | { action: 'stop'; session: string };
export type TurnActivity = {
  turn_id: string; started_at: string | null; ended_at: string | null;
  outcome: 'completed' | 'aborted' | 'error' | 'interrupted' | 'running' | 'unknown'; reason: string | null; error: AgentFailure | null; unrecorded_end: boolean;
  tool_calls: { call_id: string; tool: string; started_at: string; finished_at: string | null; outcome: string | null; output_replaced?: { mod: string; original_sha256: string; replacement_sha256: string } }[];
  processes: { id: string; kind: 'exec' | 'managed'; command: string; running: boolean | null; exit_code: number | null }[];
  files: { path: string; before: string | null; after: string | null; source: 'tool' | 'transaction' | 'exec' | 'rescan' | 'external' }[];
  truncated: boolean;
};
export type PackageState = { id: string; kind: 'mod'; version: string; description: string | null; scope: 'user' | 'project'; path: string | null; source: 'local' | 'repository' | 'package' | 'npm' | 'selection'; blocked: string | null; installed: boolean; enabled: boolean; effective: boolean; pending: 'reload' | null; failed: string | null; api: string; compatible: boolean; grants: string[]; conflicts: string[]; settings_schema: Json; settings: { [key: string]: Json } };
export type PackageSource = { kind: 'local'; path: string } | { kind: 'repository'; repository: string; revision: string; subdirectory?: string } | { kind: 'package'; index: string; id: string; version: string } | { kind: 'npm'; package: string; version?: string; registry?: string; integrity?: string };
export type PackageRequest = { action: 'install' | 'update' | 'remove' | 'rollback' | 'enable' | 'disable' | 'trust'; id?: string; source?: PackageSource; reference?: string; version?: string; index?: string; scope?: 'user' | 'project' };
export type PackageCatalogEntry = { id: string; latest: string; description: string; support: string | null; versions: { version: string; blocked: string | null }[]; installed: string | null };
export type KeymapAction = `${string}.${string}`;
export type Declined = { status: 'declined' };
export interface HostOperations {
  'exec.run': { arguments: { program: string; sha256?: string; argv?: string[]; cwd?: string; env?: Record<string, string>; stdin?: string; timeout_ms?: number; max_output_bytes?: number; output_artifact?: boolean; write?: boolean; network?: 'none' | 'loopback'; unix_sockets?: string[]; snapshot?: ResourceRef; guards?: ExecGuard[]; required_access?: { write: string[] }; exclusive_workspace?: string; sandbox?: 'none' }; result: ExecResult & { candidate_sha256?: string; evidence?: ResourceRef } };
  'exec.output_page': { arguments: { artifact: ResourceRef; cursor?: number; max_bytes?: number }; result: { text: string; cursor: number | null; bytes: number; sha256: string } };
  'workspace.read': { arguments: { paths: string[]; root?: string }; result: { files: Record<string, { text: string; sha256: string } | null> } };
  'workspace.list': { arguments: { path?: string; recursive?: boolean; include_ignored?: boolean; max_entries?: number; root?: string }; result: { entries: ({ path: string } & FileStat)[]; truncated: boolean } };
  'workspace.stat': { arguments: { paths: string[]; hash?: boolean; root?: string }; result: { files: Record<string, FileStat | null> } };
  'workspace.check_access': { arguments: { paths: string[]; write?: boolean }; result: { paths: string[]; write: boolean } };
  'workspace.snapshot': { arguments: { agent?: string; expected?: string }; result: { snapshot: ResourceRef; candidate_sha256: string } };
  'workspace.fingerprint': { arguments: { agent?: string; expected?: string }; result: { candidate_sha256: string } };
  'workspace.transaction': { arguments: { expected: Record<string, Fingerprint>; writes?: Record<string, string>; deletes?: string[]; renames?: { old: string; new: string }[]; backup?: boolean; root?: string }; result: { files: Record<string, string | null>; backup: ResourceRef | null } };
  'http.request': { arguments: HttpRequest & { max_bytes?: number }; result: HttpResponse & { truncated: boolean; bytes: number; body?: string; body_base64?: string } };
  'http.open': { arguments: HttpRequest; result: HttpResponse & { handle: number } };
  /** Dropping an in-flight read closes the stream and releases its quota slot. */
  'http.read': { arguments: { handle: number; max_bytes?: number; wait_ms?: number }; result: { done: boolean; bytes: number; data?: string; data_base64?: string } };
  'http.close': { arguments: { handle: number }; result: { closed: true } };
  'mcp.connect': { arguments: { server: string }; result: { server: string; connected: true; tool_prefix: string } };
  'mcp.disconnect': { arguments: { server: string }; result: { server: string; connected: false; tool_prefix: string } };
  'environment.read': { arguments: { names: string[] }; result: { values: Record<string, { set: boolean; value?: string | null }> } };
  /** Requires environment_overrides_v1; null restores inheritance and releases the override slot. */
  'environment.set': { arguments: { name: string; value: string | null }; result: { name: string; set: boolean } };
  'workspace.backup': { arguments: { expected: Record<string, Fingerprint> }; result: { backup: ResourceRef } };
  'workspace.restore': { arguments: { backup: ResourceRef; expected: Record<string, Fingerprint> }; result: { files: Record<string, string | null> } };
  'workspace.request_rename': { arguments: { old: string; new: string }; result: { status: 'renamed'; files: Record<string, string | null> } | { status: 'fallback'; reason: string } };
  'workspace.integrate': { arguments: { handle: string; acceptance_sha256?: string }; result: { status: 'integrated'; candidate_sha256: string; parent_candidate_sha256: string; changed_paths: string[]; evidence: HostEvidence; receipt_error?: string } | { status: 'refused'; candidate_sha256: string; missing: ContractRequirement[] } };
  'store.get': { arguments: { key: string; scope?: StoreScope }; result: { value: Json; revision: number; provenance: StoreProvenance } | null };
  'store.put': { arguments: { key: string; value: Exclude<Json, null>; expected_revision: number | null; scope?: StoreScope }; result: { revision: number } };
  'store.delete': { arguments: { key: string; expected_revision: number; scope?: StoreScope }; result: { deleted: boolean } };
  'store.list': { arguments: { prefix?: string; cursor?: string; limit?: number; scope?: StoreScope }; result: { keys: { key: string; revision: number; bytes: number; provenance: StoreProvenance }[]; cursor: string | null; generation: number } };
  'store.export': { arguments: { scope?: StoreScope; cursor?: string }; result: { schema: 1; owner: string; scope: StoreScope; generation: number; entries: Record<string, { value: Json; revision: number; provenance: StoreProvenance }>; cursor: string | null } };
  'store.reset': { arguments: { expected_generation: number; scope?: StoreScope }; result: { generation: number } };
  'evidence.write': { arguments: { media_type: 'application/json' | 'text/plain'; content: Json; label?: string } | { media_type: 'image/png' | 'image/jpeg' | 'image/svg+xml' | 'application/octet-stream'; base64: string; label?: string }; result: ResourceRef };
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
  'contract.select': { arguments: { contract: string }; result: { selected: Json; applies: 'next_session' } | Declined };
  'agents.spawn': { arguments: { role?: string; route?: string; prompt: string; definition?: string; workspace?: 'read_only' | 'isolated_worktree'; tools?: string[]; evidence?: ResourceRef; snapshot?: ResourceRef; parent_history?: boolean; resolution_context?: { acceptance_sha256: string; findings: string[] } }; result: Agent };
  'agents.message': { arguments: { handle: string; message: string }; result: { delivered: boolean } };
  'agents.cancel': { arguments: { handle: string }; result: { cancelled: boolean } };
  'agents.result': { arguments: { handle: string; consume?: boolean }; result: AgentResult };
  'agents.wait': { arguments: { handle: string; consume?: boolean }; result: AgentResult };
  'agents.list': { arguments: null; result: { handle: string; finished: boolean; consumed: boolean }[] };
  'agents.inventory': { arguments: null; result: { agents: AgentRecord[] } };
  'peers.list': { arguments: { package?: string } | null; result: { session: string; peers: { session: string; package: string; repository: string; same_project: boolean }[] } };
  'peers.send': { arguments: { to: string; package?: string; data: Json; correlation?: string; ttl_ms?: number }; result: PeerReceipt };
  'turns.queue': { arguments: { prompt: string; key: string; priority?: 'high' | 'normal' | 'low'; deadline_ms?: number }; result: { key: string; status: 'queued' | 'duplicate'; paused?: boolean } };
  'turns.queued': { arguments: null; result: { paused: boolean; started: number; spent_microusd: number; entries: TurnQueueEntry[] } };
  'turns.dequeue': { arguments: { key: string }; result: { removed: boolean } };
  'process.which': { arguments: { names: string[] }; result: { found: { name: string; path: string; sha256: string }[] } };
  /** Raster input is thread-scoped, bounded to 128 messages/256 KiB, and stops the process on overflow or a two-second blocked write. `pixels` needs `raster` and the `raster_pixels_v1` feature. */
  'process.start': { arguments: { session: string; name: string; path: string; sha256: string; arguments?: string[]; environment?: Record<string, string | null>; framing?: 'content-length' | 'ndjson' | 'raw'; network?: 'none' | 'loopback'; notify?: ('output' | 'exit')[]; sandbox?: 'none'; raster?: string; keys?: string; pixels?: boolean; stdin?: 'null' }; result: { session: string; running: true } };
  /** One call returns messages until the next would push their encoded size past 48 KiB (at most 64, at least one); the rest stays queued. Under `raw` framing, `send` holds strings and `messages` are `ProcessChunk`s. */
  'process.exchange': { arguments: { session: string; send?: Json[]; wait_ms?: number }; result: { session: string; messages: Json[]; running: true } };
  'process.status': { arguments: { session: string }; result: { session: string; running: true; idle_ms: number } };
  'process.stop': { arguments: { session: string }; result: { stopped: boolean } };
  'providers.register': { arguments: { id: string; secrets?: string[] }; result: Json };
  'providers.unregister': { arguments: { id: string }; result: Json };
  'sidecars.invoke': { arguments: { id: string; input: Json }; result: { provider: string; program_sha256: string; source_hashes: Record<string, string>; result: Json; untrusted: true } };
  'sidecars.start': { arguments: { id: string; secrets?: string[] }; result: Json };
  'sidecars.status': { arguments: { id: string }; result: Json };
  'sidecars.stop': { arguments: { id: string }; result: Json };
  'app.request': { arguments: { method: string; params: Json }; result: Json | Declined };
  'app.routes': { arguments: null; result: AppRoute[] };
  'workspace.watch': { arguments: { paths: string[]; recursive?: boolean; debounce_ms?: number; include_ignored?: boolean }; result: { watch_id: string } };
  'workspace.unwatch': { arguments: { watch_id: string }; result: { stopped: boolean } };
  /** New channels fail with channel_sequence_limit at 256 counters per publisher or 4096 process-wide. */
  'events.publish': { arguments: { channel: string; data: Json; correlation?: string }; result: { delivered: number; dropped: number } };
  /** Require timers_16ms_v1 for delays below 1000 ms. */
  'events.schedule': { arguments: { key: string; delay_ms: number }; result: { key: string; delay_ms: number } };
  'events.cancel': { arguments: { key: string }; result: { cancelled: boolean } };
  'tools.define': { arguments: { name: string; description: string; parameters: Json; label?: string }; result: { name: string; effective_at: 'next_request' } };
  'tools.undefine': { arguments: { name: string }; result: { removed: boolean } };
  'tools.list': { arguments: null; result: ToolInventory };
  'tools.invoke': { arguments: ToolCall; result: { call_id: string; output: string; success: boolean; truncated: boolean } };
  'tools.check': { arguments: ToolCall; result: { decision: 'allow' | 'ask' | 'deny'; reason: string | null; authority: 'host' | 'mod' } };
  'credentials.list': { arguments: null; result: CredentialProfile[] };
  'credentials.request': { arguments: { action: 'enroll'; kind: 'chatgpt' | 'api_key'; label: string; provider?: string } | { action: 'enroll'; kind: 'provider'; label: string; provider?: string; origin: string } | { action: 'enroll'; kind: 'secret'; label: string; origin: string } | { action: 'remove' | 'refresh'; profile: string }; result: { status: 'completed' | 'declined'; profile: CredentialProfile | null } };
  'routes.select': { arguments: { route: string; scope: 'next_request' | 'thread' }; result: { route: RouteInfo; effective_at: 'next_request' } };
  'turns.activity': { arguments: { thread_id?: string; turn_id?: string; last?: number } | null; result: { turns: TurnActivity[]; recording: boolean } };
  /** Requires turn_abort_v1; acceptance precedes cancellation cleanup. */
  'turns.abort': { arguments: { turn_id: string }; result: { accepted: boolean } };
  /** Requires terminal_selection_v1; truncation also accounts for the select-then-copy receipt budget. */
  'terminal.selection': { arguments: Record<string, never>; result: { text: string | null; truncated: boolean } };
  /** Requires terminal_copy_v1. */
  'terminal.copy': { arguments: { text: string }; result: { status: 'confirmed' | 'unconfirmed' | 'pending' | 'busy' } };
  'terminal.notify': { arguments: { title: string; body?: string }; result: { delivered: boolean; method: 'osc9' | 'osc99' | 'osc777' | 'bel' | 'none'; reason?: string } };
  'terminal.show_thread': { arguments: { thread_id: string }; result: { shown: boolean } };
  'commands.list': { arguments: null; result: { commands: CommandRow[] } };
  'commands.describe': { arguments: { command: string }; result: CommandRow };
  'commands.invoke': { arguments: { command: string; args?: string }; result: { command: string; result: Json } | Declined };
  'config.describe': { arguments: null; result: { rows: ConfigRow[] } };
  'config.set': { arguments: { key: string; value: Json; expected?: Json }; result: { key: string; effective: Json } | Declined };
  'sessions.ports': { arguments: null; result: { ports: { port: number; pid: number; address: string }[] } };
  'terminal.import_file': { arguments: { path: string; max_bytes?: number; lifetime?: 'thread' | 'package' }; result: ResourceRef | Declined };
  'terminal.image_sample': { arguments: { resource: ResourceRef; columns: number; rows: number }; result: { width: number; height: number; rgba: number[] } };
  'composer.read': { arguments: null; result: ComposerDraft };
  'composer.write': { arguments: { revision: number; edit?: ComposerEdit; cursor?: number; selection?: { start: number; end: number }; attach?: { image: ResourceRef }[]; detach?: string[] };
    result: { text: string; cursor: number; revision: number } };
  'composer.suggest': { arguments: { revision: number; id: string; text: string } | { clear: true }; result: { shown: true } | { cleared: true } };
  'prompts.consent': { arguments: { text: string; attachments?: ResourceRef[] }; result: { consent: string; sha256: string } };
  'prompts.submit': { arguments: { consent: string; text: string; attachments?: ResourceRef[]; mode: 'turn' | 'steer'; client_id?: string };
    result: { status: 'started' | 'steered'; client_id: string } | { status: 'not_submitted'; reason: string } };
  'prompts.status': { arguments: { consent: string }; result: { state: 'pending' | 'missing' } | { state: 'delivered'; client_id: string; turn_id: string } | { state: 'unconfirmed'; client_id: string } };
  'prompts.revoke': { arguments: { consent: string }; result: { revoked: number } };
  'builtins.invoke': { arguments: { action: KeymapAction }; result: { invoked: boolean } };
  'packages.list': { arguments: null; result: { packages: PackageState[]; generation: number; reload_error: string | null } };
  'packages.index': { arguments: { index?: string; query?: string }; result: { index: string; packages: PackageCatalogEntry[] } };
  'packages.preview': { arguments: PackageRequest & { expected_generation?: number }; result: { action: string; id: string; changes: Json; grants_added: string[] } };
  'packages.apply': { arguments: PackageRequest & { expected_generation: number }; result: { status: 'applied'; generation: number } | Declined };
  'packages.reload': { arguments: null; result: { generation: number; failed: string[]; applies: 'next_boundary' } };
  'settings.write': { arguments: { id?: string; values: { [key: string]: Json } }; result: { settings: { [key: string]: Json } } };
  'terminal.open': { arguments: { url: string } | { path: string } | { path: string; line?: number; editor: true }; result: { opened: true } | Declined };
  'terminal.prompt': { arguments: { kind: 'confirm'; title: string; message: string } | { kind: 'text'; title: string; message: string; masked?: boolean }
    | { kind: 'choice'; title: string; message: string; options: { value: string; label: string }[]; multiple?: boolean; other?: boolean };
    result: { status: 'accepted'; value?: string; values?: string[]; other?: boolean } | Declined };
  'terminal.pane': { arguments: { action: 'open' | 'close' | 'focus' | 'reveal'; id: string } | { action: 'scroll'; id: string; offset: number }; result: { applied: true } };
  'terminal.panes': { arguments: Record<string, never>; result: { panes: { id: string; visible: boolean; collapsed: boolean; focused: boolean; scroll: number }[] } };
  'terminal.notice': { arguments: { text: string; kind?: 'info' | 'warning' | 'error'; placement?: 'toast' | 'status'; ttl_ms?: number; id?: string; clear?: false } | { id: string; placement?: 'toast' | 'status'; clear: true } | { text: string; kind?: 'info' | 'warning' | 'error'; placement: 'transcript'; audience?: 'user' | 'model'; tool_call_id?: string };
    result: { shown: true; model?: boolean } | { cleared: boolean } };
  /** The `pixels` form needs the `raster_pixels_v1` feature. */
  'terminal.blit': { arguments: { key: string; rect: { x: number; y: number; width: number; height: number }; cells: TerminalCell[] } | { key: string; image: { media_type: 'image/png' | 'image/jpeg'; base64: string } } | { key: string; pixels: { source: string; format: 'rgb' | 'rgba'; width: number; height: number; sequence: number } };
    result: { frame: number; queued: number; frame_ms: number } | { status: 'backpressure'; retry_after_ms: number } };
  'terminal.pty': { arguments: PtyRequest; result: { session: string; running: true } | { written: number } | { text: string; running: boolean; exit_code: number | null } | { stopped: true } | Declined };
  'model.complete': { arguments: ModelCallOptions & { route: string }; result: ModelCallResult };
  /** Requires agents, sessions and sessions_tools because the snapshot includes tool payloads. */
  'model.fork': { arguments: ModelCallOptions & { route?: string; tools?: string[] }; result: ModelCallResult };
  'session.info': { arguments: null; result: SessionInfo };
  'ledger.settle': { arguments: { request_id: string; microusd: number; source: string }; result: Json };
  'time.sleep': { arguments: { ms: number }; result: { slept_ms: number; cancelled: boolean } };
}
export interface Events {
  context: { input: Context; output: ContextResult | null };
  migrate: { input: { from: number; to: number }; output: void };
  routing: { input: { routes: RouteInfo[]; model: string | null; provider: string; reasoning: string | null }; output: { route: string } | null };
  compaction: { input: { token_limit: number | null; context_window: number | null }; output: CompactionDecision };
  tool_exposure: { input: { thread_id: string | null; ledger: Ledger | null; available: string[] }; output: { enable: string[] } };
  terminal: { input: { event: string; ledger: Ledger | null; identity?: TerminalIdentity; presentation?: TerminalPresentation | null; client?: TerminalClient | null; clients?: ClientEntry[] }; output: TerminalPatch | null };
  start: { input: Json; output: void };
  resume: { input: { thread_id: string; last_turn: { turn_id: string; status: 'completed' | 'interrupted' | 'failed' | 'in_progress' } | null; restarted: boolean }; output: void };
  idle: { input: Json; output: void };
  stop: { input: Json; output: void };
  tool_result: { input: { call_id: string; agent_id: string | null; thread_id: string | null; tool: string; outcome: 'succeeded' | 'unsuccessful' | 'blocked' | 'failed' | 'failed_before_handler' | 'aborted'; answered_by: string | null; call_sha256: string | null; result_sha256: string | null; result_complete: boolean }; output: void };
  workspace_change: { input: { repository: string; source: 'tool' | 'transaction' | 'exec' | 'rescan' | 'external'; call_id: string | null; watch_id?: string; changes: { path: string; before: string | null; after: string | null }[]; status: 'observed' | 'unavailable'; reason?: string | null }; output: void };
  workspace_pre_rename: { input: { repository: string; old: string; new: string; expected: Record<string, string | null> }; output: { status: 'ready'; expected: Record<string, string | null>; writes: Record<string, string> } | { status: 'fallback'; reason: string } | void };
  turn_start: { input: { turn_id: string }; output: void };
  turn_end: { input: { turn_id: string; outcome: 'completed' | 'aborted' | 'error'; reason?: string; error?: AgentFailure; evidence?: ResourceRef }; output: void };
  compaction_start: { input: { turn_id: string; trigger: 'manual' | 'auto' }; output: void };
  compaction_end: { input: { turn_id: string; trigger: 'manual' | 'auto'; outcome: 'compacted' | 'replaced' | 'skipped' | 'deferred' | 'failed'; by: string | null; provider_call: boolean }; output: void };
  agent_end: { input: { handle: string; role: string; status: 'completed' | 'failed'; error?: string; failure?: AgentFailure | null; text?: string; sha256?: string }; output: void };
  contract: { input: { gate: 'complete' | 'integrate'; outcome: 'passed' | 'refused'; missing: ContractRequirement[]; candidate_sha256: string }
    | { gate: 'complete'; outcome: 'refused'; reason: 'unresolved_blocking_findings'; outstanding_findings: string[]; candidate_sha256: string }; output: void };
  model_response: { input: ModelResponse; output: void };
  prompt: { input: { thread_id: string; turn_id: string; original: string; effective: string; provenance: Json[] }; output: void };
  session: { input: { phase: 'start' | 'resume' | 'idle' | 'stop'; thread_id: string; cause?: string }; output: void };
  agent: { input: { phase: 'start' | 'turn' | 'end'; agent: AgentRecord }; output: void };
  tool_call: { input: { call_id: string; agent_id: string | null; tool: string; arguments: Json }; output: void };
  host_operation: { input: { phase: 'before' | 'after'; caller: string; operation: keyof HostOperations; arguments?: Json; result?: Json; error?: string }; output: void };
  app_notification: { input: { method: string; params: Json; thread_id: string | null; coalesced: number; dropped: number }; output: void };
  app_server_request: { input: { method: string; request_id: Json; phase: 'requested' | 'resolved'; params: Json; resolution: Json }; output: void };
  approval: { input: { id: string; kind: 'exec' | 'stdin' | 'execve' | 'patch' | 'mcp_tool' | 'network' | 'permissions'; thread_id: string; turn_id: string | null; agent_id: string | null; host_decision: 'ask' | 'skip' | 'forbidden'; policy: string; details: Json; assessment: boolean }; output: null | { deny: string } | { ask: string } | { approve: string } };
  approval_result: { input: { id: string; kind: string; decision: 'approved' | 'approved_for_session' | 'amended' | 'denied' | 'aborted' | 'timed_out'; source: 'user' | 'guardian' | 'hook' | 'mod' | 'policy'; mod?: string }; output: void };
  tool_output: { input: { call_id: string; tool: string; arguments: Json; success: boolean; text: string; tail: string | null; bytes: number }; output: null | { append: string } };
  completion: { input: { kind: 'mention'; query: string; candidates: { path: string; score: number }[] } | { kind: 'argument'; command: string; query: string; line: string }; output: null | { items: { path: string }[] } | { items: { insert: string }[] } };
  history: { input: { thread_id: string; agent_id: string | null; model: string | null; items: HistoryItem[] }; output: null | HistoryEdit };
  tool_batch: { input: { batch_id: string; thread_id: string; calls: { call_id: string; tool: string; arguments: Json; parallel_safe: boolean }[] }; output: null | { merge: { call_ids: string[]; tool: string; arguments: Json }[] } };
  process_event: { input: { session: string; kind: 'output'; bytes: number } | { session: string; kind: 'exit' }; output: void };
  timer: { input: { key: string }; output: void };
  /** Independent per-channel sequence; restarts at 1 after publisher reclamation (15 minutes idle and no queued events). */
  channel: { input: { publisher: string; channel: string; data: Json; correlation: string | null; sequence: number; dropped: number }; output: void };
  component_event: { input: { component: string; kind: 'select' | 'activate' | 'find' | 'input' | 'resize' | 'change' | 'focus' | 'blur' | 'scroll' | 'pointer' | 'key' | 'open' | 'close';
    origin?: 'user' | 'mod'; client?: string; value?: string; values?: string[]; offset?: number; key?: string; text?: string | null;
    pointer?: { column: number; row: number; half?: 0 | 1 | null; action: 'down' | 'up' | 'scroll_up' | 'scroll_down' | 'move' | 'drag' | 'enter' | 'leave'; button: 'left' | 'right' | 'middle' | null };
    range?: TerminalRange; anchor?: string | null; matches?: number; error?: string; events?: TerminalInputEvent[]; dropped?: number; ratio?: number[]; index?: number }; output: void };
  /** Experimental: the latest value a component module posted this frame. */
  component_post: { input: { component: string; module: string; client?: string; data: Json }; output: void };
  view: { input: { phase: 'opened' | 'closed'; view: 'bottom_pane' | 'overlay'; view_id: string | null }; output: void };
  focus: { input: { focused: boolean }; output: void };
  config_change: { input: { key: string; original: Json; effective: Json; source: string; scope: 'codex' | 'mod'; caller: string }; output: void };
  peer_message: { input: { id: string; from: PeerSender; to: PeerAddress; correlation: string | null; untrusted: true; data: Json; sent_at_ms: number }; output: void };
  peer_receipt: { input: PeerReceipt; output: void };
  turn_queue: { input: { key: string; status: 'started' | 'expired' | 'dropped' | 'denied' | 'failed'; reason?: string; turn_id?: string }; output: void };
  tool_batch_end: { input: { turn_id: string; calls: { call_id: string; tool: string; outcome: string }[] }; output: void };
  instructions_loaded: { input: { kind: 'instructions' | 'skill' | 'attachment'; source: string; sha256: string | null; bytes: number; reason: 'session_start' | 'refresh' | 'explicit' | 'implicit' }; output: void };
  thread_settings: { input: { cwd: { before: string; after: string }; roots: { added: string[]; removed: string[] }; model: { before: string | null; after: string | null };
    effort: { before: ReasoningEffort | null; after: ReasoningEffort | null }; provider: { before: string; after: string } }; output: void };
  worktree: { input: { phase: 'created' | 'removed'; path: string; owner: 'agent' | 'tui' }; output: void };
  elicitation_result: { input: { server: string; request_id: string; action: 'accept' | 'decline' | 'cancel'; content: Json; by: string | null }; output: void };
  composer: { input: { kind: 'change'; revision: number; attachments_revision: number; origin: string } | { kind: 'suggestion'; id: string; status: 'accepted' | 'dismissed' | 'cleared'; reason?: string }; output: void };
  prompt_expanded: { input: { turn_id: string; items: ({ kind: 'skill'; name: string; source: string; sha256: string } | { kind: 'mention'; name: string; source: string }
    | { kind: 'image'; source?: string; start?: number; end?: number; bytes?: number; sha256?: string } | { kind: 'paste'; start: number; end: number; bytes: number; sha256: string })[] }; output: void };
}
/** A raw read of at most 8,000 bytes: UTF-8 text as `data`, bytes that are not UTF-8 as their own `data_base64` chunk. */
export type ProcessChunk = { stream: 'stdout' | 'stderr'; data?: string; data_base64?: string };
export type HttpRequest = { url: string; method?: string; headers?: Record<string, string>; body?: string; body_base64?: string; credential?: string; timeout_ms?: number; redirects?: number };
export type HttpResponse = { status: number; url: string; headers: Record<string, string>; redirects: { status: number; origin: string | null }[] };
export type CommandRow = { command: string; description: string; owner: string | null; hidden: boolean; args_hint: string | null; immediate: boolean; protected: boolean };
export type ConfigRow = { key: string; label: string; value: Json; source: string; version: string | null; scope: 'codex' | 'mod'; editable: boolean; managed: boolean; secret: boolean; hidden: boolean; type?: string; enum?: Json[] | null };
export type AdmissionPackage = { id: string; version: string; sha256: string; source: string; scope: string; capabilities: string[]; dependencies: { id: string; version: string }[]; requires: string[]; services: Json; registrations: Json; source_use: Json };
export type ToolSpecEntry = { name: string; description: string; parameters: Json | null; deferred: boolean };
export type InterceptMatcher = string | number | boolean | null | RegExp | readonly InterceptMatcher[] | { readonly [key: string]: InterceptMatcher };
export interface InterceptSurfaces {
  tool: { input: ToolCall & { call_id: string; thread_id: string | null; agent_id: string | null; schema: Json | null; raw_arguments: string; batch: { id: string; index: number; size: number } | null }; result: { output: string; success: boolean; truncated?: boolean; call_id?: string }; answer: { output: string; success: boolean } | { deny: string } };
  tool_specs: { input: { thread_id: string; route: { name: string; model: string; provider: string } | null; tools: ToolSpecEntry[] }; result: { tools: ToolSpecEntry[] }; answer: never };
  host_operation: { input: { operation: keyof HostOperations; namespace: string; arguments: Json }; result: { value: Json }; answer: { value: Json } | { error: string } };
  command_list: { input: { commands: CommandRow[] }; result: { commands: CommandRow[] }; answer: never };
  command: { input: { command: string; args: string; owner: string | null; immediate: boolean; active_turn: boolean }; result: { result: Json }; answer: { result: Json } | { deny: string } };
  config_list: { input: { rows: ConfigRow[] }; result: { rows: ConfigRow[] }; answer: never };
  config_set: { input: { key: string; value: Json; original: Json; source: string; scope: 'codex' | 'mod' }; result: { value: Json }; answer: { deny: string } };
  admission: { input: { package: AdmissionPackage; reason: 'load' }; result: { admit: true } | { withhold: string[] } | { deny: string }; answer: { withhold: string[] } | { deny: string } };
  input: { input: { thread_id: string | null; text: string; revision: number | null; attachments: { kind: 'image' | 'audio' | 'local_audio'; source: string }[];
    elements: { kind: 'paste' | 'mention' | 'skill' | 'image'; start?: number; end?: number; name?: string; source: string }[] }; result: { text: string }; answer: { deny: string } };
  model_request: { input: ModelRequest; result: { route: string; effort: ReasoningEffort | null; cache: { from: string | null } }; answer: ModelAnswer | { deny: string } };
  model_send: { input: FinalRequestPage; result: { edits: FinalRequestEdit[]; cache?: false }; answer: { edits: FinalRequestEdit[]; cache?: false } | { deny: string } };
  response_stream: { input: StreamChunk; result: { chunks: (StreamChunk | InjectedChunk)[] }; answer: { chunks: (StreamChunk | InjectedChunk)[] } | StreamStop };
  render: { input: RenderEvent; result: RenderTree; answer: RenderTree };
  agent_offers: { input: { thread_id: string; offers: { name: string; description: string; owner: string }[] }; result: { offers: { name: string; description: string; owner: string }[] }; answer: never };
  agent_spawn: { input: AgentSpawnRequest; result: { agent_id: string | null; output: string; success: boolean }; answer: { deny: string } };
  peer_send: { input: { to: PeerAddress; correlation: string | null; data: Json }; result: { receipt: PeerReceipt }; answer: { deny: string } };
  peer_receive: { input: { id: string; from: PeerSender; to: PeerAddress; correlation: string | null; untrusted: true; data: Json }; result: { data: Json }; answer: { deny: string } };
  turn_stop: { input: { thread_id: string; turn_id: string; outcome: 'completed' | 'error'; error: string | null; message: string | null; continued: number; limit: number; provenance: { kind: 'mod'; package: string } | null }; result: { stop: true }; answer: { continue: string } };
  composer_edit: { input: { source: 'mod' | 'paste' | 'history' | 'completion'; caller: string; revision: number; edit: ComposerEdit }; result: { edit: ComposerEdit }; answer: { deny: string } };
  composer_key: { input: { key: string; text: string | null; revision: number; cursor: number }; result: { key: string }; answer: { deny: string } };
  mention: { input: { thread_id: string; path: string }; result: { path: string }; answer: { deny: string } };
  component_change: { input: { kind: 'focus'; id: string; from: string | null; to: string | null; origin: 'user' } | { kind: 'scroll'; id: string; from: number | null; to: number; origin: 'user' };
    result: { focus: string | null } | { scroll: number }; answer: { deny: string } };
  elicitation: { input: { thread_id: string; turn_id: string; server: string; request_id: string; mode: 'form' | 'openai/form' | 'openaiForm'; message: string; schema: Json };
    result: { action: 'ask' }; answer: { accept: Record<string, Json> } | { decline: string } | { cancel: string } };
  compaction: { input: CompactionOccurrence; result: CompactionResult; answer: { skip: string } | { defer: string } | { summary: string } | { history: CompactionHistory } };
  history_persist: { input: { thread_id: string; entries: PersistedEntry[] }; result: { entries: PersistedEntry[] }; answer: { entries: PersistedEntry[] } };
}
export type PersistedEntry = { index: number; kind: string; role: string | null; call_id: string | null; text: string };
export type InterceptTraceEntry = { index: number; mod: string; outcome: 'returned' | 'passed' | 'skipped' | 'kept' | 'caught' | 'rejected'; attempts: number; ms?: number; received: Json; returned?: Json; reason?: string; location?: string; required?: boolean };
export type Next<S extends keyof InterceptSurfaces> = ((input: InterceptSurfaces[S]['input']) => Promise<InterceptSurfaces[S]['result']>) & {
  readonly event: S;
  readonly origin: { readonly caller: string; readonly thread_id?: string | null; readonly agent_id?: string | null; readonly call_id?: string; readonly cell_id?: string; readonly provider?: string | null; readonly chain?: readonly string[] };
  readonly signal: { readonly aborted: boolean };
  readonly trace: readonly InterceptTraceEntry[];
  readonly budget: { readonly ms: number; readonly remainingMs: number; readonly hostCalls: number };
  is(pattern: string): boolean;
  readonly error?: { readonly kind: 'throw' | 'timeout'; readonly message: string };
  readonly called?: boolean;
};
export type InterceptResult<S extends keyof InterceptSurfaces> = InterceptSurfaces[S]['result'] | InterceptSurfaces[S]['answer'];
export type InterceptHandler<S extends keyof InterceptSurfaces> = (input: Readonly<InterceptSurfaces[S]['input']>, next: Next<S>) => InterceptResult<S> | Promise<InterceptResult<S>>;
export type InterceptOptions = { match?: InterceptMatcher; required?: boolean; before?: string[]; after?: string[] };
export type InterceptRegistration<S extends keyof InterceptSurfaces> = { catch(handler: InterceptHandler<S>): void };
export type BuiltinControls = { commands?: { hide?: string[]; replace?: Record<string, string> }; modes?: { disable?: string[] }; keys?: Record<KeymapAction, KeymapKey | null> };
/** Callback completion rejects cancelled or stale authority before committing state; see REFERENCE.md. */
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
  middleware<K extends 'prompt' | 'session' | 'agent' | 'tool_call' | 'tool_result' | 'host_operation' | 'approval'>(event: K, handler: (event: Events[K]['input']) => Events[K]['output'] | Promise<Events[K]['output']>): void;
  intercept<S extends keyof InterceptSurfaces>(pattern: S, handler: InterceptHandler<S>): InterceptRegistration<S>;
  intercept<S extends keyof InterceptSurfaces>(pattern: S, options: InterceptOptions, handler: InterceptHandler<S>): InterceptRegistration<S>;
  intercept(pattern: string, handler: InterceptHandler<keyof InterceptSurfaces>): InterceptRegistration<keyof InterceptSurfaces>;
  intercept(pattern: string, options: InterceptOptions, handler: InterceptHandler<keyof InterceptSurfaces>): InterceptRegistration<keyof InterceptSurfaces>;
  replace<K extends 'context' | 'routing' | 'compaction' | 'tool_batch' | 'completion' | 'history'>(point: K, handler: (event: Events[K]['input']) => Events[K]['output'] | Promise<Events[K]['output']>): void;
  /** A classic hook over its native event or surface; `match` filters the hook's subject, and only interceptor hooks may be `required`. */
  hook(name: ClassicHook, handler: (envelope: ClassicEnvelope) => Json | void | Promise<Json | void>): void;
  hook(name: ClassicHook, options: { match?: InterceptMatcher; required?: boolean }, handler: (envelope: ClassicEnvelope) => Json | void | Promise<Json | void>): void;
  readonly match: { glob(pattern: string): InterceptMatcher; not(matcher: InterceptMatcher): InterceptMatcher };
  /** Experimental, terminal capability: registers a component module that `module` view nodes mount; at most 16 per mod. */
  component<S, P extends Json = Json>(id: string, module: ComponentModule<S, P>): void;
  contract(document: ContractDocument): void;
  builtins(controls: BuiltinControls): void;
  provide(contract: ServiceContract, handlers: Record<string, (input: Json) => Json | Promise<Json>>): void;
  tool(spec: ToolSpec, handler: (arguments_: Json) => Json | Promise<Json>): void;
  /** Registers an agent definition named `<mod>/<name>` (capability `agents`); `offer` lists it to models. */
  agent(definition: AgentDefinition): void;
  dynamicTools(handler: (call: { name: string; arguments: Json }) => Json | Promise<Json>): void;
  virtualRead(definition: { scheme: string; version: string }, handler: (request: VirtualReadRequest) => VirtualReadResponse | Promise<VirtualReadResponse>): void;
  command(name: string, handler: (arguments_: Json) => CommandResult | Promise<CommandResult>, options?: { description?: string; cli?: string; args_hint?: string; immediate?: boolean }): void;
  completion(options: { trigger: string }, handler: (input: { kind: 'token'; trigger: string; query: string; line: string }) => { items: { insert: string }[] } | null | Promise<{ items: { insert: string }[] } | null>): void;
  progress(text: string): void;
  readonly state: { get(): Json; set(value: Json): void };
  /** Experimental, terminal capability: 65,536 UTF-8 bytes of JSON.stringify output, no lone surrogates; only commands and component events write. */
  readonly uiState: { get(): Json; set(value: Json): void };
  /** A top-level key of an object `api.state`; reads are tracked so renders redraw only when it changes. */
  atom<T extends Json>(key: string, fallback: T): Atom<Widen<T>>;
  /** One member of a map-valued atom. */
  member<T extends Json>(key: string, id: string, fallback: T): Atom<Widen<T>>;
  /** A memoised selector recomputed when an atom it read changes. */
  derive<T extends Json>(compute: () => T): Derived<T>;
  /** Runs `handler` once, after the callback that changed the value; registered during activation. */
  subscribe<T extends Json>(target: Atom<T> | Derived<T>, handler: (value: T, previous: T | undefined) => void | Promise<void>): () => void;
  unsupported(operation: string): never;
  readonly package: { readonly id: string | null; readonly version: string | null; readonly sha256: string | null };
  /** `session.info` (capability `inventory`). */
  session(): SessionInfo;
  readonly time: {
    /** Suspends the callback without holding the runtime (at most 60 s; capability `events`). */
    sleep(ms: number): { slept_ms: number; cancelled: boolean };
    wait<T>(check: () => T | Promise<T>, options?: { interval_ms?: number; timeout_ms?: number }): Promise<{ value: T; waited_ms: number; timed_out: boolean; cancelled: boolean }>;
    /** Registered during activation; `start()` schedules it from a callback. */
    after(key: string, delay_ms: number, handler: (event: { key: string }) => void | Promise<void>): Timer;
    /** Repeats until `cancel()`, the handler returns `false`, or the mod's generation ends. */
    every(key: string, interval_ms: number, handler: (event: { key: string }) => void | boolean | Promise<void | boolean>): Timer;
  };
  /** Workspace-relative reads through `workspace.stat` (capability `fs.read`). */
  readonly fs: {
    exists(path: string): boolean;
    canonical(path: string): { path: string; kind: FileStat['kind']; sha256: string | null } | null;
    ancestors(name: string, from?: string): { path: string; kind: FileStat['kind'] }[];
  };
  /** One `model.complete` on `options.route` constrained to `labels`. */
  classify<L extends string>(text: string, labels: L[], options: { route: string; instructions?: string; effort?: ReasoningEffort; timeout_ms?: number; max_output_tokens?: number; cache?: { through: 'system' } }): { label: L | null; result: ModelCallResult };
  readonly usage: {
    summarize(response: ModelResponse): UsageSummary;
    /** `account/rateLimits/read` when the mod holds `account`. */
    rateLimits(): { available: true; value: Json } | { available: false; reason: string };
  };
}
export default function activate(api: ModAPI): void | Promise<void>;

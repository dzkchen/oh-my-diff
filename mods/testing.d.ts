import type { ComponentKey, ComponentPointer, HostOperations, InterceptTraceEntry, Json, KeyName, TerminalComponent, TerminalView } from './api.d.ts';

export type StepOptions = { expect?: Json; expectError?: string; cancelled?: boolean };
export type Step = { expect?: Json; expect_error?: string; cancelled?: boolean } & (
  | { type: 'invoke'; mod: string; event: string; name: string; payload?: Json }
  | { type: 'event'; event: string; payload?: Json }
  | { type: 'tool_outcome' | 'agent'; payload?: Json }
  | { type: 'advance_time'; ms: number }
  | { type: 'wait_until'; check: Step; until: Json; every_ms?: number; max_ms: number }
  | { type: 'reload' | 'status' }
  | { type: 'state'; mod: string; value?: Json; thread_id?: string }
  | { type: 'tool_exposure'; thread_id?: string; payload?: Json }
  | { type: 'terminal_mount'; mod: string; payload?: Json }
  | ({ type: 'terminal_interact'; mod: string; payload?: Json; client?: string } & ({ key: string } | { component: string; value?: string; pointer?: PointerEvent }))
  | { type: 'component'; mod: string; module: string; instance?: string; props?: Json; columns?: number; rows?: number; events?: (ComponentKey | ComponentPointer)[] }
  | { type: 'client_attach'; name: string; renderer?: Record<string, Json>; viewport?: { width: number; height: number; unit: string }; focused?: boolean }
  | { type: 'client_detach'; id: string }
  | { type: 'intercept'; surface: string; payload: Json; core?: ({ value: Json } | { error: string })[]; origin?: Json }
);
export type HostReply<K extends keyof HostOperations> = {
  arguments?: HostOperations[K]['arguments']; optional?: boolean;
} & ({ result: HostOperations[K]['result']; error?: never } | { error: string; result?: never });
export type HostMocks = { [K in keyof HostOperations]?: HostReply<K>[] };
export type UnsafeHostReply = { arguments?: Json; optional?: boolean; unsafe?: { arguments?: boolean; result?: boolean } } & ({ result: Json } | { error: string });
export type ScenarioPart = {
  virtual_time_ms?: number;
  /** Nonsecret values `environment.read` answers; secret-like names are refused. */
  environment?: Record<string, string>;
  settings?: Record<string, Record<string, Json>>;
  /** Extra packages trusted before the project, in order. */
  packages?: string[];
  /** Mod IDs run as administrator-managed packages in the `prepend` or `append` tier. */
  tiers?: Record<string, 'prepend' | 'append'>;
  host_operations?: HostMocks;
  steps?: Step[];
};
export type Scenario = ScenarioPart & { schema: 1; steps: Step[] };
export type Trace = {
  schema: 1; offline: true; paid_requests: 0; virtual_time_ms: number;
  steps: { index: number; type: string; at_ms: number; value?: Json; error?: string }[];
  host_calls: { at_ms: number; caller: string; operation: string; arguments: Json }[];
  unused_mock_replies: { operation: string; remaining: number }[];
  status: Json;
};
export type Chain = { result: Json; input: Json; answered_by: string | null; trace: InterceptTraceEntry[]; core_calls: Json[] };
export type ViewMatch = string | Record<string, Json> | ((node: TerminalComponent) => boolean);
export type PointerEvent = { column: number; row: number; action: 'down' | 'up' | 'scroll_up' | 'scroll_down' | 'move' | 'drag' | 'enter' | 'leave'; half?: 0 | 1 | null; button?: 'left' | 'right' | 'middle' | null };
export type InteractOptions = StepOptions & { payload?: Json };
/** The value of a `component` step. */
export type ComponentFrame = { tree: TerminalComponent[]; post: { data: Json } | null; next_ms: number | null };

export function clock(virtualTimeMs: number): ScenarioPart;
export function environment(values: Record<string, string>): { environment: Record<string, string> };
export function settings(id: string, values: Record<string, Json>): { settings: Record<string, Record<string, Json>> };
/** Extra package folders trusted before the project, in order. */
export function packages(...paths: string[]): { packages: string[] };
/** Runs these mod IDs as administrator-managed packages: `prepend` outside every other mod, `append` inside. */
export function tiers(tiers: { prepend?: string[]; append?: string[] }): { tiers: Record<string, 'prepend' | 'append'> };
export function hostOperations(operations: HostMocks): { host_operations: HostMocks };
/** Deliberate negative fixtures. Set unsafe.arguments/result to bypass that boundary check; unknown operations still fail in the engine. */
export function unsafeHostOperations(operations: Record<string, UnsafeHostReply[]>): { host_operations: HostMocks };
/** Deliberate malformed scenario input for engine rejection tests. */
export function unsafeStep(value: Record<string, Json>): Step;
/** Ordered store replies, validated by the engine; persisted-state, authority and revision-conflict behavior require real-host tests. */
export function storeMock(replies?: { get?: Json[]; put?: unknown[]; delete?: unknown[] }): { host_operations: HostMocks };
export function scenario(...parts: ScenarioPart[]): Scenario;
/** Runs the project and its tiers against the engine offline and returns the trace; needs `omd-mod` (`OMD_MOD_BIN`). */
export function runScenario(directory: string, ...parts: ScenarioPart[]): Trace;
export function calls(trace: Trace, operation: string): Trace['host_calls'];

export function invoke(mod: string, event: string, name: string, payload?: Json, options?: StepOptions): Step;
export function emit(event: string, payload?: Json, options?: StepOptions): Step;
export function advance(ms: number, options?: StepOptions): Step;
/** Re-checks `check` (any step) as virtual time advances by `everyMs` until its value equals `until`, failing after `maxMs`. */
export function waitUntil(check: Step, until: Json, options: StepOptions & { everyMs?: number; maxMs: number }): Step;
export function reload(options?: StepOptions): Step;
/** Returns the mod's persisted `api.state`; with `value`, first writes it (the mod needs `store`). `threadId` selects a thread-scoped state. */
export function state(mod: string, options?: StepOptions & { value?: Json; threadId?: string }): Step;
export function mount(mod: string, options?: InteractOptions): Step;
/** Steps one instance of the mod's `api.component` module at the scenario's virtual time, delivering `events` and any due ticks, and returns a `ComponentFrame`. The instance mounts on its first step and keeps its state; `columns` default to 80 and `rows` to 0 (auto height). The module gets no host authority. */
export function component(mod: string, module: string, options?: StepOptions & { instance?: string; props?: Json; columns?: number; rows?: number; events?: (ComponentKey | ComponentPointer)[] }): Step;
export function key(mod: string, name: KeyName | string, options?: InteractOptions): Step;
export function activate(mod: string, component: string, options?: InteractOptions): Step;
export function input(mod: string, component: string, value: string, options?: InteractOptions): Step;
export function select(mod: string, component: string, value: string, options?: InteractOptions): Step;
export function pointer(mod: string, component: string, event: PointerEvent, options?: InteractOptions & { client?: string }): Step;
export function attach(name: string, options?: StepOptions & { renderer?: Record<string, Json>; viewport?: { width: number; height: number; unit: string }; focused?: boolean }): Step;
export function detach(id: string, options?: StepOptions): Step;

export function coreValue(value: Json): { value: Json };
export function coreError(error: string): { error: string };
export function intercept(surface: string, payload: Json, options?: StepOptions & { core?: ({ value: Json } | { error: string })[]; origin?: Json }): Step;

export function findAll(view: TerminalView | TerminalComponent[] | TerminalComponent, match: ViewMatch): TerminalComponent[];
export function find(view: TerminalView | TerminalComponent[] | TerminalComponent, match: ViewMatch): TerminalComponent | undefined;
export function text(view: TerminalView | TerminalComponent[] | TerminalComponent): string;

/** The mod called `next` and the chain reached the core. */
export function assertWrapped(chain: Chain, mod: string): void;
/** The mod answered without calling `next`, so the core never ran. */
export function assertShortCircuit(chain: Chain, mod: string): void;
/** The mod's link failed (skipped, kept, caught or rejected) with a reason matching `reason`. */
export function assertFailure(chain: Chain, mod: string, reason: RegExp): void;

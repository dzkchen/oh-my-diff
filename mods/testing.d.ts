import type { InterceptTraceEntry, Json, KeyName, TerminalComponent, TerminalView } from './api.d.ts';

export type StepOptions = { expect?: Json; expectError?: string; cancelled?: boolean };
export type Step = { type: string; [field: string]: Json | undefined };
/** A host operation reply: the result, or `{ error }` to fail the call. */
export type HostReply = Json | { error: string };
export type ScenarioPart = {
  virtual_time_ms?: number;
  /** Nonsecret values `environment.read` answers; secret-like names are refused. */
  environment?: Record<string, string>;
  settings?: Record<string, Record<string, Json>>;
  /** Extra packages trusted before the project, in order. */
  packages?: string[];
  /** Mod IDs run as administrator-managed packages in the `prepend` or `append` tier. */
  tiers?: Record<string, 'prepend' | 'append'>;
  host_operations?: Record<string, ({ result: Json } | { error: string })[]>;
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

export function clock(virtualTimeMs: number): ScenarioPart;
export function environment(values: Record<string, string>): { environment: Record<string, string> };
export function settings(id: string, values: Record<string, Json>): { settings: Record<string, Record<string, Json>> };
/** Extra package folders trusted before the project, in order. */
export function packages(...paths: string[]): { packages: string[] };
/** Runs these mod IDs as administrator-managed packages: `prepend` outside every other mod, `append` inside. */
export function tiers(tiers: { prepend?: string[]; append?: string[] }): { tiers: Record<string, 'prepend' | 'append'> };
export function hostOperations(operations: Record<string, HostReply[]>): { host_operations: Record<string, ({ result: Json } | { error: string })[]> };
/** Ordered `store.get` (null for a missing key), `store.put` and `store.delete` replies; they are canned, so the host's argument checks (such as the non-null `store.put` value) do not run. */
export function storeMock(replies?: { get?: Json[]; put?: unknown[]; delete?: unknown[] }): { host_operations: Record<string, ({ result: Json } | { error: string })[]> };
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
export function mount(mod: string, options?: InteractOptions): Step;
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

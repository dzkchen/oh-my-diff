export type Renderer = {
  kind: 'terminal' | 'gui' | 'text'; formats: ('svg' | 'png' | 'jpeg' | 'cells' | 'text')[];
  pointer: 'pixel' | 'cell' | 'half_cell' | 'none'; reducedMotion: boolean; cellPx?: { width: number; height: number };
};
export type Viewport = { width: number; height: number; unit: string };
export type RosterEntry = { id: string; name: string; renderer: Renderer; viewport: Viewport | null; focused: boolean; attachedMs: number };
/** `epoch` is an opaque string, empty until the host publishes its first view; a different one means the host restarted. */
export type Attachment = { clientId: string; protocol: 'omd-client/1'; epoch: string; roster: RosterEntry[]; features: string[]; delegable: string[] };
/** `snapshot` is the host's full `ModViewSnapshot` (`view`, `component_owners`, `progress`, `activity`, ...), null before the first publish. */
export type ViewUpdate = { epoch: string; revision: number; snapshot: { view: Record<string, unknown>; component_owners?: Record<string, string>; [key: string]: unknown } | null; actionToken: string };
export type SurfaceCall = { caller: string; operation: string; arguments: unknown; confirm?: string };
export type Mirrored = { caller: string; operation: 'terminal.notify' | 'terminal.notice' | 'terminal.blit'; arguments: unknown };
export type ClientEvent = { kind: 'change' | 'pointer' | 'focus' | 'scroll' | 'key'; [field: string]: unknown };
export type RpcError = Error & { code: number; data?: unknown };

export type ConnectOptions = {
  /** `ws://`/`wss://` (browsers and Node), `unix://PATH` (Node) or `stdio` (Node, spawns `command`, default `codex app-server`). */
  url: string;
  /** Sent raw as the `codex.bearer.<token>` subprotocol on `ws://`/`wss://`; browsers need a base64url or hex token. */
  token?: string;
  command?: string[];
  name: string; renderer: Renderer; operations?: string[]; reconnect?: boolean;
  onView(update: ViewUpdate): void;
  onRoster(roster: RosterEntry[]): void;
  onMirrored(call: Mirrored): void;
  onSurfaceCall?(call: SurfaceCall): unknown | Promise<unknown>;
  onServerRequest?(method: string, params: unknown): unknown | Promise<unknown>;
  onNotification?(method: string, params: unknown): void;
  onReconnect?(change: { epoch: string | null; previousEpoch: string | null }): void;
  onClose?(): void;
};

export interface Session {
  readonly attachment: Attachment | null;
  readonly epoch: string | null;
  readonly revision: number | null;
  readonly actionToken: string | null;
  attach(params?: { name?: string; renderer?: Renderer; operations?: string[] }): Promise<Attachment>;
  update(params: { renderer?: Renderer; viewport?: Viewport; focus?: boolean }): Promise<unknown>;
  detach(): Promise<unknown>;
  read(): Promise<ViewUpdate>;
  event(component: string, event: ClientEvent): Promise<{ delivered: boolean }>;
  action(params: { component: string; row?: number; value?: unknown }): Promise<{ status: 'completed'; outcome: unknown; actionToken: string }>;
  render(slot: string, props: unknown): Promise<{ original: unknown; effective: unknown; tree: unknown; answeredBy: string | null }>;
  resource(reference: string): Promise<{ mediaType: string; data: string; sha256: string }>;
  recovery(apply?: { action: 'enable' | 'disable' | 'reload' | 'reset'; target: string }): Promise<unknown>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  close(): void;
}

export type UnsupportedElement = Error & { code: 'unsupported_element'; component: string; fallback: string };

export function connect(options: ConnectOptions): Promise<Session>;
/** Null when `drawable` lists the component's type and `renderer.formats` can show it, else an `unsupported_element` error naming the fallback text to draw. */
export function unsupported(component: { type: string; id: string; alt?: string; text?: string; label?: string }, renderer: Renderer, drawable: string[]): UnsupportedElement | null;
export function encodeFrame(opcode: number, payload: Uint8Array, masked: boolean): Uint8Array;
export function frameReader(onMessage: (opcode: number, payload: Uint8Array) => void): (chunk: Uint8Array) => void;

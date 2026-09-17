export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Capability = 'context' | 'tools' | 'commands' | 'lifecycle' | 'state';
export interface ToolSpec {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, Json>; required?: string[]; additionalProperties?: boolean };
}
export interface Context {
  thread_id: string;
  turn_id: string;
  checkpoint: Json;
}
export interface ContextResult { text: string }
export interface ModAPI {
  readonly version: '0.1.0-experimental.1';
  readonly settings: Readonly<Record<string, Json>>;
  on(event: 'context', handler: (context: Context) => ContextResult | null | Promise<ContextResult | null>): void;
  on(event: 'start' | 'resume' | 'idle' | 'stop' | 'tool_result', handler: (event: Json) => void | Promise<void>): void;
  tool(spec: ToolSpec, handler: (arguments_: Json) => Json | Promise<Json>): void;
  command(name: string, handler: (arguments_: Json) => Json | Promise<Json>): void;
  readonly state: { get(): Json; set(value: Json): void };
  unsupported(operation: string): never;
}
export default function activate(api: ModAPI): void | Promise<void>;

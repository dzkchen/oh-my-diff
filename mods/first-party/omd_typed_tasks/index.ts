import type { AgentResult, Json, ModAPI } from '../../api-0.1.d.ts';

type Shape = { type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean'; properties?: Record<string, Shape>; required?: string[]; items?: Shape; enum?: Json[]; additionalProperties?: boolean; maxLength?: number; maxItems?: number };
type TaskType = { role: string; route: string; tools: 'read_search' | 'workspace_edit'; result_schema: Shape };
type Task = { id: string; type: string; prompt: string };
type Result = { result: Json; sources: { ref: string; why: string }[] };

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

function shape(value: unknown, depth = 0): value is Shape {
  if (!object(value) || depth > 6 || !['object', 'array', 'string', 'number', 'integer', 'boolean'].includes(String(value.type))) return false;
  if (Object.keys(value).some(key => !['type', 'properties', 'required', 'items', 'enum', 'additionalProperties', 'maxLength', 'maxItems'].includes(key))) return false;
  if (value.type !== 'object' && (value.properties !== undefined || value.required !== undefined || value.additionalProperties !== undefined)) return false;
  if (value.type !== 'array' && (value.items !== undefined || value.maxItems !== undefined)) return false;
  if (value.type !== 'string' && value.maxLength !== undefined) return false;
  if (value.properties !== undefined && (!object(value.properties) || Object.keys(value.properties).length > 32 || !Object.values(value.properties).every(item => shape(item, depth + 1)))) return false;
  if (value.required !== undefined && (!Array.isArray(value.required) || value.required.length > 32 || !value.required.every(item => typeof item === 'string' && object(value.properties) && item in value.properties))) return false;
  if (value.items !== undefined && !shape(value.items, depth + 1)) return false;
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length > 32)) return false;
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') return false;
  if (value.maxLength !== undefined && (typeof value.maxLength !== 'number' || !Number.isInteger(value.maxLength) || value.maxLength < 0 || value.maxLength > 32768)) return false;
  if (value.maxItems !== undefined && (typeof value.maxItems !== 'number' || !Number.isInteger(value.maxItems) || value.maxItems < 0 || value.maxItems > 128)) return false;
  return true;
}

function matches(value: Json, schema: Shape, depth = 0): boolean {
  if (depth > 6) return false;
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) return false;
  if (schema.type === 'string') return typeof value === 'string' && value.length <= (schema.maxLength ?? 32768);
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (schema.type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'array') return Array.isArray(value) && value.length <= (schema.maxItems ?? 128) && (!schema.items || value.every(item => matches(item, schema.items!, depth + 1)));
  if (!object(value)) return false;
  const properties = schema.properties ?? {};
  if (schema.required?.some(key => !(key in value))) return false;
  return Object.entries(value).every(([key, item]) => {
    const property = properties[key];
    return property ? matches(item as Json, property, depth + 1) : schema.additionalProperties === true;
  });
}

function parseResult(value: AgentResult, schema: Shape): Result {
  if (value.status !== 'completed') throw new Error(value.status === 'failed' ? `worker_failed: ${value.error}` : 'worker_still_running');
  let parsed: unknown;
  try { parsed = JSON.parse(value.text); } catch { throw new Error('malformed_worker_json'); }
  if (!object(parsed) || Object.keys(parsed).some(key => key !== 'result' && key !== 'sources') || !('result' in parsed) || !matches(parsed.result as Json, schema)) throw new Error('worker_result_schema_mismatch');
  if (!Array.isArray(parsed.sources) || parsed.sources.length < 1 || parsed.sources.length > 16 || !parsed.sources.every(source => object(source) && Object.keys(source).every(key => key === 'ref' || key === 'why') && bounded(source.ref, 512) && bounded(source.why, 256))) throw new Error('worker_sources_invalid');
  return parsed as Result;
}

export default function activate(api: ModAPI) {
  const types = api.settings.task_types ?? {};
  if (!object(types) || Object.keys(types).length > 16) throw new Error('task_types_invalid');
  for (const [name, value] of Object.entries(types)) {
    if (!bounded(name, 64) || !object(value) || Object.keys(value).some(key => !['role', 'route', 'tools', 'result_schema'].includes(key)) || !bounded(value.role, 64) || !bounded(value.route, 64) || !['read_search', 'workspace_edit'].includes(String(value.tools)) || !shape(value.result_schema) || JSON.stringify(value.result_schema).length > 1400) throw new Error(`task_type_invalid: ${name}`);
  }
  const limit = Number(api.settings.max_fan_out ?? 2);
  if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw new Error('max_fan_out_invalid');

  api.tool({
    name: 'run',
    label: 'Typed subagent tasks',
    description: 'Run up to the configured fan-out of typed workers. Each completed result must match its configured schema and cite sources before consumption. An isolated edit is integrated only after validation.',
    parameters: {
      type: 'object',
      properties: {
        tasks: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string' }, prompt: { type: 'string' } }, required: ['id', 'type', 'prompt'], additionalProperties: false } },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
  }, argument => {
    if (!object(argument) || Object.keys(argument).some(key => key !== 'tasks') || !Array.isArray(argument.tasks) || argument.tasks.length < 1 || argument.tasks.length > limit) throw new Error('task_batch_invalid');
    const tasks: Task[] = [];
    const names = new Set<string>();
    for (const item of argument.tasks) {
      if (!object(item) || Object.keys(item).some(key => !['id', 'type', 'prompt'].includes(key)) || !bounded(item.id, 64) || !bounded(item.type, 64) || !bounded(item.prompt, 6000) || names.has(item.id) || !Object.hasOwn(types, item.type)) throw new Error('task_invalid');
      names.add(item.id);
      tasks.push(item as Task);
    }
    const checkpoint = api.host.call('checkpoint.read', null);
    if (!object(checkpoint) || !bounded(checkpoint.objective, 4096) || typeof checkpoint.revision !== 'number' || !Number.isInteger(checkpoint.revision) || checkpoint.revision < 0) throw new Error('task_checkpoint_unavailable');
    const prompts = tasks.map(task => {
      const type = types[task.type] as TaskType;
      const prompt = `Task checkpoint revision ${checkpoint.revision}. Objective: ${checkpoint.objective}\n\n${task.prompt}\n\nReturn only JSON with keys result and sources. result must match this JSON schema: ${JSON.stringify(type.result_schema)}. sources must contain 1 to 16 objects with ref and why strings. Cite exact source paths, URLs, or host evidence references. Do not claim an unverified source.`;
      if (prompt.length > 8192) throw new Error('worker_prompt_limit');
      return prompt;
    });
    const handles: { task: Task; type: TaskType; handle: string }[] = [];
    const cancel = () => handles.flatMap(owned => {
      const cancelled = api.host.tryCall('agents.cancel', { handle: owned.handle });
      return cancelled.ok ? [] : [`${owned.task.id}: ${cancelled.error}`];
    });
    const abort: (message: string) => never = message => {
      const failures = cancel();
      throw new Error(failures.length ? `${message}; cancel_failed: ${failures.join(', ')}` : message);
    };
    for (const [index, task] of tasks.entries()) {
      const type = types[task.type] as TaskType;
      let agent: { handle: string } | null = null;
      let failure: string | null = null;
      try { agent = api.host.call('agents.spawn', { role: type.role, route: type.route, prompt: prompts[index], workspace: type.tools === 'workspace_edit' ? 'isolated_worktree' : 'read_only' }); } catch (error) { if (!(error instanceof Error)) throw error; failure = error.message; }
      if (failure || !agent) abort(failure ?? 'worker_spawn_failed');
      handles.push({ task, type, handle: agent.handle });
    }
    const validated: { task: Task; type: TaskType; handle: string; value: Result; evidence: Json }[] = [];
    for (const entry of handles) {
      let result: AgentResult = { status: 'running' };
      for (let attempt = 0; attempt < 20 && result.status === 'running'; attempt++) result = api.host.call('agents.wait', { handle: entry.handle, consume: false });
      let value: Result | null = null;
      let failure: string | null = null;
      try { value = parseResult(result, entry.type.result_schema); } catch (error) { failure = error instanceof Error ? error.message : String(error); }
      if (failure || !value) abort(failure ?? 'worker_result_invalid');
      validated.push({ ...entry, value, evidence: result.status === 'completed' ? result.evidence : null });
    }
    for (const entry of validated) api.host.call('agents.result', { handle: entry.handle, consume: true });
    const integrations = new Map<string, Json>();
    let failed = false;
    for (const entry of validated) if (entry.type.tools === 'workspace_edit') {
      if (failed) {
        integrations.set(entry.task.id, { status: 'not_attempted' });
        continue;
      }
      const integration = api.host.tryCall('workspace.integrate', { handle: entry.handle });
      if (integration.ok) {
        integrations.set(entry.task.id, integration.value);
        continue;
      }
      if (!integrations.size) abort(integration.error);
      failed = true;
      integrations.set(entry.task.id, { status: 'failed', error: integration.error });
    }
    const cancelFailures = failed ? cancel() : [];
    return { status: failed ? 'partially_integrated' : 'completed', ...(cancelFailures.length ? { cancel_failures: cancelFailures } : {}), checkpoint_revision: checkpoint.revision, tasks: validated.map(entry => ({ id: entry.task.id, type: entry.task.type, result: entry.value.result, sources: entry.value.sources, worker_evidence: entry.evidence, integration: integrations.get(entry.task.id) ?? null })) };
  });
}

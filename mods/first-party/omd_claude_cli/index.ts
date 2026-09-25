import type { ModAPI, ModelRequestEvent } from '../../api.d.ts';

const provider = 'omd_claude_cli';
const service = 'claude_cli';
const models = new Set(['claude-sonnet-5', 'claude-haiku-4-5-20251001']);

type Row = Record<string, any>;
type Tool = { namespace: string; name: string; kind: 'function' | 'custom' };

function plain(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function content(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) throw new Error('message_content_must_be_blocks');
  return blocks.map(block => {
    if (!plain(block) || !['input_text', 'output_text', 'text'].includes(block.type) || typeof block.text !== 'string') {
      throw new Error('unsupported_message_content');
    }
    return block.text;
  }).join('');
}

function toolName(namespace: string, name: string): string {
  const value = namespace ? `${namespace}__${name}` : name;
  if (!/^[A-Za-z0-9_-]{1,50}$/.test(value)) throw new Error('unsupported_host_tool_name');
  return value;
}

export function translateRequest(request: Row, selectedModel: string): Row {
  if (!plain(request) || request.stream !== true || request.model !== selectedModel || !models.has(selectedModel)) {
    throw new Error('unsupported_claude_request');
  }
  if (request.previous_response_id || request.conversation) throw new Error('remote_conversation_unsupported');
  if (request.instructions !== undefined && typeof request.instructions !== 'string') throw new Error('instructions_must_be_text');
  if (!Array.isArray(request.input)) throw new Error('request_input_must_be_array');
  const reverse: Record<string, Tool> = {};
  const manifest: Row[] = [];
  const tools: Row[] = [];
  const addTool = (spec: Row, namespace = '') => {
    if (spec.type === 'namespace') {
      for (const child of spec.tools ?? []) addTool(child, String(spec.name));
      return;
    }
    if (spec.type === 'web_search') return;
    if (spec.type !== 'function' && spec.type !== 'custom') throw new Error('unsupported_host_tool');
    const name = toolName(namespace, spec.name);
    if (reverse[name]) throw new Error('duplicate_host_tool');
    const schema = spec.type === 'custom'
      ? { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] }
      : spec.parameters ?? { type: 'object', properties: {} };
    if (!plain(schema)) throw new Error('invalid_host_tool_schema');
    reverse[name] = { namespace, name: spec.name, kind: spec.type };
    const description = typeof spec.description === 'string' ? spec.description : '';
    manifest.push({ name, description, inputSchema: schema });
    tools.push({ name: `mcp__omd__${name}`, description, input_schema: schema });
  };
  for (const item of request.input) {
    if (item?.type === 'additional_tools') {
      for (const group of item.tools ?? []) for (const spec of group.tools ?? []) addTool(spec, group.name);
    }
  }
  for (const spec of request.tools ?? []) addTool(spec, spec.namespace ?? '');
  const messages: Row[] = [];
  if (request.instructions) messages.push({ role: 'system', content: request.instructions });
  const pending = new Map<string, string>();
  for (const item of request.input) {
    if (!plain(item)) throw new Error('invalid_response_item');
    if (item.type === 'additional_tools') continue;
    if (item.type === 'message') {
      if (!['system', 'developer', 'user', 'assistant'].includes(item.role)) throw new Error('unsupported_message_role');
      messages.push({ role: item.role, content: content(item.content ?? []) });
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const name = toolName(item.namespace ?? '', item.name);
      const expected = item.type === 'function_call' ? 'function' : 'custom';
      if (reverse[name]?.kind !== expected) throw new Error('historical_tool_not_in_inventory');
      const id = item.call_id ?? item.id;
      if (typeof id !== 'string' || pending.has(id)) throw new Error('invalid_tool_call_id');
      if (messages.at(-1)?.role !== 'assistant') messages.push({ role: 'assistant', content: '' });
      const args = expected === 'custom' ? { input: item.input } : JSON.parse(item.arguments);
      if (!plain(args)) throw new Error('invalid_tool_arguments');
      (messages.at(-1)!.tool_calls ??= []).push({ id, name, input: args });
      pending.set(id, name);
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      if (!pending.has(item.call_id)) throw new Error('tool_result_without_call');
      messages.push({ role: 'tool', tool_call_id: item.call_id,
                      content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
                      is_error: item.is_error === true });
      pending.delete(item.call_id);
    } else {
      throw new Error(`unsupported_response_item:${item.type}`);
    }
  }
  if (pending.size || !messages.length || !['user', 'tool'].includes(messages.at(-1)!.role)) {
    throw new Error('request_must_end_with_user_or_tool_result');
  }
  const system: string[] = [];
  const frames: Row[] = [];
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      if (frames.length) throw new Error('late_system_message');
      system.push(message.content);
      continue;
    }
    const blocks: Row[] = [];
    if (message.role === 'assistant') {
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls ?? []) blocks.push({ type: 'tool_use', id: call.id,
        name: `mcp__omd__${call.name}`, input: call.input });
    } else if (message.role === 'tool') {
      blocks.push({ type: 'tool_result', tool_use_id: message.tool_call_id,
                    content: message.content, is_error: message.is_error });
    } else if (message.content) {
      blocks.push({ type: 'text', text: message.content });
    }
    const role = message.role === 'tool' ? 'user' : message.role;
    if (role === 'user' && frames.at(-1)?.type === 'user') frames.at(-1)!.message.content.push(...blocks);
    else frames.push({ type: role, message: { role, content: blocks } });
  }
  if (!frames.length || frames.at(-1)!.type !== 'user' || !frames.at(-1)!.message.content.length) {
    throw new Error('invalid_claude_history');
  }
  const reasoning = request.reasoning ?? {};
  if (!plain(reasoning) || Object.keys(reasoning).some(key => !['effort', 'summary', 'context'].includes(key)) ||
      ![undefined, 'all_turns'].includes(reasoning.context)) throw new Error('unsupported_reasoning');
  const extra: Row = { tools };
  if (reasoning.effort) extra.output_config = { effort: reasoning.effort };
  if (request.max_output_tokens != null) {
    if (!Number.isInteger(request.max_output_tokens) || request.max_output_tokens < 1) throw new Error('invalid_output_limit');
    extra.max_tokens = request.max_output_tokens;
  }
  return { system: system.join('\n\n'), frames, manifest, extra, reverse };
}

export function responseEvents(assistant: Row, admission: Row, model: string,
                               reverse: Record<string, Tool>, streamedText = false): Row[] {
  const usage = assistant.usage;
  if (!plain(usage) || !Number.isInteger(usage.input_tokens) || !Number.isInteger(usage.output_tokens)) {
    throw new Error('native_usage_missing');
  }
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const inputTokens = usage.input_tokens + cacheRead + cacheWrite;
  const id = typeof assistant.id === 'string' ? assistant.id : 'claude-native';
  const events: Row[] = streamedText ? [] : [{ type: 'response.created', response: { id } }];
  const blocks = Array.isArray(assistant.content) ? assistant.content : [];
  const output = blocks.filter(block => block.type === 'text').map(block => block.text).join('');
  if (output && !streamedText) {
    const item = { type: 'message', id: `${id}-text`, role: 'assistant',
                   content: [{ type: 'output_text', text: output }] };
    events.push({ type: 'response.output_item.added', item: { ...item, content: [] } });
    events.push({ type: 'response.output_text.delta', delta: output });
    events.push({ type: 'response.output_item.done', item });
  }
  for (const block of blocks) {
    if (block.type !== 'tool_use') continue;
    if (typeof block.name !== 'string' || !block.name.startsWith('mcp__omd__')) throw new Error('unknown_native_tool');
    const tool = reverse[block.name.slice('mcp__omd__'.length)];
    if (!tool) throw new Error('tool_outside_host_inventory');
    const item = tool.kind === 'custom'
      ? { type: 'custom_tool_call', id: block.id, call_id: block.id, namespace: tool.namespace,
          name: tool.name, input: block.input?.input }
      : { type: 'function_call', id: block.id, call_id: block.id, namespace: tool.namespace,
          name: tool.name, arguments: JSON.stringify(block.input) };
    if (tool.kind === 'custom' && typeof item.input !== 'string') throw new Error('invalid_custom_tool_input');
    events.push({ type: 'response.output_item.added', item });
    events.push({ type: 'response.output_item.done', item });
  }
  events.push({ type: 'response.completed', response: { id, model,
    usage: { input_tokens: inputTokens, input_tokens_details: { cached_tokens: cacheRead,
             cache_write_tokens: cacheWrite }, output_tokens: usage.output_tokens,
             output_tokens_details: { reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0 },
             total_tokens: inputTokens + usage.output_tokens, omd_native_usage: usage,
             omd_native_admission: admission, omd_subscription_charge: 'unknown' } } });
  return events;
}

export default function activate(api: ModAPI): void {
  const configured = api.settings.model;
  const model = typeof configured === 'string' ? configured : 'claude-sonnet-5';
  if (!models.has(model)) throw new Error('unsupported_claude_model');

  const start = () => {
    const routes = api.host.call('routes.list', null);
    if (routes.some(route => route.provider === provider && route.model === model)) {
      api.host.call('providers.register', { id: service });
    }
  };
  api.on('turn_start', start);
  api.command('claude_route', () => ({ display: `Claude CLI ${model}; subscription usage is account-metered` }));
  api.middleware('model_request', (event: ModelRequestEvent) => {
    if (event.effective.provider !== provider) return null;
    const matching = event.authorized_presets.find(preset => preset.provider === provider && preset.model === model);
    if (!matching) throw new Error('claude_route_not_host_authorized');
    if (event.effective.provider !== provider || event.effective.model !== model) {
      throw new Error('claude_route_conflicts_with_active_request');
    }
    return { preset: matching.name };
  });
}

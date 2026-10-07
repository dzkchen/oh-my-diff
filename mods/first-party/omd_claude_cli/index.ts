import type { Json, ModAPI } from '../../api.d.ts';

const service = 'claude_cli';
const delegate = 'mod_omd_claude_cli_ask_claude';

type Row = Record<string, any>;
type Tool = { namespace: string; name: string; kind: 'function' | 'custom' | 'search' };

function plain(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function image(url: unknown): Row {
  const match = typeof url === 'string' ? /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(url) : null;
  if (!match) throw new Error('unsupported_image_input');
  return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
}

function blocks(content: unknown): Row[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) throw new Error('message_content_must_be_blocks');
  return content.map(block => {
    if (plain(block) && block.type === 'input_image') return image(block.image_url);
    if (!plain(block) || !['input_text', 'output_text', 'text'].includes(block.type) || typeof block.text !== 'string') {
      throw new Error('unsupported_message_content');
    }
    return { type: 'text', text: block.text };
  }).filter(block => block.type !== 'text' || block.text);
}

function text(content: unknown): string {
  const parts = blocks(content);
  if (parts.some(block => block.type !== 'text')) throw new Error('instructions_must_be_text');
  return parts.map(block => block.text).join('');
}

// Codex returns searched default-namespace tools under `functions`; they are called by their plain names.
const scope = (spec: Row): string => spec.name === 'functions' ? '' : String(spec.name);

function toolName(namespace: string, name: string): string {
  const value = namespace ? `${namespace}__${name}` : name;
  if (!/^[A-Za-z0-9_-]{1,50}$/.test(value)) throw new Error('unsupported_host_tool_name');
  return value;
}

// The CLI drops replayed thinking from its history input, so reasoning items carry only the visible summary.
export function reasoningItem(block: Row, id: string): Row {
  return { type: 'reasoning', id, summary: block.thinking ? [{ type: 'summary_text', text: block.thinking }] : [] };
}

export function translateRequest(request: Row, model: string | undefined): Row {
  if (!plain(request) || request.stream !== true || !model || request.model !== model) {
    throw new Error('unsupported_claude_request');
  }
  if (request.previous_response_id || request.conversation) throw new Error('remote_conversation_unsupported');
  if (request.instructions !== undefined && typeof request.instructions !== 'string') throw new Error('instructions_must_be_text');
  if (!Array.isArray(request.input)) throw new Error('request_input_must_be_array');
  const reverse: Record<string, Tool> = Object.create(null);
  const manifest: Row[] = [];
  const tools: Row[] = [];
  const addTool = (spec: Row, namespace = '') => {
    if (spec.type === 'namespace') {
      for (const child of spec.tools ?? []) addTool(child, scope(spec));
      return;
    }
    if (spec.type === 'web_search' || spec.name === delegate) return;
    if (!['function', 'custom', 'tool_search'].includes(spec.type)) throw new Error('unsupported_host_tool');
    const kind = spec.type === 'tool_search' ? 'search' : spec.type;
    const name = kind === 'search' ? 'tool_search' : toolName(namespace, spec.name);
    if (reverse[name]?.kind === kind && reverse[name].namespace === namespace) return;
    if (reverse[name]) throw new Error('duplicate_host_tool');
    const schema = spec.type === 'custom'
      ? { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] }
      : spec.parameters ?? { type: 'object', properties: {} };
    if (!plain(schema)) throw new Error('invalid_host_tool_schema');
    reverse[name] = { namespace, name: spec.name ?? name, kind };
    const description = typeof spec.description === 'string' ? spec.description : '';
    manifest.push({ name, description, inputSchema: schema });
    tools.push({ name: `mcp__omd__${name}`, description, input_schema: schema });
  };
  for (const spec of request.tools ?? []) addTool(spec, spec.namespace ?? '');
  for (const item of request.input) {
    if (item?.type === 'additional_tools') {
      for (const group of item.tools ?? []) for (const spec of group.tools ?? []) addTool(spec, group.name);
    }
    if (item?.type === 'tool_search_output') for (const spec of item.tools ?? []) addTool(spec, spec.namespace ?? '');
  }
  const messages: Row[] = [];
  if (request.instructions) messages.push({ role: 'system', text: request.instructions });
  const assistant = (): Row[] => {
    if (messages.at(-1)?.role !== 'assistant') messages.push({ role: 'assistant', content: [] });
    return messages.at(-1)!.content;
  };
  const pending = new Set<string>();
  const textual = new Set<string>();
  for (const item of request.input) {
    if (!plain(item)) throw new Error('invalid_response_item');
    if (item.type === 'additional_tools' || item.type === 'reasoning') continue;
    if (item.type === 'message') {
      if (item.role === 'system' || item.role === 'developer') messages.push({ role: item.role, text: text(item.content ?? []) });
      else if (item.role === 'assistant') assistant().push(...blocks(item.content ?? []));
      else if (item.role === 'user') messages.push({ role: 'user', content: blocks(item.content ?? []) });
      else throw new Error('unsupported_message_role');
    } else if (['function_call', 'custom_tool_call', 'tool_search_call'].includes(item.type)) {
      const expected = { function_call: 'function', custom_tool_call: 'custom', tool_search_call: 'search' }[item.type as string];
      const name = expected === 'search' ? 'tool_search' : toolName(item.namespace ?? '', item.name);
      const id = item.call_id ?? item.id;
      if (typeof id !== 'string' || pending.has(id)) throw new Error('invalid_tool_call_id');
      const args = expected === 'custom' ? { input: item.input } : expected === 'search' ? item.arguments : JSON.parse(item.arguments);
      if (!plain(args)) throw new Error('invalid_tool_arguments');
      // Requests without the call's tool (Codex compaction sends none) carry the exchange as text.
      if (reverse[name]?.kind === expected) {
        assistant().push({ type: 'tool_use', id, name: `mcp__omd__${name}`, input: args });
      } else {
        textual.add(id);
        assistant().push({ type: 'text', text: `[called ${name} ${JSON.stringify(args)}]` });
      }
      pending.add(id);
    } else if (['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(item.type)) {
      if (!pending.delete(item.call_id)) throw new Error('tool_result_without_call');
      const loaded = (item.tools ?? []).flatMap((spec: Row) => spec.type === 'namespace'
        ? (spec.tools ?? []).map((child: Row) => `mcp__omd__${toolName(scope(spec), child.name)}`) : [`mcp__omd__${toolName(spec.namespace ?? '', spec.name)}`]);
      const output = item.type === 'tool_search_output' ? (loaded.length ? `Loaded tools: ${loaded.join(', ')}` : 'No matching tools.')
        : Array.isArray(item.output) ? blocks(item.output) : typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
      messages.push({ role: 'user', content: textual.has(item.call_id)
        ? [{ type: 'text', text: `[result of ${item.call_id}]` }, ...(typeof output === 'string' ? blocks(output) : output)]
        : [{ type: 'tool_result', tool_use_id: item.call_id, content: output, is_error: item.is_error === true }] });
    } else {
      throw new Error(`unsupported_response_item:${item.type}`);
    }
  }
  if (pending.size) throw new Error('request_must_end_with_user_or_tool_result');
  const system: string[] = [];
  const frames: Row[] = [];
  const late: Row[] = [];
  const attach = () => {
    const last = frames.at(-1);
    if (late.length && last?.type === 'user') last.message.content.push(...late.splice(0));
  };
  for (const message of messages) {
    if ('text' in message) {
      if (!frames.length) system.push(message.text);
      else if (message.text) {
        late.push({ type: 'text', text: `<${message.role}_message>\n${message.text}\n</${message.role}_message>` });
        attach();
      }
      continue;
    }
    if (!message.content.length) continue;
    if (message.role === 'user' && frames.at(-1)?.type === 'user') frames.at(-1)!.message.content.push(...message.content);
    else frames.push({ type: message.role, message: { role: message.role, content: message.content } });
    attach();
  }
  if (!frames.length || frames.at(-1)!.type !== 'user' || !frames.at(-1)!.message.content.length) {
    throw new Error('invalid_claude_history');
  }
  const reasoning = request.reasoning ?? {};
  if (!plain(reasoning) || Object.keys(reasoning).some(key => !['effort', 'summary', 'context'].includes(key)) ||
      ![undefined, 'all_turns'].includes(reasoning.context)) throw new Error('unsupported_reasoning');
  const extra: Row = { tools };
  if (request.max_output_tokens != null) {
    if (!Number.isInteger(request.max_output_tokens) || request.max_output_tokens < 1) throw new Error('invalid_output_limit');
    extra.max_tokens = request.max_output_tokens;
  }
  return { system: system.join('\n\n'), frames, manifest, extra, reverse, effort: reasoning.effort };
}

export function responseEvents(assistant: Row, admission: Row, model: string,
                               reverse: Record<string, Tool>, streamed = false, listCostUsd?: number): Row[] {
  const usage = assistant.usage;
  if (!plain(usage) || !Number.isInteger(usage.input_tokens) || !Number.isInteger(usage.output_tokens)) {
    throw new Error('native_usage_missing');
  }
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const inputTokens = usage.input_tokens + cacheRead + cacheWrite;
  const id = typeof assistant.id === 'string' ? assistant.id : 'claude-native';
  const events: Row[] = streamed ? [] : [{ type: 'response.created', response: { id } }];
  const content = Array.isArray(assistant.content) ? assistant.content.filter(Boolean) : [];
  if (!streamed) {
    for (const [index, block] of content.entries()) {
      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        events.push({ type: 'response.output_item.done', item: reasoningItem(block, `${id}-reasoning-${index}`) });
      }
    }
    const output = content.filter(block => block.type === 'text').map(block => block.text).join('');
    if (output) {
      const item = { type: 'message', id: `${id}-text`, role: 'assistant',
                     content: [{ type: 'output_text', text: output }] };
      events.push({ type: 'response.output_item.added', item: { ...item, content: [] } });
      events.push({ type: 'response.output_text.delta', delta: output });
      events.push({ type: 'response.output_item.done', item });
    }
  }
  for (const block of content) {
    if (block.type !== 'tool_use') continue;
    if (typeof block.name !== 'string' || !block.name.startsWith('mcp__omd__')) throw new Error('unknown_native_tool');
    const tool = reverse[block.name.slice('mcp__omd__'.length)];
    if (!tool) throw new Error('tool_outside_host_inventory');
    const item = tool.kind === 'search'
      ? { type: 'tool_search_call', id: block.id, call_id: block.id, execution: 'client', arguments: block.input }
      : tool.kind === 'custom'
        ? { type: 'custom_tool_call', id: block.id, call_id: block.id, namespace: tool.namespace,
            name: tool.name, input: block.input?.input }
        : { type: 'function_call', id: block.id, call_id: block.id, namespace: tool.namespace,
            name: tool.name, arguments: JSON.stringify(block.input) };
    if (tool.kind === 'custom' && typeof item.input !== 'string') throw new Error('invalid_custom_tool_input');
    events.push({ type: 'response.output_item.added', item });
    events.push({ type: 'response.output_item.done', item });
  }
  const creation = usage.cache_creation;
  const ttl = creation?.ephemeral_5m_input_tokens > 0 ? 300 : creation?.ephemeral_1h_input_tokens > 0 ? 3600 : null;
  events.push({ type: 'response.completed', response: { id, model: typeof assistant.model === 'string' ? assistant.model : model,
    usage: { input_tokens: inputTokens, input_tokens_details: { cached_tokens: cacheRead,
             cache_write_tokens: cacheWrite }, output_tokens: usage.output_tokens,
             output_tokens_details: { reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0 },
             total_tokens: inputTokens + usage.output_tokens, omd_native_usage: usage,
             omd_native_admission: admission, omd_subscription_charge: 'unknown',
             ...ttl ? { omd_cache_ttl_seconds: ttl } : {},
             ...Number.isFinite(listCostUsd) ? { omd_reported_cost: { usd: listCostUsd, basis: 'client_list_estimate' } } : {} } } });
  return events;
}

export default function activate(api: ModAPI): void {
  const ensure = () => {
    const status = api.host.tryCall('sidecars.status', { id: service });
    if (status.ok && (status.value as Row | null)?.running === true) return true;
    if (status.ok) api.host.tryCall('providers.unregister', { id: service });
    return api.host.tryCall('providers.register', { id: service }).ok;
  };
  // The provider is read once per thread at start or resume; each turn only restarts a stopped sidecar.
  const detect = () => {
    const config = api.host.tryCall('app.request', { method: 'config/read', params: {} });
    const ours = config.ok && (config.value as Row).config?.model_provider === 'omd_claude_cli';
    api.state.set(ours);
    if (ours) ensure();
  };
  api.on('start', detect);
  api.on('resume', detect);
  api.on('turn_start', () => {
    if (api.state.get() === true) ensure();
  });
  api.command('claude_route', () => ({ display: 'Claude CLI route: launch with `omd-package claude [--model family]` after `omd-package claude --setup`; subscription windows appear in /status limits.' }));
  if (api.settings.ask_claude !== true) return;
  api.tool({ name: 'ask_claude', description: 'Delegate a question or bounded task to Claude through the OMD Claude route and wait for its answer. Read-only by default; write mode edits an isolated worktree and integrates only within your own write permissions. Use for a second opinion, review or a self-contained task; handle simple work yourself.',
    parameters: { type: 'object', properties: {
      prompt: { type: 'string', maxLength: 12000 },
      mode: { type: 'string', enum: ['read', 'write'] },
      isolated: { type: 'boolean', description: 'Start Claude without this conversation history.' } },
    required: ['prompt'], additionalProperties: false } }, (input): Json => {
    const value = input as Row;
    if (!plain(value) || typeof value.prompt !== 'string' || !value.prompt.trim()) return { status: 'invalid', reason: 'prompt_required' };
    if (!ensure()) return { status: 'unavailable', reason: 'claude_route_not_configured' };
    const write = value.mode === 'write';
    const spawned = api.host.tryCall('agents.spawn', { role: 'claude delegate', route: service, prompt: value.prompt,
      parent_history: value.isolated !== true,
      ...(write ? { workspace: 'isolated_worktree' } : { workspace: 'read_only', tools: ['exec_command', 'write_stdin', 'read', 'grep_files', 'list_dir'] }) });
    if (!spawned.ok) return { status: 'denied', reason: spawned.error };
    const handle = spawned.value.handle;
    let result = api.host.tryCall('agents.wait', { handle });
    for (let waits = 1; waits < 27 && result.ok && result.value.status === 'running'; waits++) {
      result = api.host.tryCall('agents.wait', { handle });
    }
    if (!result.ok || result.value.status !== 'completed') {
      api.host.tryCall('agents.cancel', { handle });
      return { status: 'incomplete', reason: result.ok ? (result.value.status === 'failed' ? result.value.error : 'timeout') : result.error };
    }
    const answer = { status: 'completed', text: result.value.text, evidence: result.value.evidence };
    if (!write || !result.value.changed_paths?.length) return answer;
    const integrated = api.host.tryCall('workspace.integrate', { handle });
    return { ...answer, changed_paths: result.value.changed_paths,
      integration: integrated.ok ? integrated.value : { status: 'refused', reason: integrated.error } } as Json;
  });
}

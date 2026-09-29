import type { Json, ModAPI } from '@oh-my-diff/mod-api';

type Entry = Record<string, Json>;
type State = {
  adapter: 'debugpy' | null;
  executable: string;
  running: boolean;
  ready: boolean;
  mode: 'launch' | null;
  phase: 'idle' | 'initialized' | 'configuring' | 'active' | 'stopped' | 'failed';
  next_seq: number;
  launch_seq: number | null;
  thread_id: number | null;
  reason: string;
};
type Outcome = { ok: true; value: Entry } | { ok: false; error: string };

const session = 'debug';
const record = (value: Json): Entry | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
const string = (value: Json): string | null => typeof value === 'string' ? value : null;
const integer = (value: Json): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const bounded = (value: string, maximum = 256) => value.slice(0, maximum);
const path = (value: Json): string | null => typeof value === 'string' && value.startsWith('/') && value.length <= 4096 && !value.includes('\0') && !value.split('/').includes('..') ? value : null;

function restore(value: Json): State {
  const saved = record(value) ?? {};
  return {
    adapter: saved.adapter === 'debugpy' ? saved.adapter : null,
    executable: path(saved.executable ?? null) ?? '',
    running: saved.running === true,
    ready: saved.ready === true,
    mode: saved.mode === 'launch' ? saved.mode : null,
    phase: saved.phase === 'initialized' || saved.phase === 'configuring' || saved.phase === 'active' || saved.phase === 'stopped' || saved.phase === 'failed' ? saved.phase : 'idle',
    next_seq: integer(saved.next_seq ?? null) ?? 1,
    launch_seq: integer(saved.launch_seq ?? null),
    thread_id: integer(saved.thread_id ?? null),
    reason: string(saved.reason ?? null) ?? '',
  };
}

function compact(command: string, response: Entry): Json {
  const body = record(response.body ?? null) ?? {};
  if (command === 'threads') return { threads: Array.isArray(body.threads) ? body.threads.slice(0, 64).map(value => {
    const item = record(value) ?? {};
    return { id: integer(item.id ?? null), name: bounded(string(item.name ?? null) ?? '') };
  }) : [] };
  if (command === 'stackTrace') return { frames: Array.isArray(body.stackFrames) ? body.stackFrames.slice(0, 64).map(value => {
    const item = record(value) ?? {};
    const source = record(item.source ?? null) ?? {};
    return { id: integer(item.id ?? null), name: bounded(string(item.name ?? null) ?? ''), path: bounded(string(source.path ?? null) ?? '', 4096), line: integer(item.line ?? null), column: integer(item.column ?? null) };
  }) : [], totalFrames: integer(body.totalFrames ?? null) };
  if (command === 'scopes') return { scopes: Array.isArray(body.scopes) ? body.scopes.slice(0, 32).map(value => {
    const item = record(value) ?? {};
    return { name: bounded(string(item.name ?? null) ?? ''), variablesReference: integer(item.variablesReference ?? null), expensive: item.expensive === true };
  }) : [] };
  if (command === 'variables') return { variables: Array.isArray(body.variables) ? body.variables.slice(0, 100).map(value => {
    const item = record(value) ?? {};
    return { name: bounded(string(item.name ?? null) ?? ''), value: bounded(string(item.value ?? null) ?? '', 1024), type: bounded(string(item.type ?? null) ?? ''), variablesReference: integer(item.variablesReference ?? null) };
  }) : [] };
  if (command === 'evaluate') return { result: bounded(string(body.result ?? null) ?? '', 2048), type: bounded(string(body.type ?? null) ?? ''), variablesReference: integer(body.variablesReference ?? null) };
  if (command === 'setBreakpoints') return { breakpoints: Array.isArray(body.breakpoints) ? body.breakpoints.slice(0, 32).map(value => {
    const item = record(value) ?? {};
    return { verified: item.verified === true, line: integer(item.line ?? null) };
  }) : [] };
  return { success: response.success === true };
}

export default function activate(api: ModAPI) {
  const save = (state: State) => api.state.set(state as unknown as Json);
  const stop = (state: State, reason: string) => {
    if (state.running) api.host.tryCall('process.stop', { session });
    state.running = false;
    state.phase = reason ? 'failed' : 'idle';
    state.reason = bounded(reason);
    state.thread_id = null;
    state.ready = false;
    state.launch_seq = null;
    save(state);
  };
  const exchange = (state: State, send: Json[], wait_ms = 0): Outcome => {
    const result = api.host.tryCall('process.exchange', { session, send, wait_ms });
    if (!result.ok) {
      stop(state, 'adapter_process_failed');
      return { ok: false, error: 'debug_adapter_unavailable' };
    }
    for (const raw of result.value.messages) {
      const message = record(raw);
      if (!message) continue;
      if (message.type === 'response' && state.launch_seq !== null && message.request_seq === state.launch_seq) {
        if (message.success !== true) {
          stop(state, 'adapter_launch_refused');
          return { ok: false, error: 'debug_launch_refused' };
        }
        state.launch_seq = null;
      }
      if (message.type !== 'event') continue;
      if (message.event === 'initialized') {
        state.ready = true;
      } else if (message.event === 'stopped') {
        const body = record(message.body ?? null) ?? {};
        state.thread_id = integer(body.threadId ?? null);
        state.phase = 'stopped';
        const reason = string(body.reason ?? null);
        state.reason = reason && ['step', 'breakpoint', 'exception', 'pause', 'entry', 'goto', 'function breakpoint', 'data breakpoint', 'instruction breakpoint'].includes(reason) ? reason : 'stopped';
      } else if (message.event === 'continued') {
        state.phase = 'active';
        state.reason = '';
      } else if (message.event === 'terminated' || message.event === 'exited') {
        state.phase = 'initialized';
        state.thread_id = null;
        state.reason = 'target_exited';
      }
    }
    save(state);
    return { ok: true, value: { messages: result.value.messages } };
  };
  const send = (state: State, command: string, args: Json): Outcome => {
    const seq = state.next_seq++;
    const sent = exchange(state, [{ seq, type: 'request', command, arguments: args }]);
    if (!sent.ok) return sent;
    return { ok: true, value: { seq, messages: sent.value.messages } };
  };
  const receive = (state: State, seq: number, command: string, initial: Json): Outcome => {
    let messages = initial;
    for (let batches = 0, silent = 0; batches < 12 && silent < 6; batches++) {
      if (batches > 0) {
        const batch = exchange(state, [], 500);
        if (!batch.ok) return batch;
        messages = batch.value.messages;
        if (!Array.isArray(messages) || !messages.length) silent++;
      }
      if (!Array.isArray(messages)) return { ok: false, error: 'invalid_adapter_message' };
      for (const raw of messages) {
        const response = record(raw);
        if (response?.type !== 'response' || response.request_seq !== seq) continue;
        if (response.success !== true) return { ok: false, error: `debug_${command}_refused` };
        return { ok: true, value: { result: compact(command, response) } };
      }
    }
    save(state);
    return { ok: false, error: `debug_${command}_timeout` };
  };
  const drain = (state: State): Outcome => state.running ? exchange(state, [], 0) : { ok: true, value: {} };
  const settle = (state: State) => {
    for (let silent = 0; state.running && state.phase === 'active' && silent < 4; silent++) {
      if (!exchange(state, [], 500).ok) return;
    }
  };
  const request = (state: State, command: string, args: Json): Outcome => {
    const sent = send(state, command, args);
    if (!sent.ok) return sent;
    return receive(state, Number(sent.value.seq), command, sent.value.messages);
  };
  const failed = (state: State, result: Outcome): Json => {
    save(state);
    return result.ok ? { ...result.value, phase: state.phase, thread_id: state.thread_id, reason: state.reason } : { error: result.error, phase: state.phase, reason: state.reason };
  };
  api.tool({
    name: 'open',
    description: 'Open a sandboxed Python debugpy adapter after explicit tool approval. No target launches until a separate request.',
    parameters: { type: 'object', properties: { adapter: { type: 'string', enum: ['debugpy'] } }, required: ['adapter'], additionalProperties: false },
  }, (payload): Json => {
    const adapter = record(payload)?.adapter;
    if (adapter !== 'debugpy') return { error: 'invalid_adapter' };
    const state = restore(api.state.get());
    if (state.running) stop(state, '');
    const name = 'python3';
    const found = api.host.tryCall('process.which', { names: [name] });
    if (!found.ok || !found.value.found.length) return { error: 'adapter_dependency_absent', adapter };
    const binary = found.value.found[0];
    const started = api.host.tryCall('process.start', {
      session, name, path: binary.path, sha256: binary.sha256,
      arguments: ['-m', 'debugpy.adapter'],
      framing: 'content-length', network: 'loopback',
    });
    if (!started.ok) return { error: 'adapter_start_refused', adapter };
    state.adapter = adapter;
    state.executable = binary.path;
    state.running = true;
    state.mode = null;
    state.phase = 'initialized';
    state.next_seq = 1;
    state.reason = '';
    state.thread_id = null;
    state.ready = false;
    state.launch_seq = null;
    save(state);
    const init = request(state, 'initialize', {
      clientID: 'oh-my-diff', adapterID: 'python',
      linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path',
      supportsVariableType: true, supportsRunInTerminalRequest: false,
    });
    if (!init.ok) {
      stop(state, 'adapter_initialize_failed');
      return { error: 'adapter_initialize_failed', adapter };
    }
    return { adapter, status: 'initialized' };
  });
  api.tool({
    name: 'start',
    description: 'Launch an explicitly selected Python target under the sandboxed debugpy adapter.',
    parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['launch'] }, program: { type: 'string' }, args: { type: 'array', items: { type: 'string' }, maxItems: 16 } }, required: ['mode', 'program'], additionalProperties: false },
  }, payload => {
    const input = record(payload) ?? {};
    const state = restore(api.state.get());
    if (!state.running || !state.adapter || state.phase !== 'initialized') return { error: 'adapter_not_initialized' };
    const mode = input.mode;
    if (mode !== 'launch') return { error: 'invalid_mode' };
    const program = path(input.program ?? null);
    if (!program) return { error: 'target_required' };
    const args = Array.isArray(input.args) && input.args.length <= 16 && input.args.every(item => typeof item === 'string' && item.length <= 256) ? input.args : [];
    const sent = send(state, mode, { program, python: state.executable, args, stopOnEntry: true, justMyCode: false, redirectOutput: false });
    if (!sent.ok) return failed(state, sent);
    const immediate = Array.isArray(sent.value.messages) ? sent.value.messages.map(record).find(message => message?.type === 'response' && message.request_seq === sent.value.seq) : null;
    if (immediate && immediate.success !== true) {
      stop(state, 'adapter_launch_refused');
      return { error: 'debug_launch_refused' };
    }
    state.mode = mode;
    state.phase = 'configuring';
    state.launch_seq = immediate ? null : Number(sent.value.seq);
    save(state);
    return { status: 'configuring', request_seq: sent.value.seq };
  });
  api.tool({
    name: 'breakpoints',
    description: 'Set bounded source breakpoints while configuring or debugging.',
    parameters: { type: 'object', properties: { source: { type: 'string' }, lines: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 32 } }, required: ['source', 'lines'], additionalProperties: false },
  }, payload => {
    const input = record(payload) ?? {};
    const state = restore(api.state.get());
    drain(state);
    const source = path(input.source ?? null);
    const lines = input.lines;
    if (!state.running || !state.ready || !source || !Array.isArray(lines) || lines.length < 1 || lines.length > 32 || !lines.every(item => integer(item) !== null && Number(item) > 0)) return { error: 'invalid_breakpoints_or_adapter_not_ready' };
    return failed(state, request(state, 'setBreakpoints', { source: { path: source }, breakpoints: lines.map(line => ({ line })), sourceModified: false }));
  });
  api.tool({
    name: 'configure',
    description: 'Complete the DAP configuration after setting breakpoints.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  }, (): Json => {
    const state = restore(api.state.get());
    drain(state);
    if (!state.running || !state.ready || state.phase !== 'configuring') return { error: 'not_configuring_or_adapter_not_ready' };
    const exceptions = request(state, 'setExceptionBreakpoints', { filters: ['uncaught'] });
    if (!exceptions.ok) return failed(state, exceptions);
    state.phase = 'active';
    const result = request(state, 'configurationDone', {});
    if (result.ok) settle(state);
    else if (state.phase === 'active') state.phase = 'configuring';
    return failed(state, result);
  });
  api.tool({
    name: 'inspect',
    description: 'Inspect threads, stack frames, scopes, variables, or evaluate an expression at a stopped frame. Evaluation can run target code and prompts separately.',
    parameters: { type: 'object', properties: { command: { type: 'string', enum: ['threads', 'stackTrace', 'scopes', 'variables', 'evaluate'] }, thread_id: { type: 'integer' }, frame_id: { type: 'integer' }, variables_reference: { type: 'integer' }, expression: { type: 'string' } }, required: ['command'], additionalProperties: false },
  }, payload => {
    const input = record(payload) ?? {};
    const state = restore(api.state.get());
    drain(state);
    if (!state.running || (state.phase !== 'stopped' && input.command !== 'threads')) return { error: 'target_not_stopped', phase: state.phase };
    const command = string(input.command ?? null);
    let args: Json = {};
    if (command === 'stackTrace') {
      const threadId = integer(input.thread_id ?? null) ?? state.thread_id;
      if (!threadId) return { error: 'thread_required' };
      args = { threadId, levels: 64 };
    } else if (command === 'scopes') {
      const frameId = integer(input.frame_id ?? null);
      if (frameId === null) return { error: 'frame_required' };
      args = { frameId };
    } else if (command === 'variables') {
      const variablesReference = integer(input.variables_reference ?? null);
      if (!variablesReference) return { error: 'variables_reference_required' };
      args = { variablesReference, start: 0, count: 100 };
    } else if (command === 'evaluate') {
      const expression = string(input.expression ?? null);
      const frameId = integer(input.frame_id ?? null);
      if (!expression || expression.length > 512 || frameId === null) return { error: 'expression_and_frame_required' };
      args = { expression, frameId, context: 'repl' };
    } else if (command !== 'threads') return { error: 'invalid_inspection' };
    return failed(state, request(state, command, args));
  });
  api.tool({
    name: 'control',
    description: 'Continue, step, or pause a debug session through the active adapter.',
    parameters: { type: 'object', properties: { command: { type: 'string', enum: ['continue', 'next', 'stepIn', 'stepOut', 'pause'] }, thread_id: { type: 'integer' } }, required: ['command'], additionalProperties: false },
  }, payload => {
    const input = record(payload) ?? {};
    const state = restore(api.state.get());
    drain(state);
    const threadId = integer(input.thread_id ?? null) ?? state.thread_id;
    const command = string(input.command ?? null);
    if (!state.running || !threadId || !command || !['continue', 'next', 'stepIn', 'stepOut', 'pause'].includes(command)) return { error: 'invalid_control' };
    const previous = state.phase;
    state.phase = 'active';
    const result = request(state, command, { threadId });
    if (result.ok) settle(state);
    else if (state.phase === 'active') state.phase = previous;
    return failed(state, result);
  });
  api.tool({
    name: 'detach',
    description: 'Disconnect, terminate the launched target, and tear down the owned adapter.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  }, (): Json => {
    const state = restore(api.state.get());
    if (!state.running) return { stopped: false };
    const result = request(state, 'disconnect', { terminateDebuggee: true, restart: false });
    stop(state, '');
    return { stopped: true, disconnect: result.ok ? 'sent' : 'adapter_unavailable' };
  });
  api.tool({
    name: 'status',
    description: 'Report adapter, target phase, and bounded failure state without exposing adapter diagnostics.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  }, () => {
    const state = restore(api.state.get());
    if (state.running) {
      exchange(state, [], 250);
      if (state.running) {
        const result = api.host.tryCall('process.status', { session });
        if (!result.ok) stop(state, 'adapter_stopped');
      }
    }
    const current = restore(api.state.get());
    return { adapter: current.adapter, running: current.running, ready: current.ready, mode: current.mode, phase: current.phase, thread_id: current.thread_id, reason: current.reason };
  });
  api.on('idle', () => stop(restore(api.state.get()), ''));
  api.on('stop', () => stop(restore(api.state.get()), ''));
}

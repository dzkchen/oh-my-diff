import type { Json, ModAPI } from '../../api.d.ts';

const service = 'muse';
const marker = /OMD_MUSE_(APPROVAL|CONTINUE) (\{[^\n]*\})\s*$/;
const posture = ['serve', '--trust-workspace', '--disable-write', '--sandbox-network', 'restricted'];

type Row = Record<string, any>;

function plain(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function lines(text: string): Row[] {
  return text.split('\n').flatMap(line => { try { const row = JSON.parse(line); return plain(row) ? [row] : []; } catch { return []; } });
}

// Newest plaintext answer whose run reached a completed terminal in a Muse durable session log.
export function recovered(log: string): string | null {
  const completed = new Set<string>();
  for (const record of lines(log).reverse()) {
    const run = record.payload?.run_id;
    const event = record.payload?.event;
    if (typeof run !== 'string' || !plain(event)) continue;
    if (event.kind === 'terminal' && event.terminal === 'completed') completed.add(run);
    else if (event.kind === 'assistant_message_committed' && completed.has(run) && typeof event.text === 'string' && event.text.trim()) return event.text;
  }
  return null;
}

export default function activate(api: ModAPI): void {
  const ensure = () => {
    const status = api.host.tryCall('sidecars.status', { id: service });
    if (status.ok && (status.value as Row | null)?.running === true) return true;
    if (status.ok) api.host.tryCall('providers.unregister', { id: service });
    return api.host.tryCall('providers.register', { id: service }).ok;
  };
  const decide = (detail: Row): boolean => {
    if (api.settings.auto_approve === true) return true;
    const answer = api.host.tryCall('terminal.prompt', { kind: 'confirm', title: `Muse wants to use ${String(detail.tool ?? 'a tool')}`,
      message: String(detail.summary || 'Muse gave no details for this request.') });
    return answer.ok && answer.value.status === 'accepted';
  };
  const route = (): Row | null => {
    if (typeof api.settings.route !== 'string') return null;
    const read = api.host.tryCall('exec.run', { program: '/bin/cat', argv: [api.settings.route] });
    try { return read.ok && read.value.exit_code === 0 ? JSON.parse(read.value.stdout) : null; } catch { return null; }
  };
  const handshake = (config: Row, requests: [string, Json][]) => {
    const input = [['initialize', { clientInfo: { name: 'omd_muse', title: 'Oh My Diff', version: '0.2.0' } }], ...requests]
      .map(([method, params], index) => JSON.stringify({ jsonrpc: '2.0', id: index + 1, method, params })).join('\n');
    const run = api.host.tryCall('exec.run', { program: config.muse, argv: posture, stdin: `${input}\n`, timeout_ms: 15000,
      env: { MUSE_EXPERIMENTAL_SDK_ENABLED: '1', XDG_DATA_HOME: config.data } });
    if (!run.ok) return { error: run.error, results: {} as Record<number, Row> };
    const results: Record<number, Row> = {};
    for (const row of lines(run.value.stdout)) if (typeof row.id === 'number') results[row.id] = row;
    return { error: run.value.stderr.trim().split('\n').at(-1) ?? '', results };
  };

  api.on('turn_start', () => {
    const config = api.host.tryCall('app.request', { method: 'config/read', params: {} });
    if (config.ok && (config.value as Row).config?.model_provider === 'omd_muse') ensure();
  });
  api.tool({ name: 'approval', description: 'Internal relay for approval requests raised by a Muse lead. Never call this tool yourself.',
    parameters: { type: 'object', properties: { key: { type: 'string' }, tool: { type: 'string' }, summary: { type: 'string' } },
      required: ['key'], additionalProperties: false } },
  (input): Json => {
    const value = input as Row;
    return { approved: plain(value) && /^omd_muse_[0-9a-f]{32}$/.test(String(value.key)) && decide(value) };
  });

  api.tool({ name: 'research', description: 'Ask Muse, a separate low-cost research agent, to investigate a question about this repository or its dependencies with its own read-only tools and return findings with file paths or URLs. Use for broad reading you would otherwise do yourself; decisions and edits stay with you.',
    parameters: { type: 'object', properties: { question: { type: 'string', maxLength: 6000 } }, required: ['question'], additionalProperties: false } },
  (input): Json => {
    const value = input as Row;
    if (!plain(value) || typeof value.question !== 'string' || !value.question.trim()) return { status: 'invalid', reason: 'question_required' };
    if (!ensure()) return { status: 'unavailable', reason: 'muse_route_not_configured' };
    let prompt = `You are a read-only research subagent for another coding agent. Investigate the question below with your read and search tools; do not modify anything. Reply with concise findings, each citing file paths with line numbers or URLs, and list open questions last.\n\nQuestion:\n${value.question}`;
    let findings = '';
    let calls = 3;
    while (calls < 32) {
      calls++;
      const done = api.host.tryCall('model.complete', { route: service, prompt, timeout_ms: 300000 });
      if (!done.ok) return { status: 'failed', reason: done.error, findings };
      const match = marker.exec(done.value.text);
      findings += match ? done.value.text.slice(0, match.index) : done.value.text;
      if (!match) return { status: 'completed', findings: findings.trim(), source: 'muse', decision_owner: 'lead' };
      let detail: unknown = null;
      try { detail = JSON.parse(match[2]); } catch {}
      if (!plain(detail)) return { status: 'failed', reason: 'invalid_muse_marker', findings };
      if (match[1] === 'APPROVAL' && api.settings.auto_approve !== true && ++calls >= 32) break;
      prompt = match[1] === 'CONTINUE' ? `OMD_MUSE_CONTINUE ${JSON.stringify({ key: detail.key })}`
        : `OMD_MUSE_DECISION ${JSON.stringify({ key: detail.key, approved: decide(detail) })}`;
    }
    return { status: 'incomplete', reason: 'step_limit', findings };
  });

  api.command('muse', (argument): Json => {
    const [action = 'doctor', target = ''] = String(argument ?? '').trim().split(/\s+/);
    const config = route();
    if (!config) return { display: 'Muse route is not configured for this store; run `omd-package muse --setup`.' };
    if (action === 'fork') {
      const forked = api.host.tryCall('builtins.invoke', { command: 'fork' });
      return { display: forked.ok ? 'Forked this chat; its next Muse turn continues on a fork of the Muse session.' : `Fork failed: ${forked.error}` };
    }
    if (action === 'recover') {
      const state = api.host.tryCall('exec.run', { program: '/bin/cat', argv: [`${config.data}/omd-sessions.json`] });
      let sessions: Row = {};
      try { sessions = JSON.parse(state.ok ? state.value.stdout : '{}').sessions ?? {}; } catch {}
      const id = target || Object.entries(sessions).sort((a, b) => b[1].at - a[1].at)[0]?.[0];
      if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return { display: 'No Muse session to recover; pass a session id from `/muse sessions`.' };
      const log = api.host.tryCall('exec.run', { program: '/bin/sh', argv: ['-c',
        'f=$(find "$1/muse/sessions" -path "*/$2/session.jsonl" 2>/dev/null | head -n 1); [ -n "$f" ] && grep -E "assistant_message_committed|\\"terminal\\"" "$f" | tail -c 60000',
        'sh', config.data, id] });
      const text = log.ok ? recovered(log.value.stdout) : null;
      return text ? { display: `Recovered the latest completed Muse answer from session ${id}.`, insert: text }
        : { display: `No completed Muse answer found in the durable log of session ${id}.` };
    }
    const requests: [string, Json][] = action === 'sessions' ? [['session/list', { limit: 20 }]] : [['model/list', {}], ['session/list', { limit: 200 }]];
    const { error, results } = handshake(config, requests);
    const fingerprint = results[1]?.result?.schema?.fingerprint;
    if (!fingerprint) return { display: `Muse MSP host unavailable (${config.muse}): ${error || 'no initialize response'}` };
    const sessions: Row[] = results[action === 'sessions' ? 2 : 3]?.result?.sessions ?? [];
    if (action === 'sessions') {
      return { display: sessions.length ? sessions.map(row => `${row.sessionId}  ${row.modelId ?? ''}  ${row.updatedAt ?? ''}`).join('\n') : 'No Muse sessions.' };
    }
    const models: Row[] = results[2]?.result?.models ?? [];
    return { display: [
      `muse serve: ok (${config.muse})`,
      `schema fingerprint: ${fingerprint}${fingerprint === config.fingerprint ? ' (matches setup)' : ` (setup recorded ${config.fingerprint}; rerun omd-package muse --setup)`}`,
      `models: ${models.map(row => row.modelId).join(', ') || results[2]?.error?.message || 'none listed'}`,
      `sessions: ${sessions.length}`,
      `posture: sandboxed, workspace trust, writes disabled, shell network restricted; approvals ${api.settings.auto_approve === true ? 'auto-approved (setting)' : 'asked through OMD'}`].join('\n') };
  }, { description: 'Muse route: doctor | sessions | fork | recover [session]' });
}

#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
API = '0.2.0-experimental.1'

GATE = '''export default function activate(api) {
  api.contract({ schema: 2, id: 'probe_gate', version: 1, description: 'A passing check before completion',
    assurance: 'checked', gates: { complete: [{ receipt: 'checks', bind: ['candidate'] }] } });
  api.middleware('response_stream', event => event.boundary && /RETRY_ME/.test(event.text ?? '')
    ? { stop: { reason: 'probe marker' }, retry: { inject: 'PROBE_INJECTED_RETRY' } } : null);
}
'''

PROBE = '''const empty = { type: 'object', properties: {}, additionalProperties: false };
const error = result => result.ok ? null : String(result.error);
export default function activate(api) {
  api.on('turn_start', () => {
    api.host.tryCall('workspace.transaction', { expected: { 'event.txt': null }, writes: { 'event.txt': 'event\\n' } });
  });
  api.on('workspace_change', event => {
    const entry = api.host.call('store.get', { key: 'changes' });
    const seen = entry ? entry.value : [];
    api.host.call('store.put', { key: 'changes', expected_revision: entry ? entry.revision : null,
      value: [...seen, { source: event.source, call_id: event.call_id, status: event.status, paths: event.changes.map(change => change.path) }] });
  });
  api.tool({ name: 'check', description: 'Exercise host enforcement', parameters: empty }, () => {
    const denied = api.host.tryCall('exec.run', { program: 'sh', argv: ['-c', 'true'], network: 'loopback' });
    const slow = api.host.call('exec.run', { program: 'sh', argv: ['-c', 'sleep 5'], timeout_ms: 200 });
    const detached = api.host.call('exec.run', { program: 'sh', argv: ['-c', "perl -e 'setpgrp(0,0); sleep 5' & sleep 0.1; exit 0"], timeout_ms: 400 });
    const wide = api.host.call('exec.run', { program: 'sh', argv: ['-c', "head -c 100000 /dev/zero | tr '\\\\0' x"] });
    const write = api.host.call('exec.run', { program: 'sh', argv: ['-c', 'printf tool > tool.txt'], write: true });
    const candidate = api.host.call('workspace.snapshot', {}).candidate_sha256;
    const fingerprint = api.host.call('workspace.fingerprint', { expected: candidate }).candidate_sha256;
    const refused = api.host.call('task.complete', { candidate_sha256: candidate });
    const evidence = api.host.call('evidence.write', { media_type: 'application/json', content: { exit_code: write.exit_code } });
    api.host.call('receipts.submit', { kind: 'checks', candidate_sha256: candidate, outcome: 'pass', evidence });
    const completed = api.host.call('task.complete', { candidate_sha256: candidate });
    return { denied: error(denied), slow: slow.timed_out, detached: { timed_out: detached.timed_out, duration_ms: detached.duration_ms },
      wide: { preview: wide.stdout.length, bytes: wide.stdout_bytes, truncated: wide.stdout_truncated, preview_truncated: wide.stdout_preview_truncated },
      write: write.exit_code, fingerprint: fingerprint === candidate, refused: refused.status, missing: refused.missing ?? [], completed: completed.status };
  });
  api.tool({ name: 'store_check', description: 'Exercise store limits', parameters: empty }, () => {
    const big = api.host.tryCall('store.put', { key: 'big', value: 'x'.repeat(70000), expected_revision: null });
    api.host.call('store.put', { key: 'cas', value: 1, expected_revision: null });
    const stale = api.host.tryCall('store.put', { key: 'cas', value: 2, expected_revision: null });
    return { big: error(big), stale: error(stale) };
  });
  api.tool({ name: 'complete', description: 'Request completion under the selected contract', parameters: empty }, () => {
    const status = api.host.call('contract.status', null);
    const snapshot = api.host.tryCall('workspace.snapshot', {});
    const completion = snapshot.ok ? api.host.tryCall('task.complete', { candidate_sha256: snapshot.value.candidate_sha256 }) : snapshot;
    return { status: status.status, reason: status.provenance?.error ?? null, completion: completion.ok ? completion.value.status : String(completion.error) };
  });
}
'''


def run(argv, cwd, env=None):
    result = subprocess.run([str(value) for value in argv], cwd=cwd, env=env, text=True, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError(f'{argv[:3]}: {result.stderr[-3000:]}')
    return result.stdout

AGENT_PROBE = '''export default function activate(api) {
  api.tool({ name: 'run', description: 'Exercise owned agent handles', parameters: { type: 'object', properties: {}, additionalProperties: false } }, () => {
    const spawn = () => api.host.call('agents.spawn', { role: 'probe', route: 'worker', prompt: 'Reply WORKER_OK.', workspace: 'read_only', tools: [] });
    const first = spawn();
    const second = spawn();
    const listed = api.host.call('agents.list', null).map(agent => agent.handle).sort();
    const cancelled = api.host.call('agents.cancel', { handle: second.handle }).cancelled;
    let result = api.host.call('agents.wait', { handle: first.handle, consume: true });
    for (let attempt = 0; attempt < 5 && result.status === 'running'; attempt++) result = api.host.call('agents.wait', { handle: first.handle, consume: true });
    const remaining = api.host.call('agents.list', null);
    const gone = api.host.tryCall('agents.result', { handle: second.handle });
    return { listed: listed.length === 2 && listed.includes(first.handle) && listed.includes(second.handle), cancelled, status: result.status,
      text: result.text, consumed: result.consumed, remaining: remaining.map(agent => [agent.handle === first.handle, agent.consumed]),
      gone: gone.ok ? null : String(gone.error) };
  });
  api.tool({ name: 'integrate', description: 'Integrate an isolated writer', parameters: { type: 'object', properties: {}, additionalProperties: false } }, () => {
    const writer = api.host.call('agents.spawn', { role: 'writer', route: 'worker', prompt: 'Create worker.txt.', workspace: 'isolated_worktree' });
    let result = api.host.call('agents.wait', { handle: writer.handle, consume: true });
    for (let attempt = 0; attempt < 5 && result.status === 'running'; attempt++) result = api.host.call('agents.wait', { handle: writer.handle, consume: true });
    const integrated = api.host.call('workspace.integrate', { handle: writer.handle });
    return { status: result.status, changed: result.changed_paths ?? [], integrated: integrated.status,
      paths: integrated.changed_paths ?? [], receipt_error: integrated.receipt_error ?? null };
  });
}
'''


def package(root, name, capabilities, source):
    directory = root / name
    directory.mkdir()
    (directory / 'index.ts').write_text(source)
    (directory / 'mod.json').write_text(json.dumps({'schema': 1, 'id': name, 'version': '1.0.0', 'api': API, 'state_version': 1,
        'license': 'Apache-2.0', 'provenance': {'maintainer': 'Fixture author', 'source': 'scripts/host_session_acceptance.py'},
        'capabilities': capabilities}, indent=2))
    return directory


def install(manager, store, directory):
    inspected = json.loads(run([manager, 'inspect', directory], store.parent))
    run([manager, 'trust', store, directory, inspected['sha256'], ','.join(inspected['manifest']['capabilities'])], store.parent)
    run([manager, 'enable', store, directory], store.parent)


def item(payload, text):
    return any(record.get('type') == 'message' and record.get('role') == 'assistant'
               and any(part.get('text') == text for part in record.get('content', [])) for record in payload.get('input', []))


def outputs(payload):
    return {record['call_id']: record['output'] for record in payload.get('input', []) if record.get('type') == 'function_call_output'}


def tool(payload, name, call_id):
    def find(specs, namespace=''):
        for spec in specs:
            if spec.get('type') == 'namespace':
                found = find(spec.get('tools', []), spec['name'])
                if found:
                    return found
            elif spec.get('name') == name:
                return spec, spec.get('namespace', namespace)
        return None
    specs = payload.get('tools', []) + [spec for record in payload.get('input', [])
                                        if record.get('type') in ['additional_tools', 'tool_search_output'] for spec in record.get('tools', [])]
    found = find(specs)
    if not found:
        return {'type': 'tool_search_call', 'call_id': f'discover-{call_id}', 'execution': 'client', 'arguments': {'query': name}}
    spec, namespace = found
    return {'type': 'function_call', 'id': call_id, 'call_id': call_id, 'namespace': namespace, 'name': spec['name'], 'arguments': '{}'}


def message(text):
    return {'type': 'message', 'id': f'msg-{abs(hash(text))}', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': text}]}


class Provider:
    def __init__(self, root):
        self.root = root
        self.requests = []
        self.upgrades = []
        self.errors = []
        self.script = None
        provider = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                provider.upgrades.append(self.path)
                self.send_error(404)

            def do_POST(self):
                try:
                    payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    provider.requests.append(payload)
                    (provider.root / f'request-{len(provider.requests):02d}.json').write_text(json.dumps(payload, indent=2))
                    output = provider.script(payload)
                    events = [{'type': 'response.created', 'response': {'id': f'fixture-{len(provider.requests)}'}},
                              {'type': 'response.output_item.done', 'output_index': 0, 'item': output},
                              {'type': 'response.completed', 'response': {'id': f'fixture-{len(provider.requests)}', 'output': [output],
                                  'usage': {'input_tokens': 100, 'output_tokens': 10, 'total_tokens': 110,
                                            'input_tokens_details': {'cached_tokens': 0}, 'output_tokens_details': {'reasoning_tokens': 0}}}}]
                    encoded = ''.join(f'data: {json.dumps(event)}\n\n' for event in events).encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.send_header('Content-Length', str(len(encoded)))
                    self.end_headers()
                    self.wfile.write(encoded)
                except Exception as error:
                    provider.errors.append(f'request {len(provider.requests)}: {error!r}')
                    self.send_error(500, str(error)[:128])

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.server.server_port}/v1'


class AppServer:
    def __init__(self, codex, env, cwd, log):
        self.process = subprocess.Popen([str(codex), 'app-server'], cwd=cwd, env=env, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=log, text=True)
        self.messages = queue.Queue()
        self.next = 0
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        for line in self.process.stdout:
            self.messages.put(json.loads(line))
        self.messages.put(None)

    def send(self, value):
        self.process.stdin.write(json.dumps(value) + '\n')
        self.process.stdin.flush()

    def wait(self, accept, timeout=120):
        while True:
            value = self.messages.get(timeout=timeout)
            if value is None:
                raise RuntimeError('app-server exited')
            if 'method' in value and 'id' in value:
                raise RuntimeError(f'unexpected server request: {value}')
            if accept(value):
                return value

    def request(self, method, params):
        self.next += 1
        self.send({'id': self.next, 'method': method, 'params': params})
        reply = self.wait(lambda value: value.get('id') == self.next)
        if 'error' in reply:
            raise RuntimeError(f'{method}: {reply["error"]}')
        return reply['result']

    def turn(self, thread, text):
        self.request('turn/start', {'threadId': thread, 'input': [{'type': 'text', 'text': text}]})
        return self.wait(lambda value: value.get('method') == 'turn/completed')['params']

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            self.process.kill()


def configure(root, home, provider, websockets):
    template = json.loads((ROOT / 'mods/first-party/omd_claude_cli/models.json').read_text())['models'][0]
    catalog = root / 'models.json'
    catalog.write_text(json.dumps({'models': [{**template, 'slug': 'fixture-lead', 'display_name': 'fixture-lead', 'tool_mode': 'direct',
                                               'supports_search_tool': True, 'prefer_websockets': websockets}]}))
    home.mkdir(exist_ok=True)
    (home / 'config.toml').write_text('\n'.join([
        f'model_catalog_json={json.dumps(str(catalog))}', 'model="fixture-lead"', 'model_provider="fixture"', 'model_reasoning_effort="low"',
        'web_search="disabled"', 'approval_policy="never"', 'sandbox_mode="workspace-write"',
        '[features]', 'shell_snapshot=false', 'code_mode=false', 'code_mode_only=false', 'code_mode_host=false', 'plugins=false',
        '[model_providers.fixture]', 'name="Local fixture"', f'base_url={json.dumps(provider.url)}', 'wire_api="responses"',
        'env_key="OMD_FIXTURE_TOKEN"', f'supports_websockets={str(websockets).lower()}', 'request_max_retries=0', 'stream_max_retries=0',
        f'[projects.{json.dumps(str(root / "repository"))}]', 'trust_level="trusted"']))


def environment(root, home, mode, store):
    env = {'PATH': os.environ['PATH'], 'HOME': str(root / 'home'), 'TMPDIR': str(root), 'CODEX_HOME': str(home),
           'CODEX_SQLITE_HOME': str(root / 'sqlite'), 'OMD_MODE': mode, 'OMD_FIXTURE_TOKEN': 'local-fixture-not-a-real-key', 'RUST_LOG': 'warn'}
    if store:
        env['OMD_MOD_STORE'] = str(store)
    return env


def observed(store):
    captures = [json.loads(path.read_text()) for path in (store / 'sessions').glob('*/task-cost.json')]
    return sum(len(capture['observed']) for capture in captures)


def disabled_overhead(root, codex, manager, provider):
    provider.script = lambda payload: message('DIRECT_OK')
    shapes = {}
    for mode in ['upstream_direct', 'omd']:
        home = root / f'codex-home-{mode}'
        configure(root, home, provider, websockets=False)
        store = None
        if mode == 'omd':
            store = root / 'empty-store'
            run([manager, 'init', store, shutil.which('node')], root)
        first = len(provider.requests)
        result = subprocess.run([str(codex), 'exec', '--skip-git-repo-check', '--json', '-C', str(root / 'repository'), 'Say hello.'],
                                cwd=root / 'repository', env=environment(root, home, mode, store), stdin=subprocess.DEVNULL,
                                text=True, capture_output=True, timeout=90)
        (root / f'exec-{mode}.log').write_text(result.stdout + result.stderr)
        assert result.returncode == 0 and 'DIRECT_OK' in result.stdout, result.stderr[-3000:]
        requests = provider.requests[first:]
        assert len(requests) == 1, len(requests)
        payload = requests[0]
        shapes[mode] = {'instructions': payload.get('instructions'), 'tools': sorted(spec.get('name', spec.get('type')) for spec in payload.get('tools', [])),
                        'input': [(record.get('type'), record.get('role')) for record in payload.get('input', [])]}
        if store:
            assert observed(store) == 1, observed(store)
            assert not any((store / name).exists() for name in ['data', 'resources', 'backups']), sorted(path.name for path in store.iterdir())
    assert shapes['omd'] == shapes['upstream_direct'], json.dumps(shapes, indent=2)
    return {'requests': 2, 'identical_request_shape': True, 'zero_mod_observed_requests': 1}


def session(root, codex, manager, contract, cli, provider):
    store = root / 'store'
    run([manager, 'init', store, shutil.which('node')], root)
    gate = package(root, 'probe_gate', ['contracts', 'middleware'], GATE)
    probe = package(root, 'probe', ['contracts', 'exec', 'fs.read', 'fs.write', 'lifecycle', 'store', 'tools'], PROBE)
    install(manager, store, gate)
    install(manager, store, probe)
    repository = root / 'repository'
    run([contract, 'select', store, repository, 'probe_gate@1'], root)
    home = root / 'codex-home-session'
    configure(root, home, provider, websockets=True)
    results = {}
    phase = {'turn': 1}
    first = len(provider.requests)

    def script(payload):
        index = len(provider.requests) - first
        done = outputs(payload)
        text = json.dumps(payload.get('input', []))
        if index == 1:
            return message('RETRY_ME one')
        if phase['turn'] == 1:
            if 'check' not in done:
                if index == 2:
                    assert item(payload, 'RETRY_ME one'), 'stopped output missing from retry input'
                    assert 'A mod stopped the previous response item (probe marker).' in text and 'PROBE_INJECTED_RETRY' in text
                return tool(payload, 'mod_probe_check', 'check')
            if 'store' not in done:
                results['check'] = json.loads(done['check'])
                return tool(payload, 'mod_probe_store_check', 'store')
            if 'store' not in results:
                results['store'] = json.loads(done['store'])
                return message('RETRY_ME two')
            assert 'third_stop' not in results, 'third stop was retried'
            results['second_retry'] = item(payload, 'RETRY_ME two') and text.count('PROBE_INJECTED_RETRY') == 2
            results['third_stop'] = index
            return message('RETRY_ME three')
        if phase['turn'] == 2:
            if 'withdrawn' not in done:
                results['stopped_preserved'] = item(payload, 'RETRY_ME three') and text.count('A mod stopped the previous response item') == 3
                return tool(payload, 'mod_probe_complete', 'withdrawn')
            results['withdrawn'] = json.loads(done['withdrawn'])
            return message('RETRY_ME four')
        if phase['turn'] == 3:
            if 'restored' not in done:
                return tool(payload, 'mod_probe_complete', 'restored')
            results['restored'] = json.loads(done['restored'])
            return message('SESSION_DONE')
        raise AssertionError(f'unexpected request {index}')

    provider.script = script
    with (root / 'app-server.log').open('w') as log:
        server = AppServer(codex, environment(root, home, 'omd', store), repository, log)
        try:
            server.request('initialize', {'clientInfo': {'name': 'omd_host_session', 'version': '0'}})
            server.send({'method': 'initialized'})
            thread = server.request('thread/start', {'cwd': str(repository)})['thread']['id']
            results['turn1'] = server.turn(thread, 'Run the host probe.')['turn']['status']
            results['turn1_requests'] = len(provider.requests) - first
            run([manager, 'disable', store, gate], root)
            phase['turn'] = 2
            results['turn2'] = server.turn(thread, 'Complete after the gate mod is disabled.')['turn']['status']
            results['turn2_requests'] = len(provider.requests) - first - results['turn1_requests']
            run([manager, 'enable', store, gate], root)
            phase['turn'] = 3
            results['turn3'] = server.turn(thread, 'Complete after the gate mod is enabled again.')['turn']['status']
        finally:
            server.close()
    check = results['check']
    assert check['denied'] == 'capability_denied: network', check
    assert check['slow'] is True and check['detached']['timed_out'] is True and check['detached']['duration_ms'] < 3000, check
    assert check['wide'] == {'preview': 65536, 'bytes': 100000, 'truncated': False, 'preview_truncated': True}, check
    assert check['write'] == 0 and check['fingerprint'] is True and check['refused'] == 'refused' and check['missing'] and check['completed'] == 'completed', check
    assert results['store']['big'] == 'store_value_limit' and results['store']['stale'].startswith('store_revision_conflict'), results['store']
    assert results['second_retry'] and results['turn1_requests'] == results['third_stop'], results
    assert results['stopped_preserved'] and results['turn2'] == 'completed', results
    assert results['withdrawn']['status'] == 'unavailable' and results['withdrawn']['reason'] == 'contract_withdrawn', results['withdrawn']
    assert results['withdrawn']['completion'] == 'contract_unavailable', results['withdrawn']
    assert results['restored'] == {'status': 'active', 'reason': None, 'completion': 'completed'}, results['restored']
    assert not provider.upgrades, provider.upgrades
    requests = len(provider.requests) - first
    assert observed(store) == requests, (observed(store), requests)
    exported = json.loads(run([cli, 'store', 'export', '--mod', 'probe', '--repo', repository, '--store', store], root))
    changes = exported['entries']['changes']['value']
    assert [(change['source'], change['paths']) for change in changes] == [('transaction', ['event.txt']), ('tool', ['tool.txt'])], changes
    assert changes[0]['call_id'] is None and changes[1]['call_id'] == 'check', changes
    reset = json.loads(run([cli, 'store', 'reset', '--mod', 'probe', '--repo', repository, '--store', store], root))
    after = json.loads(run([cli, 'store', 'export', '--mod', 'probe', '--repo', repository, '--store', store], root))
    assert not after['entries'] and after['generation'] == reset['generation'], after
    return {'requests': requests, 'turns': [results['turn1'], results['turn2'], results['turn3']], 'check': check, 'store': results['store'],
            'withdrawn': results['withdrawn'], 'restored': results['restored'], 'workspace_changes': changes, 'websocket_attempts': 0,
            'observed_requests': requests}


def agents(root, codex, manager, provider):
    store = root / 'agent-store'
    run([manager, 'init', store, shutil.which('node')], root)
    install(manager, store, package(root, 'agent_probe', ['agents', 'fs.read', 'fs.write', 'tools'], AGENT_PROBE))
    repository = (root / 'repository').resolve()
    url = f'{provider.url}/responses'
    grant = root / 'worker-grant.json'
    grant.write_text(json.dumps({'schema': 1, 'paid_api_key': True, 'revocable': True, 'provider': 'fixture', 'model': 'fixture-lead',
                                 'responses_url': url, 'repository': hashlib.sha256(str(repository).encode()).hexdigest()}))
    (store / 'host.json').write_text(json.dumps({'schema': 1,
        'limits': {'requests': 40, 'exposure_microusd': 100000, 'seconds': 600, 'concurrent_workers': 4, 'max_depth': 2},
        'worker_limits': {'requests': 10, 'exposure_microusd': 50000, 'seconds': 300},
        'routes': [{'name': 'worker', 'provider': 'fixture', 'model': 'fixture-lead', 'reasoning_effort': 'low', 'responses_url': url,
                    'rates': {'input_microusd_per_million': 1, 'cached_microusd_per_million': 1, 'output_microusd_per_million': 1,
                              'reservation_microusd': 1000, 'max_output_tokens': 1000, 'input_token_ceiling': 100000, 'included_subscription': False},
                    'roles': ['worker'], 'mods': ['agent_probe'], 'grant': {'path': str(grant.resolve()), 'sha256': hashlib.sha256(grant.read_bytes()).hexdigest()}}]}))
    home = root / 'codex-home-agents'
    configure(root, home, provider, websockets=False)
    first = len(provider.requests)
    workers = []

    def script(payload):
        context = (payload.get('instructions') or '') + json.dumps(payload.get('input', []))
        done = outputs(payload)
        if 'Perform this bounded read-only role: probe.' in context:
            workers.append(payload)
            return message('WORKER_OK')
        if 'Perform this bounded isolated-worktree role: writer.' in context:
            workers.append(payload)
            if 'write' not in done:
                return {'type': 'function_call', 'id': 'write', 'call_id': 'write', 'name': 'exec_command',
                        'arguments': json.dumps({'cmd': 'printf worker > worker.txt'})}
            return message('WRITER_DONE')
        if 'agents' not in done:
            return tool(payload, 'mod_agent_probe_run', 'agents')
        if 'integrate' not in done:
            return tool(payload, 'mod_agent_probe_integrate', 'integrate')
        return message(f'AGENTS_DONE {done["agents"]}')

    provider.script = script
    result = subprocess.run([str(codex), 'exec', '--skip-git-repo-check', '--json', '-C', str(repository), 'Run the agent probe.'],
                            cwd=repository, env=environment(root, home, 'omd', store), stdin=subprocess.DEVNULL,
                            text=True, capture_output=True, timeout=180)
    (root / 'exec-agents.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0 and 'AGENTS_DONE' in result.stdout, result.stdout[-3000:] + result.stderr[-3000:]
    probe = next(json.loads(done['agents']) for payload in provider.requests[first:] for done in [outputs(payload)] if 'agents' in done)
    assert probe == {'listed': True, 'cancelled': True, 'status': 'completed', 'text': 'WORKER_OK', 'consumed': True,
                     'remaining': [[True, True]], 'gone': 'unknown_or_foreign_agent'}, probe
    integration = next(json.loads(done['integrate']) for payload in provider.requests[first:] for done in [outputs(payload)] if 'integrate' in done)
    assert integration == {'status': 'completed', 'changed': ['worker.txt'], 'integrated': 'integrated', 'paths': ['worker.txt'],
                           'receipt_error': None}, integration
    assert (repository / 'worker.txt').read_text() == 'worker', 'integrated file missing'
    return {'requests': len(provider.requests) - first, 'worker_requests': len(workers), 'probe': probe, 'integration': integration}


def main():
    parser = argparse.ArgumentParser(description='Deterministic OMD host session checks against a local mock provider.')
    parser.add_argument('--binary', type=Path, required=True, help='patched codex binary; omd, omd-mod and omd-contract must be beside it')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    codex = args.binary.resolve(strict=True)
    manager, contract, cli = (codex.parent / name for name in ['omd-mod', 'omd-contract', 'omd'])
    repository = root / 'repository'
    repository.mkdir()
    (repository / 'source.txt').write_text('source\n')
    run(['git', 'init', '-q', repository], root)
    run(['git', 'add', 'source.txt'], repository)
    run(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'Fixture'], repository)
    for name in ['home', 'sqlite']:
        (root / name).mkdir()
    provider = Provider(root)
    try:
        result = {'disabled_overhead': disabled_overhead(root, codex, manager, provider),
                  'session': session(root, codex, manager, contract, cli, provider),
                  'agents': agents(root, codex, manager, provider), 'paid_requests': 0}
    finally:
        provider.server.shutdown()
        (root / 'provider-errors.json').write_text(json.dumps(provider.errors, indent=2))
    assert not provider.errors, provider.errors
    (root / 'result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()

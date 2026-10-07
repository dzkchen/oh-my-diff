#!/usr/bin/env python3
import argparse
import hashlib
import json
import re
import shutil
import struct
import subprocess
import zlib
from pathlib import Path

import host_session_acceptance as h

ROOT = Path(__file__).resolve().parents[1]
TOKEN = 'gh' + 'p_' + 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zC8'
PASSWORD = 'fixture-pass-42'
ENV_VALUE = 'fixture-env-value-42'
PLACEHOLDER = re.compile(r'\[REDACTED:([a-z_]+):([a-z2-7]{12,52})\]')
PROBE = '''const empty = { type: 'object', properties: {}, additionalProperties: false };
export default function activate(api) {
  api.tool({ name: 'complete', description: 'Run a completion', parameters: empty }, () => {
    const done = api.host.call('model.complete', { route: 'worker', prompt: 'COMPLETE %s' });
    return { status: done.status, text: done.text };
  });
}
''' % TOKEN


def pixel():
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 2, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(b'\x00' + b'\xff\x00\x00' * 2 + b'\x00' + b'\x00\x00\xff' * 2)) + chunk(b'IEND', b''))


def text(payload):
    return json.dumps(payload)


def leaked(payloads):
    return [value for value in [TOKEN, PASSWORD, ENV_VALUE] if any(value in text(payload) for payload in payloads)]


def main():
    parser = argparse.ArgumentParser(description='Offline omd_privacy acceptance through the real final-request stage against a local mock provider.')
    parser.add_argument('--binary', type=Path, required=True, help='patched codex binary; omd-mod must be beside it')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    codex = args.binary.resolve(strict=True)
    manager = codex.parent / 'omd-mod'
    repository = root / 'repository'
    repository.mkdir()
    (repository / 'source.txt').write_text('source\n')
    (repository / '.env').write_text(f'API_KEY={ENV_VALUE}\n')
    h.run(['git', 'init', '-q', repository], root)
    h.run(['git', 'add', 'source.txt'], repository)
    h.run(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'Fixture'], repository)
    (root / 'pixel.png').write_bytes(pixel())
    for name in ['home', 'sqlite']:
        (root / name).mkdir()
    provider = h.Provider(root)
    store = root / 'store'
    h.run([manager, 'init', store, shutil.which('node')], root)
    privacy = root / 'omd_privacy'
    shutil.copytree(ROOT / 'mods/first-party/omd_privacy', privacy, ignore=shutil.ignore_patterns('*.test.*'))
    h.install(manager, store, privacy)
    h.install(manager, store, h.package(root, 'worker_probe', ['agents', 'tools'], PROBE))
    url = f'{provider.url}/responses'
    grant = root / 'worker-grant.json'
    grant.write_text(json.dumps({'schema': 1, 'paid_api_key': True, 'revocable': True, 'provider': 'fixture', 'model': 'fixture-lead',
                                 'responses_url': url, 'repository': hashlib.sha256(str(repository.resolve()).encode()).hexdigest()}))
    (store / 'host.json').write_text(json.dumps({'schema': 1,
        'limits': {'requests': 60, 'exposure_microusd': 100000, 'seconds': 600, 'concurrent_workers': 4, 'max_depth': 2},
        'worker_limits': {'requests': 20, 'exposure_microusd': 50000, 'seconds': 300},
        'routes': [{'name': 'worker', 'provider': 'fixture', 'model': 'fixture-lead', 'reasoning_effort': 'low', 'responses_url': url,
                    'rates': {'input_microusd_per_million': 10000, 'cached_microusd_per_million': 1000, 'output_microusd_per_million': 20000,
                              'reservation_microusd': 10000, 'max_output_tokens': 1000, 'input_token_ceiling': 100000, 'included_subscription': False},
                    'roles': ['worker'], 'mods': ['worker_probe'],
                    'grant': {'path': str(grant.resolve()), 'sha256': hashlib.sha256(grant.read_bytes()).hexdigest()}}]}))
    home = root / 'codex-home'
    h.configure(root, home, provider, websockets=False)
    env = h.environment(root, home, 'omd', store)
    workers = []

    def script(payload):
        if 'bounded read-only role: completion' in text(payload):
            workers.append(payload)
            return h.message('WORKER_OK')
        done = h.outputs(payload)
        if 'PRIVACY_EXERCISE' in text(payload) and 'complete' not in done:
            return h.tool(payload, 'mod_worker_probe_complete', 'complete')
        if 'PRIVACY_EXERCISE' in text(payload) and 'env' not in done:
            return {'type': 'function_call', 'id': 'env', 'call_id': 'env', 'name': 'exec_command', 'arguments': json.dumps({'cmd': 'cat .env'})}
        return h.message('DONE')

    provider.script = script

    def exec_(name, prompt, *extra):
        before = len(provider.requests)
        result = subprocess.run([str(codex), 'exec', '--skip-git-repo-check', '--json', *extra, '-C', str(repository), prompt],
                                cwd=repository, env=env, stdin=subprocess.DEVNULL, text=True, capture_output=True, timeout=300)
        (root / f'exec-{name}.log').write_text(result.stdout + result.stderr)
        return result, provider.requests[before:]

    try:
        guarded, guarded_requests = exec_('guarded', f'Deploy with {TOKEN} and password = "{PASSWORD}". Run PRIVACY_EXERCISE.')
        filler = ''.join(f'line {index} of ordinary build output. ' for index in range(4000))
        paged, paged_requests = exec_('paged', f'{filler[:81899]} {TOKEN} {filler[:30000]}')
        h.run([manager, 'settings', store, privacy, json.dumps({'unscanned': 'deny'})], root)
        unscanned, unscanned_requests = exec_('unscanned', 'Describe the attached pixel.', '-i', str(root / 'pixel.png'))
        h.run([manager, 'settings', store, privacy, '{}'], root)
        with (privacy / 'index.ts').open('a') as source:
            source.write('\n')
        unavailable, unavailable_requests = exec_('unavailable', f'Plain {TOKEN} while the policy cannot load')
        (privacy / 'index.ts').write_text((ROOT / 'mods/first-party/omd_privacy/index.ts').read_text())
        h.run([manager, 'disable', store, privacy], root)
        disabled, disabled_requests = exec_('disabled', f'Plain {TOKEN} with the policy disabled')
    finally:
        provider.server.shutdown()
    assert not provider.errors, provider.errors
    assert guarded.returncode == 0, guarded.stdout[-3000:] + guarded.stderr[-3000:]
    assert guarded_requests and not leaked(guarded_requests), f'leaked to the provider: {leaked(guarded_requests)}'
    lead = [payload for payload in guarded_requests if payload not in workers]
    prompt_ids = {match.group(2) for payload in lead for match in PLACEHOLDER.finditer(text(payload)) if match.group(1) == 'github_token'}
    assert len(prompt_ids) == 1, f'the token was not one stable placeholder across lead requests: {prompt_ids}'
    assert all('[REDACTED:assigned_secret:' in text(payload) for payload in lead), 'the assigned password was not redacted'
    assert workers and all('COMPLETE [REDACTED:github_token:' in text(payload) for payload in workers), 'the worker completion was not redacted'
    env_output = next(output for payload in guarded_requests for call_id, output in h.outputs(payload).items() if call_id == 'env')
    assert 'approval request failed' in str(env_output), f'the sensitive-path read was not held for approval: {env_output}'
    assert 'DONE' in guarded.stdout, guarded.stdout[-2000:]
    assert paged.returncode == 0 and paged_requests and not leaked(paged_requests), paged.stdout[-2000:] + paged.stderr[-2000:]
    paged_prompt = next(part['text'] for item in paged_requests[0]['input'] if item.get('role') == 'user'
                        for part in item.get('content', []) if part.get('text', '').startswith('line 0 '))
    assert [match.group(1) for match in PLACEHOLDER.finditer(paged_prompt)] == ['github_token'], 'the split token was not one placeholder'
    assert PLACEHOLDER.sub('X', paged_prompt) == f'{filler[:81899]} X {filler[:30000]}', 'paging changed text outside the token'
    for name, result, requests, reason in [('unscanned', unscanned, unscanned_requests, 'unscanned image_url content'),
                                           ('unavailable', unavailable, unavailable_requests, 'request_policy_unavailable')]:
        output = result.stdout + result.stderr
        assert result.returncode != 0 and not requests, f'{name}: {len(requests)} requests, exit {result.returncode}'
        assert reason in output, f'{name}: {output[-2000:]}'
    assert any(TOKEN in text(payload) for payload in disabled_requests), 'the disabled policy still edited the request'
    staged = [(session / 'mod-middleware.jsonl').is_file() and 'final_request' in (session / 'mod-middleware.jsonl').read_text()
              for session in sorted((store / 'sessions').glob('0*'))]
    assert staged == [True, True, True, True, False], f'final-request stage records per session: {staged}'
    stored = [str(path.relative_to(store)) for path in store.rglob('*') if path.is_file()
              and any(value.encode() in path.read_bytes() for value in [TOKEN, PASSWORD, ENV_VALUE])]
    assert not stored, f'raw values in the mod store: {stored}'
    summary = {'guarded_requests': len(guarded_requests), 'worker_requests': len(workers), 'token_placeholders': len(prompt_ids),
               'paged_prompt_bytes': len(paged_prompt.encode()),
               'env_tool_output': str(env_output)[:300], 'unscanned_exit': unscanned.returncode, 'unavailable_exit': unavailable.returncode,
               'disabled_requests': len(disabled_requests), 'stage_records_per_session': staged, 'paid_requests': 0}
    (root / 'result.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()

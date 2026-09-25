#!/usr/bin/env python3
import json
from pathlib import Path
import sys

try:
    from scripts import preview_lock
except ModuleNotFoundError:
    import preview_lock


ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / 'runtime/claude-full.lock.json'
MOD = 'mods/first-party/omd_claude_cli'
FILES = ('mod.json', 'index.ts', 'models.json', 'setup.mjs', 'transport.mjs')
SOURCES = tuple(f'{MOD}/{name}' for name in FILES)


def build():
    base = ROOT / MOD
    manifest = json.loads((base / 'mod.json').read_text())
    api = json.loads((ROOT / 'mods/package.json').read_text())['version']
    if manifest['id'] != base.name or manifest['api'] != api:
        raise ValueError('Claude mod identity or API differs from release pin')
    return {
        'schema': 1,
        'cli_version': '2.1.281 (Claude Code)',
        'mod_api': api,
        'package': {
            'id': manifest['id'], 'version': manifest['version'],
            'extension_type': 'mod', 'capabilities': manifest['capabilities'],
            'source': MOD,
            'files': {name: preview_lock.digest(base / name) for name in FILES},
            'package_sha256': preview_lock.package_digest(base),
        },
    }


def load():
    return json.loads(LOCK.read_text())


def main():
    expected = json.dumps(build(), indent=2, sort_keys=True) + '\n'
    if '--write' in sys.argv[1:]:
        LOCK.write_text(expected)
        print(f'wrote {LOCK.relative_to(ROOT)}')
    elif LOCK.read_text() != expected:
        raise SystemExit('Claude Full lock differs from pinned sources')
    else:
        print('Claude Full lock matches pinned sources')


if __name__ == '__main__':
    main()

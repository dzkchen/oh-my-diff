import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const userCli = readFileSync(new URL('./pi_user_cli.mjs', import.meta.url), 'utf8');
const surface = { events: {}, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };
const sha = text => createHash('sha256').update(text).digest('hex');
const candidate = 'a'.repeat(64);
const review = '---\ndescription: Review a file\nargument-hint: <path> [mode]\n---\nReview $1 carefully\n$@\n';
const plain = `\n${'y'.repeat(70)}\nsecond line\n`;

function invoke(name, payload, receipts = [], event = 'tool') {
  const request = { source, filename: 'omd_project_pi_prompts.ts', api: '0.2.0-experimental.3', capabilities: ['tools', 'commands', 'fs.read'],
    environment: ['crypto'], state: null, settings: {}, event, name, payload, receipts, surface, hook_budget_ms: 3000 };
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], {
    input: JSON.stringify(request), encoding: 'utf8', timeout: 6000,
  });
  assert.ifError(result.error);
  assert.ok(result.stdout, result.stderr);
  return JSON.parse(result.stdout);
}

function fixture(files = {}) {
  let stale = false;
  let truncated = false;
  let hashStale = false;
  const calls = [];
  const entries = () => {
    const all = new Map();
    for (const [path, content] of Object.entries(files || {})) {
      const parts = path.split('/');
      for (let index = 1; index < parts.length; index++) all.set(parts.slice(0, index).join('/'), { kind: 'dir', size: 0 });
      all.set(path, { kind: content === null ? 'symlink' : 'file', size: content === null ? 0 : Buffer.byteLength(content) });
    }
    return all;
  };
  return {
    files, calls,
    set stale(value) { stale = value; },
    set truncated(value) { truncated = value; },
    set hashStale(value) { hashStale = value; },
    run(name, payload = {}, event = 'tool') {
      const receipts = [];
      for (let index = 0; index < 40; index++) {
        const output = invoke(name, payload, receipts, event);
        if (!output.host_call) return output;
        const call = output.host_call;
        calls.push(call);
        let value;
        if (['workspace.snapshot', 'workspace.fingerprint'].includes(call.operation)) {
          if (stale && call.arguments.expected) { receipts.push({ call, error: 'workspace_candidate_stale' }); continue; }
          value = { snapshot: { reference: 'fixture', sha256: candidate }, candidate_sha256: candidate };
        } else if (call.operation === 'workspace.stat') value = { files: Object.fromEntries(call.arguments.paths.map(path => {
          const entry = entries().get(path);
          return [path, entry ? { ...entry, mtime_ms: 1, ...(call.arguments.hash && entry.kind === 'file'
            ? { sha256: hashStale ? candidate : sha(files[path]) } : {}) } : null];
        })) };
        else if (call.operation === 'workspace.list') value = { entries: [...entries()].filter(([path]) => path.startsWith(`${call.arguments.path}/`)
          && (call.arguments.recursive || !path.slice(call.arguments.path.length + 1).includes('/')))
          .map(([path, entry]) => ({ path, ...entry, mtime_ms: 1 })), truncated };
        else if (call.operation === 'workspace.read') value = { files: Object.fromEntries(call.arguments.paths.map(path => [path,
          files[path] === undefined ? null : { text: files[path], sha256: sha(files[path]) }])) };
        else assert.fail(`unexpected operation ${call.operation}`);
        receipts.push({ call, value });
      }
      assert.fail('project Pi prompt mod did not finish');
    },
  };
}

test('project prompt discovery matches retained native frontmatter and fallback fixtures', () => {
  const f = fixture({ '.pi/prompts/review.md': review, '.pi/prompts/plain.md': plain });
  const result = f.run('discover');
  assert.equal(result.error, undefined, result.error);
  assert.deepEqual(result.value.resources.map(item => item.name), ['plain', 'review']);
  assert.equal(result.value.resources[0].description, `${'y'.repeat(60)}...`);
  assert.equal(result.value.resources[1].description, 'Review a file');
  assert.equal(result.value.resources[1].argument_hint, '<path> [mode]');
  assert.equal(result.value.resources[1].content, 'Review $1 carefully\n$@');
  assert.equal(result.value.resources[1].sha256, sha(review));
  assert.equal(f.calls.filter(call => call.operation === 'workspace.read').length, 1);
  assert.equal(f.run('expand', { name: 'review', args: '"src/main.rs" fast' }).value.text, 'Review src/main.rs carefully\nsrc/main.rs fast');
});

test('Pi slash command lists scoped prompts and submits exact expanded text', () => {
  const f = fixture({ '.pi/prompts/review.md': review });
  const listed = f.run('pi', '', 'command');
  assert.equal(listed.error, undefined, listed.error);
  assert.match(listed.value.display, /review \(project\): Review a file/);
  const expanded = f.run('pi', 'review "src/main.rs" fast', 'command');
  assert.equal(expanded.error, undefined, expanded.error);
  assert.deepEqual(expanded.value, { submit: 'Review src/main.rs carefully\nsrc/main.rs fast' });
  assert.match(f.run('pi', '../outside', 'command').error, /pi_command_invalid/);
});

test('argument substitution matches representative Pi 0.74 oracle cases', () => {
  const cases = [
    ['Review $1 then $2', 'a b', 'Review a then b'],
    ['All: $@ / $ARGUMENTS', 'one "two words" \'three\'', 'All: one two words three / one two words three'],
    ['Slice ${@:2} and ${@:1:2} and ${@:0} and ${@:3:0}', 'a b c d', 'Slice b c d and a b and a b c d and '],
    ['Missing $3 and $0 and $10', 'x y', 'Missing  and  and '],
    ['Money $$1 and ${@:x} and ${@:2:y}', 'p q r', 'Money $p and ${@:x} and ${@:2:y}'],
    ['Special $@', '$& $$ $` $\' tail', 'Special $@ $ Special  $ tail'],
    ['Nested ${@:1}', '"${@:2}" z', 'Nested ${@:2} z'],
    ['Tabs\t$1', 'a\tb  c', 'Tabs\ta'],
    ['Unclosed "quote $1', '"a b', 'Unclosed "quote a b'],
    ['Arguments $ARGUMENTS$@', '', 'Arguments '],
  ];
  for (const [template, args, expected] of cases) {
    const f = fixture({ '.pi/prompts/oracle.md': template });
    assert.equal(f.run('expand', { name: 'oracle', args }).value.text, expected);
  }
});

test('stale snapshots, truncated lists, symlinks, and malformed YAML fail closed or diagnose', () => {
  const f = fixture({ '.pi/prompts/review.md': review, '.pi/prompts/linked.md': null,
    '.pi/prompts/complex.md': '---\ndescription: valid\n  invalid continuation\n---\nBody' });
  const result = f.run('discover');
  assert.equal(result.error, undefined, result.error);
  assert.deepEqual(result.value.resources.map(item => item.name), ['review']);
  assert.deepEqual(result.value.diagnostics.map(item => item.error).sort(), ['pi_frontmatter_unsupported', 'pi_symlink_unsupported']);
  f.truncated = true;
  assert.match(f.run('discover').error, /pi_discovery_limit/);
  f.truncated = false;
  f.hashStale = true;
  assert.match(f.run('discover').error, /pi_source_stale/);
  f.hashStale = false;
  f.stale = true;
  assert.match(f.run('discover').error, /workspace_candidate_stale/);
  const missing = fixture(null).run('discover');
  assert.deepEqual(missing.value.resources, []);
  assert.match(f.run('expand', { name: '../outside', args: '' }).error, /pi_input_invalid/);
});

test('YAML block scalars preserve literal and folded prompt descriptions', () => {
  const f = fixture({ '.pi/prompts/literal.md': '---\ndescription: |-\n  Review the source\n  with care\n---\nBody',
    '.pi/prompts/folded.md': '---\ndescription: >-\n  Review the source\n  with care\n---\nBody' });
  const resources = f.run('discover').value.resources;
  assert.deepEqual(resources.map(item => [item.name, item.description]),
    [['folded', 'Review the source with care'], ['literal', 'Review the source\nwith care']]);
});

test('project skills match retained nested, ignored, root-file and description fixtures', () => {
  const skill = description => `---\ndescription: ${description}\n---\nBody\n`;
  const f = fixture({
    '.pi/skills/root.md': '---\nname: root-skill\ndescription: Root file\n---\n',
    '.pi/skills/group/alpha/SKILL.md': skill('Alpha skill'),
    '.pi/skills/group/alpha/nested/SKILL.md': skill('Hidden below a skill root'),
    '.pi/skills/group/ignored/SKILL.md': skill('Ignored by gitignore'),
    '.pi/skills/.gitignore': 'group/ignored/\n',
    '.pi/skills/group/.ignore': 'gamma\n',
    '.pi/skills/group/gamma/SKILL.md': skill('Ignored by nested ignore'),
    '.pi/skills/group/.hidden/SKILL.md': skill('Dot directory'),
    '.pi/skills/node_modules/pkg/SKILL.md': skill('Dependency'),
    '.pi/skills/group/beta/SKILL.md': 'No frontmatter\n',
    '.pi/skills/group/delta/SKILL.md': '---\nname: delta-renamed\ndescription: Delta\n---\n',
    '.pi/skills/group/deep/notes.md': skill('Not a root file'),
  });
  const result = f.run('discover');
  assert.equal(result.error, undefined, result.error);
  assert.deepEqual(result.value.resources.map(item => `${item.kind}/${item.name}`), ['skills/alpha', 'skills/delta-renamed', 'skills/root-skill']);
  assert.ok(result.value.diagnostics.some(item => item.error === 'pi_skill_description_required'));
  assert.equal(result.value.resources[0].content, skill('Alpha skill'));
  assert.equal(result.value.resources[0].sha256, sha(skill('Alpha skill')));
});

test('unsupported ignore syntax and changed skill hashes fail closed', () => {
  const files = { '.pi/skills/.gitignore': '[unsupported]\n', '.pi/skills/team/SKILL.md': '---\ndescription: Team\n---\n' };
  const f = fixture(files);
  assert.match(f.run('discover').error, /pi_ignore_pattern_unsupported/);
  files['.pi/skills/.gitignore'] = '!team\n';
  f.hashStale = true;
  assert.match(f.run('discover').error, /pi_source_stale/);
});

test('user-agent Pi prompts and skills are read from an explicit local directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-pi-user-'));
  try {
    mkdirSync(join(root, 'prompts'));
    mkdirSync(join(root, 'skills', 'review'), { recursive: true });
    writeFileSync(join(root, 'prompts', 'hello.md'), '---\ndescription: User greeting\n---\nHello $1\n');
    writeFileSync(join(root, 'skills', 'review', 'SKILL.md'), '---\ndescription: User review\n---\nReview it.\n');
    const run = (tool, input) => {
      const request = { tool, input, user_agent_dir: realpathSync(root) };
      const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '--eval', userCli, JSON.stringify(request)],
        { input: source, encoding: 'utf8', timeout: 6000 });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const discovered = run('discover', {});
    assert.deepEqual(discovered.resources.map(item => [item.kind, item.name, item.scope]),
      [['prompts', 'hello', 'user'], ['skills', 'review', 'user']]);
    assert.equal(discovered.resources[0].path, join(realpathSync(root), 'prompts', 'hello.md'));
    assert.match(discovered.user_source_digest, /^[0-9a-f]{64}$/);
    assert.equal(run('expand', { name: 'hello', args: 'world' }).text, 'Hello world');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

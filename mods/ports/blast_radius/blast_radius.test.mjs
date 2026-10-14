import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { assertShortCircuit, assertWrapped, calls, coreValue, hostOperations, intercept, runScenario } from '@oh-my-diff/mod-api/testing';

const skip = !process.env.OMD_MOD_BIN && 'needs the omd-mod engine in OMD_MOD_BIN';
const directory = fileURLToPath(new URL('.', import.meta.url));
const ran = { output: 'ran', success: true };
const exec = (stdout, exit_code = 0, stderr = '') => ({ exit_code, stdout, stderr });
const root = exec('/work/repo\n');
const accepted = { status: 'accepted', values: ['proceed'] };
const declined = { status: 'accepted', values: ['cancel'] };

function guard(cmd, operations, workdir) {
  const arguments_ = workdir ? { cmd, workdir } : { cmd };
  const input = { tool: 'exec_command', arguments: arguments_, call_id: 'call-1', thread_id: 'fixture', agent_id: null, schema: null, raw_arguments: JSON.stringify(arguments_), batch: null };
  const trace = runScenario(directory, hostOperations(operations), { steps: [intercept('tool', input, { core: [coreValue(ran)] })] });
  return { trace, chain: trace.steps[0].value, prompt: calls(trace, 'terminal.prompt')[0]?.arguments, execs: calls(trace, 'exec.run').map(call => call.arguments) };
}

test('commands that are not risky run without measuring or asking', { skip }, () => {
  for (const cmd of ['ls -la', 'git status', 'rm file.txt', 'git push origin main', 'git checkout -b topic', 'git restore --staged .', 'cat migrate.sql']) {
    const { trace, chain } = guard(cmd, {});
    assertWrapped(chain, 'blast_radius');
    assert.deepEqual(trace.host_calls, [], cmd);
  }
});

test('rm -rf is measured and holds until the user accepts', { skip }, () => {
  const { trace, chain, prompt, execs } = guard('rm -rf build', {
    'exec.run': [root, exec('3 24 1\n./build/a.o\n./build/b.o\n./build/c.o\n')],
    'terminal.prompt': [accepted],
  });
  assertWrapped(chain, 'blast_radius');
  assert.deepEqual(execs.map(call => call.program), ['pwd', 'bash']);
  assert.equal(execs[1].cwd, undefined);
  assert.deepEqual(execs[1].argv.slice(-2), ['blast-radius', 'build']);
  assert.equal(prompt.kind, 'choice');
  assert.deepEqual(prompt.options.map(option => option.label), ['Proceed', 'Cancel']);
  assert.match(prompt.message, /^Command: rm -rf build · Would delete 3 files \(about 24 KB\) · Paths: build · build\/a\.o, build\/b\.o, build\/c\.o$/);
  assert.deepEqual(trace.unused_mock_replies, []);
});

test('declining denies the call with the measured summary and never reaches the tool', { skip }, () => {
  const { chain } = guard('rm -rf build', { 'exec.run': [root, exec('3 24 1\n./build/a.o\n')], 'terminal.prompt': [declined] });
  assertShortCircuit(chain, 'blast_radius');
  assert.match(chain.result.deny, /did not run it: the user pressed Cancel\. It would have: delete 3 files/);
});

test('a prompt that cannot be asked denies', { skip }, () => {
  const { chain } = guard('git clean -fd', { 'exec.run': [root, exec('')], 'terminal.prompt': [{ error: 'client_surface_unavailable' }] });
  assertShortCircuit(chain, 'blast_radius');
  assert.match(chain.result.deny, /the question could not be asked/);
});

test('a failed measurement still asks and says so', { skip }, () => {
  const { chain, prompt } = guard('git reset --hard', { 'exec.run': [root, exec('', 128, 'fatal: not a git repository')], 'terminal.prompt': [accepted] });
  assertWrapped(chain, 'blast_radius');
  assert.match(prompt.message, /git reset --hard \(could not measure it\) · Could not measure: fatal: not a git repository/);
});

test('cd and git -C move where the measurement runs', { skip }, () => {
  const { chain, prompt, execs } = guard('cd app && git -C pkg reset --hard', {
    'exec.run': [root, exec('M  src/a.ts\n M src/b.ts\n?? new.txt\n'), exec(' 2 files changed, 3 insertions(+), 1 deletion(-)\n')],
    'terminal.prompt': [accepted],
  });
  assertWrapped(chain, 'blast_radius');
  assert.deepEqual(execs.slice(1).map(call => [call.program, call.cwd]), [['env', 'app/pkg'], ['env', 'app/pkg']]);
  assert.match(prompt.message, /discard uncommitted changes in 2 files/);
  assert.match(prompt.message, /M {2}src\/a\.ts, M src\/b\.ts/);
  assert.doesNotMatch(prompt.message, /new\.txt/);
});

test('a folder outside the repository is not measured', { skip }, () => {
  const { chain, prompt, execs } = guard('cd /etc && rm -rf old', { 'exec.run': [root], 'terminal.prompt': [accepted] });
  assertWrapped(chain, 'blast_radius');
  assert.equal(execs.length, 1);
  assert.match(prompt.message, /Could not measure: \/etc is outside the repository/);
});

test('home and shell-expanded paths are reported as unmeasurable instead of as empty', { skip }, () => {
  for (const cmd of ['rm -rf ~/cache', 'rm -rf $HOME/cache']) {
    const { prompt, execs } = guard(cmd, { 'exec.run': [root], 'terminal.prompt': [declined] });
    assert.equal(execs.length, 1, cmd);
    assert.match(prompt.message, /Could not measure: a path uses ~ or a shell expansion/, cmd);
  }
});

test('a force-push lists the commits it would drop', { skip }, () => {
  const { chain, prompt, execs } = guard('git push --force origin feature', {
    'exec.run': [root, exec(''), exec('abc123 first\ndef456 second\n')],
    'terminal.prompt': [accepted],
  });
  assertWrapped(chain, 'blast_radius');
  assert.deepEqual(execs[2].argv.slice(-5), ['log', '--oneline', '--no-decorate', '--end-of-options', 'feature..origin/feature']);
  assert.match(prompt.message, /force-push to origin\/feature: drops 2 commits · .* · abc123 first, def456 second/);
});

test('git clean is dry-run with the user flags but never -f', { skip }, () => {
  const { prompt, execs } = guard('git clean -fdx -e keep', {
    'exec.run': [root, exec('Would remove tmp/\nWould remove out.log\n')],
    'terminal.prompt': [declined],
  });
  assert.deepEqual(execs[1].argv.slice(-6), ['clean', '-n', '-dx', '-e', 'keep', '--']);
  assert.deepEqual([execs[1].program, ...execs[1].argv.slice(0, 2)], ['env', 'LC_ALL=C', 'git'], 'git output is parsed in the C locale');
  assert.match(prompt.message, /remove 2 untracked paths · .* · tmp\/, out\.log/);
});

test('git checkout . and git restore . measure only the current folder', { skip }, () => {
  for (const cmd of ['cd app && git checkout .', 'cd app && git restore .']) {
    const { execs } = guard(cmd, { 'exec.run': [root, exec(' M a.ts\n'), exec('')], 'terminal.prompt': [declined] });
    assert.deepEqual(execs.slice(1).map(call => [call.cwd, ...call.argv.slice(-2)]), [['app', '--', '.'], ['app', '--', '.']], cmd);
  }
});

test('a refspec source cannot become a git option', { skip }, () => {
  const { prompt, execs } = guard('git push origin +--output=x:main', { 'exec.run': [root, exec('')], 'terminal.prompt': [declined] });
  assert.ok(execs.every(call => !call.argv.some(word => word.startsWith('--output'))), JSON.stringify(execs));
  assert.match(prompt.message, /could not measure it/);
});

test('prisma migrations are listed with the runner the command used', { skip }, () => {
  for (const [cmd, program, argv] of [['npx prisma migrate deploy', 'npx', ['prisma', 'migrate', 'status']], ['yarn prisma migrate dev', 'yarn', ['prisma', 'migrate', 'status']],
    ['pnpm exec prisma migrate deploy', 'pnpm', ['exec', 'prisma', 'migrate', 'status']]]) {
    const { execs } = guard(cmd, { 'exec.run': [root, exec('')], 'terminal.prompt': [declined] });
    assert.deepEqual([execs[1].program, execs[1].argv], [program, argv], cmd);
  }
});

test('pending migrations are listed from the tool status', { skip }, () => {
  const { prompt, execs } = guard('python3 manage.py migrate', {
    'exec.run': [root, exec('[X]  app.0001\n[ ]  app.0002\n[ ]  app.0003\n')],
    'terminal.prompt': [declined],
  });
  assert.deepEqual(execs[1].argv, ['manage.py', 'showmigrations', '--plan']);
  assert.match(prompt.message, /apply 2 pending migrations · .* · app\.0002, app\.0003/);
});

test('nice and popd are looked through', { skip }, () => {
  for (const cmd of ['nice -n 5 rm -rf build', 'pushd sub && popd && rm -rf build']) {
    const { prompt, execs } = guard(cmd, { 'exec.run': [root, exec('3 24 1\n./build/a.o\n')], 'terminal.prompt': [declined] });
    assert.match(prompt.message, /Would delete 3 files/, cmd);
    assert.equal(execs[1].cwd, undefined, cmd);
  }
});

import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

const [runnerPath, mode = 'once', count = '30', cache = 'cached', workload = 'command', compilation = 'lazy', prewarm = 'none', preparation = 'none'] = process.argv.slice(2);
if (!runnerPath || !['once', 'reuse', 'serve', 'v8'].includes(mode) || !['command', 'render'].includes(workload) || ['serve', 'v8'].includes(mode) && workload !== 'render') throw new Error('usage: node runner_latency.mjs RUNNER once|reuse|serve|v8 [REPEATS] [cached|uncached|all] [command|render] [lazy|eager|paired] [none|icu] [none|inspect]');
if (!Number.isSafeInteger(Number(count)) || Number(count) < 1 || !['cached', 'uncached', 'all'].includes(cache)) throw new Error('positive repeats and cached|uncached|all required');
if (!['lazy', 'eager', 'paired'].includes(compilation) || mode === 'v8' && compilation !== 'lazy') throw new Error('compilation must be lazy|eager|paired; eager applies only to Node');
if (compilation === 'paired' && (mode !== 'reuse' || preparation !== 'inspect')) throw new Error('paired compilation requires reuse and inspect preparation');
if (!['none', 'icu'].includes(prewarm)) throw new Error('prewarm must be none|icu');
if (!['none', 'inspect'].includes(preparation) || preparation === 'inspect' && (workload !== 'command' || mode !== 'reuse')) throw new Error('preparation must be none|inspect; inspect requires reused command mode');
let runner = mode === 'v8' ? '' : readFileSync(runnerPath, 'utf8').replace('let input = Buffer.alloc(0);', 'process.stdout.write("{\\"ready\\":true}\\n"); let input = Buffer.alloc(0);');
if (prewarm === 'icu') runner = runner.replace("stripTypeScriptTypes('let ready: boolean;');", "stripTypeScriptTypes('let ready: boolean;'); 'a'.localeCompare('b');");
if (mode !== 'v8' && !runner.includes('process.stdout.write("{\\"ready\\":true}\\n");')) throw new Error('runner readiness instrumentation did not match');
if (cache === 'all' && !runner.includes('const request = JSON.parse(${JSON.stringify(JSON.stringify(request))});')) throw new Error('all transformation requires the preserved partial-cache prototype');
if (cache === 'uncached' && !runner.includes('function moduleFor(source, context, identifier, typescript = true) {')) throw new Error('uncached transformation did not match');
if (cache === 'uncached') runner = runner.replace('function moduleFor(source, context, identifier, typescript = true) {',
  'function moduleFor(source, context, identifier, typescript = true) { return new SourceTextModule(typescript ? stripTypeScriptTypes(source) : source, {context, identifier});');
if (cache === 'all') runner = runner
  .replace('const globals = Object.create(null);', 'const globals = Object.create(null); globals.__request = JSON.stringify(request);')
  .replace('const request = JSON.parse(${JSON.stringify(JSON.stringify(request))});', 'const request = JSON.parse(globalThis.__request); delete globalThis.__request;')
  .replace('new SourceTextModule(bootstrap, { context })', "moduleFor(bootstrap, context, 'bootstrap', false)")
  .replace('const dispatch = new SourceTextModule(`', 'const dispatch = moduleFor(`')
  .replace('`, { context });\n  await dispatch.link', "`, context, 'dispatch', false);\n  await dispatch.link");
if (mode === 'reuse') runner = runner.replace('let input = Buffer.alloc(0);', 'let completed = 0; let input = Buffer.alloc(0);')
  .replace('await evaluate(request);', 'await evaluate(request); if (++completed % 1000 === 0) writeSync(2, JSON.stringify({completed, ...process.memoryUsage()}) + "\\n");');
const source = readFileSync(new URL('../mods/first-party/omd_mods/index.ts', import.meta.url), 'utf8');
const node = realpathSync(mode === 'v8' ? runnerPath : process.execPath);
const literal = JSON.stringify(node);
const profile = `(version 1)(deny default)(allow process-exec (literal ${literal}))(allow process-info* (target self))(allow sysctl-read)(allow signal (target self))(allow file-read* (literal "/")(literal ${literal})(subpath "/System/Library")(subpath "/usr/lib")(literal "/dev/null")(literal "/dev/urandom")(literal "/dev/random"))(allow file-write* (literal "/dev/null"))`;
const request = { source, filename: '/fixture/index.ts', api: '0.2.0-experimental.5', capabilities: ['commands', 'packages', 'store', 'terminal'],
  settings: {}, state: null, surface: { events: { terminal: 'terminal', component_event: 'terminal' }, replacements: [], middleware: [], state: 'store', contracts: 'contracts' },
  hook_budget_ms: 2000, receipts: [], event: 'command', name: 'mods', payload: '', interactive: true, reuse: mode === 'reuse' };
if (workload === 'render') Object.assign(request, {
  source: "export default api => api.intercept('render', () => ({text: 'render-marker'}));",
  capabilities: ['terminal'], surface: {...request.surface, intercept: {render: 'terminal'}},
  event: 'intercept', name: '0', payload: {surface: 'render', input: {text: 'render-marker'}, original: {}, origin: {caller: 'engine'}}, serve: mode === 'serve'
});
if (mode === 'v8') request.source = "JSON.stringify({value:{result:{text:'render-marker'}}})";

async function boot(compile = compilation) {
  const started = performance.now();
  const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, node, ...(mode === 'v8' ? [] : ['--max-old-space-size=64', '--no-compilation-cache', ...(compile === 'eager' ? ['--no-lazy'] : []), '--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner])],
    { cwd: '/', env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', data => { errors = (errors + data).slice(0, 16000); });
  const iterator = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const first = await iterator.next();
    if (first.done || !JSON.parse(first.value).ready) throw new Error(`runner failed to boot: ${errors}`);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return { child, iterator, bootMs: performance.now() - started, errors: () => errors };
}

async function invoke(worker, event = request.event) {
  worker.child.stdin.write(JSON.stringify({ ...request, event }) + '\n');
  for (;;) {
    const { value, done } = await worker.iterator.next();
    if (done) throw new Error(`runner exited: ${worker.errors()}`);
    const frame = JSON.parse(value);
    if (!frame.call) {
      if (frame.error || (event === 'inspect' ? !frame.registrations?.commands?.length : workload === 'command' ? !JSON.parse(frame.ui_state)?.open : frame.value?.result?.text !== 'render-marker')) throw new Error(JSON.stringify(frame));
      return frame;
    }
    if (frame.call.operation !== 'packages.list') throw new Error(`unexpected host call ${frame.call.operation}`);
    const packages = ['omd_update', 'omd_mods', 'omd_logo'].map(id => ({ id, kind: 'mod', version: '1.0.0', description: id, scope: 'user', path: `/mods/${id}`, source: 'selection', installed: true, enabled: true, effective: true, pending: null, failed: null, api: '0.2.0-experimental.5', compatible: true, grants: ['terminal'], conflicts: [], settings_schema: null, settings: {} }));
    worker.child.stdin.write(JSON.stringify({ value: { generation: 1, reload_error: null, packages } }) + '\n');
  }
}

const samples = [];
let worker;
try {
  if (compilation === 'paired') {
    let seed = 411;
    for (let pair = 0; pair < Number(count); pair++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const order = seed < 0x80000000 ? ['lazy', 'eager'] : ['eager', 'lazy'];
      for (const compile of order) {
        worker = await boot(compile);
        const timer = setTimeout(() => worker?.child.kill('SIGKILL'), 5000);
        try {
          const inspectStarted = performance.now();
          await invoke(worker, 'inspect');
          const inspectMs = performance.now() - inspectStarted;
          for (let command = 1; command <= 2; command++) {
            const started = performance.now();
            await invoke(worker);
            samples.push({ pair, compilation: compile, command, warmup: false, ms: performance.now() - started, boot_ms: worker.bootMs, inspect_ms: inspectMs });
          }
        } finally {
          clearTimeout(timer);
          worker.child.kill();
          worker = null;
        }
      }
    }
  } else {
  for (let index = 0; index <= Number(count); index++) {
    if (!worker) {
      worker = await boot();
      if (preparation === 'inspect') await invoke(worker, 'inspect');
    }
    const timer = setTimeout(() => worker?.child.kill('SIGKILL'), 5000);
    const started = performance.now();
    try {
      await invoke(worker);
      samples.push({ warmup: index === 0, ms: performance.now() - started, boot_ms: worker.bootMs });
    } finally {
      clearTimeout(timer);
      if (mode === 'once') {
        worker.child.kill();
        worker = null;
      }
    }
  }
  }
} catch (error) {
  console.error(JSON.stringify({ completed: samples.length, error: String(error) }));
  throw error;
} finally {
  worker?.child.kill();
}
const sorted = samples.filter(value => !value.warmup).map(value => value.ms).sort((a, b) => a - b);
const summarize = values => Object.fromEntries([50, 75, 95].map(p => [`p${p}`, values[Math.round((values.length - 1) * p / 100)]]));
console.log(JSON.stringify({ node: process.version, executable_sha256: createHash('sha256').update(readFileSync(node)).digest('hex'), runnerPath, source_sha256: createHash('sha256').update(readFileSync(runnerPath)).digest('hex'), runner_sha256: createHash('sha256').update(mode === 'v8' ? readFileSync(runnerPath) : runner).digest('hex'), mode, cache, workload, method: mode === 'v8' ? 'fresh V8 isolate and script compilation plus JSON exchange; no OMD SDK or ES-module parity' : 'prebooted Seatbelt runner; /mods with fixture packages.list or trivial render; excludes process boot, Rust host and terminal',
  internal_compilation_cache: false, compilation, prewarm, preparation, fixture_package_ids: ['omd_update', 'omd_mods', 'omd_logo'], memory: (worker?.errors() ?? '').split('\n').filter(line => line.startsWith('{"completed":')).map(line => JSON.parse(line)),
  samples, summary: compilation === 'paired' ? Object.fromEntries(['lazy', 'eager'].flatMap(compile => [1, 2].map(command => [`${compile}_command_${command}`, summarize(samples.filter(sample => sample.compilation === compile && sample.command === command).map(sample => sample.ms).sort((a, b) => a - b))]))) : summarize(sorted) }, null, 2));

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createNet } from 'node:net';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_VERSION, checkCli, cliArgs, eventQueue } from './transport.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function unusedPort() {
  const server = createNet();
  await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}

async function findCli(value) {
  if (value) return realpath(value);
  for (const directory of (process.env.PATH ?? '').split(':')) {
    const candidate = join(directory, 'claude');
    try { await access(candidate, constants.X_OK); return realpath(candidate); } catch {}
  }
  throw new Error('official_claude_cli_unavailable');
}

// Runs the CLI against a local stand-in for the Messages API, so discovery never reaches the account.
async function offline(claude, argv, input) {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (request.method !== 'POST') { response.writeHead(200).end(); return; }
      const events = [
        { type: 'message_start', message: { id: 'msg_omd_probe', type: 'message', role: 'assistant', content: [],
          usage: { input_tokens: 1, output_tokens: 1 } } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' }];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const child = spawn(claude, argv, { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_MAX_RETRIES: '0' } });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  const next = eventQueue(child);
  child.stdin.end(`${input.map(row => JSON.stringify(row)).join('\n')}\n`);
  const events = [];
  for (let event = await next(); event !== null; event = await next()) if (!(event instanceof Error)) events.push(event);
  clearTimeout(timer);
  server.close();
  return events;
}

export async function discover(claude) {
  const base = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence'];
  const init = await offline(claude, base, [{ type: 'control_request', request_id: 'omd', request: { subtype: 'initialize' } }]);
  const offered = init.find(event => event.type === 'control_response')?.response?.response?.models;
  if (!Array.isArray(offered)) throw new Error('claude_model_catalog_unavailable');
  const models = [];
  for (const option of offered) {
    if (option.value === 'default' || typeof option.resolvedModel !== 'string') continue;
    const slug = option.resolvedModel.replace(/\[1m\]$/, '');
    if (models.some(model => model.slug === slug)) continue;
    const entry = { slug, cli: option.resolvedModel, family: option.value.replace(/\[1m\]$/, '').replace(/^claude-([a-z]+).*$/, '$1'),
      name: `Claude ${String(option.description ?? option.displayName).split(' · ')[0]}`,
      description: String(option.description ?? ''), efforts: option.supportsEffort ? option.supportedEffortLevels ?? [] : [],
      thinking: option.supportsAdaptiveThinking === true };
    const probe = await offline(claude, cliArgs(entry, entry.efforts.at(-1)),
      [{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'ok' }] } }]);
    entry.window = probe.find(event => event.type === 'result')?.modelUsage?.[entry.cli]?.contextWindow;
    if (!Number.isInteger(entry.window) || entry.window < 100000) throw new Error(`claude_context_window_unmeasured:${entry.cli}`);
    models.push(entry);
  }
  if (!models.length) throw new Error('claude_model_catalog_empty');
  return models;
}

function catalog(models, template) {
  return { models: models.map((model, index) => ({ ...template, slug: model.slug, display_name: model.name,
    description: `${model.description} Official Claude CLI subscription route through the opt-in OMD mod.`.trim(),
    context_window: model.window, max_context_window: model.window, auto_compact_token_limit: Math.floor(model.window * 0.9),
    default_reasoning_level: model.efforts.includes('high') ? 'high' : null,
    supported_reasoning_levels: model.efforts.map(effort => ({ effort, description: effort })),
    supports_reasoning_summaries: model.thinking, default_reasoning_summary: model.thinking ? 'auto' : 'none',
    priority: 90 + index })) };
}

async function setup(recordPath, claudePath, billing) {
  if (!['subscription', 'api'].includes(billing)) throw new Error('claude_billing_must_be_subscription_or_api');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  if (record.profile !== 'full' || !record.packages?.omd_claude_cli) throw new Error('omd_plus_claude_mod_required');
  const installed = join(record.store, 'sources', 'omd_claude_cli');
  const mod = await realpath(installed);
  if (mod !== source) throw new Error('setup_must_run_from_installed_mod');
  const claude = await findCli(claudePath);
  checkCli(claude, billing);
  const models = await discover(claude);
  const directory = join(record.store, 'routes', 'claude');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const routePath = join(directory, 'route.json');
  const catalogPath = join(directory, 'models.json');
  const tokenPath = join(directory, 'local-token');
  let previous = {};
  try { previous = JSON.parse(await readFile(routePath, 'utf8')); } catch {}
  try { await writeFile(tokenPath, randomBytes(40).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await chmod(tokenPath, 0o600);
  const port = previous.port ?? await unusedPort();
  const fallback = models.find(model => model.family === 'opus') ?? models[0];
  const settings = { store: join(record.store, 'mods.json'), paths: [installed, mod] };
  await writeFile(routePath, `${JSON.stringify({ port, claude, billing, settings, default: fallback.slug, models }, null, 2)}\n`);
  const template = JSON.parse(await readFile(join(source, 'models.json'), 'utf8')).models[0];
  await writeFile(catalogPath, `${JSON.stringify(catalog(models, template), null, 2)}\n`);
  const node = await realpath(record.author.node);
  const home = homedir();
  const username = userInfo().username;
  const readPaths = [];
  for (const path of [mod, directory, settings.store, claude, dirname(claude), resolve(dirname(node), '..'), '/opt/homebrew',
    join(home, '.claude'), join(home, '.claude.json'), join(home, 'Library/Keychains'), '/System', '/usr/lib',
    '/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld', '/System/Volumes/Preboot/Cryptexes/OS/usr/lib']) {
    try { const real = await realpath(path); if (!readPaths.includes(real)) readPaths.push(real); } catch {}
  }
  const url = `http://127.0.0.1:${port}/v1`;
  const hostPath = join(record.store, 'host.json');
  let host = {};
  try { host = JSON.parse(await readFile(hostPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  host.schema = 1;
  host.max_request_bytes = Math.max(host.max_request_bytes ?? 0, 16 * 1024 * 1024);
  host.worker_limits = { requests: 60, exposure_microusd: 0, ...host.worker_limits,
    seconds: Math.max(host.worker_limits?.seconds ?? 0, 86400) };
  host.secret_refs = { ...host.secret_refs, claude_local_token: tokenPath };
  host.services = [...(host.services ?? []).filter(grant => grant.id !== 'claude_cli'), {
    id: 'claude_cli', mod_id: 'omd_claude_cli', program: node, program_sha256: sha(await readFile(node)),
    arguments: [join(mod, 'transport.mjs'), 'serve', routePath, home, username],
    secrets: { OMD_CLAUDE_LOCAL_TOKEN: 'claude_local_token' }, network: true, read_paths: readPaths,
    route: { name: 'claude', roles: ['lead'], provider: 'omd_claude_cli', model: fallback.slug, reasoning_effort: 'high',
      responses_url: `${url}/responses`, rates: { input_microusd_per_million: 0, cached_microusd_per_million: 0,
        output_microusd_per_million: 0, reservation_microusd: 0, max_output_tokens: 128000,
        input_token_ceiling: fallback.window, ...billing === 'api' ? { provider_billed: true } : { included_subscription: true } } } }];
  await writeFile(hostPath, `${JSON.stringify(host, null, 2)}\n`, { mode: 0o600 });
  return { provider: { id: 'omd_claude_cli', name: 'OMD Claude CLI', base_url: url, env_key: 'OMD_CLAUDE_LOCAL_TOKEN',
    token: tokenPath, catalog: catalogPath, route: routePath }, cli: CLI_VERSION, billing,
    models: models.map(({ slug, family, window }) => ({ slug, family, window })), default: fallback.slug };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [action, record, claude, billing = 'subscription'] = process.argv.slice(2);
  try {
    if (action !== 'setup') throw new Error('unsupported_claude_setup_action');
    console.log(JSON.stringify(await setup(record, claude || '', billing)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

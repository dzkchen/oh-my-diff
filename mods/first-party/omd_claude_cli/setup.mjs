import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createNet } from 'node:net';
import { constants } from 'node:fs';
import { access, chmod, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNT } from './index.ts';
import { accountEnv, checkCli, cliArgs, cliEnv, eventQueue } from './transport.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function unusedPort() {
  const server = createNet();
  await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}

// O_EXLOCK (macOS open(2)) takes the flock the host holds on store.lock while it writes host.json; Node has no flock.
const O_EXLOCK = 0x20;
export async function updateHost(store, change, after) {
  let lock;
  for (const deadline = Date.now() + 5000; !lock;) {
    try { lock = await open(join(store, 'store.lock'), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_EXLOCK, 0o600); }
    catch (error) {
      if (error.code !== 'EAGAIN' || Date.now() > deadline) throw new Error(`host_config_locked: ${error.code}`);
      await new Promise(done => setTimeout(done, 20));
    }
  }
  try {
    const path = join(store, 'host.json');
    let host = {};
    try { host = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const result = await change(host);
    const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temp, `${JSON.stringify(host, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    try { await rename(temp, path); } catch (error) { await rm(temp, { force: true }); throw error; }
    await after?.();
    return result;
  } finally { await lock.close(); }
}

async function findCli() {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    const candidate = join(directory, 'claude');
    try { await access(candidate, constants.X_OK); return realpath(candidate); } catch {}
  }
  throw new Error('official_claude_cli_unavailable');
}

// Runs the CLI against a local stand-in for the Messages API, so discovery never reaches the account.
async function offline(claude, argv, input, account) {
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
  const child = spawn(claude, argv, { stdio: ['pipe', 'pipe', 'ignore'], env: cliEnv({
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_MAX_RETRIES: '0', ...accountEnv(account) }) });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  const next = eventQueue(child);
  child.stdin.end(`${input.map(row => JSON.stringify(row)).join('\n')}\n`);
  const events = [];
  for (let event = await next(); event !== null; event = await next()) if (!(event instanceof Error)) events.push(event);
  clearTimeout(timer);
  server.close();
  return events;
}

export async function discover(claude, account = null) {
  const base = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence'];
  const init = await offline(claude, base, [{ type: 'control_request', request_id: 'omd', request: { subtype: 'initialize' } }], account);
  const offered = init.find(event => event.type === 'control_response')?.response?.response?.models;
  if (!Array.isArray(offered)) throw new Error('claude_model_catalog_unavailable');
  const models = [];
  for (const option of offered) {
    if (option.value === 'default' || typeof option.resolvedModel !== 'string') continue;
    const model = option.resolvedModel.replace(/\[1m\]$/, '');
    const million = model !== option.resolvedModel;
    const slug = million ? `${model}-1m` : model;
    if (models.some(known => known.slug === slug)) continue;
    const label = `Claude ${String(option.description ?? option.displayName).split(' · ')[0]}`;
    const entry = { slug, model, cli: option.resolvedModel, family: option.value.replace(/\[1m\]$/, '').replace(/^claude-([a-z]+).*$/, '$1'),
      name: million && !/1M/i.test(label) ? `${label} (1M context)` : label,
      description: String(option.description ?? ''), efforts: option.supportsEffort ? option.supportedEffortLevels ?? [] : [],
      thinking: option.supportsAdaptiveThinking === true };
    const probe = await offline(claude, cliArgs(entry, entry.efforts.at(-1)),
      [{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'ok' }] } }], account);
    entry.window = probe.find(event => event.type === 'result')?.modelUsage?.[entry.cli]?.contextWindow;
    if (!Number.isInteger(entry.window) || entry.window < 100000) throw new Error(`claude_context_window_unmeasured:${entry.cli}`);
    models.push(entry);
    if (models.length === 16) break;
  }
  if (!models.length) throw new Error('claude_model_catalog_empty');
  return models;
}

const PROVIDER = 'omd_claude_cli';
export const publishable = accounts => {
  const chosen = new Set([...accounts.map(account => account.models[0]), ...accounts.flatMap(account => account.models.slice(1))].slice(0, 16));
  return accounts.flatMap(account => account.models.filter(model => chosen.has(model)));
};
const routeName = name => name === 'default' ? 'claude' : `claude-${name}`;
const widest = accounts => Math.max(...accounts.flatMap(account => account.models.map(model => model.window)));
const rates = (billing, window) => ({ input_microusd_per_million: 0, cached_microusd_per_million: 0, output_microusd_per_million: 0,
  reservation_microusd: 0, max_output_tokens: 128000, input_token_ceiling: window,
  ...billing === 'api' ? { provider_billed: true } : { included_subscription: true } });

async function setup(name, action, login) {
  const mod = await realpath(source);
  const store = dirname(dirname(mod));
  if (basename(dirname(mod)) !== 'sources') throw new Error('setup_must_run_from_installed_mod');
  if (!ACCOUNT.test(name ?? '') || name === 'api') throw new Error('claude_account_name_invalid: a letter, then lowercase letters, digits, _ or - (at most 24)');
  const directory = join(store, 'routes', 'claude');
  const routePath = join(directory, 'route.json');
  const tokenPath = join(directory, 'local-token');
  let previous = {};
  try { previous = JSON.parse(await readFile(routePath, 'utf8')); } catch {}
  const known = (previous.accounts ?? []).find(account => account.name === name);
  let accounts = (previous.accounts ?? []).filter(account => account.name !== name);
  const home = homedir();
  const username = userInfo().username;
  let host = {};
  try { host = JSON.parse(await readFile(join(store, 'host.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const taken = (routes, adding = 0) => {
    const others = (routes ?? []).filter(route => route.provider !== PROVIDER);
    if (action !== 'remove' && others.some(other => other.name === routeName(name))) throw new Error(`claude_route_name_taken: another route is named ${routeName(name)}`);
    if (others.length + accounts.length + adding > 32) throw new Error('host_route_limit: host.json holds at most 32 routes');
    return others;
  };
  const signOut = (cli, dir) => cli !== null && spawnSync(cli, ['auth', 'logout'], { encoding: 'utf8', timeout: 10000,
    env: cliEnv({ HOME: home, USER: username, LOGNAME: username, ...accountEnv({ config_dir: dir }) }) }).status === 0;
  const owned = async dir => relative(await realpath(join(directory, 'accounts')), await realpath(dir)) === name;
  let signedOut = null;
  let claude = previous.claude ?? null;
  let added = null;
  let discard = async () => {};
  if (action === 'remove') {
    if (!known) throw new Error(`claude_account_unknown: ${name}`);
    if (known.config_dir && await owned(known.config_dir).catch(() => false)) {
      signedOut = signOut(await findCli().catch(() => null), known.config_dir);
      await rm(known.config_dir, { recursive: true, force: true });
    }
  } else {
    if (!['subscription', 'api'].includes(action)) throw new Error('claude_billing_must_be_subscription_or_api');
    const config = name === 'default' ? null : login || join(directory, 'accounts', name);
    if (config && !known) discard = async () => {
      signOut(await findCli().catch(() => null), config);
      await rm(join(directory, 'accounts', name), { recursive: true, force: true });
    };
    try {
      taken(host.routes, 1);
      if (config) {
        await mkdir(join(directory, 'accounts', name), { recursive: true, mode: 0o700 });
        if (!await owned(config).catch(() => false)) throw new Error('claude_account_directory_outside_store');
        await chmod(config, 0o700);
      }
      const account = { name, billing: action, config_dir: config };
      claude = await findCli();
      const status = checkCli(claude, action, home, username, account);
      const models = (await discover(claude, account)).map(model => name === 'default' ? model
        : { ...model, slug: `${model.slug}.${name}`, name: `${model.name} · ${name}`.slice(0, 64) });
      const fallback = models.find(model => model.family === 'opus' && !model.cli.endsWith('[1m]')) ?? models[0];
      added = { ...account, plan: status.subscriptionType ?? null,
        email: status.email ?? null, cli_version: status.cliVersion, default: fallback.slug, models: [fallback, ...models.filter(model => model !== fallback)] };
    } catch (error) {
      await discard();
      throw error;
    }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await writeFile(tokenPath, randomBytes(40).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await chmod(tokenPath, 0o600);
  const node = await realpath(process.execPath);
  const programSha = sha(await readFile(node));
  let latest;
  // Under the host lock, so concurrent setups merge into the accounts the other one just wrote.
  const merge = async host => {
    let current = {};
    try { current = JSON.parse(await readFile(routePath, 'utf8')); } catch {}
    accounts = (current.accounts ?? []).filter(account => account.name !== name);
    if (added) accounts.splice(name === 'default' ? 0 : accounts.length, 0, added);
    else claude = current.claude ?? null;
    const port = current.port ?? await unusedPort();
    const url = `http://127.0.0.1:${port}/v1`;
    const readPaths = [];
    for (const path of [mod, directory, join(store, 'mods.json'), ...claude ? [claude, dirname(claude)] : [], resolve(dirname(node), '..'), '/opt/homebrew',
      join(home, '.claude'), join(home, '.claude.json'), join(home, 'Library/Keychains'), '/System', '/usr/lib',
      '/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld', '/System/Volumes/Preboot/Cryptexes/OS/usr/lib', ...accounts.flatMap(account => account.config_dir ?? [])]) {
      try { const real = await realpath(path); if (!readPaths.includes(real)) readPaths.push(real); } catch {}
    }
    const route = account => ({ name: routeName(account.name), roles: ['lead'], provider: PROVIDER, model: account.default, reasoning_effort: 'high',
      responses_url: `${url}/responses`, rates: rates(account.billing, widest([account])) });
    host.schema = 1;
    host.max_request_bytes = Math.max(host.max_request_bytes ?? 0, 16 * 1024 * 1024);
    const raise = (name, value, ceiling) => Math.max(host.worker_limits?.[name] ?? 0, Math.min(value, host.limits?.[name] ?? ceiling));
    host.worker_limits = { exposure_microusd: 0, ...host.worker_limits, requests: raise('requests', 300, 400), seconds: raise('seconds', 86400, 86400) };
    host.secret_refs = { ...host.secret_refs, claude_local_token: tokenPath };
    host.routes = [...taken(host.routes), ...accounts.map(route)];
    host.services = [...(host.services ?? []).filter(grant => grant.id !== 'claude_cli'), ...accounts.length ? [{
      id: 'claude_cli', mod_id: PROVIDER, program: node, program_sha256: programSha,
      arguments: [join(mod, 'transport.mjs'), 'serve', routePath, home, username],
      secrets: { OMD_CLAUDE_LOCAL_TOKEN: 'claude_local_token' }, network: true, read_paths: readPaths,
      route: { ...route(accounts[0]), rates: rates(accounts.some(account => account.billing === 'api') ? 'api' : 'subscription', widest(accounts)) } }] : []];
    latest = { port, claude, accounts };
  };
  const writeRoute = async () => {
    const temp = `${routePath}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temp, `${JSON.stringify(latest, null, 2)}\n`, { flag: 'wx' });
    try { await rename(temp, routePath); } catch (error) { await rm(temp, { force: true }); throw error; }
  };
  let committed = false;
  try { await updateHost(store, merge, () => { committed = true; return writeRoute(); }); } catch (error) {
    if (!committed) await discard();
    throw error;
  }
  const published = publishable(accounts);
  return { signed_out: signedOut, accounts: accounts.map(account => ({ name: account.name, billing: account.billing, plan: account.plan,
    email: account.email, cli_version: account.cli_version, config_dir: account.config_dir, route: routeName(account.name), models: account.models.length })),
    models: published.map(model => ({ slug: model.slug, display: model.name, context_window: model.window, efforts: model.efforts,
      ...model.efforts.includes('high') ? { default_effort: 'high' } : {} })) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [name, action, login] = process.argv.slice(2);
  try {
    console.log(JSON.stringify(await setup(name, action, login)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER, profileEntry, profilesOf, routeFor, serviceFor } from './profiles.ts';

const source = dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function unusedPort() {
  const server = createServer();
  await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}

async function json(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

// O_EXLOCK (macOS open(2)) takes the flock the host holds on store.lock while it writes host.json; Node has no flock.
const O_EXLOCK = 0x20;
export async function updateHost(store, change) {
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
    const host = await json(path, {});
    const result = change(host);
    const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temp, `${JSON.stringify(host, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    try { await rename(temp, path); } catch (error) { await rm(temp, { force: true }); throw error; }
    return result;
  } finally { await lock.close(); }
}

export function catalogEntry(profile, bundled, index) {
  const native = bundled.find(model => model.slug === profile.model);
  return { ...native ?? bundled[0], slug: profile.name, display_name: `${profile.name} · ${profile.model}`,
    description: `${profile.protocol} profile through omd_profiles${profile.paid ? ' (paid API)' : ''}.`,
    context_window: profile.window, max_context_window: profile.window, auto_compact_token_limit: Math.floor(profile.window * 0.9),
    visibility: 'list', supported_in_api: true, priority: 70 + index, ...native ? {} : { web_search_tool_type: null },
    ...profile.text_only ? { input_modalities: ['text'] } : {} };
}

export function resolved(profile, bundled, router) {
  const native = bundled.find(model => model.slug === profile.model);
  if (!native && !profile.window) throw new Error(`profile_window_required: ${profile.model} is not in the Codex catalog`);
  const template = native ?? bundled[0] ?? {};
  return { ...profile, window: profile.window ?? native.context_window, effort: template.default_reasoning_level ?? 'medium',
    efforts: (template.supported_reasoning_levels ?? []).map(level => level.effort).filter(Boolean), router };
}

async function prepare(store) {
  const directory = join(store, 'routes', 'profiles');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const routePath = join(directory, 'route.json');
  const tokenPath = join(directory, 'local-token');
  const previous = await json(routePath, {});
  const port = previous.port ?? await unusedPort();
  try { await writeFile(tokenPath, randomBytes(40).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await chmod(tokenPath, 0o600);
  return { directory, routePath, tokenPath, previous, port, url: `http://127.0.0.1:${port}/v1` };
}

async function write(store, mod, profiles, allowance, { routePath, tokenPath, previous, port }) {
  if (allowance !== null && !(Number.isFinite(allowance) && allowance > 0)) throw new Error('profile_allowance_invalid: USD above zero');
  const names = profiles.map(profile => profile.name);
  const fallback = names.includes(previous.default) ? previous.default : names[0] ?? null;
  const node = await realpath(process.execPath);
  const programSha = sha(await readFile(node));
  const readPaths = [join(await realpath(store), 'host.json')];
  for (const path of [mod, resolve(dirname(node), '..'), '/System', '/usr/lib', '/private/etc/ssl', '/etc/ssl']) {
    try { const real = await realpath(path); if (!readPaths.includes(real)) readPaths.push(real); } catch {}
  }
  const ordered = [...profiles.filter(profile => profile.name === fallback), ...profiles.filter(profile => profile.name !== fallback)];
  await updateHost(store, host => {
    host.schema = 1;
    host.max_request_bytes = Math.max(host.max_request_bytes ?? 0, 16 * 1024 * 1024);
    if (allowance !== null) host.limits = { ...host.limits, exposure_microusd: Math.round(allowance * 1_000_000) };
    if (profiles.some(profile => profile.paid) && !(host.limits?.exposure_microusd > 0)) throw new Error('profile_allowance_required: paid API profiles need an allowance (--allowance USD)');
    host.secret_refs = { ...host.secret_refs, omd_profiles_local_token: tokenPath };
    host.routes = [...(host.routes ?? []).filter(route => route.provider !== PROVIDER), ...ordered.map(routeFor)];
    host.services = [...(host.services ?? []).filter(grant => grant.id !== PROVIDER), ...serviceFor(ordered).map(grant => ({ ...grant,
      mod_id: PROVIDER, program: node, program_sha256: programSha, arguments: [join(mod, 'router.mjs'), 'serve', readPaths[0], String(port)],
      secrets: { OMD_PROFILES_LOCAL_TOKEN: 'omd_profiles_local_token' }, network: true, read_paths: readPaths }))];
  });
  await writeFile(routePath, `${JSON.stringify({ port, default: fallback, models: names.map(name => ({ slug: name, family: name })) }, null, 2)}\n`);
  return fallback;
}

// Codex's cached model catalog gives a catalog model's context window and efforts without asking the user.
async function catalog(model) {
  const cache = await json(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json'), {}).catch(() => ({}));
  const found = (Array.isArray(cache.models) ? cache.models : []).find(item => item?.slug === model);
  if (!Number.isInteger(found?.context_window)) return null;
  const efforts = (found.supported_reasoning_levels ?? []).map(level => level?.effort).filter(effort => typeof effort === 'string');
  return { window: found.context_window, effort: found.default_reasoning_level ?? 'medium', efforts };
}

async function setup(recordPath, optionText) {
  const options = JSON.parse(optionText || '{}');
  const allowance = options.allowance === undefined || options.allowance === null ? null : Number(options.allowance);
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  if (record.profile !== 'full' || !record.packages?.omd_profiles) throw new Error('omd_plus_profiles_mod_required');
  const mod = await realpath(join(record.store, 'sources', 'omd_profiles'));
  if (mod !== source) throw new Error('setup_must_run_from_installed_mod');
  const paths = await prepare(record.store);
  const host = await json(join(record.store, 'host.json'), {});
  const profiles = profilesOf(host.routes ?? []).filter(profile => profile.name !== options.remove && profile.name !== options.add?.name)
    .map(profile => ({ ...profile, router: paths.url }));
  if (!profiles.length && !options.add && !(host.routes ?? []).some(route => route.provider === PROVIDER)) throw new Error('no_profiles: add one with --add');
  const dump = spawnSync(record.binary.installed_path, ['debug', 'models', '--bundled'], { encoding: 'utf8', timeout: 30000 });
  if (dump.status !== 0) throw new Error('codex_bundled_catalog_unavailable');
  const bundled = JSON.parse(dump.stdout).models;
  if (options.add) {
    const listed = spawnSync(record.manager.installed_path, ['credentials', record.store], { encoding: 'utf8', timeout: 30000 });
    if (listed.status !== 0) throw new Error(`credentials_unavailable: ${listed.stderr.trim()}`);
    profiles.push(resolved(profileEntry(options.add, JSON.parse(listed.stdout)), bundled, paths.url));
  }
  const fallback = await write(record.store, mod, profiles, allowance, paths);
  const catalogPath = join(paths.directory, 'models.json');
  await writeFile(catalogPath, `${JSON.stringify({ models: profiles.map((profile, index) => catalogEntry(profile, bundled, index)) }, null, 2)}\n`);
  return { provider: { id: 'omd_profiles', name: 'OMD profiles', base_url: paths.url, env_key: 'OMD_PROFILES_LOCAL_TOKEN',
    token: paths.tokenPath, catalog: catalogPath, route: paths.routePath },
    profiles: profiles.map(profile => ({ slug: profile.name, protocol: profile.protocol, paid: Boolean(profile.paid) })), default: fallback };
}

async function session(optionText) {
  const { profiles, allowance = null } = JSON.parse(optionText);
  if (basename(dirname(source)) !== 'sources') throw new Error('setup_must_run_from_installed_mod');
  const store = dirname(dirname(source));
  const paths = await prepare(store);
  const routed = profiles.map(profile => ({ ...profile, router: paths.url }));
  await write(store, source, routed, allowance === null ? null : Number(allowance), paths);
  return { profiles: routed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2);
  try {
    if (!['setup', 'session', 'catalog'].includes(action)) throw new Error('unsupported_profiles_setup_action');
    let input = '';
    if (action === 'session') for await (const chunk of process.stdin) input += chunk;
    console.log(JSON.stringify(action === 'setup' ? await setup(...args) : action === 'catalog' ? await catalog(args[0]) : await session(input)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

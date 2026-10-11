import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const PROTOCOLS = ['responses', 'chat', 'anthropic'];

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

export function profileEntry(options, credentials) {
  const { name, credential, protocol, url, model } = options;
  if (!/^[a-z0-9_-]{1,32}$/.test(name ?? '')) throw new Error('profile_name_invalid: lowercase letters, digits, _ or -');
  if (!PROTOCOLS.includes(protocol)) throw new Error(`profile_protocol_invalid: ${PROTOCOLS.join('|')}`);
  if (!/^https:\/\//.test(url ?? '') || !model) throw new Error('profile_url_and_upstream_model_required');
  const found = credentials.find(item => item.label === credential || item.id === credential);
  if (!found || found.kind === 'secret') throw new Error(`credential_not_enrolled: run /profile add in an OMD+ session first (${credential})`);
  if (new URL(url).origin !== found.origin) throw new Error(`profile_url_origin_mismatch: ${found.label} is enrolled for ${found.origin}`);
  const paid = options.paid ? String(options.paid).split(':').map(Number) : null;
  if (paid && (paid.length !== 2 || paid.some(value => !Number.isFinite(value) || value <= 0))) throw new Error('profile_paid_invalid: INPUT_USD:OUTPUT_USD per million tokens, both above zero');
  if (found.kind !== 'chatgpt' && !paid) throw new Error('profile_paid_required: API-key profiles bill per request');
  const count = (value, label, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) throw new Error(`profile_${label}_invalid: a whole number of tokens above zero`);
    return number;
  };
  return { name, protocol, url, model, credential: found.id, kind: found.kind, window: count(options.window, 'window', null),
    reasoning: options.reasoning === true, max_output: count(options.max_output, 'max_output', 32000), paid };
}

export function routeFor(slug, profile, template, url) {
  const window = profile.window ?? template.context_window;
  const [input, output] = (profile.paid ?? [0, 0]).map(usd => Math.round(usd * 1_000_000));
  const reservation = profile.paid ? Math.ceil((window * input + profile.max_output * output) / 1_000_000) : 0;
  return { name: profile.name, roles: ['lead'], provider: 'omd_profiles', model: slug,
    reasoning_effort: template.default_reasoning_level ?? 'medium', responses_url: `${url}/responses`,
    rates: { input_microusd_per_million: input, cached_microusd_per_million: input, output_microusd_per_million: output,
      reservation_microusd: reservation, max_output_tokens: profile.max_output, input_token_ceiling: window, included_subscription: !profile.paid } };
}

export function catalogEntry(slug, profile, bundled, index) {
  const native = bundled.find(model => model.slug === profile.model);
  if (!native && !profile.window) throw new Error(`profile_window_required: ${profile.model} is not in the Codex catalog`);
  const window = profile.window ?? native.context_window;
  return { ...native ?? bundled[0], slug, display_name: `${profile.name} · ${profile.model}`,
    description: `${profile.protocol} profile through omd_profiles${profile.paid ? ' (paid API)' : ''}.`,
    context_window: window, max_context_window: window, auto_compact_token_limit: Math.floor(window * 0.9),
    visibility: 'list', supported_in_api: true, priority: 70 + index, ...native ? {} : { web_search_tool_type: null } };
}

async function setup(recordPath, optionText) {
  const options = JSON.parse(optionText || '{}');
  const allowance = options.allowance === undefined || options.allowance === null ? null : Number(options.allowance);
  if (allowance !== null && !(Number.isFinite(allowance) && allowance > 0)) throw new Error('profile_allowance_invalid: USD above zero');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  if (record.profile !== 'full' || !record.packages?.omd_profiles) throw new Error('omd_plus_profiles_mod_required');
  const mod = await realpath(join(record.store, 'sources', 'omd_profiles'));
  if (mod !== source) throw new Error('setup_must_run_from_installed_mod');
  const directory = join(record.store, 'routes', 'profiles');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const routePath = join(directory, 'route.json');
  const catalogPath = join(directory, 'models.json');
  const tokenPath = join(directory, 'local-token');
  const previous = await json(routePath, {});
  const profiles = { ...previous.profiles };
  for (const [slug, profile] of Object.entries(profiles)) if (profile.name === options.remove || profile.name === options.add?.name) delete profiles[slug];
  if (options.add) {
    const listed = spawnSync(record.manager.installed_path, ['credentials', record.store], { encoding: 'utf8', timeout: 30000 });
    if (listed.status !== 0) throw new Error(`credentials_unavailable: ${listed.stderr.trim()}`);
    const profile = profileEntry(options.add, JSON.parse(listed.stdout));
    profiles[`${profile.name}/${profile.model}`] = profile;
  }
  if (!Object.keys(profiles).length && !Object.keys(previous.profiles ?? {}).length) throw new Error('no_profiles: add one with --add');
  try { await writeFile(tokenPath, randomBytes(40).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await chmod(tokenPath, 0o600);
  const port = previous.port ?? await unusedPort();
  const url = `http://127.0.0.1:${port}/v1`;
  const dump = spawnSync(record.binary.installed_path, ['debug', 'models', '--bundled'], { encoding: 'utf8', timeout: 30000 });
  if (dump.status !== 0) throw new Error('codex_bundled_catalog_unavailable');
  const bundled = JSON.parse(dump.stdout).models;
  const slugs = Object.keys(profiles);
  const models = slugs.map((slug, index) => catalogEntry(slug, profiles[slug], bundled, index));
  const fallback = slugs.includes(previous.default) ? previous.default : slugs[0] ?? null;
  const node = await realpath(record.author.node);
  const readPaths = [];
  for (const path of [mod, directory, resolve(dirname(node), '..'), '/System', '/usr/lib', '/private/etc/ssl', '/etc/ssl']) {
    try { const real = await realpath(path); if (!readPaths.includes(real)) readPaths.push(real); } catch {}
  }
  const hostPath = join(record.store, 'host.json');
  const host = await json(hostPath, {});
  const routes = slugs.map((slug, index) => routeFor(slug, profiles[slug], models[index], url));
  host.schema = 1;
  host.max_request_bytes = Math.max(host.max_request_bytes ?? 0, 16 * 1024 * 1024);
  if (allowance !== null) host.limits = { ...host.limits, exposure_microusd: Math.round(allowance * 1_000_000) };
  if (routes.some(route => !route.rates.included_subscription) && !(host.limits?.exposure_microusd > 0)) throw new Error('profile_allowance_required: pass --allowance USD for paid API profiles');
  host.secret_refs = { ...host.secret_refs, omd_profiles_local_token: tokenPath };
  host.routes = [...(host.routes ?? []).filter(route => route.provider !== 'omd_profiles'), ...routes];
  host.services = [...(host.services ?? []).filter(grant => grant.id !== 'omd_profiles'), ...slugs.length ? [{
    id: 'omd_profiles', mod_id: 'omd_profiles', program: node, program_sha256: sha(await readFile(node)),
    arguments: [join(mod, 'router.mjs'), 'serve', routePath], secrets: { OMD_PROFILES_LOCAL_TOKEN: 'omd_profiles_local_token' },
    credentials: [...new Set(slugs.map(slug => profiles[slug].credential))], network: true, read_paths: readPaths, route: routes[slugs.indexOf(fallback)] }] : []];
  await writeFile(routePath, `${JSON.stringify({ port, default: fallback, models: slugs.map(slug => ({ slug, family: profiles[slug].name })), profiles }, null, 2)}\n`);
  await writeFile(catalogPath, `${JSON.stringify({ models }, null, 2)}\n`);
  await writeFile(hostPath, `${JSON.stringify(host, null, 2)}\n`, { mode: 0o600 });
  return { provider: { id: 'omd_profiles', name: 'OMD profiles', base_url: url, env_key: 'OMD_PROFILES_LOCAL_TOKEN',
    token: tokenPath, catalog: catalogPath, route: routePath },
    profiles: slugs.map(slug => ({ slug, protocol: profiles[slug].protocol, paid: Boolean(profiles[slug].paid) })), default: fallback };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [action, record, options] = process.argv.slice(2);
  try {
    if (action !== 'setup') throw new Error('unsupported_profiles_setup_action');
    console.log(JSON.stringify(await setup(record, options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { slug } from './text.mjs';

const NOISE = /collect|analytics|telemetry|tracking|track\b|beacon|metrics|sentry|\brum\b|pixel|\bads?\b|gtm|segment|hotjar|clarity|logs?\b|heartbeat|ping\b/i;
const GENERIC = new Set(['api', 'rest', 'json', 'v1', 'v2', 'v3', 'v4', 'graphql', 'gql', 'ajax', 'xhr', 'data', 'internal', 'public', '_next', 'query']);
const DROP_HEADERS = /^(cookie|host|content-length|user-agent|accept-encoding|connection|origin|referer|authorization|proxy-authorization|x-api-key|x-auth-token|priority|pragma|cache-control)$|^sec-|^:/i;
const VERBS = { POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'delete' };

export class Sites {
  constructor(dataDir) {
    this.dir = join(dataDir, 'sites');
  }

  load(host) {
    try {
      return { apis: {}, aliases: {}, ...JSON.parse(readFileSync(join(this.dir, `${host}.json`), 'utf8')) };
    } catch {
      return { apis: {}, aliases: {} };
    }
  }

  save(host, site) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.dir, `${host}.json`), `${JSON.stringify(site, null, 1)}\n`, { mode: 0o600 });
  }
}

const siteOf = host => {
  if (/^[\d.]+$|^\[|^localhost$/.test(host)) return host;
  const labels = host.split('.');
  const shared = /^(co|com|net|org|gov|ac|edu|ne|or|github|gitlab|vercel|netlify|pages|herokuapp|blogspot)$/.test(labels.at(-2) ?? '');
  return labels.slice(shared ? -3 : -2).join('.');
};

function parseBody(postData, contentType) {
  if (!postData) return { kind: 'none' };
  try {
    return { kind: 'json', value: JSON.parse(postData) };
  } catch {}
  if (/x-www-form-urlencoded/i.test(contentType ?? '')) return { kind: 'form', value: Object.fromEntries(new URLSearchParams(postData)) };
  return { kind: 'raw', value: postData };
}

const header = (headers, name) => Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];

export function shape(value, depth = 0) {
  if (Array.isArray(value)) return value.length ? `[${value.length}× ${shape(value[0], depth + 1)}]` : '[]';
  if (value && typeof value === 'object') {
    if (depth > 2) return '{…}';
    const keys = Object.keys(value);
    const parts = keys.slice(0, 8).map(key => (value[key] && typeof value[key] === 'object' ? `${key}: ${shape(value[key], depth + 1)}` : key));
    return `{${parts.join(', ')}${keys.length > 8 ? ', …' : ''}}`;
  }
  return typeof value;
}

const matches = (value, values) => {
  const text = String(value ?? '').toLowerCase();
  return text.length > 0 && values.some(given => text === given || (given.length >= 3 && text.includes(given)));
};

export function learn(site, request, pageUrl, given) {
  if (!['XHR', 'Fetch'].includes(request.type) || !(request.status >= 200 && request.status < 300) || !/json|graphql/i.test(request.mimeType ?? '')) return null;
  const url = new URL(request.url);
  const page = new URL(pageUrl);
  if (siteOf(url.hostname) !== siteOf(page.hostname) || NOISE.test(url.pathname)) return null;
  const values = given.map(value => String(value).toLowerCase());
  const body = parseBody(request.postData, header(request.requestHeaders, 'content-type'));
  const operation = body.kind === 'json' && (body.value?.operationName || /^\s*(?:query|mutation)\s+(\w+)/.exec(body.value?.query ?? '')?.[1]);
  const graphql = !!(body.kind === 'json' && typeof body.value?.query === 'string');
  const vars = new Set();
  const segments = url.pathname.split('/').filter(Boolean).map((segment, index, all) => {
    if (!matches(decodeURIComponent(segment), values)) return segment;
    const name = slug(all[index - 1] ?? 'path').replace(/s$/, '') || 'path';
    vars.add(name);
    return `{${name}}`;
  });
  const query = Object.fromEntries(url.searchParams);
  for (const [key, value] of Object.entries(query)) if (matches(value, values)) vars.add(key);
  const fields = graphql ? body.value.variables ?? {} : body.kind === 'json' || body.kind === 'form' ? body.value : {};
  if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
    for (const [key, value] of Object.entries(fields)) if (typeof value !== 'object' && matches(value, values)) vars.add(key);
  }
  const path = `/${segments.join('/')}`;
  const signature = `${request.method} ${url.origin}${path} ${operation || ''}`;
  const existing = Object.entries(site.apis).find(([, entry]) => entry.signature === signature);
  const words = operation ? [slug(operation.replace(/([a-z])([A-Z])/g, '$1-$2'))]
    : segments.filter(segment => !segment.startsWith('{') && !GENERIC.has(segment.toLowerCase()) && !/^\d+$|^[0-9a-f-]{16,}$/i.test(segment)).slice(-2).map(slug);
  const rpc = ['action', 'method', 'op', 'operation', 'cmd', 'list', 'prop'].map(key => query[key]).find(value => value && /^[\w.-]{2,40}$/.test(value));
  if (rpc && (!words.length || /\b(api|rpc|php|ajax|index)\b/i.test(segments.at(-1) ?? ''))) words.splice(0, words.length, slug(rpc));
  let name = existing?.[0] ?? ([graphql ? '' : VERBS[request.method], ...words].filter(Boolean).join('-') || 'root');
  if (!existing) {
    const base = name;
    for (let suffix = 2; site.apis[name]; suffix++) name = `${base}-${suffix}`;
  }
  const headers = {};
  const csrf = [];
  for (const [key, value] of Object.entries(request.requestHeaders ?? {})) {
    if (/csrf|xsrf/i.test(key)) csrf.push(key);
    else if (!DROP_HEADERS.test(key)) headers[key] = value;
  }
  const writes = graphql ? !/^\s*(query\b|\{)/.test(body.value.query) : request.method !== 'GET' || /^\s*mutation\b/.test(query.query ?? '');
  const entry = {
    signature, method: request.method, origin: url.origin, path, query, body, graphql, headers, csrf,
    auth: !!header(request.requestHeaders, 'authorization'),
    vars: [...new Set([...(existing?.[1].vars ?? []), ...vars])], writes,
    page: page.origin, shape: request.sample === undefined ? existing?.[1].shape ?? '' : shape(request.sample),
  };
  site.apis[name] = entry;
  return { name, entry, isNew: !existing };
}

export function keys(entry) {
  const out = new Set(entry.vars);
  for (const match of entry.path.matchAll(/\{(\w[\w-]*)\}/g)) out.add(match[1]);
  for (const key of Object.keys(entry.query)) out.add(key);
  const fields = entry.graphql ? entry.body.value.variables ?? {} : entry.body.kind === 'json' || entry.body.kind === 'form' ? entry.body.value : {};
  if (fields && typeof fields === 'object' && !Array.isArray(fields)) for (const key of Object.keys(fields)) out.add(key);
  return [...out];
}

const coerce = (original, value) => {
  if (typeof original === 'number' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (typeof original === 'boolean') return value === true || value === 'true';
  if (original !== null && typeof original === 'object' && typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {}
  }
  return value === true ? 'true' : value;
};

export function build(entry, args) {
  const known = keys(entry);
  if ((entry.graphql || /^\s*(query|mutation)\b/.test(entry.query.query ?? '')) && 'query' in args) throw new Error('The GraphQL query of a learned endpoint is fixed; pass its variables');
  const pick = Object.fromEntries(Object.entries(args).map(([key, value]) => [known.find(name => name === key || slug(name) === slug(key)) ?? key, value]));
  const unknown = Object.keys(pick).filter(key => !known.includes(key));
  if (unknown.length) throw new Error(`Unknown parameter ${unknown.map(key => `--${key}`).join(', ')}; this endpoint takes ${known.map(key => `--${key}`).join(' ') || 'nothing'}`);
  let path = entry.path.replace(/\{(\w[\w-]*)\}/g, (_, name) => {
    if (pick[name] === undefined) throw new Error(`--${name} is required`);
    if (/^\.{1,2}$/.test(String(pick[name]))) throw new Error(`--${name} cannot be . or ..`);
    return encodeURIComponent(pick[name]);
  });
  const url = new URL(`${entry.origin}${path}`);
  for (const [key, value] of Object.entries(entry.query)) url.searchParams.set(key, pick[key] === undefined ? value : String(pick[key]));
  for (const [key, value] of Object.entries(pick)) if (!(key in entry.query) && entry.body.kind === 'none' && !entry.path.includes(`{${key}}`)) url.searchParams.set(key, String(value));
  let body;
  if (entry.body.kind === 'json') {
    const value = structuredClone(entry.body.value);
    const target = entry.graphql ? (value.variables ??= {}) : value;
    for (const [key, given] of Object.entries(pick)) if (!(key in entry.query) && !entry.path.includes(`{${key}}`)) target[key] = coerce(target[key], given);
    body = JSON.stringify(value);
  } else if (entry.body.kind === 'form') {
    const value = { ...entry.body.value };
    for (const [key, given] of Object.entries(pick)) if (!(key in entry.query)) value[key] = String(given);
    body = new URLSearchParams(value).toString();
  } else if (entry.body.kind === 'raw') body = entry.body.value;
  path = `${url.pathname}${url.search}`;
  return { url: url.href, method: entry.method, headers: entry.headers, csrf: entry.csrf, body, path };
}

export function expand(commands, args) {
  const word = text => text.replace(/\$(\d)/g, (_, n) => args[Number(n) - 1] ?? '');
  return commands.map(pipeline => pipeline.map(argv => argv.flatMap(text => text === '$@' ? args : [word(text)])));
}

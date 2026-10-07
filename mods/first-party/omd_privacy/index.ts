import type { FinalRequestEdit, FinalRequestPage, FinalRequestSegment, Json, ModAPI } from '../../api.d.ts';

type Exemptions = { fingerprints: string[]; domains: string[]; paths: PathPattern[]; ignored: number };
type Context = { exempt: Exemptions; before: number; leftOpen: boolean; rightOpen: boolean };
type Rule = (text: string, context: Context) => [number, number][];
type Check = (value: string, groups: Record<string, string | undefined>, exempt: Exemptions) => boolean;
type Saved = { salt?: string; ids?: Record<string, string>; counts?: Record<string, number>; denied?: number; last?: string };

const PLACEHOLDER = /\[REDACTED:[a-z0-9_]+:[a-z2-7]{12,52}\]/g;
const PLAIN = /example|placeholder|changeme|dummy|redacted|your[_-]|xxxx|\*\*\*/i;
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org', 'example', 'test', 'invalid', 'localhost'];
const TEST_CARDS = new Set(['4242424242424242', '4111111111111111', '5555555555554444', '378282246310005', '6011111111111117']);
const PEM_BEGIN = /-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----/g;
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g;
const JWT_OPEN_RIGHT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,2}$/;
const JWT_OPEN_LEFT = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}(?![A-Za-z0-9_.-])/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const MAX_IDS = 1000;

const varied = (value: string, distinct = 8) => new Set(value).size >= distinct && !PLAIN.test(value);
const mixed = (value: string) => /\d/.test(value) && /[A-Za-z]/.test(value) && varied(value);
const opaque = (value: string) => /[A-Z]/.test(value) || /^[0-9a-f._~+/-]+$/.test(value) || value.split(/[._~+/-]/).some(part => part.length >= 16);

function regex(pattern: RegExp, check?: Check, groups: string[] = []): Rule {
  return (text, { exempt }) => [...text.matchAll(pattern)].flatMap(match => {
    const span = groups.map(group => match.indices!.groups![group]).find(Boolean);
    const [start, end] = span ?? [match.index!, match.index! + match[0].length];
    return !check || check(text.slice(start, end), match.groups ?? {}, exempt) ? [[start, end] as [number, number]] : [];
  });
}

function assigned(value: string, groups: Record<string, string | undefined>) {
  if (/^(?:\$|%|process\.env|os\.environ|env\.)/i.test(value) || !varied(value, 4)) return false;
  if (/^(?:true|false|null|none|nil|undefined|string|number|boolean|bool|str|int|bytes|required|optional|secret|password|token|test|empty|unset|hidden)$/i.test(value)) return false;
  if (groups.quoted !== undefined) return !/\s/.test(value) || /[^A-Za-z\s.,!?'"-]/.test(value);
  return /[^A-Za-z_]/.test(value) && !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value);
}

const pem: Rule = (text, { leftOpen }) => {
  const ends = [...text.matchAll(PEM_END)].map(match => match.index! + match[0].length);
  const found: [number, number][] = [];
  let from = 0;
  for (const begin of text.matchAll(PEM_BEGIN)) {
    if (begin.index! < from) continue;
    from = ends.find(end => end > begin.index! + begin[0].length) ?? text.length;
    found.push([begin.index!, from]);
  }
  const orphan = ends.find(end => end <= (found[0]?.[0] ?? text.length));
  if (leftOpen && orphan !== undefined) found.push([0, orphan]);
  return found;
};

const jwt: Rule = (text, context) => {
  const found = regex(JWT)(text, context);
  const right = context.rightOpen ? JWT_OPEN_RIGHT.exec(text) : null;
  if (right) found.push([right.index, text.length]);
  const left = context.leftOpen ? JWT_OPEN_LEFT.exec(text) : null;
  if (left && left[0].length > context.before) found.push([0, left[0].length]);
  return found;
};

function publicV4(text: string) {
  const [a, b, c] = text.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b < 128 || a === 169 && b === 254
    || a === 172 && b >= 16 && b < 32 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2))
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}

function words(part: string, tail: boolean): number[] | null {
  if (part === '') return [];
  const out: number[] = [];
  const groups = part.split(':');
  for (const [index, group] of groups.entries()) {
    if (tail && index === groups.length - 1 && group.includes('.')) {
      const octets = group.split('.');
      if (octets.length !== 4 || octets.some(octet => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return null;
      const [a, b, c, d] = octets.map(Number);
      out.push(a * 256 + b, c * 256 + d);
    } else if (/^[0-9A-Fa-f]{1,4}$/.test(group)) out.push(parseInt(group, 16));
    else return null;
  }
  return out;
}

function ipv6(text: string): number[] | null {
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const compressed = halves.length === 2;
  const left = words(halves[0], !compressed);
  const right = compressed ? words(halves[1], true) : [];
  if (!left || !right) return null;
  const fill = 8 - left.length - right.length;
  if (compressed ? fill < 1 : fill !== 0) return null;
  return [...left, ...new Array<number>(compressed ? fill : 0).fill(0), ...right];
}

function publicV6(text: string) {
  const value = ipv6(text);
  if (!value || text.replace(/[^0-9A-Fa-f]/g, '').length < 4 || !/[0-9A-Fa-f]{3}/.test(text)) return false;
  if (value.slice(0, 7).every(word => word === 0) && value[7] <= 1) return false;
  if (value.slice(0, 5).every(word => word === 0) && value[5] === 0xffff) {
    return publicV4(`${value[6] >> 8}.${value[6] & 255}.${value[7] >> 8}.${value[7] & 255}`);
  }
  const [first, second] = value;
  return !((first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00 || (first & 0xff00) === 0xff00 || first === 0x2001 && second === 0x0db8);
}

function luhn(text: string) {
  const digits = text.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19 || !/^[3-6]/.test(digits) || TEST_CARDS.has(digits)) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

const domainExempt = (domain: string, exempt: Exemptions) => [...RESERVED_DOMAINS, ...exempt.domains]
  .some(reserved => domain.toLowerCase() === reserved || domain.toLowerCase().endsWith(`.${reserved}`));

const SECRETS: Record<string, Rule> = {
  private_key: pem,
  aws_access_key: regex(/(?<![A-Za-z0-9])(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Za-z0-9])/g, value => varied(value.slice(4), 6)),
  github_token: regex(/(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,251}|github_pat_[A-Za-z0-9_]{22,242})(?![A-Za-z0-9_])/g, value => varied(value)),
  gitlab_token: regex(/(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,64}(?![A-Za-z0-9_-])/g, value => varied(value)),
  slack_token: regex(/(?<![A-Za-z0-9-])(?:xox[abposr]-[A-Za-z0-9-]{10,250}|https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,120})(?![A-Za-z0-9-])/g, value => varied(value)),
  stripe_key: regex(/(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,247}(?![A-Za-z0-9])/g, value => varied(value)),
  ai_api_key: regex(/(?<![A-Za-z0-9_-])sk-(?:ant-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,250}(?![A-Za-z0-9_-])/g, mixed),
  google_api_key: regex(/(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g, value => varied(value)),
  npm_token: regex(/(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g, value => varied(value)),
  jwt,
  bearer_token: regex(/\b(?:Bearer\s+(?<value>[A-Za-z0-9._~+/-]{16,1024}=*)|Basic\s+(?<basic>[A-Za-z0-9+/]{16,1024}={0,2}))(?![A-Za-z0-9._~+/=-])/dgi,
    value => mixed(value) && opaque(value), ['value', 'basic']),
  url_credentials: regex(/\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/"'<>[\]\\]{1,128}:(?<value>[^\s@/"'<>[\]\\]{1,256})@/dgi,
    value => !/^(?:\*+|\$\{?[A-Za-z_]+\}?)$/.test(value), ['value']),
  assigned_secret: regex(/(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api_?key|apikey|access_?key|private_?key|secret_?key|credentials?)(?:\\*["'])?\s*(?::=|=>|=|:)\s*(?:(?<quote>\\*["'])(?<quoted>(?:(?!\k<quote>|\[REDACTED:)[^\n\\]){6,256})\k<quote>|(?<value>[^\s"'`,;&{}()<>[\]\\]{6,256})(?![^\s"'`,;&{}()<>[\]\\])(?!\s*\())/dgi,
    assigned, ['quoted', 'value']),
};

const PII: Record<string, Rule> = {
  email: regex(/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@(?<domain>(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24})(?![A-Za-z0-9-])/g,
    (_, groups, exempt) => !domainExempt(groups.domain ?? '', exempt)),
  phone: regex(/(?<![\w+])(?:\+[1-9](?:[ .-]?\d){6,14}|\(?[2-9]\d{2}\)?[ .-]\d{3}[ .-]\d{4})(?!\w)/g, value => !/555[ .-]?01\d\d$/.test(value)),
  ipv4: regex(/(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\w|\.\d)/g, publicV4),
  ipv6: regex(/(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}(?:[0-9A-Fa-f]{1,4}|(?:\d{1,3}\.){3}\d{1,3})?(?![\w:]|\.\d)/g, publicV6),
  card: regex(/(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g, luhn),
  us_ssn: regex(/(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g),
};

const strings = (value: Json | undefined) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function configure(settings: Readonly<Record<string, Json>>) {
  const secrets = strings(settings.secrets);
  const pii = strings(settings.pii);
  const exempt: Exemptions = { fingerprints: [], domains: [], paths: [], ignored: 0 };
  for (const entry of strings(settings.exempt)) {
    const at = entry.indexOf(':');
    const [kind, value] = [entry.slice(0, at), entry.slice(at + 1).trim()];
    if (kind === 'sha256' && /^[0-9a-f]{16,64}$/.test(value)) exempt.fingerprints.push(value);
    else if (kind === 'domain' && value) exempt.domains.push(value.toLowerCase());
    else if (kind === 'path' && value) exempt.paths.push(pathPattern(value));
    else exempt.ignored++;
  }
  return {
    rules: [...secrets.filter(name => name in SECRETS).map(name => [name, SECRETS[name]] as const),
      ...pii.filter(name => name in PII).map(name => [name, PII[name]] as const)],
    secrets: secrets.filter(name => name in SECRETS), pii: pii.filter(name => name in PII),
    unknown: [...secrets.filter(name => !(name in SECRETS)), ...pii.filter(name => !(name in PII))],
    scopes: strings(settings.scopes), paths: String(settings.paths), sensitive: strings(settings.sensitive_paths).map(pathPattern),
    unscanned: String(settings.unscanned), exempt,
  };
}

function bytes(value: string): Uint8Array {
  const encoded = encodeURIComponent(value).replace(/%([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Uint8Array.from(encoded, character => character.charCodeAt(0));
}

const hex = (data: Uint8Array) => Array.from(data, item => item.toString(16).padStart(2, '0')).join('');

async function sha256(value: string) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(value) as BufferSource)));
}

function base32(data: Uint8Array) {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of data) {
    buffer = buffer << 8 | byte;
    bits += 8;
    while (bits >= 5) out += BASE32[buffer >> (bits -= 5) & 31];
  }
  return bits ? out + BASE32[buffer << (5 - bits) & 31] : out;
}

function utf8Length(text: string) {
  let length = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return length;
}

const scopeOf = (segment: FinalRequestSegment) => segment.kind.startsWith('tool_call.') || segment.kind === 'tool_output' ? 'tools'
  : segment.kind === 'user.text' || segment.kind === 'message.user' ? 'prompt' : segment.role === 'assistant' ? 'replies' : 'context';

function wellFormed(page: FinalRequestPage) {
  return !!page && Array.isArray(page.segments) && Array.isArray(page.opaque) && !!page.scope
    && page.segments.every(segment => !!segment && typeof segment.id === 'string' && typeof segment.kind === 'string'
      && typeof segment.text === 'string' && typeof segment.editable === 'boolean'
      && (segment.offset === undefined || Number.isInteger(segment.offset) && typeof segment.before === 'string' && typeof segment.after === 'string'));
}

function apply(text: string, edits: FinalRequestEdit[]) {
  return [...edits].sort((a, b) => b.start - a.start).reduce((out, edit) => out.slice(0, edit.start) + edit.text + out.slice(edit.end), text);
}

type Pending = { segment: FinalRequestSegment; own: FinalRequestEdit[]; taken: FinalRequestEdit[] };

function coalesce({ segment, own, taken }: Pending) {
  const out: FinalRequestEdit[] = [];
  for (const edit of own) {
    const last = out[out.length - 1];
    const text = last ? last.text + segment.text.slice(last.end, edit.start) + edit.text : '';
    if (last && utf8Length(text) <= 4096 && !taken.some(other => other.start <= edit.start && other.end >= last.end)) Object.assign(last, { end: edit.end, text });
    else out.push({ ...edit });
  }
  return out;
}

type PathPattern = { pattern: string; want: RegExp[]; directory: boolean };

const pathPattern = (pattern: string): PathPattern => ({ pattern, directory: pattern.endsWith('/'), want: pattern.replace(/\/+$/, '').split('/')
  .map(part => new RegExp(`^${part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)) });

function pathHit(command: string, patterns: PathPattern[], exempt: PathPattern[]) {
  const names = (parts: string[], { want, directory }: PathPattern) => {
    for (let at = 0; at + want.length <= parts.length; at++) {
      if ((directory || at + want.length === parts.length) && want.every((part, index) => part.test(parts[at + index]))) return true;
    }
    return false;
  };
  for (const token of command.split(/[\s'"`;|&<>()=]+/).filter(Boolean)) {
    const parts = token.replace(/\/+$/, '').split('/');
    if (exempt.some(pattern => names(parts, pattern))) continue;
    const hit = patterns.find(pattern => names(parts, pattern));
    if (hit) return hit.pattern;
  }
  return null;
}

export default function activate(api: ModAPI) {
  const load = (): Saved => {
    const value = api.state.get();
    return value && typeof value === 'object' && !Array.isArray(value) ? JSON.parse(JSON.stringify(value)) as Saved : {};
  };

  api.intercept('model_send', { required: true }, async (page, next) => {
    if (!wellFormed(page)) return { deny: 'omd_privacy: malformed request page' };
    const inner = await next(page);
    const config = configure(api.settings);
    const before = load();
    const saved = load();
    const where = page.scope.kind;
    const refuse = (reason: string) => {
      saved.denied = (saved.denied ?? 0) + 1;
      saved.last = `denied ${reason.split(';')[0]} (${where})`;
      api.state.set(saved as Json);
      return { deny: `omd_privacy: ${reason}` };
    };
    const unscanned = config.unscanned === 'deny' ? page.opaque.find(item => item.kind !== 'encrypted_content') : undefined;
    if (unscanned) return refuse(`unscanned ${unscanned.kind} content; set unscanned to allow to send it outside the guarantee`);
    saved.salt ??= hex(crypto.getRandomValues(new Uint8Array(32)));
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(saved.salt.match(/../g)!, pair => parseInt(pair, 16)),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const thread = page.scope.thread_id ?? 'internal';
    const ids = saved.ids ??= {};
    const mint = async (rule: string, value: string, fingerprint: string) => {
      const full = base32(new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes(`${thread}\0${rule}\0${value}`) as BufferSource)));
      let length = 12;
      while (ids[full.slice(0, length)] && ids[full.slice(0, length)] !== fingerprint && length < full.length) length += 4;
      const id = full.slice(0, length);
      if (!ids[id]) ids[id] = fingerprint;
      return id;
    };
    const pending: Pending[] = [];
    const counts: Record<string, number> = {};
    for (const segment of page.segments) {
      if (!config.scopes.includes(scopeOf(segment))) continue;
      const head = segment.before ?? '';
      const framed = head + segment.text + (segment.after ?? '');
      const context: Context = { exempt: config.exempt, before: head.length,
        leftOpen: (segment.offset ?? 0) > head.length, rightOpen: utf8Length(segment.after ?? '') > 1020 };
      const found = config.rules.flatMap(([rule, find]) => find(framed, context).map(([start, end]) => ({ rule, start, end })))
        .filter(({ start, end }) => end > start)
        .sort((a, b) => a.start - b.start || b.end - a.end);
      const merged: typeof found = [];
      for (const finding of found) {
        const last = merged[merged.length - 1];
        if (last && finding.start < last.end) last.end = Math.max(last.end, finding.end);
        else merged.push({ ...finding });
      }
      const taken = inner.edits.filter(edit => edit.segment === segment.id);
      const skip = [...taken, ...[...framed.matchAll(PLACEHOLDER)].map(match => ({ start: match.index! - head.length, end: match.index! + match[0].length - head.length }))]
        .sort((a, b) => a.start - b.start);
      const own: FinalRequestEdit[] = [];
      for (const { rule, start, end } of merged) {
        if (end <= head.length || start >= head.length + segment.text.length) continue;
        const pieces: [number, number][] = [];
        let from = Math.max(start, head.length) - head.length;
        const to = Math.min(end, head.length + segment.text.length) - head.length;
        for (const other of skip) {
          if (other.end <= from || other.start >= to) continue;
          if (other.start > from) pieces.push([from, other.start]);
          from = Math.max(from, other.end);
        }
        if (from < to) pieces.push([from, to]);
        if (!pieces.length) continue;
        const value = framed.slice(start, end);
        const fingerprint = await sha256(value);
        if (config.exempt.fingerprints.some(exempted => fingerprint.startsWith(exempted))) continue;
        const id = await mint(rule, value, fingerprint.slice(0, 16));
        if (!segment.editable) return refuse(`${rule} in ${segment.kind} text, which cannot be redacted (placeholder ${id}); review it and run /privacy allow ${id} if it is not sensitive`);
        if (start >= head.length) counts[rule] = (counts[rule] ?? 0) + 1;
        pieces.forEach(([piece, until], index) => own.push({ segment: segment.id, start: piece, end: until,
          text: index === 0 && start >= head.length ? `[REDACTED:${rule}:${id}]` : '' }));
      }
      if (own.length && segment.kind === 'tool_call.arguments' && segment.offset === undefined) {
        let valid = true;
        try { JSON.parse(segment.text); } catch { valid = false; }
        if (valid) {
          try { JSON.parse(apply(segment.text, [...taken, ...own])); } catch { return refuse('redaction would break tool-call JSON arguments'); }
        }
      }
      pending.push({ segment, own, taken });
    }
    let edits = pending.flatMap(item => item.own);
    if (inner.edits.length + edits.length > 256) edits = pending.flatMap(coalesce);
    if (inner.edits.length + edits.length > 256) return refuse('more than 256 redaction edits on one request page');
    const redacted = Object.values(counts).reduce((sum, count) => sum + count, 0);
    if (redacted) {
      saved.counts ??= {};
      for (const [rule, count] of Object.entries(counts)) saved.counts[rule] = (saved.counts[rule] ?? 0) + count;
      saved.last = `redacted ${redacted} (${where})`;
    }
    const names = Object.keys(ids);
    for (const name of names.slice(0, Math.max(0, names.length - MAX_IDS))) delete ids[name];
    if (JSON.stringify(saved) !== JSON.stringify(before)) api.state.set(saved as Json);
    return { edits: [...inner.edits, ...edits], ...(inner.cache === false ? { cache: false as const } : {}) };
  });

  api.middleware('approval', event => {
    const config = configure(api.settings);
    if (config.paths === 'off' || !['exec', 'stdin', 'execve'].includes(event.kind)) return null;
    const details = (event.details ?? {}) as Record<string, Json>;
    const text = [details.command, details.argv, details.input].map(value => Array.isArray(value) ? value.map(String).join(' ') : typeof value === 'string' ? value : '').join(' ');
    const unchecked = event.kind === 'stdin' && typeof details.input !== 'string';
    const hit = pathHit(text, config.sensitive, config.exempt.paths);
    if (!hit && !unchecked) return null;
    const reason = hit ? `omd_privacy: this command names a sensitive path (${hit}), so its output would reach the model`
      : 'omd_privacy: this session input is too large to check for sensitive paths';
    return config.paths === 'deny' ? { deny: reason } : { ask: reason };
  });

  const allow = async (text: string) => {
    const id = /^(?:\[REDACTED:[a-z0-9_]+:)?([a-z2-7]{12,52})\]?$/.exec(text)?.[1];
    const known = id ? load().ids?.[id] : undefined;
    if (id && !known && text !== id) return { display: `Unknown placeholder ${id}; pass the value itself to exempt it.` };
    const entry = `sha256:${known ?? (await sha256(text)).slice(0, 16)}`;
    const exempt = strings(api.settings.exempt);
    if (exempt.includes(entry)) return { display: `Already exempt (${entry}).` };
    const written = api.host.tryCall('settings.write', { values: { exempt: [...exempt, entry] } });
    return { display: written.ok ? `Exempt (${entry}); later requests send that value unredacted.` : `Not saved (${written.error})` };
  };

  api.command('privacy', value => {
    const [verb = '', ...rest] = String(value ?? '').trim().split(/\s+/);
    if (verb === 'allow' && rest.length) return allow(rest.join(' '));
    if (verb && verb !== 'status') return { display: 'Usage: /privacy [status] or /privacy allow PLACEHOLDER_ID|VALUE' };
    const config = configure(api.settings);
    const saved = load();
    const counts = Object.entries(saved.counts ?? {}).map(([rule, count]) => `${rule} ${count}`).join(', ') || 'none';
    const exempt = config.exempt;
    return { display: [
      'Model-bound privacy policy on every provider request; while enabled, requests are refused if it is unavailable, fails or times out.',
      `Secret rules: ${config.secrets.join(', ') || 'none'}`,
      `PII rules: ${config.pii.join(', ') || 'off'}`,
      ...config.unknown.length ? [`Unknown rules ignored: ${config.unknown.join(', ')}`] : [],
      `Scopes: ${config.scopes.join(', ') || 'none'}`,
      `Sensitive paths: ${config.paths} (${config.sensitive.length} patterns)`,
      `Unscanned images, audio and files: ${config.unscanned}`,
      `Exemptions: ${exempt.fingerprints.length} fingerprints, ${exempt.domains.length} domains, ${exempt.paths.length} paths${exempt.ignored ? `, ${exempt.ignored} invalid ignored` : ''}`,
      'Terminal display: unchanged; the screen, transcript, rollout and resume data keep the originals.',
      `Redacted: ${counts} · denied ${saved.denied ?? 0} · last: ${saved.last ?? 'none'}`,
      `Placeholders: ${Object.keys(saved.ids ?? {}).length} known`,
    ].join('\n') };
  }, { description: 'Show privacy rules and counts, or exempt a reviewed placeholder or value', args_hint: '[status | allow PLACEHOLDER_ID|VALUE]' });
}

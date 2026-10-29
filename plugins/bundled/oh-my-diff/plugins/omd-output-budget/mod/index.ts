import type { Json, ModAPI, ResourceRef } from '@oh-my-diff/mod-api';
import { base64, clip, count, excerpt, fallback, htmlText, limitFor, lineCount, matches, outline, query, rank, size, split, terms } from './budget.ts';

type Entry = { id: string; reference: ResourceRef; bytes: number; kind: 'tool' | 'doc'; label: string; terms: Record<string, number>; length: number };
type Value = Exclude<Json, null>;

const SCOPE = 'thread';
const KEEP = 120;
const INDEX_BYTES = 2048;
const CAPTURE_TOKENS = 65_536;
const NATIVE_BYTES = 40_000;
const PAGE = 65_536;
const SCAN_BYTES = 640 * 1024;
const RECEIPT_ROOM = 960 * 1024;
const DOC_BYTES = 240 * 1024;
const WIDEN = /^(?:exec_command|write_stdin)$/;
const CODEX_CUT = /^Warning: truncated output \(original token count: \d+\)/m;

const number = (value: Json | undefined, fallback: number, low: number, high: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(high, Math.max(low, Math.round(value))) : fallback;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export default function activate(api: ModAPI) {
  const budget = () => {
    const result_bytes = number(api.settings.result_bytes, 16_384, 1024, 262_144);
    return {
      result_bytes,
      turn_bytes: number(api.settings.turn_bytes, 131_072, 4096, 1_048_576),
      floor_bytes: Math.min(result_bytes, number(api.settings.floor_bytes, 4096, 1024, 65_536)),
    };
  };

  const get = <T>(key: string) => {
    const found = api.host.tryCall('store.get', { key, scope: SCOPE });
    return found.ok && found.value ? { value: found.value.value as unknown as T, revision: found.value.revision } : null;
  };

  const update = <T>(key: string, change: (current: T | null) => T) => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = get<T>(key);
      const next = change(current?.value ?? null);
      if (api.host.tryCall('store.put', { key, value: next as unknown as Value, expected_revision: current?.revision ?? null, scope: SCOPE }).ok) return next;
    }
    return null;
  };

  const deliver = (bytes: number) => update<number>('turn', delivered => (delivered ?? 0) + bytes);

  const remember = (entry: Entry) => {
    let evicted: string[] = [];
    const listed = update<string[]>('outs', ids => {
      const kept = [entry.id, ...(ids ?? []).filter(id => id !== entry.id)];
      evicted = kept.slice(KEEP);
      return kept.slice(0, KEEP);
    });
    if (listed === null) return false;
    for (const id of evicted) {
      const old = get<Entry>(`out/${id}`);
      if (old) api.host.tryCall('store.delete', { key: `out/${id}`, expected_revision: old.revision, scope: SCOPE });
    }
    return update<Entry>(`out/${entry.id}`, () => entry) !== null;
  };

  const entry = (id: string) => get<Entry>(`out/${id}`)?.value ?? null;

  const page = (reference: ResourceRef, cursor: number) => {
    const read = api.host.tryCall('evidence.read', { reference, cursor, max_bytes: PAGE });
    return read.ok ? read.value : null;
  };

  const ending = (reference: ResourceRef, bytes: number) => {
    for (let back = 0; back < 4; back += 1) {
      const read = page(reference, Math.max(0, bytes - PAGE + back));
      if (read) return read.text as string;
    }
    return undefined;
  };

  api.on('turn_start', () => {
    update<number>('turn', () => 0);
  });

  api.intercept('tool', { match: { tool: /^(?!mod_omd_output_budget_)/ } }, async (e, next) => {
    if (next.origin?.caller === 'code_mode' || (e.batch && e.call_id.startsWith(`${e.batch.id}-merge-`))) return next(e);
    const args = e.arguments && typeof e.arguments === 'object' && !Array.isArray(e.arguments) ? e.arguments as Record<string, Json> : null;
    const widen = WIDEN.test(e.tool) && args !== null && args.max_output_tokens == null;
    const result = await next(widen ? { ...e, arguments: { ...args, max_output_tokens: CAPTURE_TOKENS } } : e);
    const visible = size(result.output);
    const total = typeof result.bytes === 'number' ? result.bytes : visible;
    const limit = limitFor(get<number>('turn')?.value ?? 0, budget());
    if (!result.truncated && total <= limit) {
      deliver(visible);
      return result;
    }
    const send = (output: string) => {
      deliver(size(output));
      return { output, success: result.success };
    };
    const unkept = (reason: string) => send(fallback(result.output, Math.max(limit, NATIVE_BYTES), reason));
    const original = api.host.tryCall('tools.original', { call_id: e.call_id });
    if (!original.ok) return unkept(original.error);
    const id = `out_${original.value.sha256.slice(0, 12)}`;
    const counted = terms(result.output, INDEX_BYTES);
    const kept = remember({
      id, reference: original.value.reference, bytes: original.value.bytes, kind: 'tool',
      label: clip(typeof args?.cmd === 'string' ? args.cmd : `${e.tool} ${JSON.stringify(e.arguments)}`, 160),
      terms: counted.terms, length: counted.length,
    });
    if (!kept) return unkept('the output index is busy');
    const { header, body } = split(result.output);
    const code = /Process exited with code (\d+)|Exit code: (\d+)/.exec(header);
    return send(excerpt(result.output, limit, id, original.value.bytes, {
      note: CODEX_CUT.test(body.slice(0, 200)) ? 'Codex had already cut its middle' : '',
      failed: code ? (code[1] ?? code[2]) !== '0' : !result.success,
      end: original.value.bytes > visible ? ending(original.value.reference, original.value.bytes) : undefined,
    }));
  });

  api.tool({
    name: 'read',
    description: 'Page a full tool output or fetched document kept by the output budget, by line. Use the id from an [omd_output_budget: …] marker or a search result; pass next_line and next_cursor back to continue.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Output id such as out_1a2b3c4d5e6f' },
        line: { type: 'number', description: 'First line to return, 1-based (default 1)' },
        lines: { type: 'number', description: 'Number of lines (default 200, at most 2000)' },
        cursor: { type: 'number', description: 'next_cursor from the previous read, passed with its next_line as line, to continue without rescanning' },
        max_bytes: { type: 'number', description: 'Byte cap for the returned text (default 16384, at most 49152)' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  }, (value): Json => {
    const request = value as { id?: string; line?: number; lines?: number; cursor?: number; max_bytes?: number };
    const kept = entry(String(request.id ?? ''));
    if (!kept) return { error: `unknown output id ${request.id}; search lists kept ids` };
    const resume = typeof request.cursor === 'number' && request.cursor >= 0;
    if (resume && typeof request.line !== 'number') return { error: 'pass next_line as line together with next_cursor' };
    const from = number(request.line, 1, 1, Number.MAX_SAFE_INTEGER);
    const count = number(request.lines, 200, 1, 2000);
    const cap = number(request.max_bytes, 16_384, 1024, 49_152);
    const out: string[] = [];
    let current = resume ? from : 1;
    let offset = resume ? request.cursor as number : 0;
    let cursor: number | null = offset;
    let carry = '';
    let bytes = 0;
    let scanned = 0;
    let stopped: number | null = null;
    while (cursor !== null && stopped === null) {
      if (scanned >= SCAN_BYTES && current < from) return { error: `line ${from} is past the ${SCAN_BYTES} bytes one read scans; search this id for a line near it` };
      const read = page(kept.reference, cursor);
      if (!read) return { error: 'the kept output is no longer readable' };
      scanned += size(JSON.stringify(read.text));
      cursor = read.cursor;
      const parts = (carry + read.text).split('\n');
      carry = cursor === null ? '' : parts.pop() ?? '';
      if (cursor === null && parts.at(-1) === '') parts.pop();
      for (const text of parts) {
        if (current >= from) {
          if (out.length >= count) { stopped = offset; break; }
          if (bytes + size(text) + 1 > cap) {
            if (out.length) { stopped = offset; break; }
            const piece = clip(text, cap - 64);
            out.push(`${piece}…[line continues: ${size(text) - size(piece)} more bytes]`);
            offset += size(text) + 1;
            current += 1;
            stopped = offset;
            break;
          }
          out.push(text);
          bytes += size(text) + 1;
        }
        offset += size(text) + 1;
        current += 1;
      }
    }
    const end = from + out.length - 1;
    const more = stopped !== null || cursor !== null || carry !== '';
    return {
      id: kept.id, label: kept.label, bytes: kept.bytes, first_line: from, last_line: end, text: out.join('\n'),
      next_line: more ? end + 1 : null, next_cursor: more ? (stopped ?? offset) : null,
    };
  });

  api.tool({
    name: 'search',
    description: 'Ranked full-text search over full tool outputs and fetched documents kept by the output budget in this thread. Returns matching lines with ids and line numbers; pass id to search one output completely.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to find' },
        id: { type: 'string', description: 'Search only this output id' },
        limit: { type: 'number', description: 'Matching lines to return (default 8, at most 20)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  }, (value): Json => {
    const request = value as { query?: string; id?: string; limit?: number };
    const words = query(String(request.query ?? ''));
    if (!words.length) return { error: 'query has no searchable words' };
    const limit = number(request.limit, 8, 1, 20);
    const ids = request.id ? [request.id] : get<string[]>('outs')?.value ?? [];
    const kept = ids.map(entry).filter((found): found is Entry => found !== null);
    if (request.id && !kept.length) return { error: `unknown output id ${request.id}; search without id lists kept ids` };
    const byId = new Map(kept.map(found => [found.id, found]));
    const ranked = rank(words, kept);
    const unindexed = words.some(word => !kept.some(found => count(found.terms, word)));
    const scan = request.id ? kept : [...new Set([...ranked.slice(0, 4).map(hit => hit.id), ...(unindexed ? ids : [])])].flatMap(id => byId.get(id) ?? []);
    const hits: { id: string; label: string; line: number; text: string; score: number }[] = [];
    let left = Math.min(SCAN_BYTES, RECEIPT_ROOM - size(JSON.stringify(kept)));
    let scanned = 0;
    let partial = false;
    for (const found of scan) {
      let cursor: number | null = 0;
      let line = 1;
      let carry = '';
      while (cursor !== null) {
        if (left < PAGE * 2) { partial = true; break; }
        const read = page(found.reference, cursor);
        if (!read) { partial = true; break; }
        left -= size(JSON.stringify(read.text));
        cursor = read.cursor;
        const text: string = carry + read.text;
        const cut = cursor === null ? text.length : text.lastIndexOf('\n') + 1;
        carry = text.slice(cut);
        for (const hit of matches(text.slice(0, cut), words, line, limit)) hits.push({ id: found.id, label: found.label, ...hit });
        line += lineCount(text.slice(0, cut));
      }
      scanned += 1;
      if (partial) break;
    }
    const best = hits.sort((a, b) => b.score - a.score || a.line - b.line).slice(0, limit);
    return {
      matches: best.map(({ id, label, line, text }) => ({ id, label, line, text })),
      outputs: ranked.slice(0, 10).map(({ id, score }) => {
        const found = byId.get(id) as Entry;
        return { id, label: found.label, kind: found.kind, bytes: found.bytes, score: Math.round(score * 100) / 100 };
      }),
      kept: kept.length, scanned, partial,
    };
  });

  api.tool({
    name: 'fetch',
    description: 'Fetch a documentation URL with curl through the session\'s own command sandbox, network permissions and approvals, keep its text by content hash, and return an outline. Then use search and read instead of re-fetching.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) URL of a documentation page' } },
      required: ['url'],
      additionalProperties: false,
    },
  }, async (value): Promise<Json> => {
    const url = String((value as { url?: string }).url ?? '');
    if (!/^https?:\/\/[^\s'"\\`$]+$/.test(url) || url.length > 2048) return { error: 'url must be http(s) without spaces, quotes, backslashes, backticks or $' };
    const cmd = `curl -fsSL --proto '=http,https' --proto-redir '=http,https' --max-time 25 --max-filesize 2000000 -A omd-output-budget -- '${url}'`;
    const run = api.host.tryCall('tools.invoke', { tool: 'exec_command', arguments: { cmd, max_output_tokens: CAPTURE_TOKENS, yield_time_ms: 30_000 } });
    if (!run.ok) return { error: run.error };
    const { header, body } = split(run.value.output);
    const exit = /Process exited with code (\d+)/.exec(header)?.[1] ?? /Exit code: (\d+)/.exec(header)?.[1] ?? null;
    if (exit === '63') return { error: 'the page is larger than 2 MB' };
    if (exit !== '0' || /Process running with session ID/.test(header)) return { error: `curl did not finish cleanly (exit ${exit ?? 'unknown'})`, output: clip(run.value.output, 2048) };
    const cut = run.value.truncated || CODEX_CUT.test(body.slice(0, 200));
    const html = /^\s*(?:Warning: truncated output[^\n]*\n(?:Total output lines[^\n]*\n)?\s*)?<(?:!doctype html|html|head|body)\b/i.test(body);
    const parsed = html ? htmlText(body) : { title: '', text: body };
    const text = clip(parsed.text, DOC_BYTES);
    if (!text.trim()) return { error: 'the page has no text' };
    const sha = await sha256(text);
    const id = `out_${sha.slice(0, 12)}`;
    const written = api.host.tryCall('evidence.write', { media_type: 'application/octet-stream', base64: base64(text), label: clip(`docs ${url}`, 128) });
    if (!written.ok) return { error: `the page text could not be kept: ${written.error}` };
    const counted = terms(text, INDEX_BYTES);
    if (!remember({ id, reference: written.value, bytes: size(text), kind: 'doc', label: clip(url, 160), terms: counted.terms, length: counted.length })) {
      return { error: 'the output index is busy; fetch again' };
    }
    return { id, url, title: clip(parsed.title, 200), bytes: size(text), lines: lineCount(text), truncated: cut || size(parsed.text) > DOC_BYTES, headings: outline(text), next: `search with {"query":"…","id":"${id}"} or read by line` };
  });
}

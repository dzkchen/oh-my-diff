import type { Json, ModAPI } from '../../api.d.ts';

type Seen = { sig: string; count: number };
type State = { calls: Record<string, Seen>; held: string[] };

const KEYS = 64;
const HELD = 4;
const FAILED_AFTER = 3;
const SAME_AFTER = 4;
const LABEL = 120;
const SKIP = /^(write_stdin|wait|update_plan)$/;
const HEAD = 1024;
const TAIL = 512;
const VOLATILE = /^\[omd_output_budget:.*$|\bout_[0-9a-f]{12}\b|^(Chunk ID|Wall time):.*$|"(chunk_id|wall_time_seconds)":\s*("[^"]*"|[\d.e-]+)|\d+(\.\d+)?\s*(ms|s|sec|seconds)\b/gm;

const EDIT_TOOL = /^apply_patch$|(^|_)(edit|write|create|replace)(_file|_editor)?$/;
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
const REDIRECT = /(?<![\d=<>&-])>>?\s*(?!&)([^\s;&|<>()]+)/g;
const WRITER = /(?:^|\s)(tee|cp|mv|sed|perl)\s+(.*)$/s;
const IN_PLACE = /(?:^|\s)-[a-zA-Z]*i[\w.]*(?=\s|$)/;
const UNSEEN_WRITE = /<<|\.write\(|write_text\(|writeFile/;
function writes(cmd: string): { created: string[]; changed: string[]; unseen: boolean } {
  const plain = cmd.replace(QUOTED, "''");
  const created = [...plain.matchAll(REDIRECT)].map(match => match[1]).filter(path => path !== '/dev/null');
  const changed: string[] = [];
  let unseen = UNSEEN_WRITE.test(cmd);
  for (const part of plain.split(/&&|\|\||[;|\n]/)) {
    const [, tool, rest = ''] = WRITER.exec(part.trim()) ?? [];
    const words = rest.split(/\s+/).filter(word => word && !word.startsWith('-'));
    const files = (tool === 'sed' && !/(?:^|\s)-[ef]\b/.test(rest) ? words.slice(1) : words).filter(word => word !== "''");
    if (tool === 'tee') created.push(...files);
    else if ((tool === 'cp' || tool === 'mv') && files.length > 1) changed.push(files[files.length - 1]);
    else if ((tool === 'sed' || tool === 'perl') && IN_PLACE.test(rest)) { changed.push(...files); unseen ||= !files.length; }
  }
  const named = (paths: string[]) => paths.filter(path => /^[\w./-]+$/.test(path));
  unseen ||= named(created).length < created.length || named(changed).length < changed.length;
  return { created: named(created), changed: named(changed), unseen };
}
const command = (args: Json) => {
  const value = typeof args === 'string' ? args : args && typeof args === 'object' && !Array.isArray(args) ? args.cmd ?? args.command : null;
  return typeof value === 'string' ? value : Array.isArray(value) ? value.join(' ') : '';
};
const edits = (tool: string, args: Json) => {
  const found = writes(command(args));
  return EDIT_TOOL.test(tool) || found.unseen || found.created.length + found.changed.length > 0;
};

const hash = (text: string) => {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return value.toString(16);
};
const signature = (output: string) => {
  const text = output.replace(VOLATILE, '').trim();
  return hash(text.length > HEAD + TAIL ? `${text.slice(0, HEAD)}\n${text.slice(-TAIL)}` : text);
};
const label = (args: Json) => {
  const cmd = args && typeof args === 'object' && !Array.isArray(args) && typeof args.cmd === 'string' ? args.cmd : JSON.stringify(args);
  const line = cmd.replace(/\s+/g, ' ').trim();
  return line.length > LABEL ? `${line.slice(0, LABEL)}…` : line;
};

export default function activate(api: ModAPI) {
  api.intercept('tool', async (e, next) => {
    const result = await next(e);
    const caller = next.origin?.caller;
    if ((caller !== 'model' && caller !== 'code_mode') || e.agent_id) return result;
    const state: State = { calls: {}, held: [], ...(api.state.get() as Partial<State> | null) };
    if (SKIP.test(e.tool)) {
      if (caller !== 'model' || !state.held.length) return result;
      api.state.set({ ...state, held: [] } as unknown as Json);
      return { ...result, output: `${result.output}\n\n${state.held.join('\n')}` };
    }
    const key = 'k' + hash(`${e.tool}\n${JSON.stringify(e.arguments).replace(/\s+/g, ' ')}`);
    const sig = `${result.success ? 'ok' : 'failed'}:${signature(result.output)}`;
    const seen = state.calls[key]?.sig === sig ? { sig, count: state.calls[key].count + 1 } : { sig, count: 1 };
    const { [key]: _, ...rest } = edits(e.tool, e.arguments) ? {} as State['calls'] : state.calls;
    const calls = Object.fromEntries([...Object.entries(rest), [key, seen]].slice(-KEYS));
    const limit = result.success ? SAME_AFTER : FAILED_AFTER;
    const notes = seen.count === limit
      ? [`[omd_loop_guard] \`${label(e.arguments)}\` has now returned the same ${result.success ? 'output' : 'error'} ${seen.count} times. Repeating it will not change the result: change the command or the approach.`]
      : [];
    const all = caller === 'model' ? [...state.held, ...notes] : [];
    api.state.set({ calls, held: caller === 'code_mode' ? [...state.held, ...notes].slice(-HELD) : [] } as unknown as Json);
    return all.length ? { ...result, output: `${result.output}\n\n${all.join('\n')}` } : result;
  });
}

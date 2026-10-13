import type { CommandResult, ComposerDraft, Json, ModAPI, RenderEvent, ResourceRef, TerminalClient, TerminalComponent, TerminalRenderSite } from '../../api.d.ts';
import { clamp, size, clean, cells } from './text.ts';
import { SOURCE_BYTES, DRAWN_BYTES, diagram, fences, chunks, presentation, kindOf } from './mermaid.ts';

const DIR = '.omd/preview';
const TEXT_BYTES = 4_000;
const DIFF_BYTES = 48_000;
const MAX_WATCHES = 8;
const POLL_MS = 2_000;
const MAX_IMAGES = 16;
const TILE_ROWS = [2, 8];
const TILE_MIN = 7;
const USAGE = 'usage: /preview [N | list | PATH] [--inline] [--watch] | /preview diagrams [N] | /preview image [N] | /preview server [PORT] | /preview unwatch | /preview close';

type Inline = { title: string; kind: string; text: string; source?: string; image?: ResourceRef };
type Picture = { id: string; label: string; owner: string; image: ResourceRef | null; aspect: number };
type State = { inline: Inline | null; revision: number; watch: string[]; hashes: Record<string, string>; images: Picture[]; attachments?: number };
type Turn = { items?: { type?: string; text?: string }[] };
type Rendered = { path: string } | { error: string };

const outputFor = (source: string) => `${DIR}/${source.replace(/[/\\]/g, '__')}.html`;
const inlineKind = (path: string) => {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  if (['md', 'markdown', 'mdx'].includes(extension)) return 'markdown';
  return ['diff', 'patch'].includes(extension) ? 'diff' : extension;
};
const pictures = (draft: ComposerDraft): Picture[] => draft.attachments.filter(item => item.kind === 'image').slice(0, MAX_IMAGES)
  .map(item => ({ id: item.id, label: clamp(clean(item.label).replace(/\n/g, ' '), 64).text || 'image', owner: item.owner, image: item.resource,
    aspect: item.width && item.height ? item.width / item.height : 1 }));

// Every draft image in one row: the tallest tile height at which all tiles fit, else the minimum height and as many as fit with a +N note; the row is wide enough that each tile's floored flex share holds its width.
const strip = (images: Picture[], client: TerminalClient | null | undefined): TerminalComponent[] => {
  const room = Math.max(TILE_MIN, (client?.columns ?? 80) - 4), ratio = client?.cell_px ? client.cell_px.height / client.cell_px.width : 2;
  const tallest = Math.max(TILE_ROWS[0], Math.min(TILE_ROWS[1], Math.floor((client?.rows ?? 24) / 4)));
  const absent = (picture: Picture) => `${picture.label}: no preview\nonly PNG and JPEG up to 8 MiB`;
  const more = (count: number) => count < images.length ? `${count ? `+${images.length - count} more: ` : ''}/preview image ${count + 1} to ${images.length}` : '';
  const cap = (count: number) => room - (more(count) ? cells(more(count)) + 1 : 0);
  const width = (picture: Picture, rows: number, count: number) => picture.image ? Math.min(cap(count), Math.max(TILE_MIN, Math.ceil(rows * ratio * picture.aspect)))
    : Math.max(...absent(picture).split('\n').map(cells));
  const flex = (wide: number, widest: number) => Math.max(1, Math.round(12 * wide / widest));
  const total = (rows: number, count: number) => {
    const shown = images.slice(0, count), boxes = shown.filter(picture => picture.image).map(picture => width(picture, rows, count));
    if (boxes.length && cap(count) < TILE_MIN) return Infinity;
    const widest = Math.max(1, ...boxes), weight = boxes.reduce((sum, wide) => sum + flex(wide, widest), 0);
    const share = Math.max(0, ...boxes.map(wide => Math.ceil(wide * weight / flex(wide, widest))));
    return share + shown.filter(picture => !picture.image).reduce((sum, picture) => sum + width(picture, rows, count), 0) + count - 1 + (more(count) ? cells(more(count)) + 1 : 0);
  };
  let rows = tallest, count = images.length;
  while (rows > TILE_ROWS[0] && total(rows, count) > room) rows -= 1;
  while (count > 0 && total(rows, count) > room) count -= 1;
  const wide = (picture: Picture) => width(picture, rows, count);
  const widest = Math.max(1, ...images.slice(0, count).filter(picture => picture.image).map(wide));
  const tiles = images.slice(0, count).map((picture, index): TerminalComponent => picture.image ? {
    type: 'box', id: `omd_preview_tile_${index}`, label: `${picture.label} tile`, max_width: wide(picture), flex: flex(wide(picture), widest), children: [
      { type: 'image', id: `omd_preview_thumb_${index}`, label: `${picture.label} thumbnail`, image: picture.image, alt: picture.label, height: rows, pointer: true },
      { type: 'button', id: `omd_preview_open_${index}`, label: `Preview ${picture.label}`, text: `#${index + 1}`, action: { command: 'omd_preview:preview', args: `image ${index + 1}` } },
    ] } : { type: 'text', id: `omd_preview_thumb_${index}`, label: picture.label, text: absent(picture), tone: 'muted' });
  const note: TerminalComponent[] = more(count) ? [{ type: 'text', id: 'omd_preview_more', label: 'More images', text: more(count), tone: 'muted' }] : [];
  return [{ type: 'box', id: 'omd_preview_strip', label: 'Draft image strip', style: { direction: 'row' }, children: [
    { type: 'box', id: 'omd_preview_tiles', label: 'Draft image tiles', max_width: Math.min(room, total(rows, count)), style: { direction: 'row', gap: 1 }, children: [...tiles, ...note] }] }];
};

export default function activate(api: ModAPI) {
  const thumbnails = api.settings.thumbnails !== false;
  const diagrams = ['ascii', 'off'].includes(String(api.settings.diagrams)) ? String(api.settings.diagrams) : 'unicode';
  const load = (): State => ({ inline: null, revision: 0, watch: [], hashes: {}, images: [], ...(api.state.get() as Partial<State> | null) });
  const save = (patch: Partial<State>) => api.state.set({ ...load(), ...patch } as unknown as Json);

  const render = (output: string, title: string, source?: string, markdown?: string): Rendered => {
    const watch = source !== undefined && load().watch.includes(source);
    const input = markdown === undefined ? '' : `const markdown = ${JSON.stringify(markdown)};\n`;
    const run = api.host.tryCall('exec.run', {
      program: 'node',
      argv: ['--input-type=module', '-', output, title, watch ? 'watch' : '', ...(source ? [source] : [])],
      stdin: input + api.assets.read('render.mjs').text,
      write: true,
      timeout_ms: 30_000,
    });
    if (!run.ok) return { error: run.error === 'exec_arguments_invalid' ? 'the text is too long to preview (about 48 KB at most)' : run.error };
    return run.value.exit_code === 0 ? { path: run.value.stdout } : { error: /Error: (.*)/.exec(run.value.stderr)?.[1] ?? 'render failed' };
  };

  const open = (rendered: Rendered, label: string): CommandResult => {
    if ('error' in rendered) return { display: `/preview: ${rendered.error}` };
    const opened = api.host.tryCall('terminal.open', { path: rendered.path });
    if (opened.ok && 'opened' in opened.value) return { display: `Opened ${label} in the browser` };
    return { display: `Wrote ${label} to ${rendered.path}${opened.ok ? '' : ` (${opened.error})`}` };
  };

  const show = (title: string, kind: string, text: string): CommandResult => {
    const limit = kind === 'diff' ? DIFF_BYTES : TEXT_BYTES;
    const shown = clamp(clean(text), limit);
    save({ inline: { title: clamp(clean(title), 120).text, kind, text: shown.text }, revision: load().revision + 1 });
    return shown.cut ? { display: `Showing the first ${limit / 1000} KB inline; /preview without --inline opens all of it in the browser` } : null;
  };

  const currentThread = () => {
    const before = api.host.call('store.get', { key: 'thread' });
    api.host.call('store.put', { key: 'thread', value: true, expected_revision: before?.revision ?? null });
    return api.host.call('store.get', { key: 'thread' })?.provenance.thread_id ?? null;
  };

  const responses = (limit: number): string[] => {
    const page = api.host.call('app.request', { method: 'thread/turns/list', params: { threadId: currentThread(), limit, itemsView: 'summary' } }) as { data?: Turn[] };
    return (page.data ?? []).flatMap(turn => (turn.items ?? []).filter(item => item.type === 'agentMessage').slice(-1).map(item => item.text ?? ''));
  };

  const viewImage = (picture: Picture) => picture.image
    ? save({ inline: { title: picture.label, kind: 'image', text: picture.id, image: picture.image }, revision: load().revision + 1 })
    : null;

  const preview = (words: string[]): CommandResult => {
    const inline = words.includes('--inline');
    const target = words.filter(word => !word.startsWith('--')).join(' ');
    if (words.some(word => word.startsWith('--') && word !== '--inline' && word !== '--watch')) return { display: USAGE };
    if (target.startsWith('./')) return previewFile(target.slice(2), inline, words.includes('--watch'));
    if (target === 'close') {
      save({ inline: null });
      return null;
    }
    if (target === 'unwatch') {
      save({ watch: [], hashes: {} });
      return { display: 'Stopped watching preview files' };
    }
    if (words[0] === 'server') {
      const listed = api.host.tryCall('sessions.ports', null);
      if (!listed.ok) return { display: `Server ports are unavailable here: ${listed.error}` };
      const { ports } = listed.value;
      const port = words[1] ? ports.find(item => String(item.port) === words[1]) : ports.length === 1 ? ports[0] : undefined;
      if (!port) return { display: ports.length ? `Listening: ${ports.map(item => item.port).join(', ')}; use /preview server PORT` : 'No server started by this session is listening' };
      const opened = api.host.tryCall('terminal.open', { url: `http://localhost:${port.port}` });
      return { display: opened.ok && 'opened' in opened.value ? `Opened http://localhost:${port.port}` : `Not opened${opened.ok ? '' : `: ${opened.error}`}` };
    }
    if (words[0] === 'image') {
      const draft = api.host.tryCall('composer.read', null);
      if (!draft.ok) return { display: `The draft is unavailable here: ${draft.error}` };
      const images = pictures(draft.value), picture = images[Number(words[1] ?? 1) - 1];
      save({ images });
      if (!picture) return { display: images.length ? `The draft has ${images.length} image${images.length === 1 ? '' : 's'}; use /preview image 1-${images.length}` : 'The draft has no images' };
      if (!picture.image) return { display: `${picture.label} has no preview: only PNG and JPEG images up to 8 MiB do` };
      viewImage(picture);
      return null;
    }
    if (words[0] === 'diagrams') {
      const found = responses(10).flatMap((text, index) => fences(clean(text)).flatMap(part => 'source' in part ? [{ response: index + 1, source: part.source }] : []));
      if (!words[1]) return { display: found.length ? `${found.map((item, index) => `${index + 1}. ${kindOf(item.source)} in response ${item.response}`).join('\n')}\nUse /preview diagrams N to inspect, expand or copy one` : 'No Mermaid diagrams in the last 10 responses' };
      const item = found[Number(words[1]) - 1];
      if (!item) return { display: `No diagram ${words[1]}; /preview diagrams lists them` };
      const long = size(item.source) > SOURCE_BYTES ? `Not drawn: its source is over ${SOURCE_BYTES / 1000} KB; source shown and copied up to 4 KB` : '';
      save({ inline: { title: `Diagram ${words[1]} (response ${item.response})`, kind: 'diagram', text: long, source: clamp(item.source, SOURCE_BYTES).text }, revision: load().revision + 1 });
      return null;
    }
    if (target === 'list') {
      const lines = responses(10).map((text, index) => `${index + 1}. ${text.replace(/\s+/g, ' ').slice(0, 90)}`);
      return { display: lines.join('\n') || 'No responses in this session yet' };
    }
    if (!target || /^\d+$/.test(target)) {
      const index = Math.max(1, Number(target || 1));
      const text = responses(Math.min(index, 20))[index - 1];
      if (text === undefined) return { display: `No response ${index} in this session` };
      return inline ? show(`Response ${index}`, 'markdown', text) : open(render(`${DIR}/response.html`, `Response ${index}`, undefined, text), `response ${index}`);
    }
    return previewFile(target, inline, words.includes('--watch'));
  };

  const previewFile = (path: string, inline: boolean, watched: boolean): CommandResult => {
    const file = api.host.call('workspace.stat', { paths: [path], hash: watched }).files[path];
    if (file?.kind !== 'file') return { display: `No file ${path} in the workspace` };
    if (inline) {
      if (file.size > 1_000_000) return { display: `${path} is too large to show inline; use /preview ${path}` };
      return show(path, inlineKind(path), api.host.call('workspace.read', { paths: [path] }).files[path]?.text ?? '');
    }
    if (watched) {
      const watch = [...new Set([...load().watch, path])];
      if (watch.length > MAX_WATCHES) return { display: `At most ${MAX_WATCHES} files can be watched; use /preview unwatch` };
      save({ watch, hashes: { ...load().hashes, [path]: file.sha256 ?? '' } });
    }
    const result = open(render(outputFor(path), path, path), path);
    if (watched) api.host.tryCall('events.publish', { channel: 'watch', data: null });
    return result;
  };

  const poll = (retry = false) => {
    const { watch, hashes } = load();
    if (!watch.length) {
      if (retry) api.host.tryCall('events.schedule', { key: 'poll', delay_ms: POLL_MS });
      return;
    }
    const stat = api.host.tryCall('workspace.stat', { paths: watch, hash: true });
    if (stat.ok) {
      const next = Object.fromEntries(watch.map(path => [path, stat.value.files[path]?.sha256 ?? '']));
      for (const path of watch) if (hashes[path] !== undefined && next[path] && next[path] !== hashes[path]) render(outputFor(path), path, path);
      save({ hashes: next });
    }
    api.host.tryCall('events.schedule', { key: 'poll', delay_ms: POLL_MS });
  };

  const refresh = (attachments?: number) => {
    const draft = api.host.tryCall('composer.read', null), images = draft.ok ? pictures(draft.value) : [], state = load();
    if (attachments === state.attachments && JSON.stringify(images) === JSON.stringify(state.images)) return;
    const stale = state.inline?.kind === 'image' && !images.some(picture => picture.id === state.inline!.text);
    save({ images, attachments, ...(stale ? { inline: null } : {}) });
  };

  api.command('preview', value => {
    try {
      return preview(String(value ?? '').trim().split(/\s+/).filter(Boolean));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { display: `/preview: ${error.message}` };
    }
  }, { description: 'Render a response or file as HTML (--inline shows it here), inspect Mermaid diagrams or preview draft images' });

  api.on('channel', event => { if (event.channel === 'omd_preview/watch') poll(true); });
  api.on('timer', () => poll());
  for (const event of ['start', 'resume'] as const) api.on(event, () => { poll(); if (thumbnails) refresh(); });
  if (thumbnails) {
    api.on('composer', event => { if (event.kind === 'change' && event.attachments_revision !== load().attachments) refresh(event.attachments_revision); });
  }
  api.on('component_event', event => {
    if (event.component.startsWith('omd_preview_') && event.events?.some(input => 'key' in input && input.key === 'Esc')) {
      save({ inline: null });
      return;
    }
    const index = thumbnails ? /^omd_preview_thumb_(\d+)$/.exec(event.component)?.[1] : undefined;
    const picture = index === undefined ? undefined : load().images[Number(index)];
    if (picture && event.kind === 'pointer' && event.pointer?.action === 'down' && event.pointer.button === 'left') viewImage(picture);
  });
  if (diagrams !== 'off') {
    api.intercept('render', { match: { component: 'assistant_message', lifecycle: 'final', props: { text: [api.match.glob('*\x60\x60\x60mermaid*'), api.match.glob('*~~~mermaid*')] } } }, event => {
      const { viewport, props } = event as RenderEvent<'assistant_message'>;
      const tree = presentation(props.text, diagrams === 'unicode', Math.max(20, viewport.columns - 3));
      if (!tree || tree.length > 60) return { tree: [{ type: 'native' }] };
      if (props.truncated) return { tree: [{ type: 'native' }, { type: 'box', id: 'omd_preview_diagrams', label: 'Drawn diagrams', title: 'Diagrams drawn from the start of this response', children: tree.filter(node => node.type !== 'markdown') }] };
      return { tree: [{ type: 'box', id: 'omd_preview_response', label: 'Response', children: [{ type: 'box', id: 'omd_preview_response_body', label: 'Response', children: tree }] }] };
    });
  }

  const drawing = (source: string, columns: number) => {
    try {
      const drawn = diagram(source, diagrams !== 'ascii', columns).lines.join('\n');
      if (size(drawn) > DRAWN_BYTES) throw new Error(`the drawing is over ${DRAWN_BYTES / 1000} KB`);
      return drawn;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return `Not drawn: ${error.message}`;
    }
  };

  const dialog = (inline: Inline, revision: number, columns: number): TerminalComponent[] => {
    const close: TerminalComponent = { type: 'button', id: 'omd_preview_close', label: 'Close preview', text: 'Close', action: { command: 'omd_preview:preview', args: 'close' } };
    if (inline.kind === 'image' && inline.image) return [
      { type: 'image', id: `omd_preview_image_${revision}`, label: `${inline.title} preview`, image: inline.image, alt: inline.title, height: 16 },
      { type: 'text', id: 'omd_preview_image_note', label: 'Image note', text: `${inline.title} stays in the draft; Esc or Close returns to it`, tone: 'muted' }, close];
    if (inline.kind === 'diagram') return [
      { type: 'pane', id: `omd_preview_pane_${revision}`, label: 'Diagram and source, scroll with arrows or the mouse wheel', children: [
        ...chunks((inline.text || drawing(inline.source ?? '', columns)).split('\n')).map((text, index): TerminalComponent => ({ type: 'text', id: `omd_preview_drawn_${index}`, label: 'Drawn diagram', text })),
        { type: 'code', id: 'omd_preview_source', label: 'Mermaid source', text: inline.source ?? '', language: 'mermaid' }] },
      { type: 'button', id: 'omd_preview_copy', label: 'Copy the Mermaid source', text: 'Copy source', action: { copy: inline.source || ' ', label: 'Mermaid source' } }, close];
    const id = `omd_preview_body_${revision}`;
    const body: TerminalComponent = inline.kind === 'markdown' ? { type: 'markdown', id, label: inline.title, text: inline.text }
      : inline.kind === 'diff' ? { type: 'diff', id, label: inline.title, unified: inline.text }
        : { type: 'code', id, label: inline.title, text: inline.text, language: inline.kind };
    return [{ type: 'pane', id: `omd_preview_pane_${revision}`, label: 'Preview content, scroll with arrows or the mouse wheel', children: [body] }, close];
  };

  api.on('terminal', event => {
    if (event?.event === 'startup' && load().inline) save({ inline: null });
    const { inline, revision, images } = load();
    const sites: Partial<Record<'dialog' | 'above_composer', TerminalRenderSite>> = {};
    if (inline) sites.dialog = { mode: 'replace', components: [{ type: 'dialog', id: 'omd_preview_dialog', label: 'Preview', title: inline.title, children: dialog(inline, revision, Math.min((event?.client?.columns ?? 80) - 4, 76) - 3) }] };
    if (thumbnails && images.length) sites.above_composer = { mode: 'wrap', components: [{ type: 'slot' }, {
      type: 'box', id: 'omd_preview_images', label: 'Draft images', title: `Draft image${images.length === 1 ? '' : 's'} (${images.length})`, children: strip(images, event?.client) }] };
    return Object.keys(sites).length ? { sites } : null;
  });
}

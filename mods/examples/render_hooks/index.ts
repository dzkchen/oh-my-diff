import type { ModAPI, RenderEvent } from '@oh-my-diff/mod-api';

const FRAMES = ['◐', '◓', '◑', '◒'];

export default function activate(api: ModAPI) {
  api.intercept('render', { match: { component: 'spinner' } }, event => {
    const { header, elapsed_seconds } = (event as RenderEvent<'spinner'>).props;
    return { tree: [{ type: 'line', id: 'render_hooks_spinner', label: 'Working', spans: [
      { text: `${FRAMES[elapsed_seconds % FRAMES.length]} `, tone: 'accent', bold: true },
      { text: header }, { text: ` · ${elapsed_seconds}s`, tone: 'muted' }] }] };
  });

  api.intercept('render', { match: { component: ['tool_call', 'command_output'] } }, async (event, next) => {
    const { props } = event as RenderEvent<'tool_call' | 'command_output'>;
    const name = props.kind === 'exec' ? props.command : props.kind === 'mcp' ? `${props.server}.${props.tool}` : props.tool;
    const failed = props.kind === 'exec' ? props.exit_code !== 0 : props.status === 'failed';
    const inner = await next(event);
    return { tree: [{ type: 'box', id: 'render_hooks_tool', label: `Tool ${name}`.slice(0, 128), title: `${failed ? '✗' : '⚙'} ${name}`.slice(0, 128),
      children: inner.tree }] };
  });

  api.intercept('render', { match: { component: 'assistant_message', lifecycle: 'final', props: { first: true } } }, async (event, next) => {
    const { text } = (event as RenderEvent<'assistant_message'>).props;
    const inner = await next(event);
    const words = text.split(/\s+/).filter(Boolean).length;
    return { tree: [{ type: 'text', id: 'render_hooks_words', label: 'Message length', text: `${words} words`, tone: 'muted' }, ...inner.tree] };
  });

  api.intercept('render', { match: { component: 'question', lifecycle: 'live' } }, async (event, next) => {
    const inner = await next(event);
    return { tree: [{ type: 'text', id: 'render_hooks_question', label: 'Question note', text: 'The agent is waiting for your answer.', tone: 'attention' },
      ...inner.tree] };
  });
}

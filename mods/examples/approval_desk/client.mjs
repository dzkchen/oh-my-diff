import { connect, unsupported } from '@oh-my-diff/mod-api/client';

const url = process.env.APPROVAL_DESK_URL ?? process.argv[2];
const decision = process.env.APPROVAL_DESK_DECISION ?? 'decline';
const renderer = { kind: 'gui', formats: ['svg', 'png', 'cells'], pointer: 'pixel', reducedMotion: false };
const DRAWN = ['line', 'text', 'list', 'input', 'multiselect', 'select', 'button', 'image', 'raster'];
const APPROVALS = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'];
const log = (kind, value) => console.log(JSON.stringify({ kind, ...value }));

function desk({ revision, snapshot }) {
  const components = snapshot?.view.sites?.sidebar?.components ?? [];
  for (const component of components) {
    const missing = unsupported(component, renderer, DRAWN);
    if (missing) log('unsupported', { message: missing.message });
  }
  const rows = components.find(component => component.id === 'desk_log')?.rows ?? [];
  log('desk', { revision, rows: rows.map(row => row.spans.map(span => span.text).join('')) });
}

const session = await connect({
  url, name: 'approval desk', renderer,
  onView: desk,
  onRoster: roster => log('roster', { clients: roster.map(client => client.name) }),
  onMirrored: ({ operation, arguments: args }) => log('mirrored', { operation, text: args?.text ?? null }),
  onServerRequest: (method, params) => {
    if (!APPROVALS.includes(method)) return undefined;
    log('approval', { method, threadId: params.threadId, itemId: params.itemId, command: params.command ?? null, decision });
    return { decision };
  },
  onNotification: (method, params) => {
    if (method === 'serverRequest/resolved') log('resolved', params);
    if (method === 'thread/started') session.request('thread/resume', { threadId: params.thread.id }).catch(error => log('error', { message: error.message }));
  },
  onClose: () => process.exit(0),
});

const { data } = await session.request('thread/loaded/list', {});
for (const threadId of data) await session.request('thread/resume', { threadId });
log('ready', { clientId: session.attachment.clientId, threads: data });

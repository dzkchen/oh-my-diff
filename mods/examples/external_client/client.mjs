import { readFileSync } from 'node:fs';
import { connect, unsupported } from '@oh-my-diff/mod-api/client';

const url = process.env.EXTERNAL_CLIENT_URL ?? process.argv[2];
const tokenFile = process.env.EXTERNAL_CLIENT_AUTH_FILE;
const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : undefined;
const renderer = { kind: 'text', formats: ['text'], pointer: 'none', reducedMotion: true };
const joined = spans => (spans ?? []).map(span => span.text).join('');
const draw = {
  text: component => component.text, markdown: component => component.text, code: component => component.text,
  line: component => joined(component.spans), button: component => `[${component.text}]`,
  list: (component, indent) => component.rows.map((row, index) => `${index}. ${joined(row.spans) || row.label}`).join(`\n${indent}`),
  box: component => component.title ?? component.label ?? '', pane: component => component.title ?? component.label ?? '',
};

function lines(component, indent = '') {
  const missing = unsupported(component, renderer, Object.keys(draw));
  const own = missing ? `[${missing.message}]` : draw[component.type](component, indent);
  return [`${indent}${own}`, ...(component.children ?? []).flatMap(child => lines(child, `${indent}  `))];
}

function print({ revision, snapshot }) {
  console.error(`--- revision ${revision}`);
  for (const [site, { components = [] }] of Object.entries(snapshot?.view.sites ?? {})) {
    console.error(`# ${site}`);
    for (const component of components) console.error(lines(component).join('\n'));
  }
}

let picked = false;
let session;
session = await connect({
  url, token, name: 'external_client text renderer',
  renderer,
  onView: view => {
    print(view);
    pick(view);
  },
  onRoster: roster => console.error(`clients: ${roster.map(client => client.name).join(', ')}`),
  onMirrored: ({ caller, operation, arguments: args }) => console.error(`${caller} ${operation} ${JSON.stringify(args)}`),
  onClose: () => process.exit(0),
});
pick(await session.read());

async function pick({ snapshot }) {
  if (!session || picked) return;
  const find = components => components?.flatMap(component => [component, ...find(component.children) ?? []]) ?? [];
  const rows = find(snapshot?.view.sites?.sidebar?.components).find(component => component.id === 'external_clients')?.rows ?? [];
  const self = rows.findIndex(row => row.value === session.attachment.clientId);
  if (self < 0) return;
  picked = true;
  const result = await session.action({ component: 'external_clients', row: self }).catch(error => {
    picked = false;
    return { status: error.message };
  });
  console.error(`action ${result.status}${result.outcome?.display ? `: ${result.outcome.display}` : ''}`);
}

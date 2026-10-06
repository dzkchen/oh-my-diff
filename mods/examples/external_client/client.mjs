import { readFileSync } from 'node:fs';
import { connect } from '@oh-my-diff/mod-api/client';

const url = process.env.EXTERNAL_CLIENT_URL ?? process.argv[2];
const tokenFile = process.env.EXTERNAL_CLIENT_TOKEN_FILE;
const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : undefined;
const joined = spans => (spans ?? []).map(span => span.text).join('');

function lines(component, indent = '') {
  const own = {
    text: () => component.text, markdown: () => component.text, code: () => component.text,
    line: () => joined(component.spans), button: () => `[${component.text}]`,
    list: () => component.rows.map((row, index) => `${index}. ${joined(row.spans) || row.label}`).join(`\n${indent}`),
    image: () => `[image: ${component.alt}]`, raster: () => `[raster: ${component.alt}]`,
  }[component.type]?.() ?? `${component.title ?? component.label ?? component.type}`;
  return [`${indent}${own}`, ...(component.children ?? []).flatMap(child => lines(child, `${indent}  `))];
}

function print({ revision, snapshot }) {
  console.log(`--- revision ${revision}`);
  for (const [site, { components = [] }] of Object.entries(snapshot?.view.sites ?? {})) {
    console.log(`# ${site}`);
    for (const component of components) console.log(lines(component).join('\n'));
  }
}

const session = await connect({
  url, token, name: 'external_client text renderer',
  renderer: { kind: 'text', formats: ['text'], pointer: 'none', reducedMotion: true },
  onView: print,
  onRoster: roster => console.log(`clients: ${roster.map(client => client.name).join(', ')}`),
  onMirrored: ({ caller, operation, arguments: args }) => console.log(`${caller} ${operation} ${JSON.stringify(args)}`),
  onClose: () => process.exit(0),
});

const { snapshot } = await session.read();
const rows = snapshot?.view.sites?.sidebar?.components?.find(component => component.id === 'external_clients')?.rows ?? [];
const self = rows.findIndex(row => row.value === session.attachment.clientId);
if (self >= 0) {
  const result = await session.action({ component: 'external_clients', row: self }).catch(error => ({ status: error.message }));
  console.log(`action ${result.status}${result.outcome?.display ? `: ${result.outcome.display}` : ''}`);
}

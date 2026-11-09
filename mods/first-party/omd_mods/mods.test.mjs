import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const root = new URL('./', import.meta.url);
const source = readFileSync(new URL('index.ts', root), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', root), 'utf8'));
const mod = (id, extra = {}) => ({ id, scope: 'user', description: null, installed: true, enabled: true, effective: true, pending: null, failed: null, blocked: null,
  version: '1.0.0', source: 'npm', compatible: true, conflicts: [], settings: {}, settings_schema: null, maintainer: null, contributes: { commands: [], keys: [] }, ...extra });
const logo = mod('omd_logo', { description: 'The OMD mark', settings: { size: 'big' }, settings_schema: { properties: { size: { type: 'string', enum: ['big', 'small'] }, 'max tokens': { type: 'number' } } } });

function invoke(payload, { packages = [logo], generation = 1, ui_state, state = null, ...answers } = {}) {
  const calls = [];
  const reply = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event: 'command', name: 'mods', payload, ui_state }, call => {
    calls.push(call);
    if (call.operation in answers) return answers[call.operation](call.arguments);
    if (call.operation === 'packages.list') return { generation, reload_error: null, packages };
    if (call.operation === 'packages.index') return { packages: [] };
    if (call.operation === 'commands.list') return { commands: [] };
    if (call.operation === 'plugins.components') return { components: [] };
    if (call.operation === 'terminal.panel') return { shown: true };
    assert.fail(`unexpected host call ${call.operation}`);
  });
  assert.equal(reply.error, undefined, reply.error);
  return { ...reply, calls, stored: reply.state ?? null, ui: reply.ui_state === undefined ? null : JSON.parse(reply.ui_state), panels: calls.filter(call => call.operation === 'terminal.panel').map(call => call.arguments) };
}
const operations = reply => reply.calls.map(call => call.operation);

test('a toggle leaves redrawing to the host after a change and corrects the panel when it is declined', () => {
  const opened = invoke('');
  assert.equal(opened.panels[0].items.find(item => item.id === 'user:omd_logo').value, true);
  const declined = invoke('panel user user:omd_logo false', { ui_state: opened.ui, 'packages.apply': () => ({ status: 'declined' }) });
  assert.deepEqual(operations(declined), ['packages.list', 'packages.apply', 'packages.list', 'commands.list', 'packages.list', 'plugins.components', 'terminal.panel']);
  assert.equal(declined.panels[0].items.find(item => item.id === 'user:omd_logo').value, true);
  const applied = invoke('panel user user:omd_logo false', { ui_state: opened.ui, 'packages.apply': () => ({ status: 'applied', generation: 2 }) });
  assert.deepEqual(operations(applied), ['packages.list', 'packages.apply']);
  const redrawn = invoke('panel user', { ui_state: applied.ui, generation: 2, packages: [{ ...logo, enabled: false, effective: false }] });
  assert.equal(redrawn.panels[0].items.find(item => item.id === 'user:omd_logo').value, false);
});

test('Apply sends the generation the change was reviewed at', () => {
  const reviewed = invoke('update omd_logo', { 'packages.preview': () => ({ action: 'update', id: 'omd_logo', changes: {}, grants_added: [] }) });
  let sent;
  invoke('apply', { ui_state: reviewed.ui, generation: 2, 'packages.apply': args => { sent = args; return { status: 'declined' }; } });
  assert.equal(sent.expected_generation, 1);
});

test('a typed cancel says whether it dropped a waiting review', () => {
  const reviewed = invoke('update omd_logo', { 'packages.preview': () => ({ action: 'update', id: 'omd_logo', changes: {}, grants_added: [] }) });
  const cancelled = invoke('cancel', { ui_state: reviewed.ui });
  assert.equal(cancelled.value.display, 'Cancelled');
  assert.equal(invoke('cancel', { ui_state: cancelled.ui }).value.display, 'Nothing to cancel');
});

test('a typed action while a change waits for review reports its own result and keeps the review', () => {
  const reviewed = invoke('update omd_logo', { 'packages.preview': () => ({ action: 'update', id: 'omd_logo', changes: {}, grants_added: [] }) });
  const typed = invoke('enable omd_gone', { ui_state: reviewed.ui });
  assert.match(typed.value.display, /omd_gone/);
  assert.ok(!operations(typed).includes('packages.apply'));
});

test('a panel action after its UI state was cleared keeps the chosen scope and finds the directory again', () => {
  const index = () => ({ packages: [{ id: 'omd_preview', description: 'Previews', latest: '1.2.0', installed: null, versions: [{ version: '1.2.0', blocked: null }] }] });
  let previewed;
  invoke('panel project get:omd_preview', { ui_state: null, 'packages.index': index, 'packages.preview': args => { previewed = args; return { action: 'install', id: 'omd_preview', changes: {}, grants_added: [] }; } });
  assert.deepEqual([previewed.reference, previewed.scope], ['omd_preview@1.2.0', 'project']);
});

test('a mod panel skips settings it cannot address, tells same-named mods apart and reports a removed mod', () => {
  const opened = invoke('omd_logo', { packages: [logo, mod('logo')] });
  const ids = opened.panels[0].items.map(item => item.id);
  assert.ok(ids.includes('setting:size') && !ids.some(id => id.includes('max')));
  const removed = invoke('mod user:omd_gone', { packages: [logo] });
  assert.match(removed.panels[0].subtitle, /no longer installed/);
});

test('a shadowed or off copy shows no settings and never writes them, since the host saves to the copy that is on', () => {
  const packages = [{ ...logo, effective: false }, { ...logo, scope: 'project' }];
  const shadowed = invoke('mod user:omd_logo', { packages });
  assert.ok(!shadowed.panels[0].items.some(item => item.id.startsWith('setting:')));
  assert.match(shadowed.panels[0].subtitle, /This project's copy is in use; change its settings there/);
  const typed = invoke('mod user:omd_logo setting:size small', { packages, ui_state: shadowed.ui });
  assert.ok(!operations(typed).includes('settings.write'));
  assert.match(typed.panels[0].subtitle, /change its settings there/);
  const off = invoke('mod user:omd_logo', { packages: [{ ...logo, enabled: false, effective: false }] });
  assert.match(off.panels[0].subtitle, /Turn it on to change its settings/);
  assert.ok(invoke('mod project:omd_logo', { packages }).panels[0].items.some(item => item.id === 'setting:size'));
});

test('the mods mod cannot turn itself off or remove itself', () => {
  const packages = [logo, mod('omd_mods')];
  const opened = invoke('', { packages });
  assert.equal(opened.panels[0].items.find(item => item.id === 'user:omd_mods').kind, 'action');
  const pressed = invoke('panel user user:omd_mods', { packages, ui_state: opened.ui });
  assert.deepEqual(operations(pressed), ['packages.list', 'commands.list', 'packages.list', 'plugins.components', 'terminal.panel']);
  assert.deepEqual(invoke('omd_mods', { packages }).panels[0].items.map(item => item.id), ['do:update', 'do:rollback']);
  const typed = invoke('disable omd_mods', { packages });
  assert.deepEqual(operations(typed), ['packages.list']);
});

test('installing never replaces an installed mod or the mods mod itself', () => {
  const index = () => ({ packages: [{ id: 'omd_logo', description: 'Logo', latest: '1.0.0', installed: '1.0.0', versions: [{ version: '1.0.0', blocked: null }] }] });
  const directory = invoke('panel user get:omd_logo', { ui_state: null, 'packages.index': index });
  assert.ok(!operations(directory).includes('packages.preview'));
  const source = invoke('panel user source /mods/omd_mods', { ui_state: null, 'packages.preview': () => ({ action: 'install', id: 'omd_mods', changes: {}, grants_added: [] }) });
  assert.ok(!operations(source).includes('packages.apply'));
});

test('a large directory index is read in pages and stays inside the UI state limit', () => {
  const versions = Array.from({ length: 4 }, (_, index) => ({ version: `1.${index}.0`, blocked: null }));
  const packages = Array.from({ length: 250 }, (_, index) => ({ id: `omd_package_${index}`, description: 'd'.repeat(300), latest: '1.3.0', installed: null, versions }));
  assert.ok(Buffer.byteLength(JSON.stringify(packages)) > 131_072);
  const page = ({ cursor = '0', limit = 200 }) => {
    const end = Number(cursor) + limit;
    return { packages: packages.slice(Number(cursor), end), total: packages.length, cursor: end < packages.length ? String(end) : null };
  };
  const opened = invoke('', { 'packages.index': page });
  assert.ok(Buffer.byteLength(JSON.stringify(opened.ui)) <= 65_536);
  assert.equal(opened.ui.catalog.length, 120, opened.ui.catalogError);
  assert.equal(opened.ui.catalog.at(-1).id, 'omd_package_119');
  assert.ok(operations(opened).filter(operation => operation === 'packages.index').length > 1);
  const heavy = packages.map(item => ({ ...item, support: 's'.repeat(1_000) }));
  const crowded = invoke('', { 'packages.index': ({ cursor = '0', limit }) => ({ packages: heavy.slice(Number(cursor), Number(cursor) + limit), cursor: String(Number(cursor) + limit) }) });
  assert.ok(crowded.ui.catalog.length >= 50 && crowded.ui.catalog.length < 120, `${crowded.ui.catalog.length}`);
  assert.ok(Buffer.byteLength(JSON.stringify(crowded.ui)) <= 65_536);
});

test('a required mod stays on and the directory offers installed mods only as updates', () => {
  const packages = [logo, mod('omd_update', { required: true }), mod('omd_preview')];
  const index = () => ({ packages: [
    { id: 'omd_update', description: 'Updates', latest: '1.0.0', installed: '1.0.0', versions: [{ version: '1.0.0', blocked: null }] },
    { id: 'omd_preview', description: 'Previews', latest: '1.10.0', installed: '1.9.0', versions: [{ version: '1.10.0', blocked: null }] },
    { id: 'omd_logo', description: 'Logo', latest: '1.0.0', installed: '1.1.0', versions: [{ version: '1.0.0', blocked: null }] },
    { id: 'omd_frecency', description: 'Ranks files', latest: '1.0.0', installed: null, versions: [{ version: '1.0.0', blocked: null }] }] });
  const opened = invoke('', { packages, 'packages.index': index });
  const items = opened.panels[0].items;
  assert.equal(items.find(item => item.id === 'user:omd_update').kind, 'action');
  assert.deepEqual(items.filter(item => /^(get|update):/.test(item.id)).map(item => [item.id, item.tab, item.label]),
    [['update:user:omd_preview', 'directory', 'Preview 1.9.0 → 1.10.0'], ['get:omd_frecency', 'installed', 'Frecency 1.0.0']]);
  const typed = invoke('disable omd_update', { packages });
  assert.deepEqual(operations(typed), ['packages.list']);
});

test('a route setting offers a helper model and saves the route the host added', () => {
  const advisor = mod('omd_advisor', { settings: { route: '' }, settings_schema: { properties: { route: { type: 'string', title: 'Advisor model', choices: 'routes', enum: [] } } } });
  const opened = invoke('omd_advisor', { packages: [advisor] });
  const items = opened.panels[0].items;
  let written;
  const added = invoke('mod user:omd_advisor route:route', { packages: [advisor], ui_state: opened.ui,
    'routes.add': args => { assert.deepEqual(args, { mod: 'omd_advisor' }); return { route: 'plan-gpt-6-1-sol-omd_advisor' }; },
    'settings.write': args => { written = args; return {}; } });
  assert.deepEqual(written, { id: 'omd_advisor', scope: 'user', values: { route: 'plan-gpt-6-1-sol-omd_advisor' } });
  invoke('mod user:omd_advisor route:route', { packages: [advisor], ui_state: opened.ui, 'routes.add': () => ({ status: 'declined' }) });
});

test('Choose a model lists routes.models with their efforts, marks the lead model Advisor would skip and adds the pick', () => {
  const advisor = mod('omd_advisor', { settings: { route: '' }, settings_schema: { properties: {
    route: { type: 'string', title: 'Advisor model', choices: 'routes', enum: [] }, skip_same_model: { type: 'boolean', default: true } } } });
  const models = [
    { model: 'gpt-lead', display_name: 'Lead', efforts: ['low', 'medium'], default_effort: 'medium', context_window: 258_400 },
    { model: 'bad model', display_name: 'Bad', efforts: ['low'], default_effort: 'low', context_window: 1 },
    { model: 'gpt-noeffort', display_name: 'None', efforts: [], default_effort: 'low', context_window: 1 },
    { model: 'gpt-other', display_name: 'Other', efforts: ['high', 'xhigh'], default_effort: 'xhigh', context_window: 475_000 }];
  const answers = { packages: [advisor],
    'routes.models': args => { assert.deepEqual(args, { mod: answers.target ?? 'omd_advisor' }); return models; },
    'session.info': () => ({ model: 'gpt-lead', provider: 'openai' }) };
  const opened = invoke('omd_advisor', { packages: [advisor] });
  assert.deepEqual(opened.panels[0].items.filter(item => /^(choose|route):/.test(item.id)).map(item => item.id), ['choose:route', 'route:route']);
  assert.match(opened.panels[0].items.find(item => item.id === 'route:route').description, /Advisor skips it while skip_same_model is on/);
  const choosing = invoke('mod user:omd_advisor choose:route', { ...answers, ui_state: opened.ui });
  const panel = choosing.panels[0];
  assert.deepEqual(panel.items.map(item => [item.id, item.label]), [
    ['pick:route:gpt-lead:low', 'Lead · low'], ['pick:route:gpt-lead:medium', 'Lead · medium (default)'],
    ['pick:route:gpt-other:high', 'Other · high'], ['pick:route:gpt-other:xhigh', 'Other · xhigh (default)'], ['cancel', 'Back']]);
  assert.match(panel.subtitle, /Advisor skips while it would run on the lead's model \(skip_same_model is on\), so pick a model other than gpt-lead/);
  assert.equal(panel.items[0].description, "258K context; the lead's model: Advisor would skip");
  assert.equal(panel.items[2].description, '475K context');
  let written;
  invoke('mod user:omd_advisor pick:route:gpt-other:high', { packages: [advisor], ui_state: choosing.ui,
    'routes.add': args => { assert.deepEqual(args, { mod: 'omd_advisor', model: 'gpt-other', effort: 'high' }); return { route: 'plan-gpt-other-omd_advisor' }; },
    'settings.write': args => { written = args; return {}; } });
  assert.deepEqual(written, { id: 'omd_advisor', scope: 'user', values: { route: 'plan-gpt-other-omd_advisor' } });
  const refused = invoke('mod user:omd_advisor pick:route:gpt-other:high', { packages: [advisor], ui_state: choosing.ui,
    'routes.add': () => { throw new Error('routes_add_effort_unsupported'); } });
  assert.match(refused.panels[0].subtitle, /No helper model was added \(routes_add_effort_unsupported\)/);
  assert.equal(refused.ui.choosing, null);
  const back = invoke('mod user:omd_advisor cancel', { packages: [advisor], ui_state: choosing.ui });
  assert.ok(back.panels[0].items.some(item => item.id === 'choose:route'));
  const quiet = mod('omd_quiet', { settings: { route: '' }, settings_schema: { properties: { route: { type: 'string', choices: 'routes' } } } });
  answers.target = 'omd_quiet';
  const plain = invoke('mod user:omd_quiet choose:route', { ...answers, packages: [quiet] });
  assert.doesNotMatch(plain.panels[0].subtitle, /skip/);
  assert.equal(plain.panels[0].items[0].description, "258K context; the lead's model");
  const empty = invoke('mod user:omd_quiet choose:route', { packages: [quiet], 'routes.models': () => [] });
  assert.match(empty.panels[0].subtitle, /No ChatGPT models are available/);
  const unsigned = invoke('mod user:omd_quiet choose:route', { packages: [quiet], 'routes.models': () => { throw new Error('routes_add_needs_chatgpt: sign in'); } });
  assert.match(unsigned.panels[0].subtitle, /The model list is unavailable \(routes_add_needs_chatgpt: sign in\)/);
  assert.ok(!operations(unsigned).includes('app.request'));
});

test('a mod that needs approval again says so and names the command that reviews it', () => {
  const revoked = mod('omd_preview', { enabled: false, effective: false, needs_approval: true, failed: 'capability_denied: omd_preview: approve it again with omd mods update omd_preview' });
  const item = invoke('', { packages: [revoked] }).panels[0].items.find(item => item.id === 'user:omd_preview');
  assert.equal(item.group, 'Needs attention');
  assert.match(item.description, /^needs approval/);
  assert.match(item.detail, /^needs approval · every project · Review it from a shell with omd mods update omd_preview$/);
  const subtitle = invoke('omd_preview', { packages: [revoked] }).panels[0].subtitle;
  assert.match(subtitle, /^needs approval · 1\.0\.0/);
  assert.match(subtitle, /Review it from a shell with omd mods update omd_preview\./);
  assert.doesNotMatch(subtitle, /--yes|Why it failed/);
  const project = mod('omd_preview', { scope: 'project', enabled: false, effective: false, needs_approval: true, failed: 'capability_denied' });
  const scoped = invoke('', { packages: [project] }).panels[0].items.find(item => item.id === 'project:omd_preview');
  assert.match(scoped.detail, /omd mods update omd_preview --scope project$/);
});

test('the list groups mods by state, searches their commands and reopens where it was closed', () => {
  const packages = [logo, mod('omd_usage', { enabled: false, effective: false }), mod('omd_preview', { failed: 'activation failed' })];
  const index = () => ({ packages: [{ id: 'omd_frecency', description: 'Ranks files', latest: '1.0.0', installed: null, versions: [{ version: '1.0.0', blocked: null }] }] });
  const commands = () => ({ commands: [{ command: 'usage', description: '', owner: 'omd_usage', hidden: false, args_hint: null, immediate: false, protected: false }] });
  const opened = invoke('', { packages, 'packages.index': index, 'commands.list': commands });
  const listed = opened.panels[0].items.filter(item => item.tab === 'installed').map(item => [item.id, item.group]);
  assert.deepEqual(listed, [['user:omd_preview', 'Needs attention'], ['user:omd_logo', 'On'], ['user:omd_usage', 'Off'], ['get:omd_frecency', 'Available']]);
  const usage = opened.panels[0].items.find(item => item.id === 'user:omd_usage');
  assert.equal(usage.keywords, 'omd_usage /usage');
  assert.match(usage.detail, /^off · every project · Commands: \/usage$/);
  assert.match(opened.panels[0].items.find(item => item.id === 'user:omd_preview').detail, /Why it failed: activation failed/);
  assert.equal(opened.panels[0].close_args, 'closed');
  const closed = invoke('closed user:omd_usage use', { state: { onboarded: true } });
  assert.deepEqual(operations(closed), []);
  assert.deepEqual(closed.stored, { onboarded: true, selected: 'user:omd_usage', query: 'use' });
  const reopened = invoke('', { packages, state: closed.stored });
  assert.deepEqual([reopened.panels[0].selected, reopened.panels[0].query], ['user:omd_usage', 'use']);
});

test('an identity collision warning is shown before accepting trust', () => {
  const warning = 'Same-ID copies share storage and owned credential authority';
  const result = invoke('update omd_logo', { 'packages.preview': () => ({ action: 'update', id: 'omd_logo', changes: {}, grants_added: [], identity_warning: warning }) });
  assert.ok(result.value.display.includes(warning));
  const panel = invoke('panel user', { ui_state: result.ui });
  assert.ok(JSON.stringify(panel.panels).includes(warning));
});

const theme = mod('theme', { settings: { greeting: 'hi' }, settings_schema: { properties: { greeting: { type: 'string', title: 'Greeting' }, limit: { type: 'number', title: 'Max tokens' } } },
  inherited_enabled: true, inherited_settings: { greeting: 'hi' }, overrides: { settings: {} } });

test('changes save for every terminal unless Only this terminal is chosen for that mod', () => {
  const off = { ...theme, enabled: false, effective: false };
  const sent = [];
  const answers = { packages: [off], 'packages.apply': args => { sent.push(args); return { status: 'applied', generation: 2 }; } };
  const opened = invoke('theme', { packages: [off] });
  assert.deepEqual(opened.panels[0].items.find(item => item.id === 'target'), { id: 'target', label: 'Changes apply to', kind: 'choice', value: 'shared',
    options: [{ value: 'shared', label: 'Every terminal' }, { value: 'terminal', label: 'Only this terminal' }] });
  assert.equal(opened.panels[0].items.find(item => item.id === 'enabled').label, 'On');
  const shared = invoke('mod user:theme enabled true', { ...answers, ui_state: opened.ui });
  assert.equal(sent.pop().target, undefined);
  assert.equal(shared.ui.notice, 'Theme is on.');
  const local = invoke('mod user:theme target terminal', { packages: [off], ui_state: opened.ui });
  assert.equal(local.panels[0].items.find(item => item.id === 'target').value, 'terminal');
  const toggled = invoke('mod user:theme enabled true', { ...answers, ui_state: local.ui });
  assert.equal(sent.pop().target, 'terminal');
  assert.equal(toggled.ui.notice, 'Theme is on in this terminal until you close it.');
  invoke('panel user user:theme true', { ...answers, ui_state: local.ui });
  assert.equal(sent.pop().target, 'terminal');
  invoke('panel user user:theme true', { ...answers, ui_state: opened.ui });
  assert.equal(sent.pop().target, undefined);
  const written = [];
  const write = args => { written.push(args); return { settings: args.values }; };
  const saved = invoke('mod user:theme setting:greeting yo', { packages: [theme], ui_state: opened.ui, 'settings.write': write });
  assert.deepEqual(written.pop(), { id: 'theme', scope: 'user', values: { greeting: 'yo' } });
  assert.equal(saved.ui.notice, 'Greeting saved.');
  const set = invoke('mod user:theme setting:greeting yo', { packages: [theme], ui_state: local.ui, 'settings.write': write });
  assert.deepEqual(written.pop(), { id: 'theme', scope: 'user', values: { greeting: 'yo' }, target: 'terminal' });
  assert.equal(set.ui.notice, 'Greeting set for this terminal until you close it.');
  const reverted = invoke('mod user:theme target shared', { packages: [off], ui_state: local.ui });
  assert.equal(reverted.panels[0].items.find(item => item.id === 'target').value, 'shared');
});

test('a mod with its own choices in this terminal is marked in the list and offers to use saved settings or keep them', () => {
  const plain = invoke('theme', { packages: [theme] });
  assert.doesNotMatch(plain.panels[0].subtitle, /Saved default|own choices/);
  assert.ok(!plain.panels[0].items.some(item => item.id.startsWith('do:reset') || item.id === 'do:save-defaults'));
  assert.doesNotMatch(invoke('', { packages: [theme] }).panels[0].items.find(item => item.id === 'user:theme').description ?? '', /only this terminal/);
  const own = { ...theme, overrides: { enabled: true, settings: {} } };
  assert.match(invoke('', { packages: [own] }).panels[0].items.find(item => item.id === 'user:theme').description, /only this terminal/);
  const opened = invoke('theme', { packages: [own] });
  assert.match(opened.panels[0].subtitle, /This terminal has its own choices/);
  assert.deepEqual(opened.panels[0].items.filter(item => item.id === 'do:reset' || item.id === 'do:save-defaults').map(item => item.label), ['Use saved settings', 'Keep these for every terminal']);
});

test('a mod with terminal choices keeps editing this terminal after its UI state is cleared until Every terminal is picked', () => {
  const own = { ...theme, overrides: { settings: { greeting: 'yo' } } };
  const written = [];
  const write = args => { written.push(args); return { settings: args.values }; };
  const opened = invoke('theme', { packages: [own] });
  assert.equal(opened.panels[0].items.find(item => item.id === 'target').value, 'terminal');
  invoke('mod user:theme setting:greeting hey', { packages: [own], 'settings.write': write });
  assert.equal(written.pop().target, 'terminal');
  const shared = invoke('mod user:theme target shared', { packages: [own], ui_state: opened.ui });
  assert.equal(shared.panels[0].items.find(item => item.id === 'target').value, 'shared');
  invoke('mod user:theme setting:greeting hey', { packages: [own], ui_state: shared.ui, 'settings.write': write });
  assert.equal(written.pop().target, undefined);
});

test('reset and save-defaults reviews list what changes and offer no Apply when nothing differs', () => {
  const own = { ...theme, overrides: { enabled: false, settings: { greeting: 'yo' } } };
  const changes = { target: 'shared', enabled: { before: false, after: true }, settings: [{ key: 'greeting', before: 'hi', after: 'yo' }] };
  for (const [action, note] of [['save-defaults', 'Applies to every terminal and future launches.'], ['reset', 'This terminal goes back to your saved settings.']]) {
    let request;
    const previewed = invoke(`mod user:theme do:${action}`, { packages: [own], 'packages.preview': args => { request = args; return { action, id: 'theme', changes, grants_added: [] }; } });
    assert.deepEqual([request.action, request.scope, request.target], [action, 'user', undefined]);
    const subtitle = previewed.panels[0].subtitle;
    for (const line of ['On: off → on', 'Greeting: hi → yo', note]) assert.ok(subtitle.split('\n').includes(line), subtitle);
    assert.doesNotMatch(subtitle, /no package changes/);
    let applied;
    invoke('apply', { packages: [own], ui_state: previewed.ui, 'packages.apply': args => { applied = args; return { status: 'applied', generation: 2 }; } });
    assert.equal(applied.action, action);
    const same = invoke(`mod user:theme do:${action}`, { packages: [own], 'packages.preview': () => ({ action, id: 'theme', changes: { target: 'shared', enabled: null, settings: [] }, grants_added: [] }) });
    assert.match(same.panels[0].subtitle, /Nothing to change/);
    assert.ok(!same.panels[0].items.some(item => item.id === 'apply'));
  }
});

test('a required mod keeps its settings editable and an administrator-managed one shows them read-only', () => {
  const required = { ...theme, required: true };
  const opened = invoke('theme', { packages: [required] });
  assert.ok(!opened.panels[0].items.some(item => item.id === 'enabled'));
  assert.equal(opened.panels[0].items.find(item => item.id === 'setting:greeting').kind, 'text');
  let written;
  const saved = invoke('mod user:theme setting:greeting yo', { packages: [required], 'settings.write': args => { written = args; return { settings: args.values }; } });
  assert.deepEqual(written, { id: 'theme', scope: 'user', values: { greeting: 'yo' } });
  assert.equal(saved.ui.notice, 'Greeting saved.');
  const managed = { ...theme, scope: 'managed', required: true };
  const shown = invoke('mod managed:theme', { packages: [managed] });
  assert.match(shown.panels[0].subtitle, /Your administrator manages this mod/);
  assert.deepEqual(shown.panels[0].items.filter(item => item.id.startsWith('setting:')).map(item => [item.kind, item.description]), [['action', 'hi'], ['action', 'not set']]);
  assert.ok(!shown.panels[0].items.some(item => item.id === 'target'));
  const typed = invoke('mod managed:theme setting:greeting yo', { packages: [managed], ui_state: shown.ui });
  assert.ok(!operations(typed).includes('settings.write'));
  const refused = invoke('mod user:theme setting:greeting yo', { packages: [theme], 'settings.write': () => { throw new Error('configuration_override_forbidden'); } });
  assert.doesNotMatch(refused.panels[0].subtitle, /configuration_override_forbidden/);
  for (const [error, notice] of [['grant_expired: trust the package again', 'Greeting was not saved (its permission expired; choose Trust again)'],
    ['settings_file_invalid: mode', 'Greeting was not saved (its settings file has a mistake; fix or delete the file, then try again)']])
    assert.equal(invoke('mod user:theme setting:greeting yo', { packages: [theme], 'settings.write': () => { throw new Error(error); } }).ui.notice, notice);
  for (const source of ['npm', 'selection']) {
    const expired = { ...theme, source, enabled: false, failed: 'grant_expired: trust the package again' };
    const panel = invoke('theme', { packages: [{ ...expired, needs_approval: true }] }).panels[0];
    assert.ok(panel.items.some(item => item.id === 'do:trust' && item.label === 'Trust again'), source);
    assert.match(panel.subtitle, /^needs approval [^]*Choose Trust again, or review it from a shell with omd mods update theme\./, source);
  }
});

test('a number setting asks for a number by its label', () => {
  const typed = invoke('mod user:theme setting:limit lots', { packages: [theme] });
  assert.equal(typed.ui.notice, 'Enter a number for Max tokens, like 5');
});

test('settings writes retain the selected user or project copy', () => {
  const packages = [
    mod('fixture', { scope: 'user', settings: { mode: 'user' }, settings_schema: { properties: { mode: { type: 'string' } } } }),
    mod('fixture', { scope: 'project', settings: { mode: 7 }, settings_schema: { properties: { mode: { type: 'number' } } } }),
  ];
  const written = [];
  const answer = args => { written.push(args); return { settings: args.values }; };
  invoke('mod user:fixture setting:mode chosen', { packages, 'settings.write': answer });
  invoke('mod project:fixture setting:mode 42', { packages, 'settings.write': answer });
  assert.deepEqual(written, [
    { id: 'fixture', scope: 'user', values: { mode: 'chosen' } },
    { id: 'fixture', scope: 'project', values: { mode: 42 } },
  ]);
});

test('an id installed in both scopes asks for the scope instead of acting on the first copy', () => {
  const packages = [logo, { ...logo, scope: 'project' }];
  for (const typed of ['disable omd_logo', 'omd_logo', 'mod omd_logo']) {
    const reply = invoke(typed, { packages });
    assert.match(reply.value.display, /user:omd_logo or project:omd_logo/);
    assert.ok(!operations(reply).includes('packages.apply'));
  }
  let sent;
  invoke('disable project:omd_logo', { packages, 'packages.apply': args => { sent = args; return { status: 'declined' }; } });
  assert.equal(sent.scope, 'project');
});

test('a bundled mod installed as a selection is listed once, and the directory marks experimental entries', () => {
  const packages = [logo, mod('omd_usage', { source: 'selection', enabled: false, effective: false, maintainer: 'Oh My Diff',
    contributes: { commands: [{ name: 'hud', description: 'Usage dialog' }], keys: [{ key: 'alt+a', description: 'Usage dialog' }] } })];
  const index = () => ({ packages: [
    { id: 'omd_usage', description: 'Usage', latest: '1.0.0', support: 'supported', installed: null, versions: [{ version: '1.0.0', blocked: null }] },
    { id: 'omd_btw', description: 'Side questions', latest: '1.0.0', support: 'experimental', installed: null, versions: [{ version: '1.0.0', blocked: null }] }] });
  const opened = invoke('', { packages, 'packages.index': index });
  const items = opened.panels[0].items;
  assert.deepEqual(items.filter(item => item.id.startsWith('get:')).map(item => [item.id, item.description]), [['get:omd_btw', 'Experimental · Side questions']]);
  assert.match(items.find(item => item.id === 'user:omd_usage').detail, /^off · every project · Commands: \/hud · Keys: alt\+a · By Oh My Diff$/);
  const got = invoke('panel user get:omd_usage', { packages, ui_state: opened.ui, 'packages.index': index });
  assert.match(got.ui.notice, /already installed/);
  assert.ok(!operations(got).includes('packages.preview'));
});

test('list and object settings are edited as text and saved with their type', () => {
  const privacy = mod('omd_privacy', { settings: { pii: ['email'], terminals: [{ id: 't' }], check: {} }, settings_schema: { properties: {
    pii: { type: 'array', default: [], title: 'Personal data checks' }, terminals: { type: 'array', default: [] }, check: { type: 'object', default: {} } } } });
  const opened = invoke('omd_privacy', { packages: [privacy] });
  const items = opened.panels[0].items;
  assert.deepEqual(items.map(item => item.id).slice(0, 4), ['enabled', 'setting:pii', 'setting:terminals', 'setting:check']);
  assert.ok(items.findIndex(item => item.id === 'target') > items.findIndex(item => item.id === 'setting:check'));
  assert.deepEqual(items.filter(item => item.id.startsWith('setting:')).map(item => [item.kind, item.value]), [['text', 'email'], ['text', '[{"id":"t"}]'], ['text', '{}']]);
  const written = [];
  const answers = { packages: [privacy], ui_state: opened.ui, 'settings.write': args => { written.push(args.values); return { settings: {} }; } };
  invoke('mod user:omd_privacy setting:pii email, phone ,', answers);
  invoke('mod user:omd_privacy setting:check {"program": "/bin/true"}', answers);
  invoke('mod user:omd_privacy setting:pii ["a,b"]', answers);
  assert.deepEqual(written, [{ pii: ['email', 'phone'] }, { check: { program: '/bin/true' } }, { pii: ['a,b'] }]);
  const bad = invoke('mod user:omd_privacy setting:terminals {"id": 1}', answers);
  assert.match(bad.panels[0].subtitle, /Enter JSON for terminals, like \[\]/);
  assert.equal(written.length, 3);
});

test('a plugin mod component is offered under Available and turned on with one reviewed install', () => {
  const components = () => ({ components: [
    { plugin: 'omd-anchored-edit', marketplace: 'oh-my-diff', version: '0.2.0', id: 'omd_anchored_edit', description: 'Anchored edits', sha256: 'a'.repeat(64), error: null, installed: false, enabled: false },
    { plugin: 'other', marketplace: 'm', version: '1.0.0', id: 'other', description: null, sha256: null, error: 'plugin_component_digest_mismatch', installed: false, enabled: false },
    { plugin: 'done', marketplace: 'm', version: '1.0.0', id: 'omd_logo', description: null, sha256: 'b'.repeat(64), error: null, installed: true, enabled: true }] });
  const opened = invoke('', { 'plugins.components': components });
  assert.deepEqual(opened.panels[0].items.filter(item => item.id.startsWith('plugin:')).map(item => [item.id, item.label, item.description]), [
    ['plugin:oh-my-diff/omd-anchored-edit', 'Anchored Edit (plugin)', 'Anchored edits'],
    ['plugin:m/other', 'Other (plugin)', "Can't be turned on: plugin_component_digest_mismatch"]]);
  let previewed;
  invoke('panel user plugin:oh-my-diff/omd-anchored-edit', { ui_state: opened.ui, 'plugins.components': components,
    'packages.preview': args => { previewed = args; return { action: 'install', id: 'omd_anchored_edit', changes: {}, grants_added: ['fs.write'] }; } });
  assert.deepEqual([previewed.action, previewed.source, previewed.enable], ['install', { kind: 'plugin', plugin: 'omd-anchored-edit', marketplace: 'oh-my-diff' }, true]);
});

test('the welcome card shows once on a fresh session without repeating the mod count', () => {
  const show = (state, phase) => callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event: 'terminal',
    payload: { presentation: { phase }, identity: { install_profile: 'full', mods: { active: 3, installed: 5, failed: 1 } } } }, () => assert.fail('no host calls'));
  const fresh = show(null, 'fresh');
  const texts = fresh.value.sites.welcome.components.slice(1).map(component => component.text).join('\n');
  assert.match(texts, /\/mods turns more on/);
  assert.doesNotMatch(texts, /of 5|failed/);
  assert.equal(show(null, 'resumed').value, null);
});

test('an install that could not also turn the mod on says why it is still off', () => {
  const reviewed = invoke('plugin oh-my-diff/omd-anchored-edit', { 'packages.preview': () => ({ action: 'install', id: 'omd_anchored_edit', changes: {}, grants_added: [] }) });
  const applied = invoke('apply', { ui_state: reviewed.ui, 'packages.apply': () => ({ status: 'applied', generation: 2, enabled: false, reason: 'service_provider_missing: needs lsp' }) });
  assert.match(applied.value.display, /installed but still off \(service_provider_missing: needs lsp\)/);
});

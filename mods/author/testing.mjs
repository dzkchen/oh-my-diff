import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { runScenarioObject } from './cli.mjs';

const TERMINAL = { event: 'draw', ledger: null };

const withOptions = (step, { expect, expectError, cancelled } = {}) => ({
  ...step,
  ...(expect !== undefined && { expect }),
  ...(expectError !== undefined && { expect_error: expectError }),
  ...(cancelled && { cancelled }),
});

export const clock = virtualTimeMs => ({ virtual_time_ms: virtualTimeMs });
export const environment = values => ({ environment: values });
export const settings = (id, values) => ({ settings: { [id]: values } });
export const packages = (...paths) => ({ packages: paths });
export const tiers = ({ prepend = [], append = [] }) => ({
  tiers: Object.fromEntries([...prepend.map(id => [id, 'prepend']), ...append.map(id => [id, 'append'])]),
});
export const hostOperations = operations => ({
  host_operations: Object.fromEntries(Object.entries(operations).map(([operation, replies]) => [operation, replies.map(reply => (typeof reply?.error === 'string' && Object.keys(reply).length === 1 ? reply : { result: reply }))])),
});
export const storeMock = ({ get = [], put = [], delete: remove = [] } = {}) => hostOperations({
  'store.get': get.map((value, index) => (value === null ? null : { value, revision: index + 1, provenance: { mod: 'fixture', source_sha256: '0'.repeat(64), thread_id: null, origin: 'cli', at: '1970-01-01T00:00:00Z' } })),
  'store.put': put.map((_, index) => ({ revision: index + 1 })),
  'store.delete': remove.map(() => ({ deleted: true })),
});

// Fields combine in order: host operation queues and packages append, settings and tiers merge, other fields take the last value.
export function scenario(...parts) {
  const merged = { schema: 1, steps: [] };
  for (const { host_operations: operations, packages: extra, settings: configured, tiers: tiered, steps, ...fields } of parts) {
    Object.assign(merged, fields);
    for (const [operation, replies] of Object.entries(operations ?? {})) {
      merged.host_operations = { ...merged.host_operations, [operation]: [...(merged.host_operations?.[operation] ?? []), ...replies] };
    }
    if (extra) merged.packages = [...(merged.packages ?? []), ...extra];
    if (configured) merged.settings = { ...merged.settings, ...configured };
    if (tiered) merged.tiers = { ...merged.tiers, ...tiered };
    merged.steps.push(...(steps ?? []));
  }
  return merged;
}

export const runScenario = (directory, ...parts) => runScenarioObject(directory, scenario(...parts));

export const calls = (trace, operation) => trace.host_calls.filter(call => call.operation === operation);

export const invoke = (mod, event, name, payload = null, options) => withOptions({ type: 'invoke', mod, event, name, payload }, options);
export const emit = (event, payload = null, options) => withOptions({ type: 'event', event, payload }, options);
export const advance = (ms, options) => withOptions({ type: 'advance_time', ms }, options);
export const waitUntil = (check, until, { everyMs, maxMs, ...options }) => withOptions({ type: 'wait_until', check, until, every_ms: everyMs, max_ms: maxMs }, options);
export const reload = options => withOptions({ type: 'reload' }, options);
export const state = (mod, { value, threadId, ...options } = {}) => withOptions({ type: 'state', mod, ...(value !== undefined && { value }), ...(threadId && { thread_id: threadId }) }, options);
export const mount = (mod, { payload = TERMINAL, ...options } = {}) => withOptions({ type: 'terminal_mount', mod, payload }, options);
export const component = (mod, module, { instance, props, columns, rows, events, ...options } = {}) => withOptions({ type: 'component', mod, module, ...(instance && { instance }), ...(props !== undefined && { props }), ...(columns && { columns }), ...(rows && { rows }), ...(events && { events }) }, options);

const interact = (mod, target, { payload = TERMINAL, ...options } = {}) => withOptions({ type: 'terminal_interact', mod, payload, ...target }, options);
export const key = (mod, name, options) => interact(mod, { key: name }, options);
export const activate = (mod, component, options) => interact(mod, { component }, options);
export const input = (mod, component, value, options) => interact(mod, { component, value }, options);
export const select = input;
export const pointer = (mod, component, event, { client, ...options } = {}) => interact(mod, { component, pointer: { half: null, button: null, ...event }, ...(client && { client }) }, options);
export const attach = (name, { renderer, viewport, focused, ...options } = {}) => withOptions({ type: 'client_attach', name, renderer, viewport, focused }, options);
export const detach = (id, options) => withOptions({ type: 'client_detach', id }, options);

export const coreValue = value => ({ value });
export const coreError = error => ({ error });
export const intercept = (surface, payload, { core = [], origin, ...options } = {}) => withOptions({ type: 'intercept', surface, payload, core, ...(origin && { origin }) }, options);

const roots = view => (Array.isArray(view) ? view : view?.sites ? Object.values(view.sites).flatMap(site => site.components ?? []) : [view]);
function* walk(view) {
  for (const node of roots(view)) {
    yield node;
    yield* walk(node.children ?? []);
  }
}
const matches = match => (typeof match === 'function' ? match : typeof match === 'string' ? node => node.id === match : node => Object.entries(match).every(([field, value]) => isDeepStrictEqual(node[field], value)));

export const findAll = (view, match) => [...walk(view)].filter(matches(match));
export const find = (view, match) => findAll(view, match)[0];
export function text(view) {
  const own = node => node.text ?? node.spans?.map(span => span.text).join('') ?? node.rows?.map(row => row.label).join('\n') ?? node.title ?? (typeof node.value === 'string' ? node.value : undefined);
  return roots(view).map(node => [own(node), text(node.children ?? [])].filter(Boolean).join('\n')).filter(Boolean).join('\n');
}

const link = (chain, mod) => chain.trace.find(entry => entry.mod === mod) ?? assert.fail(`no ${mod} link in ${JSON.stringify(chain.trace.map(entry => `${entry.mod}:${entry.outcome}`))}`);
export function assertWrapped(chain, mod) {
  assert.ok(link(chain, mod).attempts >= 1, `${mod} never called next`);
  assert.notEqual(chain.answered_by, mod, `${mod} answered instead of wrapping`);
  assert.ok(chain.core_calls.length >= 1, 'the chain never reached the core');
}
export function assertShortCircuit(chain, mod) {
  assert.equal(chain.answered_by, mod);
  assert.deepEqual(chain.core_calls, []);
}
export function assertFailure(chain, mod, reason) {
  const entry = link(chain, mod);
  assert.ok(!['passed', 'returned'].includes(entry.outcome), `${mod} ${entry.outcome}`);
  assert.match(entry.reason ?? '', reason);
}

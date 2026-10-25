import type { AgentSpawnRequest, ModAPI, ReasoningEffort } from '../../api.d.ts';

type Role = 'research' | 'review' | 'worker';
type Choice = { query: string; effort: ReasoningEffort | null };
type Directives = Partial<Record<Role | 'all', Choice>>;
type Model = { model: string; displayName: string; hidden: boolean; modelProvider?: string | null;
  supportedReasoningEfforts: { reasoningEffort: ReasoningEffort }[] };

const ROLES: Role[] = ['research', 'review', 'worker'];
const EFFORTS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const ROLE_WORDS: [Role, RegExp][] = [
  ['review', /\b(?:review|audit|critique|verif)/i],
  ['research', /\b(?:research|investigat|explor|look (?:up|into)|find out|survey)/i],
  ['worker', /\b(?:implement|write|edit|fix|build|code|work)/i],
];
const LEAD = /^(?:default|lead|same|inherit)/i;
const EFFORT = String.raw`(?:\s+(?:at|with)\s+(none|minimal|low|medium|high|xhigh)(?:\s+effort)?)?`;
const USE = new RegExp(String.raw`\buse\s+([a-z][\w.\- ]{0,40}?)${EFFORT}\s+(?:as|for)\s+(?:the\s+)?(?:sub-?agents?|agents?|helpers?)(?:\s+(?:to|for)\s+(\w+))?`, 'gi');
const MENTION = new RegExp(String.raw`(?<![\w.])@([a-z][\w.\-]{0,40})${EFFORT}\s+for\s+(\w+)`, 'gi');

const roleOf = (word: string | undefined): Role | 'all' => ROLE_WORDS.find(([, pattern]) => pattern.test(word ?? ''))?.[0] ?? 'all';
const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim().split(' ').filter(Boolean);

function directives(text: string): Directives {
  const found: Directives = {};
  for (const pattern of [USE, MENTION]) {
    for (const [, query, effort, role] of text.matchAll(pattern)) found[roleOf(role)] = { query: query.trim().replace(/^the\s+/i, ''), effort: (effort?.toLowerCase() ?? null) as ReasoningEffort | null };
  }
  return found;
}

function classify(spawn: AgentSpawnRequest): Role | null {
  if (spawn.definition === 'explorer') return 'research';
  if (spawn.definition === 'worker') return 'worker';
  return ROLE_WORDS.find(([, pattern]) => pattern.test(spawn.prompt))?.[0] ?? null;
}

// A task with no role words (multi-agent v2 seals it) takes the only role-specific choice, if there is exactly one.
const only = (choices: Directives) => {
  const set = ROLES.filter(role => choices[role]);
  return set.length === 1 ? choices[set[0]] : undefined;
};

function resolve(models: Model[], query: string): Model | null {
  const wanted = words(query);
  const matches = models.filter(model => {
    const known = words(`${model.model} ${model.model.replace(/-(\d+)-(\d+)/g, '-$1.$2')} ${model.displayName}`);
    return wanted.length > 0 && wanted.every(word => known.some(token => token.startsWith(word)));
  });
  return matches.find(model => model.model === query) ?? matches.find(model => !model.hidden) ?? matches[0] ?? null;
}

export default function activate(api: ModAPI) {
  const defaults: Directives = {};
  for (const role of ROLES) {
    const query = api.settings[`${role}_model`];
    const effort = api.settings[`${role}_effort`];
    if (typeof query === 'string' && query.trim()) defaults[role] = { query: query.trim(), effort: EFFORTS.includes(effort as ReasoningEffort) ? effort as ReasoningEffort : null };
  }
  const fallback = (text: string) => {
    api.host.tryCall('terminal.notice', { text, kind: 'warning', placement: 'toast', id: 'fallback' });
    api.host.tryCall('terminal.notice', { text, kind: 'warning', placement: 'transcript' });
  };
  const catalog = () => {
    const listed = api.host.tryCall('app.request', { method: 'model/list', params: { includeHidden: true } });
    return listed.ok && listed.value !== null && typeof listed.value === 'object' && 'data' in listed.value ? listed.value.data as unknown as Model[] : [];
  };

  api.intercept('input', (event, next) => {
    const found = Object.entries(directives(event.text));
    if (!found.length) return next(event);
    const models = catalog();
    const kept: Directives = {};
    for (const [role, choice] of found) {
      if (LEAD.test(choice.query) || resolve(models, choice.query)) kept[role as Role | 'all'] = choice;
      else fallback(`No model matches "${choice.query}", so ${role === 'all' ? '' : `${role} `}subagents keep the lead's model`);
    }
    if (Object.keys(kept).length) api.state.set({ ...(api.state.get() as Directives | null ?? {}), ...kept });
    return next(event);
  });

  api.intercept('agent_spawn', (spawn, next) => {
    if (spawn.origin !== 'model') return next(spawn);
    const role = classify(spawn);
    const chosen = api.state.get() as Directives | null ?? {};
    const choice = role ? chosen[role] ?? chosen.all ?? defaults[role] : chosen.all ?? only(chosen) ?? only(defaults);
    const kind = role ? `${role} subagent` : 'subagent';
    if (!choice || LEAD.test(choice.query)) return next(spawn);
    const models = catalog();
    if (spawn.model && models.some(model => model.model === spawn.model)) return next(spawn);
    const model = resolve(models, choice.query);
    if (!model) {
      fallback(`No model matches "${choice.query}", so this ${kind} runs on the lead's model`);
      return next({ ...spawn, model: null });
    }
    if (model.modelProvider) {
      const routes = api.host.tryCall('routes.list', null);
      if (!routes.ok || !routes.value.some(route => route.provider === model.modelProvider && route.roles.includes('lead') && route.available)) {
        fallback(`${model.displayName} has no usable route, so this ${kind} runs on the lead's model`);
        return next({ ...spawn, model: null });
      }
    }
    const supported = (effort: ReasoningEffort | null) => effort && model.supportedReasoningEfforts.some(option => option.reasoningEffort === effort) ? effort : null;
    const effort = choice.effort ? supported(choice.effort) : supported(spawn.effort);
    return next({ ...spawn, model: model.model, effort });
  });
}

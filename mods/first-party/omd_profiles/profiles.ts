import type { HostRoute, Json, ProviderModel, ServiceGrantUpdate } from '../../api.d.ts';

export const PROVIDER = 'omd_profiles';
export const PROTOCOLS = ['responses', 'chat', 'anthropic'];
export const URLS: Record<string, string> = { chatgpt: 'https://chatgpt.com/backend-api/codex/responses', api_key: 'https://api.openai.com/v1/responses',
  anthropic: 'https://api.anthropic.com/v1/messages' };

type Credential = { id: string; label: string; kind: string; origin?: string | null };
export type Options = { name?: string; credential?: string; protocol?: string; url?: string; model?: string; window?: unknown; paid?: unknown;
  reasoning?: boolean; cache_control?: boolean; text_only?: boolean; max_output?: unknown };
export type Profile = { name: string; protocol: string; url: string; model: string; credential: string; kind: string; window: number | null;
  reasoning: boolean; cache_control: boolean; text_only: boolean; max_output: number; paid: number[] | null; effort?: string; efforts?: string[]; router?: string };

export const NAME = /^[a-z0-9_-]{1,32}$/;
export const origin = (url: string) => {
  const authority = /^https:\/\/([^/?#]+)/i.exec(url)?.[1].toLowerCase();
  return authority ? `https://${authority.replace(/:443$/, '')}` : null;
};

export function profileEntry(options: Options, credentials: Credential[]): Profile {
  const { name, credential, protocol, url, model } = options;
  if (!NAME.test(name ?? '')) throw new Error('profile_name_invalid: lowercase letters, digits, _ or -');
  if (!PROTOCOLS.includes(protocol ?? '')) throw new Error(`profile_protocol_invalid: ${PROTOCOLS.join('|')}`);
  if (!origin(url ?? '') || !model) throw new Error('profile_url_and_upstream_model_required');
  const found = credentials.find(item => item.label === credential || item.id === credential);
  if (!found || found.kind === 'secret') throw new Error(`credential_not_enrolled: run /profile add in an OMD+ session first (${credential})`);
  if (origin(url!) !== found.origin) throw new Error(`profile_url_origin_mismatch: ${found.label} is enrolled for ${found.origin}`);
  const paid = options.paid ? String(options.paid).split(':').map(Number) : null;
  if (paid && (paid.length !== 2 || paid.some(value => !Number.isFinite(value) || value <= 0))) throw new Error('profile_paid_invalid: INPUT_USD:OUTPUT_USD per million tokens, both above zero');
  if (found.kind !== 'chatgpt' && !paid) throw new Error('profile_paid_required: API-key profiles bill per request');
  const count = (value: unknown, label: string, fallback: number | null) => {
    if (value === undefined || value === null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) throw new Error(`profile_${label}_invalid: a whole number of tokens above zero`);
    return number;
  };
  return { name: name!, protocol: protocol!, url: url!, model, credential: found.id, kind: found.kind, window: count(options.window, 'window', null),
    reasoning: options.reasoning === true, cache_control: options.cache_control === true, text_only: options.text_only === true, max_output: count(options.max_output, 'max_output', 32000)!, paid };
}

export function routeFor(profile: Profile): HostRoute {
  const window = profile.window!;
  const [input, output] = (profile.paid ?? [0, 0]).map(usd => Math.round(usd * 1_000_000));
  const reservation = profile.paid ? Math.ceil((window * input + profile.max_output * output) / 1_000_000) : 0;
  return { name: profile.name, roles: ['lead'], provider: PROVIDER, model: profile.name, reasoning_effort: profile.effort ?? 'medium',
    responses_url: `${profile.router}/responses`, data: profile as unknown as Json,
    rates: { input_microusd_per_million: input, cached_microusd_per_million: input, output_microusd_per_million: output,
      reservation_microusd: reservation, max_output_tokens: profile.max_output, input_token_ceiling: window, included_subscription: !profile.paid } };
}

export const modelFor = (profile: Profile): ProviderModel => ({ slug: profile.name, display: `${profile.name} · ${profile.model}`, context_window: profile.window!,
  efforts: profile.efforts?.length ? profile.efforts : [profile.effort ?? 'medium'], default_effort: profile.effort ?? 'medium' });

export const serviceFor = (profiles: Profile[]): ServiceGrantUpdate[] => profiles.length
  ? [{ id: PROVIDER, credentials: [...new Set(profiles.map(profile => profile.credential))], route: { ...routeFor(profiles[0]), data: undefined } }] : [];

export const profilesOf = (routes: { provider: string; data?: Json }[]): Profile[] =>
  routes.filter(route => route.provider === PROVIDER && route.data && typeof route.data === 'object').map(route => route.data as unknown as Profile);

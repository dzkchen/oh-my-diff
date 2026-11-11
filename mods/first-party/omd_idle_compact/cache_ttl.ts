import type { ModelResponse } from '../../api.d.ts';

type CacheResponse = Pick<ModelResponse, 'provider' | 'route' | 'credential' | 'requested_model' | 'served_model' | 'usage' | 'cache' | 'cost'>;
export type CacheMemo = { identity: string; ttl: number; reported: boolean; expires: number };

export const OPENAI_TTL_MS = 30 * 60_000;
export const OPENAI_LONG_TTL_MS = 12 * 3_600_000;
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'oss']);

export const cacheIdentity = (response: CacheResponse) => JSON.stringify([response.provider, response.route, response.credential, response.requested_model, response.served_model]);
export const flatBilling = (response: CacheResponse) => response.provider === 'openai' && (response.cost.basis === 'included_subscription' || response.cost.basis === 'unpriced');

export function cacheLifetime(response: CacheResponse, minutes: number, at: number, previous: CacheMemo | null): CacheMemo {
  const identity = cacheIdentity(response);
  const read = (response.cache.read_tokens ?? 0) > 0;
  const reportedSeconds = (response.usage as { omd_cache_ttl_seconds?: unknown } | null)?.omd_cache_ttl_seconds;
  let ttl = 0, reported = false;
  if (LOCAL_PROVIDERS.has(response.provider)) ttl = 0;
  else if (minutes > 0) ttl = minutes * 60_000;
  else if (flatBilling(response)) ttl = 0;
  else if (typeof reportedSeconds === 'number' && Number.isFinite(reportedSeconds) && reportedSeconds > 0) [ttl, reported] = [reportedSeconds * 1000, true];
  else if (read && previous?.reported && previous.identity === identity) [ttl, reported] = [previous.ttl, true];
  else if (response.provider === 'openai' && (read || (response.cache.write_tokens ?? 0) > 0)) ttl = OPENAI_TTL_MS;
  const long = response.provider === 'openai' && response.cost.basis !== 'included_subscription' && ttl === OPENAI_LONG_TTL_MS && read;
  const kept = previous?.ttl === ttl && previous.identity === identity ? previous.expires : 0;
  return { identity, ttl, reported, expires: long ? Math.max(kept, at + OPENAI_TTL_MS) : at + ttl };
}

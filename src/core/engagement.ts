import { DAY_MS } from '../shared/constants';
import type { ChannelId, WatchEvent } from '../shared/types';

/** A session counts half as much every this many days, so engagement follows current habits. */
export const ENGAGEMENT_HALF_LIFE_DAYS = 30;

/**
 * Engagement score in 0..1 per channel: mean completion, damped until there are a few sessions.
 * With `now`, each session is weighted by its age (half-life ENGAGEMENT_HALF_LIFE_DAYS), so a
 * channel binged last year fades and confidence keeps growing with frequent recent viewing.
 */
export function channelEngagement(events: WatchEvent[], now?: number): Map<ChannelId, number> {
  const agg = new Map<ChannelId, { sum: number; w: number }>();
  for (const ev of events) {
    if (!ev.channelId) continue;
    const w = now === undefined ? 1 : Math.pow(0.5, Math.max(0, now - ev.at) / DAY_MS / ENGAGEMENT_HALF_LIFE_DAYS);
    const a = agg.get(ev.channelId) ?? { sum: 0, w: 0 };
    a.sum += w * (ev.abandoned ? ev.completion * 0.5 : ev.completion);
    a.w += w;
    agg.set(ev.channelId, a);
  }
  const out = new Map<ChannelId, number>();
  for (const [id, { sum, w }] of agg) {
    if (w <= 0) continue;
    const confidence = 1 - Math.exp(-w / 5);
    out.set(id, (sum / w) * confidence);
  }
  return out;
}

/** A channel the user isn't subscribed to seeds Discover after this many good recent sessions... */
export const WATCH_SEED_MIN_SESSIONS = 3;
/** ...each at least this complete... */
export const WATCH_SEED_MIN_COMPLETION = 0.5;
/** ...within this window. */
export const WATCH_SEED_WINDOW_MS = 60 * DAY_MS;

/**
 * Where Discover starts from, with a weight each: every subscription (with a floor, so cold start
 * works), plus channels the user clearly watches without subscribing (their engagement, no floor).
 */
export function seedWeights(
  subscribed: Set<ChannelId>,
  engagement: Map<ChannelId, number>,
  events: WatchEvent[],
  now: number,
): Map<ChannelId, number> {
  const out = new Map<ChannelId, number>();
  for (const id of subscribed) out.set(id, subscriptionWeight(engagement.get(id)));
  const good = new Map<ChannelId, number>();
  for (const ev of events) {
    if (!ev.channelId || subscribed.has(ev.channelId) || now - ev.at > WATCH_SEED_WINDOW_MS) continue;
    if (ev.completion < WATCH_SEED_MIN_COMPLETION) continue;
    good.set(ev.channelId, (good.get(ev.channelId) ?? 0) + 1);
  }
  for (const [id, n] of good) {
    const e = engagement.get(id) ?? 0;
    if (n >= WATCH_SEED_MIN_SESSIONS && e > 0) out.set(id, e);
  }
  return out;
}

/** Baseline weight a subscription carries even with no watch history, so cold start still works. */
export const SUBSCRIPTION_BASE_WEIGHT = 0.3;

export function subscriptionWeight(engagement: number | undefined): number {
  return SUBSCRIPTION_BASE_WEIGHT + (1 - SUBSCRIPTION_BASE_WEIGHT) * (engagement ?? 0);
}

/**
 * Most a channel can get from the watch-history seed: a seeded channel ranks above one with no
 * signal, but below anything the user demonstrably finishes.
 */
export const HISTORY_SEED_MAX = 0.5;

/** Seed value for a channel watched `count` times in recent history: 1 → ~0.09, 5 → ~0.32, 15+ → ~0.5. */
export function historySeedValue(count: number): number {
  return HISTORY_SEED_MAX * (1 - Math.exp(-Math.max(0, count) / 5));
}

/**
 * Crawl priority per channel: real engagement from watch logs wherever it exists, otherwise the
 * history seed. The seed never overrides a channel with real watch logs, and it only orders
 * crawling; ranking still uses watch logs alone.
 */
export function crawlPriority(
  engagement: Map<ChannelId, number>,
  seed: Record<ChannelId, number> | undefined,
): Map<ChannelId, number> {
  const out = new Map(engagement);
  for (const [id, count] of Object.entries(seed ?? {})) {
    if (!out.has(id)) out.set(id, historySeedValue(count));
  }
  return out;
}

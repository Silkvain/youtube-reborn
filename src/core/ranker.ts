import {
  ANCHOR_MAX_AGE_MS,
  ANCHOR_MAX_IMPRESSIONS,
  ANCHOR_SLOTS,
  DAY_MS,
  FEED_SAMPLING_SHARPNESS,
  FEED_SIZE,
  IMPRESSION_DECAY,
  MAX_CHANNEL_RUN,
  MORE_LIKE_THIS_MULTIPLIER,
  SUBSCRIPTION_MIX,
  TRENDING_POOL_MS,
  TRENDING_WINDOW_MS,
} from '../shared/constants';
import type { ChannelId, Feedback, FeedItem, Reason, TrendingQueryResult, Video } from '../shared/types';
import type { RankContext, SignalSource, Via } from './sources/types';

/** Feedback multiplier for a channel: 0 hides it, "more like this" boosts it. */
export function feedbackMultiplier(fb: Feedback | undefined): number {
  if (!fb) return 1;
  return fb.kind === 'notInterested' ? 0 : MORE_LIKE_THIS_MULTIPLIER;
}

/**
 * Weighted average of every source's 0..1 score, times the feedback multiplier.
 * Subscribed and hidden channels are excluded: this is the discovery side only.
 */
export async function scoreCandidates(
  sources: SignalSource[],
  ctx: RankContext,
  feedback: Map<ChannelId, Feedback>,
  /** Per-source multipliers on the default weights (learned on the device, see sourceWeights). */
  tuning?: Map<string, number>,
): Promise<Map<ChannelId, number>> {
  const weightOf = (s: SignalSource) => s.weight * (tuning?.get(s.id) ?? 1);
  const results = await Promise.all(
    sources.map(async (s) => {
      try {
        return { s, scores: await s.score(ctx) };
      } catch (err) {
        console.error(`[YouTube Reborn] source "${s.id}" failed`, err);
        return { s, scores: new Map<ChannelId, number>() };
      }
    }),
  );
  // Sources with nothing to say (no data yet, or failed) sit out, so a new or empty source never
  // waters down the others.
  const speaking = results.filter((r) => r.scores.size > 0);
  const totalWeight = speaking.reduce((sum, r) => sum + weightOf(r.s), 0) || 1;
  const combined = new Map<ChannelId, number>();
  for (const { s, scores } of results) {
    for (const [id, v] of scores) {
      if (ctx.subscribed.has(id)) continue;
      combined.set(id, (combined.get(id) ?? 0) + (weightOf(s) * clamp01(v)) / totalWeight);
    }
  }
  for (const [id, v] of combined) {
    const m = feedbackMultiplier(feedback.get(id));
    if (m === 0) combined.delete(id);
    else combined.set(id, v * m);
  }
  return combined;
}

/**
 * Why each candidate was found: across sources, the seed (and in-between channel) that contributed
 * most, scaled by the source's weight.
 */
export async function explainCandidates(
  sources: SignalSource[],
  ctx: RankContext,
  tuning?: Map<string, number>,
): Promise<Map<ChannelId, Via>> {
  const best = new Map<ChannelId, Via>();
  for (const s of sources) {
    if (!s.explain) continue;
    const w = s.weight * (tuning?.get(s.id) ?? 1);
    let via: Map<ChannelId, Via>;
    try {
      via = await s.explain(ctx);
    } catch {
      continue;
    }
    for (const [id, v] of via) {
      const scaled = { ...v, weight: v.weight * w };
      const cur = best.get(id);
      if (!cur || scaled.weight > cur.weight) best.set(id, scaled);
    }
  }
  return best;
}

export interface FeedInput {
  now: number;
  /** Recent uploads from subscribed channels. */
  subscriptionVideos: Video[];
  /** Recent uploads from discovery candidates. */
  discoveryVideos: Video[];
  /** Candidate channel scores from scoreCandidates. */
  candidateScores: Map<ChannelId, number>;
  engagement: Map<ChannelId, number>;
  channelTitles: Map<ChannelId, string>;
  reasons?: Map<ChannelId, string | Reason>;
  /** Videos to leave out, e.g. ones the user already finished. */
  exclude?: Set<string>;
  size?: number;
  mix?: number;
  /**
   * A new random draw per Home visit: items are picked with probability rising with their score,
   * so each visit shows a different mix. Without a seed the feed is the plain top-ranked list.
   */
  seed?: number;
  /** Earlier visits each video was on screen; each one lowers its weight. */
  impressions?: Map<string, number>;
  /** The seed each discovery candidate came from: at most MAX_PER_SEED Discover items per seed. */
  seedOf?: Map<ChannelId, ChannelId>;
}

/** Discover items per seed: one subscription can't fill Discover with its neighbours. */
export const MAX_PER_SEED = 4;

const SUB_HALF_LIFE_DAYS = 4;
const DISCOVERY_HALF_LIFE_DAYS = 45;
const MAX_PER_SUB_CHANNEL = 3;
const MAX_PER_DISCOVERY_CHANNEL = 2;

function decay(ageMs: number, halfLifeDays: number): number {
  return Math.pow(0.5, Math.max(0, ageMs) / DAY_MS / halfLifeDays);
}

/** Subscription uploads: recency, boosted by how much the user engages with that channel. */
export function subscriptionItemScore(v: Video, now: number, engagement: number | undefined): number {
  return decay(now - v.publishedAt, SUB_HALF_LIFE_DAYS) * (0.5 + (engagement ?? 0));
}

/** Discovery uploads: channel score dominates; recency matters less than for subscriptions. */
export function discoveryItemScore(v: Video, now: number, channelScore: number): number {
  return channelScore * (0.3 + 0.7 * decay(now - v.publishedAt, DISCOVERY_HALF_LIFE_DAYS));
}

/**
 * A channel's standout videos first: 0.6–1.0 by how a video's views compare with that channel's
 * median (a logistic of the log ratio). Unknown views count as typical.
 */
export function standoutFactor(views: number | undefined, channelMedianViews: number | undefined): number {
  if (!views || !channelMedianViews) return 0.8;
  const x = Math.log(views / channelMedianViews);
  return 0.6 + 0.4 / (1 + Math.exp(-x));
}

/** Median view count per channel over the given videos (ignoring unknowns). */
export function channelMedianViews(videos: Video[]): Map<ChannelId, number> {
  const by = new Map<ChannelId, number[]>();
  for (const v of videos) {
    if (!v.viewCount) continue;
    const list = by.get(v.channelId) ?? [];
    list.push(v.viewCount);
    by.set(v.channelId, list);
  }
  const out = new Map<ChannelId, number>();
  for (const [id, list] of by) out.set(id, list.sort((a, b) => a - b)[Math.floor(list.length / 2)]!);
  return out;
}

/**
 * A stable random number in (0, 1) for one video in one draw: the same seed and ID always give
 * the same value, so videos arriving mid-visit slot in without reshuffling what's on screen.
 */
export function unitRandom(seed: number, id: string): number {
  let h = (seed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) + 0.5) / 4294967296;
}

/**
 * Sort key for a weighted draw without replacement (Efraimidis–Spirakis): sorting by
 * log(u) / weight gives each item a chance to come first proportional to its weight.
 */
function drawKey(seed: number, id: string, weight: number): number {
  return weight > 0 ? Math.log(unitRandom(seed, id)) / Math.pow(weight, FEED_SAMPLING_SHARPNESS) : -Infinity;
}

/**
 * A weighted draw over an ordered list: earlier items (and heavier ones) tend to come first, but
 * each seed gives a different order. Same seed, same order.
 */
export function drawOrder<T>(items: T[], seed: number, idOf: (t: T) => string, weightOf: (t: T, index: number) => number): T[] {
  return items
    .map((t, i) => ({ t, key: drawKey(seed, idOf(t), weightOf(t, i)) }))
    .sort((a, b) => b.key - a.key)
    .map(({ t }) => t);
}

function rankWithCap(scored: { v: Video; score: number }[], cap: number): Video[] {
  scored.sort((a, b) => b.score - a.score || b.v.publishedAt - a.v.publishedAt);
  const perChannel = new Map<ChannelId, number>();
  const out: Video[] = [];
  for (const { v } of scored) {
    const n = perChannel.get(v.channelId) ?? 0;
    if (n >= cap) continue;
    perChannel.set(v.channelId, n + 1);
    out.push(v);
  }
  return out;
}

/**
 * Interleave two ranked lists so that subscription items make up `mix` of every prefix
 * (as closely as possible). When one list runs out, the other fills the rest.
 */
export function interleave<T>(subs: T[], disc: T[], mix: number, size: number): { item: T; discover: boolean }[] {
  const out: { item: T; discover: boolean }[] = [];
  let i = 0;
  let j = 0;
  while (out.length < size && (i < subs.length || j < disc.length)) {
    const wantSub = i < (out.length + 1) * mix || j >= disc.length;
    if (wantSub && i < subs.length) out.push({ item: subs[i++]!, discover: false });
    else if (j < disc.length) out.push({ item: disc[j++]!, discover: true });
    else out.push({ item: subs[i++]!, discover: false });
  }
  return out;
}

/**
 * Reorder so no more than `maxRun` consecutive items share a channel. When the next item
 * would break the rule, the nearest later item from a different channel is pulled forward.
 * If nothing else is left, the remaining items are appended as-is.
 */
export function applyDiversity<T>(items: T[], channelOf: (t: T) => string, maxRun = MAX_CHANNEL_RUN): T[] {
  const pending = [...items];
  const out: T[] = [];
  while (pending.length) {
    const runChannel = out.length >= maxRun ? channelOf(out[out.length - 1]!) : null;
    const runFull =
      runChannel !== null && out.slice(-maxRun).every((t) => channelOf(t) === runChannel);
    let idx = 0;
    if (runFull) {
      idx = pending.findIndex((t) => channelOf(t) !== runChannel);
      if (idx === -1) {
        out.push(...pending);
        break;
      }
    }
    out.push(pending.splice(idx, 1)[0]!);
  }
  return out;
}

export function buildFeed(input: FeedInput): FeedItem[] {
  const { now, engagement, candidateScores, channelTitles } = input;
  const size = input.size ?? FEED_SIZE;
  const mix = input.mix ?? SUBSCRIPTION_MIX;
  const exclude = input.exclude ?? new Set<string>();
  const usable = (v: Video) => !v.isShort && !exclude.has(v.id);
  const { seed } = input;
  const seen = (v: Video) => input.impressions?.get(v.id) ?? 0;
  // Already shown and passed over: less likely each time. With a seed, the score becomes a draw.
  const weight = (v: Video, score: number) => score * Math.pow(IMPRESSION_DECAY, seen(v));
  const order = (v: Video, score: number) => (seed === undefined ? weight(v, score) : drawKey(seed, v.id, weight(v, score)));

  const subScores = new Map<string, number>();
  const subs = rankWithCap(
    input.subscriptionVideos.filter(usable).map((v) => {
      const score = subscriptionItemScore(v, now, engagement.get(v.channelId));
      subScores.set(v.id, score);
      return { v, score: order(v, score) };
    }),
    MAX_PER_SUB_CHANNEL,
  );
  const medians = channelMedianViews(input.discoveryVideos);
  const ranked = rankWithCap(
    input.discoveryVideos
      .filter((v) => usable(v) && (candidateScores.get(v.channelId) ?? 0) > 0)
      .map((v) => ({
        v,
        score: order(v, discoveryItemScore(v, now, candidateScores.get(v.channelId)!) * standoutFactor(v.viewCount, medians.get(v.channelId))),
      })),
    MAX_PER_DISCOVERY_CHANNEL,
  );
  // At most MAX_PER_SEED Discover items from any one seed's neighbourhood.
  const perSeed = new Map<ChannelId, number>();
  const disc = ranked.filter((v) => {
    const seed = input.seedOf?.get(v.channelId);
    if (!seed) return true;
    const n = perSeed.get(seed) ?? 0;
    if (n >= MAX_PER_SEED) return false;
    perSeed.set(seed, n + 1);
    return true;
  });

  // Anchors: in a drawn feed, brand-new uploads from subscriptions stay at the top until seen.
  const anchors =
    seed === undefined
      ? []
      : pickAnchors(
          subs.filter((v) => now - v.publishedAt <= ANCHOR_MAX_AGE_MS && seen(v) < ANCHOR_MAX_IMPRESSIONS),
          (v) => subScores.get(v.id) ?? 0,
        );
  const anchored = new Set(anchors.map((v) => v.id));
  const rest = subs.filter((v) => !anchored.has(v.id));

  const mixed = [
    ...anchors.map((item) => ({ item, discover: false })),
    ...interleave(rest, disc, mix, size - anchors.length),
  ];
  const diverse = applyDiversity(mixed, (m) => m.item.channelId);
  return diverse.map(({ item: v, discover }) =>
    toFeedItem(v, channelTitles, discover, discover ? input.reasons?.get(v.channelId) : undefined),
  );
}

/** Up to ANCHOR_SLOTS of the best-scored new uploads, one per channel. */
function pickAnchors(fresh: Video[], score: (v: Video) => number): Video[] {
  const channels = new Set<ChannelId>();
  const out: Video[] = [];
  for (const v of [...fresh].sort((a, b) => score(b) - score(a) || b.publishedAt - a.publishedAt)) {
    if (out.length >= ANCHOR_SLOTS) break;
    if (channels.has(v.channelId)) continue;
    channels.add(v.channelId);
    out.push(v);
  }
  return out;
}

function toFeedItem(v: Video, channelTitles: Map<ChannelId, string>, discover: boolean, why?: string | Reason): FeedItem {
  const reason = typeof why === 'string' ? { text: why } : why;
  return {
    videoId: v.id,
    title: v.title,
    channelId: v.channelId,
    channelTitle: channelTitles.get(v.channelId) ?? '',
    thumbnailUrl: v.thumbnailUrl,
    publishedAt: v.publishedAt,
    durationSec: v.durationSec,
    viewCount: v.viewCount,
    discover,
    reason: reason?.text,
    ...(reason?.channelId ? { reasonChannelId: reason.channelId } : {}),
    ...(reason?.source ? { source: reason.source } : {}),
  };
}

export interface ArchivePage {
  items: FeedItem[];
  hasMore: boolean;
  /** Read older subscriptions-feed pages before showing this one (see archiveNeedsDeeper). */
  deeper?: boolean;
}

/**
 * Older subscription uploads for scrolling past the main feed: every stored upload, newest first,
 * with the same diversity rule. `offset`/`limit` page through the list; `exclude` holds videos
 * already on screen (the main feed) or already watched.
 */
export function buildArchive(
  subscriptionVideos: Video[],
  channelTitles: Map<ChannelId, string>,
  exclude: Set<string>,
  offset: number,
  limit: number,
): ArchivePage {
  const sorted = subscriptionVideos
    .filter((v) => !v.isShort && !exclude.has(v.id))
    .sort((a, b) => b.publishedAt - a.publishedAt || a.id.localeCompare(b.id));
  const diverse = applyDiversity(sorted, (v) => v.channelId);
  const page = diverse.slice(offset, offset + limit);
  return {
    items: page.map((v) => toFeedItem(v, channelTitles, false)),
    hasMore: offset + limit < diverse.length,
  };
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

export interface TrendingInput {
  now: number;
  queries: Record<string, TrendingQueryResult>;
  maxAgeMs: number;
  /** Videos the user hid, or already watched. */
  excludeVideos: Set<string>;
  /** Channels the user said not to recommend. */
  hiddenChannels: Set<ChannelId>;
  slots: number;
  /** Extra filter, e.g. the language check. */
  accept?: (v: TrendingQueryResult['videos'][number]) => boolean;
}

/**
 * The most-viewed videos today: merge every cached search, keep each video's highest view count,
 * then take the top `slots` by views with at most one video per creator. Today's videos come
 * first; if hides or a thin day leave too few, the biggest of the last few days fill the rest.
 */
export function pickTrending(input: TrendingInput): FeedItem[] {
  const oldest = input.now - TRENDING_WINDOW_MS;
  const best = new Map<string, TrendingQueryResult['videos'][number]>();
  for (const q of Object.values(input.queries)) {
    if (input.now - q.fetchedAt > input.maxAgeMs) continue;
    for (const v of q.videos) {
      if (input.now - v.publishedAt > TRENDING_POOL_MS || input.excludeVideos.has(v.id) || input.hiddenChannels.has(v.channelId)) continue;
      if (input.accept && !input.accept(v)) continue;
      const cur = best.get(v.id);
      if (!cur || v.viewCount > cur.viewCount) best.set(v.id, v);
    }
  }
  const byViews = [...best.values()].sort((a, b) => b.viewCount - a.viewCount || a.id.localeCompare(b.id));
  const today = byViews.filter((v) => v.publishedAt >= oldest);
  const backup = byViews.filter((v) => v.publishedAt < oldest);
  const perChannel = new Set<ChannelId>();
  const out: FeedItem[] = [];
  for (const v of [...today, ...backup]) {
    if (out.length >= input.slots) break;
    if (perChannel.has(v.channelId)) continue;
    perChannel.add(v.channelId);
    out.push(toFeedItem(v, new Map([[v.channelId, v.channelTitle]]), false));
  }
  return out;
}

/**
 * The top row with Enhanced discoverability: alternate slots between YouTube's "most viewed this
 * week" (search) and what the community watched, starting with search. One video per creator,
 * no repeats; if one list runs out the other fills in.
 */
export function blendTopRow(search: FeedItem[], community: FeedItem[], slots: number): FeedItem[] {
  const out: FeedItem[] = [];
  const videos = new Set<string>();
  const creators = new Set<ChannelId>();
  const lists = [search, community];
  const next = [0, 0];
  for (let turn = 0; out.length < slots && (next[0]! < search.length || next[1]! < community.length); turn++) {
    const which = next[turn % 2]! < lists[turn % 2]!.length ? turn % 2 : 1 - (turn % 2);
    const list = lists[which]!;
    while (next[which]! < list.length) {
      const item = list[next[which]!++]!;
      if (videos.has(item.videoId) || creators.has(item.channelId)) continue;
      videos.add(item.videoId);
      creators.add(item.channelId);
      out.push(item);
      break;
    }
  }
  return out;
}

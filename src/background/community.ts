/**
 * "Enhanced discoverability": the opt-in that shares anonymous signals and downloads what
 * everyone's signals add up to. Runs from the service worker's crawl alarm.
 *
 * Off (the default) means nothing here runs and nothing is stored. On means:
 * - once a day, at a random time: "these public videos were watched" (day + rough completion),
 *   only for viewing after the user opted in;
 * - once a week, at a random time: pairs of the user's most-watched channels;
 * - each upload spends one fresh anonymous token; nothing links uploads together;
 * - downloads: the region's community trending list and the channel-graph shards that cover the
 *   user's own channels. Newer servers include the shared upload pool in those shards: recent
 *   uploads of the channels there, stored like crawled uploads so the crawler skips them.
 */
import * as db from '../core/db';
import { buildEvents, buildPairs, jitteredTime } from '../core/community';
import { COMMUNITY_API, COMMUNITY_TEST, communityPermission } from '../shared/community/config';
import { isChannelId, isVideoId, shardOf, utcDay, utcWeek, type GraphShard, type Token } from '../shared/community/protocol';
import { videoThumbnail } from '../content/innertube';
import type { Video } from '../shared/types';
import { getSettings } from '../shared/settings';
import { CommunityClient, type Fetch } from './community-client';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const TRENDING_REFRESH = 6 * HOUR;
export const GRAPH_REFRESH = DAY;
/** Channels whose graph shards are fetched: subscriptions and most-watched, best first. */
export const GRAPH_SEED_CHANNELS = 40;
/** Tokens fetched per day: one for events, one for pairs, one spare for a retry. */
const TOKENS_PER_DAY = 3;

/** A random time in [min, max] from now; 2–4 minutes in test builds. */
const later = (now: number, minMs: number, maxMs: number) =>
  COMMUNITY_TEST ? jitteredTime(now, 2 * 60_000, 4 * 60_000) : jitteredTime(now, minMs, maxMs);

export interface CommunityDeps {
  now: number;
  client: CommunityClient;
  /** Channels to fetch graph shards for, most important first. */
  seeds: string[];
}

/** Whether the feature may run right now: built in, switched on, and permission granted. */
/**
 * The user's own choice: they agreed to share (and the browser still grants the server
 * permission). Switching the whole extension off pauses sharing but doesn't change this; only
 * the Enhanced discoverability switch does.
 */
export async function communityOptedIn(): Promise<boolean> {
  const permission = communityPermission();
  if (!permission) return false;
  if (!(await getSettings()).enhancedDiscovery) return false;
  return chrome.permissions.contains({ origins: [permission] });
}

/** Whether the feature may run right now: opted in, and the extension is switched on. */
export async function communityActive(): Promise<boolean> {
  return (await getSettings()).enabled && (await communityOptedIn());
}

/** Called when the toggle changes: start fresh on opt-in, forget everything on opt-out. */
export async function onCommunityToggle(on: boolean, now = Date.now()): Promise<void> {
  if (on) {
    const cur = await db.getMeta('community');
    if (!cur?.optedInAt) await db.setMeta('community', { optedInAt: now, eventsSentThrough: now });
  } else {
    await db.setMeta('community', {});
    await db.setMeta('communityVideos', {});
    await forgetPoolUploads();
  }
}

async function takeToken(state: db.CommunityState, deps: CommunityDeps): Promise<Token> {
  const today = utcDay(deps.now);
  if (state.tokens?.epoch !== today || !state.tokens.list.length) {
    const list = await deps.client.getTokens(TOKENS_PER_DAY);
    state.tokens = { epoch: list[0]?.epoch ?? today, list };
  }
  const token = state.tokens.list.shift();
  if (!token) throw new Error('no token');
  return token;
}

/** One step of work. Returns the updated state; the caller stores it. Exported for tests. */
export async function communityStep(state: db.CommunityState, deps: CommunityDeps): Promise<db.CommunityState> {
  const { now, client } = deps;
  const s: db.CommunityState = { ...state };
  if (s.retryAt && now < s.retryAt) return s;
  try {
    // Downloads first: they're what makes the feature useful from day one.
    const region = (await db.getMeta('region')) ?? 'global';
    if (!s.trending || now - s.trending.fetchedAt > TRENDING_REFRESH || s.trending.region !== region) {
      const file = (await client.getTrending(region)) ?? (region !== 'global' ? await client.getTrending('global') : null);
      s.trending = { fetchedAt: now, region, file };
    }
    if (!s.graph || now - s.graph.fetchedAt > GRAPH_REFRESH) {
      const wanted = [...new Set(deps.seeds.slice(0, GRAPH_SEED_CHANNELS).map((c) => shardOf(c)))];
      const shards: Record<number, GraphShard> = {};
      for (const n of wanted) {
        const shard = await client.getGraphShard(n);
        if (shard) shards[n] = shard;
      }
      s.graph = { fetchedAt: now, shards };
      await storePoolUploads(shards, now);
    }

    // Uploads. Only viewing after opt-in, never before.
    const log = (await db.getAllWatchEvents()).filter((e) => e.at >= (s.optedInAt ?? now));
    s.nextEventsAt ??= later(now, HOUR / 2, 6 * HOUR);
    if (now >= s.nextEventsAt) {
      const { events, through } = buildEvents(log, s.eventsSentThrough ?? s.optedInAt ?? now, now);
      if (events.length) await client.sendEvents(await takeToken(s, deps), events);
      s.eventsSentThrough = through;
      s.nextEventsAt = later(now, 18 * HOUR, 30 * HOUR);
    }
    const week = utcWeek(now);
    if (s.pairsWeekSent !== week) {
      s.nextPairsAt ??= later(now, HOUR, 48 * HOUR);
      if (now >= s.nextPairsAt) {
        const pairs = buildPairs(log, now);
        if (pairs.length) await client.sendPairs(await takeToken(s, deps), pairs);
        s.pairsWeekSent = week;
        s.nextPairsAt = undefined;
      }
    }
    s.failures = 0;
    s.retryAt = undefined;
    s.lastOkAt = now;
  } catch (err) {
    s.failures = (s.failures ?? 0) + 1;
    s.retryAt = now + Math.min(DAY, HOUR * 2 ** Math.min(4, s.failures - 1));
    console.warn('[YouTube Reborn] enhanced discoverability: will retry later', err instanceof Error ? err.message : err);
  }
  return s;
}

/**
 * Stores the shared upload pool's videos like the crawler's own Videos-tab reads, and marks those
 * channels as read when the server fetched them, so the crawler doesn't spend requests on them.
 * Exported for tests.
 */
export async function storePoolUploads(shards: Record<number, GraphShard>, now: number): Promise<number> {
  let stored = 0;
  const pooled = (await db.getMeta('communityPool')) ?? {};
  for (const shard of Object.values(shards)) {
    for (const [channelId, entry] of Object.entries(shard.uploads ?? {})) {
      if (!isChannelId(channelId) || !Array.isArray(entry?.v)) continue;
      const existing = await db.getChannel(channelId);
      // Subscriptions come from YouTube's own subscriptions feed; the pool is for everyone else.
      if (existing?.isSubscribed) continue;
      const videos: Video[] = entry.v
        .filter(([id, title, published, duration]) => isVideoId(id) && typeof title === 'string' && published > 0 && duration > 0)
        .map(([id, title, published, duration, views]) => ({
          id,
          channelId,
          title: title.slice(0, 200),
          publishedAt: published * 1000,
          thumbnailUrl: videoThumbnail(id),
          durationSec: duration,
          viewCount: views >= 0 ? views : undefined,
        }));
      if (!videos.length) continue;
      await db.putVideos(videos);
      stored += videos.length;
      pooled[channelId] = [...new Set([...(pooled[channelId] ?? []), ...videos.map((v) => v.id)])].slice(-20);
      const fetchedAt = Math.min(now, Number(entry.f) || 0);
      await db.upsertChannel({
        id: channelId,
        title: existing?.title ? undefined : String(entry.t ?? '').slice(0, 200),
        videosTabFetchedAt: Math.max(existing?.videosTabFetchedAt ?? 0, fetchedAt) || undefined,
      });
    }
  }
  await db.setMeta('communityPool', pooled);
  return stored;
}

/**
 * Opting out: delete the pool's videos, and mark those channels unread so the crawler fetches
 * them itself if they're still worth showing.
 */
async function forgetPoolUploads(): Promise<void> {
  const pooled = (await db.getMeta('communityPool')) ?? {};
  await db.deleteVideos(Object.values(pooled).flat());
  for (const id of Object.keys(pooled)) await db.upsertChannel({ id, videosTabFetchedAt: 0 });
  await db.setMeta('communityPool', {});
}

let running = false;

/** Crawl-alarm hook. Cheap no-op unless the feature is built in, on, and permitted. */
export async function communityTick(seeds: () => Promise<string[]>, fetchFn?: Fetch): Promise<boolean> {
  if (running || !(await communityActive())) return false;
  running = true;
  try {
    const before = (await db.getMeta('community')) ?? {};
    const after = await communityStep(before, {
      now: Date.now(),
      client: new CommunityClient(COMMUNITY_API, fetchFn),
      seeds: await seeds(),
    });
    // The user may have opted out while this ran: then keep nothing. (Switching the whole
    // extension off only pauses sharing, so what was downloaded is kept.)
    if (!(await communityOptedIn())) {
      await forgetPoolUploads();
      return false;
    }
    await db.setMeta('community', after);
    return after.trending !== before.trending || after.graph !== before.graph;
  } finally {
    running = false;
  }
}

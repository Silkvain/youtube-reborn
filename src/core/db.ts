import { openDB, deleteDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { NewsStory } from '../content/innertube';
import type { Purpose } from '../shared/constants';
import type { GraphShard, Token, TrendingFile } from '../shared/community/protocol';
import type {
  Channel,
  ChannelId,
  Edge,
  Feedback,
  HandleRecord,
  HistorySeed,
  TrendingQueryResult,
  Video,
  VideoFeedback,
  WatchEvent,
  TrendingVideo,
} from '../shared/types';

export const DB_NAME = 'youtube-reborn';
export const SCHEMA_VERSION = 4;

export interface MetaValues {
  schemaVersion: number;
  lastSubsSync: number;
  /** Set while a tab is fetching subscriptions, so two tabs don't both do it. */
  subsSyncClaimedAt: number;
  loggedOut: boolean;
  /** Cached "today, by views" search results, keyed by query. */
  trendingQueries: Record<string, TrendingQueryResult>;
  /** Crawler rate limiter, including the daily request counter and per-purpose spend. */
  rateLimiter: {
    lastRequestAt: number;
    consecutiveFailures: number;
    backoffUntil: number;
    stoppedDay?: string;
    counter: { day: string; count: number };
    spent?: Partial<Record<Purpose, number>>;
  };
  /** Progress of the subscriptions-feed sync (see background/subsfeed.ts). */
  subsFeed: SubsFeedStateValue;
  /** Engagement seed read once from watch history. */
  historySeed: HistorySeed;
  /** YouTube region the user browses in (two letters), reported by the YouTube tab. */
  region: string;
  /** "Enhanced discoverability" progress and downloaded community data (empty when off). */
  community: CommunityState;
  /** YouTube's own details for community-trending videos, looked up by the crawler. */
  communityVideos: Record<string, { fetchedAt: number; video: TrendingVideo | null }>;
  /** Videos stored from the shared upload pool, per channel, so opting out can delete them. */
  communityPool: Record<ChannelId, string[]>;
  /** YouTube's News hub for the user's region: top stories in YouTube's order. */
  news: { fetchedAt: number; region: string; stories: NewsStory[] };
  /** YouTube interface language the user browses in (e.g. "en-GB"), reported by the YouTube tab. */
  language: string;
  /** On-device Discover measurement (see background/discover-stats.ts). */
  discoverStats: import('../background/discover-stats').DiscoverStats;
  /** Feed cards seen on screen: visits counted (`n`) and the last one (`at`), per video ID. */
  impressions: Record<string, { n: number; at: number }>;
}

export interface CommunityState {
  /** When the user switched it on: nothing watched before this is ever uploaded. */
  optedInAt?: number;
  /** Newest watch-event time already uploaded. */
  eventsSentThrough?: number;
  nextEventsAt?: number;
  /** Week bucket pairs were last sent for (once per week, so each person counts once). */
  pairsWeekSent?: string;
  nextPairsAt?: number;
  tokens?: { epoch: string; list: Token[] };
  trending?: { fetchedAt: number; region: string; file: TrendingFile | null };
  graph?: { fetchedAt: number; shards: Record<number, GraphShard> };
  /** Back off after failures. */
  retryAt?: number;
  failures?: number;
  lastOkAt?: number;
}

/** Stored shape of background/subsfeed.ts's SubsFeedState (kept here so db.ts has no upward import). */
export interface SubsFeedStateValue {
  lastSyncAt?: number;
  lastOkAt?: number;
  firstSyncDone: boolean;
  gaps: string[];
  backfill: string | null;
  backfillDone: boolean;
  failures: number;
  /**
   * Furthest point read so far: the oldest timeline upload seen and the token for the next older
   * page (null once the feed has no more). "Earlier from your subscriptions" reads on from here.
   */
  deepest?: { token: string | null; oldestAt: number };
  session?: {
    phase: 'top' | 'gap' | 'backfill';
    pages: number;
    phasePages: number;
    startedAt: number;
    firstRun: boolean;
  };
}

export type MetaKey = keyof MetaValues;

interface RebornDB extends DBSchema {
  channels: { key: ChannelId; value: Channel };
  edges: {
    key: [ChannelId, ChannelId, string];
    value: Edge;
    indexes: { byFrom: ChannelId; byTo: ChannelId };
  };
  videos: {
    key: string;
    value: Video;
    indexes: { byChannel: ChannelId; byPublished: number };
  };
  watchEvents: {
    key: string;
    value: WatchEvent;
    indexes: { byChannel: ChannelId; byVideo: string };
  };
  feedback: { key: ChannelId; value: Feedback };
  videoFeedback: { key: string; value: VideoFeedback };
  handles: { key: string; value: HandleRecord };
  meta: { key: MetaKey; value: { key: MetaKey; value: unknown } };
}

export type DB = IDBPDatabase<RebornDB>;

let dbPromise: Promise<DB> | null = null;

/**
 * Opens the database, running migrations in order. Each `if (oldVersion < N)` block upgrades
 * to version N; add a new block (and bump SCHEMA_VERSION) for future schema changes.
 */
export function getDB(): Promise<DB> {
  dbPromise ??= openDB<RebornDB>(DB_NAME, SCHEMA_VERSION, {
    async upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        db.createObjectStore('channels', { keyPath: 'id' });
        const edges = db.createObjectStore('edges', { keyPath: ['fromChannelId', 'toChannelId', 'type'] });
        edges.createIndex('byFrom', 'fromChannelId');
        edges.createIndex('byTo', 'toChannelId');
        const videos = db.createObjectStore('videos', { keyPath: 'id' });
        videos.createIndex('byChannel', 'channelId');
        videos.createIndex('byPublished', 'publishedAt');
        const watch = db.createObjectStore('watchEvents', { keyPath: 'id' });
        watch.createIndex('byChannel', 'channelId');
        watch.createIndex('byVideo', 'videoId');
        db.createObjectStore('feedback', { keyPath: 'channelId' });
        db.createObjectStore('handles', { keyPath: 'ref' });
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (oldVersion < 2) {
        // v2 adds Video.viewCount. Mark every channel's uploads stale so the crawler
        // refetches them (with view counts) on its next ticks instead of within 12–24 h.
        let cursor = await tx.objectStore('channels').openCursor();
        while (cursor) {
          if (cursor.value.uploadsFetchedAt !== undefined) {
            const { uploadsFetchedAt: _stale, ...rest } = cursor.value;
            await cursor.update(rest);
          }
          cursor = await cursor.continue();
        }
      }
      if (oldVersion < 3) {
        // v3: "not interested" can target one video instead of the whole channel.
        db.createObjectStore('videoFeedback', { keyPath: 'videoId' });
      }
      if (oldVersion < 4) {
        // v4: subscription uploads come from YouTube's subscriptions feed, which includes
        // durations, so the per-channel durations bookkeeping is gone. Existing videos (from
        // RSS) stay; they aren't marked inSubsFeed, so the first feed sync runs as a first run
        // (a few pages plus a 30-day backfill) instead of stopping on them.
        let cursor = await tx.objectStore('channels').openCursor();
        while (cursor) {
          const value = cursor.value as Channel & { durationsFetchedAt?: number };
          if (value.durationsFetchedAt !== undefined) {
            const { durationsFetchedAt: _gone, ...rest } = value;
            await cursor.update(rest);
          }
          cursor = await cursor.continue();
        }
      }
    },
    blocking() {
      // Another context wants a newer version: close so it can upgrade.
      void dbPromise?.then((db) => db.close());
      dbPromise = null;
    },
  })
    .then(async (db) => {
      await db.put('meta', { key: 'schemaVersion', value: SCHEMA_VERSION });
      return db;
    })
    .catch((err: unknown) => {
      // Don't cache a failed open: let the next call try again.
      dbPromise = null;
      throw err;
    });
  return dbPromise;
}

export async function getMeta<K extends MetaKey>(key: K): Promise<MetaValues[K] | undefined> {
  const row = await (await getDB()).get('meta', key);
  return row?.value as MetaValues[K] | undefined;
}

export async function setMeta<K extends MetaKey>(key: K, value: MetaValues[K]): Promise<void> {
  await (await getDB()).put('meta', { key, value });
}

export async function clearAll(): Promise<void> {
  const db = await getDB();
  db.close();
  dbPromise = null;
  await deleteDB(DB_NAME);
}

// ---- Channels ----

export async function getChannel(id: ChannelId): Promise<Channel | undefined> {
  return (await getDB()).get('channels', id);
}

export async function getAllChannels(): Promise<Channel[]> {
  return (await getDB()).getAll('channels');
}

/** Insert or merge a channel; never downgrades isSubscribed or erases known fields. */
export async function upsertChannel(patch: Partial<Channel> & { id: ChannelId }): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('channels', 'readwrite');
  const existing = await tx.store.get(patch.id);
  const merged: Channel = {
    title: '',
    isSubscribed: false,
    ...existing,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== '')),
    id: patch.id,
  };
  await tx.store.put(merged);
  await tx.done;
}

/** Replace the subscribed set: listed channels become subscribed, all others unsubscribed. */
export async function replaceSubscriptions(
  subs: { id: ChannelId; title: string; handle?: string; thumbnailUrl?: string }[],
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('channels', 'readwrite');
  const ids = new Set(subs.map((s) => s.id));
  for (const ch of await tx.store.getAll()) {
    if (ch.isSubscribed && !ids.has(ch.id)) await tx.store.put({ ...ch, isSubscribed: false });
  }
  for (const s of subs) {
    const existing = await tx.store.get(s.id);
    await tx.store.put({
      ...existing,
      id: s.id,
      title: s.title || existing?.title || '',
      handle: s.handle ?? existing?.handle,
      thumbnailUrl: s.thumbnailUrl ?? existing?.thumbnailUrl,
      isSubscribed: true,
    });
  }
  await tx.done;
}

// ---- Edges ----

export async function getAllEdges(): Promise<Edge[]> {
  return (await getDB()).getAll('edges');
}

/**
 * Replace all edges of `type` originating at `from` with `next`, keeping firstSeenAt for
 * edges that already existed. Used after each crawl so edges reflect the latest page state.
 */
export async function replaceEdgesFrom(
  from: ChannelId,
  type: Edge['type'],
  next: Omit<Edge, 'firstSeenAt' | 'fromChannelId' | 'type'>[],
  now: number,
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('edges', 'readwrite');
  const existing = (await tx.store.index('byFrom').getAll(from)).filter((e) => e.type === type);
  const byTo = new Map(existing.map((e) => [e.toChannelId, e]));
  const keep = new Set(next.map((n) => n.toChannelId));
  for (const e of existing) {
    if (!keep.has(e.toChannelId)) await tx.store.delete([e.fromChannelId, e.toChannelId, e.type]);
  }
  for (const n of next) {
    if (n.toChannelId === from) continue;
    await tx.store.put({
      fromChannelId: from,
      toChannelId: n.toChannelId,
      type,
      firstSeenAt: byTo.get(n.toChannelId)?.firstSeenAt ?? now,
      lastSeenAt: n.lastSeenAt,
      count: n.count,
      ...(n.sibling ? { sibling: true } : {}),
    });
  }
  await tx.done;
}

/** Most video IDs kept per mention edge. */
const MAX_MENTION_VIDEOS = 20;

/**
 * Record description mentions: `from`'s video `videoId` (published `at`) links to each target.
 * Counts distinct videos, so reading the same description twice (RSS, then the watch page)
 * never inflates an edge. Edges stored before v4 carry only a count; that count is kept as a floor.
 */
export async function addMentions(
  from: ChannelId,
  mentions: { toChannelId: ChannelId; videoId: string; at: number }[],
  now: number,
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('edges', 'readwrite');
  for (const m of mentions) {
    if (m.toChannelId === from) continue;
    const existing = await tx.store.get([from, m.toChannelId, 'mention']);
    const videos = new Set(existing?.videos ?? []);
    videos.add(m.videoId);
    const list = [...videos].slice(-MAX_MENTION_VIDEOS);
    const legacy = existing && !existing.videos ? existing.count : 0;
    await tx.store.put({
      fromChannelId: from,
      toChannelId: m.toChannelId,
      type: 'mention',
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: Math.max(existing?.lastSeenAt ?? 0, m.at),
      count: Math.max(legacy, list.length),
      videos: list,
    });
  }
  await tx.done;
}

export async function putEdge(edge: Edge): Promise<void> {
  if (edge.fromChannelId === edge.toChannelId) return;
  const db = await getDB();
  const tx = db.transaction('edges', 'readwrite');
  const existing = await tx.store.get([edge.fromChannelId, edge.toChannelId, edge.type]);
  await tx.store.put({ ...edge, firstSeenAt: existing?.firstSeenAt ?? edge.firstSeenAt });
  await tx.done;
}

// ---- Videos ----

export async function putVideos(videos: Video[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('videos', 'readwrite');
  for (const v of videos) {
    const existing = await tx.store.get(v.id);
    await tx.store.put({
      ...existing,
      ...v,
      durationSec: v.durationSec ?? existing?.durationSec,
      viewCount: v.viewCount ?? existing?.viewCount,
    });
  }
  await tx.done;
}

/** Of `ids`, the ones already stored from the subscriptions feed. */
export async function knownFeedVideoIds(ids: string[]): Promise<Set<string>> {
  const db = await getDB();
  const tx = db.transaction('videos', 'readonly');
  const out = new Set<string>();
  for (const id of ids) if ((await tx.store.get(id))?.inSubsFeed) out.add(id);
  await tx.done;
  return out;
}

/** Fill in durations for videos already stored; never adds videos or touches other fields. */
export async function setDurations(entries: { id: string; durationSec?: number }[]): Promise<number> {
  const db = await getDB();
  const tx = db.transaction('videos', 'readwrite');
  let n = 0;
  for (const { id, durationSec } of entries) {
    if (!durationSec) continue;
    const v = await tx.store.get(id);
    if (v && v.durationSec !== durationSec) {
      await tx.store.put({ ...v, durationSec });
      n++;
    }
  }
  await tx.done;
  return n;
}

/** Refresh title and view count of videos already stored; never adds a video. */
export async function updateStoredVideos(videos: Video[]): Promise<number> {
  const db = await getDB();
  const tx = db.transaction('videos', 'readwrite');
  let n = 0;
  for (const v of videos) {
    const existing = await tx.store.get(v.id);
    if (!existing) continue;
    await tx.store.put({ ...existing, title: v.title || existing.title, viewCount: v.viewCount ?? existing.viewCount });
    n++;
  }
  await tx.done;
  return n;
}

export async function getVideosSince(since: number): Promise<Video[]> {
  return (await getDB()).getAllFromIndex('videos', 'byPublished', IDBKeyRange.lowerBound(since));
}

/** Delete these videos, except any the subscriptions feed also delivered. */
export async function deleteVideos(ids: string[]): Promise<number> {
  const db = await getDB();
  const tx = db.transaction('videos', 'readwrite');
  let n = 0;
  for (const id of ids) {
    const v = await tx.store.get(id);
    if (v && !v.inSubsFeed) {
      await tx.store.delete(id);
      n++;
    }
  }
  await tx.done;
  return n;
}

/** Delete videos published before `olderThan`, except those from channels in `keepChannels`. */
export async function pruneVideos(olderThan: number, keepChannels: Set<ChannelId> = new Set()): Promise<number> {
  const db = await getDB();
  const tx = db.transaction('videos', 'readwrite');
  let n = 0;
  let cursor = await tx.store.index('byPublished').openCursor(IDBKeyRange.upperBound(olderThan, true));
  while (cursor) {
    if (!keepChannels.has(cursor.value.channelId)) {
      await cursor.delete();
      n++;
    }
    cursor = await cursor.continue();
  }
  await tx.done;
  return n;
}

// ---- Watch events ----

export async function putWatchEvent(ev: WatchEvent): Promise<void> {
  await (await getDB()).put('watchEvents', ev);
}

export async function getAllWatchEvents(): Promise<WatchEvent[]> {
  return (await getDB()).getAll('watchEvents');
}

// ---- Feedback ----

export async function putFeedback(fb: Feedback): Promise<void> {
  await (await getDB()).put('feedback', fb);
}

export async function getAllFeedback(): Promise<Feedback[]> {
  return (await getDB()).getAll('feedback');
}

export async function deleteFeedback(channelId: ChannelId): Promise<void> {
  await (await getDB()).delete('feedback', channelId);
}

export async function putVideoFeedback(fb: VideoFeedback): Promise<void> {
  await (await getDB()).put('videoFeedback', fb);
}

export async function deleteVideoFeedback(videoId: string): Promise<void> {
  await (await getDB()).delete('videoFeedback', videoId);
}

export async function getAllVideoFeedback(): Promise<VideoFeedback[]> {
  return (await getDB()).getAll('videoFeedback');
}

// ---- Handles ----

export async function getHandle(ref: string): Promise<HandleRecord | undefined> {
  return (await getDB()).get('handles', ref);
}

export async function putHandle(rec: HandleRecord): Promise<void> {
  await (await getDB()).put('handles', rec);
}

export async function getAllHandles(): Promise<HandleRecord[]> {
  return (await getDB()).getAll('handles');
}

export async function count(store: 'channels' | 'edges' | 'videos' | 'watchEvents'): Promise<number> {
  return (await getDB()).count(store);
}

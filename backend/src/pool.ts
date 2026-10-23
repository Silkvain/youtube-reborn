/**
 * The shared upload pool: recent long-form uploads of channels in the published community graph,
 * fetched from the official YouTube Data API v3 and embedded in the graph shards, so each device
 * gets candidates for those channels without crawling them.
 *
 * - Only channels that are already in the published graph (so past the contributor threshold) are
 *   fetched. A dormant server publishes no graph, so it fetches nothing.
 * - Cost: about 1 quota unit per channel (its long-form uploads playlist) plus 1 per 50 videos
 *   (durations and views). Google refuses requests past the daily quota; it never bills.
 * - YouTube API Services policies: stored API data is refreshed regularly and anything older
 *   than 30 days is dropped, never published.
 */
import { isChannelId, isVideoId, type PoolChannel, type PoolVideo } from '../../src/shared/community/protocol';

/** Newest long-form uploads kept per channel. */
export const POOL_VIDEOS_PER_CHANNEL = 4;
/** Channels fetched per pool run: well under the Free plan's 50 outgoing requests per run. */
export const POOL_CHANNELS_PER_RUN = 36;
/** Quota units used per UTC day at most (Google's default is 10,000). */
export const POOL_DAILY_UNITS = 9_000;
/** A channel is re-fetched once its entry is this old. */
export const POOL_REFRESH_MS = 86_400_000;
/** Entries older than this are never published (YouTube API policy) and are re-fetched first. */
export const POOL_MAX_AGE_MS = 30 * 86_400_000;
/** Neighbours per channel whose uploads are embedded in a shard, strongest first. */
export const POOL_NEIGHBOURS_EMBEDDED = 15;
const MAX_TITLE = 200;

const API = 'https://www.googleapis.com/youtube/v3';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchedUploads {
  /** Channel → its uploads, or null when the channel has no long-form uploads (or is gone). */
  results: [string, PoolChannel | null][];
  units: number;
  /** Google said the daily quota is used up: stop until tomorrow. */
  quotaHit: boolean;
}

/** "PT1H2M3S" → 3723. Unparseable → 0. */
export function parseIsoDuration(s: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s);
  if (!m) return 0;
  const [, d, h, min, sec] = m.map((x) => Number(x ?? 0));
  return d! * 86_400 + h! * 3600 + min! * 60 + sec!;
}

async function quotaExceeded(res: Response): Promise<boolean> {
  if (res.status !== 403 && res.status !== 429) return false;
  const text = await res.text().catch(() => '');
  return /quotaExceeded|rateLimitExceeded|dailyLimitExceeded/.test(text) || res.status === 429;
}

/** Recent long-form uploads for each channel. The key is sent to Google only. */
export async function fetchUploads(channels: string[], key: string, fetchFn: Fetch, now: number): Promise<FetchedUploads> {
  const out: FetchedUploads = { results: [], units: 0, quotaHit: false };
  const latest = new Map<string, string[]>();
  for (const channel of channels) {
    if (!isChannelId(channel)) continue;
    // "UULF" + the channel ID's tail is the channel's long-form uploads: no Shorts, no live streams.
    const playlist = `UULF${channel.slice(2)}`;
    const res = await fetchFn(
      `${API}/playlistItems?part=contentDetails&maxResults=${POOL_VIDEOS_PER_CHANNEL}&playlistId=${playlist}&fields=items(contentDetails(videoId))&key=${key}`,
    );
    out.units += 1;
    if (await quotaExceeded(res)) {
      out.quotaHit = true;
      break;
    }
    if (res.status === 404) {
      out.results.push([channel, null]);
      continue;
    }
    if (!res.ok) continue; // try again on a later run
    const body = (await res.json()) as { items?: { contentDetails?: { videoId?: string } }[] };
    latest.set(channel, (body.items ?? []).map((i) => i.contentDetails?.videoId).filter(isVideoId));
  }

  const ids = [...latest.values()].flat();
  const details = new Map<string, { video: PoolVideo; channelTitle: string; channelId: string }>();
  for (let i = 0; i < ids.length && !out.quotaHit; i += 50) {
    const res = await fetchFn(
      `${API}/videos?part=snippet,contentDetails,statistics&id=${ids.slice(i, i + 50).join(',')}` +
        `&fields=items(id,snippet(channelId,channelTitle,title,publishedAt,liveBroadcastContent),contentDetails(duration),statistics(viewCount))&key=${key}`,
    );
    out.units += 1;
    if (await quotaExceeded(res)) {
      out.quotaHit = true;
      break;
    }
    if (!res.ok) continue;
    const body = (await res.json()) as {
      items?: {
        id?: string;
        snippet?: { channelId?: string; channelTitle?: string; title?: string; publishedAt?: string; liveBroadcastContent?: string };
        contentDetails?: { duration?: string };
        statistics?: { viewCount?: string };
      }[];
    };
    for (const it of body.items ?? []) {
      const s = it.snippet;
      if (!isVideoId(it.id) || !s?.title || !s.channelId || (s.liveBroadcastContent ?? 'none') !== 'none') continue;
      const duration = parseIsoDuration(it.contentDetails?.duration ?? '');
      const published = Date.parse(s.publishedAt ?? '');
      if (!duration || !Number.isFinite(published)) continue;
      details.set(it.id, {
        video: [it.id, s.title.slice(0, MAX_TITLE), Math.floor(published / 1000), duration, Number(it.statistics?.viewCount ?? 0) || 0],
        channelTitle: (s.channelTitle ?? '').slice(0, MAX_TITLE),
        channelId: s.channelId,
      });
    }
  }

  // Only channels whose video details were fetched are stored; the rest are retried later.
  for (const [channel, videoIds] of latest) {
    if (out.quotaHit && videoIds.some((v) => !details.has(v))) continue;
    const found = videoIds.map((v) => details.get(v)).filter((d) => d?.channelId === channel);
    if (!found.length) {
      out.results.push([channel, videoIds.length ? { t: '', f: now, v: [] } : null]);
      continue;
    }
    found.sort((a, b) => b!.video[2] - a!.video[2]);
    out.results.push([channel, { t: found[0]!.channelTitle, f: now, v: found.map((d) => d!.video) }]);
  }
  return out;
}

/** Channels whose uploads go into a shard: its own channels and their strongest neighbours. */
export function embeddedChannels(neighbours: Record<string, [string, number, number?][]>): Set<string> {
  const out = new Set<string>();
  for (const [channel, list] of Object.entries(neighbours)) {
    out.add(channel);
    for (const [n] of list.slice(0, POOL_NEIGHBOURS_EMBEDDED)) out.add(n);
  }
  return out;
}

/** A stored entry worth publishing: has videos and is within the API policy's 30 days. */
export function publishable(entry: PoolChannel | null | undefined, now: number): entry is PoolChannel {
  return !!entry && entry.v.length > 0 && now - entry.f < POOL_MAX_AGE_MS;
}

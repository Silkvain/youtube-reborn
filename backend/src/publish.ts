/**
 * Builds the public files from the aggregates. Pure functions over snapshots, so they're testable
 * without Cloudflare. Nothing below the contributor threshold is ever published.
 */
import { GRAPH_SHARDS, shardOf, type GraphShard, type TrendingEntry, type TrendingFile } from '../../src/shared/community/protocol';
import type { Aggregate } from './objects';
import { noisyCount, noisyValue, type PrivacyParams } from './privacy';

export const TRENDING_DAYS = 7;
export const TRENDING_LIMIT = 100;
export const GRAPH_WEEKS = 4;
export const NEIGHBOURS_PER_CHANNEL = 50;
/**
 * Link strength = co-watch count / sqrt((popularity_a + K)(popularity_b + K)), where popularity is
 * how many pair-contributions a channel appears in. Dividing by popularity (Davidson et al. 2010,
 * §2.2) stops a few giant channels leading every list; K damps tiny, noisy channels.
 */
export const POPULARITY_SHRINK = 50;
/** One person's weekly upload has at most 11 pairs containing a given channel (top 12 channels). */
export const POPULARITY_SENSITIVITY = 11;

/**
 * Trending keys are `t|{day}|{region}|{videoId}`. Sums each video's contributors over the given
 * days, per region and for "global", and publishes the videos that clear the threshold.
 */
export async function buildTrending(
  entries: [string, Aggregate][],
  days: Set<string>,
  period: string,
  p: PrivacyParams,
  now: number,
): Promise<TrendingFile[]> {
  type Acc = { n: number; meta?: Aggregate['meta'] };
  const byRegion = new Map<string, Map<string, Acc>>();
  const add = (region: string, video: string, a: Aggregate) => {
    const m = byRegion.get(region) ?? new Map<string, Acc>();
    const cur = m.get(video) ?? { n: 0 };
    cur.n += a.n;
    cur.meta ??= a.meta;
    m.set(video, cur);
    byRegion.set(region, m);
  };
  for (const [key, a] of entries) {
    const [, day, region, video] = key.split('|');
    if (!day || !region || !video || !days.has(day)) continue;
    add(region, video, a);
    add('global', video, a);
  }
  const files: TrendingFile[] = [];
  for (const [region, videos] of byRegion) {
    const published: TrendingEntry[] = [];
    for (const [v, acc] of videos) {
      const n = await noisyCount(acc.n, `trending|${period}|${region}|${v}`, p);
      if (n === null) continue;
      published.push({ v, c: String(acc.meta?.c ?? ''), n });
    }
    published.sort((a, b) => b.n - a.n || a.v.localeCompare(b.v));
    files.push({ generatedAt: now, region, videos: published.filter((x) => x.c).slice(0, TRENDING_LIMIT) });
  }
  return files;
}

/**
 * Pair keys are `p|{week}|{a}|{b}`. Sums each pair's contributors over the given weeks, publishes
 * pairs that clear the threshold as neighbours of both channels, and splits channels into shards.
 */
export async function buildGraph(
  entries: [string, Aggregate][],
  weeks: Set<string>,
  period: string,
  p: PrivacyParams,
  now: number,
): Promise<GraphShard[]> {
  const pairs = new Map<string, number>();
  for (const [key, a] of entries) {
    const [, week, ca, cb] = key.split('|');
    if (!week || !ca || !cb || !weeks.has(week)) continue;
    const k = `${ca}|${cb}`;
    pairs.set(k, (pairs.get(k) ?? 0) + a.n);
  }
  // Popularity per channel (internal only, noised: it shapes what is published).
  const exactPopularity = new Map<string, number>();
  for (const [k, count] of pairs) {
    for (const c of k.split('|')) exactPopularity.set(c, (exactPopularity.get(c) ?? 0) + count);
  }
  const popularity = new Map<string, number>();
  for (const [c, v] of exactPopularity) popularity.set(c, await noisyValue(v, `pop|${period}|${c}`, p, POPULARITY_SENSITIVITY));

  const neighbours = new Map<string, [string, number, number][]>();
  const link = (from: string, to: string, n: number, s: number) => {
    const list = neighbours.get(from) ?? [];
    list.push([to, n, s]);
    neighbours.set(from, list);
  };
  for (const [k, count] of pairs) {
    const n = await noisyCount(count, `pair|${period}|${k}`, p);
    if (n === null) continue;
    const [a, b] = k.split('|') as [string, string];
    const s = n / Math.sqrt(((popularity.get(a) ?? 0) + POPULARITY_SHRINK) * ((popularity.get(b) ?? 0) + POPULARITY_SHRINK));
    const strength = Math.round(s * 1e4) / 1e4;
    link(a, b, n, strength);
    link(b, a, n, strength);
  }
  const shards = new Map<number, GraphShard>();
  for (const [channel, list] of neighbours) {
    list.sort((x, y) => y[2] - x[2] || y[1] - x[1] || x[0].localeCompare(y[0]));
    const s = shardOf(channel, GRAPH_SHARDS);
    const shard = shards.get(s) ?? { generatedAt: now, shard: s, neighbours: {} };
    shard.neighbours[channel] = list.slice(0, NEIGHBOURS_PER_CHANNEL);
    shards.set(s, shard);
  }
  return [...shards.values()];
}

/** Remove blocked videos and channels from a trending file. */
export function blockTrending(file: TrendingFile, blocked: Set<string>): TrendingFile {
  if (!blocked.size) return file;
  return { ...file, videos: file.videos.filter((v) => !blocked.has(v.v) && !blocked.has(v.c)) };
}

/** Remove blocked channels (as keys, neighbours and pooled uploads) and blocked videos from a graph shard. */
export function blockGraph(shard: GraphShard, blocked: Set<string>): GraphShard {
  if (!blocked.size) return shard;
  const neighbours: GraphShard['neighbours'] = {};
  for (const [channel, list] of Object.entries(shard.neighbours)) {
    if (blocked.has(channel)) continue;
    const kept = list.filter(([n]) => !blocked.has(n));
    if (kept.length) neighbours[channel] = kept;
  }
  if (!shard.uploads) return { ...shard, neighbours };
  const uploads: NonNullable<GraphShard['uploads']> = {};
  for (const [channel, entry] of Object.entries(shard.uploads)) {
    if (blocked.has(channel)) continue;
    const v = entry.v.filter(([id]) => !blocked.has(id));
    if (v.length) uploads[channel] = { ...entry, v };
  }
  return { ...shard, neighbours, uploads };
}

/** Uploads accepted over the trending window, from per-day counter keys `u|{day}`. */
export function uploadsInWindow(entries: [string, Aggregate][], days: Set<string>): number {
  let n = 0;
  for (const [key, a] of entries) if (days.has(key.split('|')[1] ?? '')) n += a.n;
  return n;
}

/**
 * What "Enhanced discoverability" uploads, computed on the device from local watch logs. Pure
 * functions: given the same logs they always produce the same payloads, which the tests pin down.
 */
import {
  MAX_EVENTS_PER_SUBMISSION,
  MAX_PAIRS_PER_SUBMISSION,
  completionBucket,
  isChannelId,
  isVideoId,
  utcDay,
  type ChannelPair,
  type WatchedEvent,
} from '../shared/community/protocol';
import type { ChannelId, WatchEvent } from '../shared/types';

/** A session counts as "watched" from this many seconds (or 25% of a short video). */
export const MIN_WATCHED_SEC = 60;
/** Channels considered for pairs: the most-watched over this window. */
export const PAIRS_WINDOW_MS = 28 * 86_400_000;
export const PAIRS_TOP_CHANNELS = 12;
/** Fewer channels than this and no pairs are sent (a pair list that short is too revealing). */
export const PAIRS_MIN_CHANNELS = 3;

const DAY_MS = 86_400_000;

function watched(e: WatchEvent): boolean {
  return e.watchedSec >= MIN_WATCHED_SEC || (e.completion >= 0.25 && e.watchedSec >= 10);
}

/**
 * Watched events since `since` (exclusive), at most one per video, oldest days first. Only the
 * last 3 days count (the server rejects older ones). Returns the payload and the newest `at`
 * included, so the caller can remember where it got to.
 */
export function buildEvents(log: WatchEvent[], since: number, now: number): { events: WatchedEvent[]; through: number } {
  const earliest = Math.max(since, now - 2 * DAY_MS - (now % DAY_MS));
  const seen = log.filter((e) => e.at > since && e.at <= now);
  const recent = seen
    .filter((e) => e.at >= earliest && watched(e) && isVideoId(e.videoId) && isChannelId(e.channelId))
    .sort((a, b) => a.at - b.at);
  const best = new Map<string, WatchEvent>();
  for (const e of recent) {
    const cur = best.get(e.videoId);
    if (!cur || e.completion > cur.completion) best.set(e.videoId, e);
  }
  const events = [...best.values()]
    .slice(-MAX_EVENTS_PER_SUBMISSION)
    .map((e): WatchedEvent => ({ v: e.videoId, c: e.channelId, d: utcDay(e.at), q: completionBucket(e.completion) }));
  // Everything looked at counts as done, including sessions too short to send.
  const through = seen.reduce((max, e) => Math.max(max, e.at), since);
  return { events, through };
}

/**
 * Pairs of the user's most-watched channels over the last 4 weeks. Weight 1–3 reflects how much
 * of both channels the user watched (the weaker of the two decides). No times, no videos.
 */
export function buildPairs(log: WatchEvent[], now: number): ChannelPair[] {
  const seconds = new Map<ChannelId, number>();
  for (const e of log) {
    if (e.at < now - PAIRS_WINDOW_MS || e.at > now || !watched(e) || !isChannelId(e.channelId)) continue;
    seconds.set(e.channelId, (seconds.get(e.channelId) ?? 0) + e.watchedSec);
  }
  const top = [...seconds.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, PAIRS_TOP_CHANNELS);
  if (top.length < PAIRS_MIN_CHANNELS) return [];
  // Watch time → strength: under 20 min = 1, under 2 h = 2, more = 3.
  const strength = (sec: number): 1 | 2 | 3 => (sec >= 7200 ? 3 : sec >= 1200 ? 2 : 1);
  const pairs: ChannelPair[] = [];
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const [a, sa] = top[i]!;
      const [b, sb] = top[j]!;
      const w = Math.min(strength(sa), strength(sb)) as 1 | 2 | 3;
      pairs.push(a < b ? [a, b, w] : [b, a, w]);
    }
  }
  return pairs.slice(0, MAX_PAIRS_PER_SUBMISSION);
}

/** A random time in [from + minMs, from + maxMs): uploads never line up with a viewing session. */
export function jitteredTime(from: number, minMs: number, maxMs: number, random = Math.random): number {
  return from + minMs + Math.floor(random() * (maxMs - minMs));
}

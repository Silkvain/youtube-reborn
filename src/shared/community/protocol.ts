/**
 * Wire protocol for "Enhanced discoverability", shared by the extension and the backend.
 *
 * Privacy rules this protocol is built around (see docs/enhanced-discoverability.md):
 * - No user ID, ever. Uploads carry a one-time anonymous token (blindrsa.ts) and nothing that
 *   links two uploads together.
 * - Viewing history never leaves the device. Uploads are (a) "these public videos were watched
 *   today" events and (b) pairs of channels the same person watches, computed on the device.
 * - Events carry a calendar day, never a time; pairs carry no time at all.
 * - The server publishes only aggregates that enough people contributed to, with noise added.
 */

export const API_VERSION = 'v1';

/** Tokens the server signs per request, and per day per client (it asks once a day). */
export const MAX_TOKENS_PER_REQUEST = 3;
export const MAX_EVENTS_PER_SUBMISSION = 50;
export const MAX_PAIRS_PER_SUBMISSION = 66; // 12 channels → 12·11/2 pairs
/** Published channel graph is split into this many cacheable files by hash of channel ID. */
export const GRAPH_SHARDS = 256;
/** Nonce size for tokens. */
export const NONCE_BYTES = 32;

export interface KeyResponse {
  /** UTC day the key is valid for, "YYYY-MM-DD". */
  epoch: string;
  /** Modulus and exponent, base64url big-endian. */
  n: string;
  e: string;
}

export interface TokenRequest {
  epoch: string;
  /** Blinded values, base64url, one per token wanted. */
  blinded: string[];
}

export interface TokenResponse {
  signatures: string[];
}

/** A spent token: the nonce the client hashed and the unblinded signature over it. */
export interface Token {
  epoch: string;
  nonce: string;
  sig: string;
}

/** Completion bucket: 0 = <25%, 1 = 25–50%, 2 = 50–90%, 3 = ≥90%. */
export type CompletionBucket = 0 | 1 | 2 | 3;

export interface WatchedEvent {
  /** Video ID. */
  v: string;
  /** Channel ID. */
  c: string;
  /** UTC day watched, "YYYY-MM-DD". */
  d: string;
  q: CompletionBucket;
}

export interface EventsSubmission {
  token: Token;
  events: WatchedEvent[];
}

/** [channelA, channelB, weight 1–3] with channelA < channelB. */
export type ChannelPair = [string, string, 1 | 2 | 3];

export interface PairsSubmission {
  token: Token;
  pairs: ChannelPair[];
}

/**
 * IDs only: titles and durations are looked up from YouTube by the extension, so nobody can make
 * the published list show text of their choosing.
 */
export interface TrendingEntry {
  v: string;
  /** Channel the uploader said it belongs to; the extension re-checks it against YouTube. */
  c: string;
  /** Noisy count of people who watched it this week. */
  n: number;
}

export interface TrendingFile {
  generatedAt: number;
  region: string;
  videos: TrendingEntry[];
  /** Not enough people sharing yet: nothing is published until there are. */
  dormant?: boolean;
}

export interface GraphShard {
  generatedAt: number;
  shard: number;
  /**
   * channel → [neighbour, noisy co-watch count, strength?][], strongest first. `strength` (newer
   * servers) is the count normalised by both channels' popularity, so giant channels don't lead
   * every list; clients fall back to the count when it's missing.
   */
  neighbours: Record<string, [string, number, number?][]>;
  /**
   * The shared upload pool (newer servers): recent long-form uploads of the channels in this
   * shard and of their strongest neighbours, fetched by the server from the official YouTube
   * Data API. Public data only; it saves each device crawling those channels itself.
   */
  uploads?: Record<string, PoolChannel>;
  dormant?: boolean;
}

/** [videoId, title, publishedAt (unix seconds), durationSec, viewCount] */
export type PoolVideo = [string, string, number, number, number];

export interface PoolChannel {
  /** Channel title. */
  t: string;
  /** When the server fetched these uploads (ms). */
  f: number;
  /** Newest first. */
  v: PoolVideo[];
}

// ---- shared helpers ----

export const isVideoId = (s: unknown): s is string => typeof s === 'string' && /^[\w-]{11}$/.test(s);
export const isChannelId = (s: unknown): s is string => typeof s === 'string' && /^UC[\w-]{22}$/.test(s);
export const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
export const isRegion = (s: unknown): s is string => typeof s === 'string' && /^([A-Z]{2}|global)$/.test(s);

export function utcDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** ISO-ish week bucket ("YYYY-Www" by Monday-start UTC weeks) used to age out pairs. */
export function utcWeek(t: number): string {
  const d = new Date(t);
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
  return `W${utcDay(monday.getTime())}`;
}

/** FNV-1a: stable, fast, identical in the extension and the Worker. */
export function shardOf(channelId: string, shards = GRAPH_SHARDS): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < channelId.length; i++) {
    h ^= channelId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % shards;
}

export function completionBucket(completion: number): CompletionBucket {
  if (completion >= 0.9) return 3;
  if (completion >= 0.5) return 2;
  if (completion >= 0.25) return 1;
  return 0;
}

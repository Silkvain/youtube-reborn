/**
 * Thin client for YouTube's internal "InnerTube" API (/youtubei/v1/...) plus the public RSS feed.
 * Every YouTube-specific response shape lives in this file, so API changes are fixed in one place
 * and caught by the fixture tests in test/innertube.test.ts.
 *
 * Shapes observed on www.youtube.com (WEB client 2.20261014.01.00, Oct 2026):
 * - POST /youtubei/v1/navigation/resolve_url {url}         -> endpoint.browseEndpoint.browseId
 * - POST /youtubei/v1/browse {browseId: UC...}              -> channel Home tab; "Featured Channels"
 *   is a shelfRenderer > horizontalListRenderer of gridChannelRenderer items
 * - POST /youtubei/v1/browse {browseId, params: VIDEOS_TAB} -> richGridRenderer of lockupViewModel
 * - POST /youtubei/v1/browse {browseId: "FEchannels"}       -> subscriptions (needs the session);
 *   logged out it returns responseContext.mainAppWebResponseContext.loggedOut = true
 * - POST /youtubei/v1/browse {continuation: token}          -> next page (continuationItemRenderer)
 * - GET /feeds/videos.xml?channel_id=UC...                  -> last 15 uploads with full descriptions
 * - POST /youtubei/v1/search {query, params: THIS_WEEK_BY_VIEWS} -> videoRenderer items, sorted
 *   by view count. (FEtrending, the old Trending page, now returns 400.)
 * - POST /youtubei/v1/browse {browseId: "FEsubscriptions"}  -> the user's subscriptions feed (needs
 *   the session). Video items are parsed with the same lockupViewModel / videoRenderer code as
 *   everything else; Shorts come as shortsLockupViewModel shelves and are skipped. NOT yet
 *   captured signed in: the fixture is synthetic, built from public lockups (see README).
 * - POST /youtubei/v1/browse {browseId: "FEhistory"}        -> watch history (needs the session);
 *   same item parsers, only channel IDs are kept. Also not yet captured signed in.
 * - Watch page data (ytInitialData on load, yt-navigate-finish detail.response.response after SPA
 *   navigation): videoSecondaryInfoRenderer.attributedDescription.commandRuns carry description
 *   @handle and channel links already resolved to browseEndpoint.browseId (verified Oct 2026).
 * - Video lockups (lockupViewModel) on watch pages now show views as "10M" with the full
 *   "10 million views" only in accessibilityLabel (Oct 2026); both are read.
 *
 * Parsers are defensive: a missing field skips that item, never throws.
 */
import { DAY_MS, FALLBACK_CLIENT_VERSION } from '../shared/constants';
import type { ChannelId, TrendingVideo, Video, YtClientConfig } from '../shared/types';

export const ORIGIN = 'https://www.youtube.com';
/** Channel "Videos" tab browse params, as sent by the web client. */
export const VIDEOS_TAB_PARAMS = 'EgZ2aWRlb3PyBgQKAjoA';
export const SUBSCRIPTIONS_BROWSE_ID = 'FEchannels';
export const SUBSCRIPTION_FEED_BROWSE_ID = 'FEsubscriptions';
export const HISTORY_BROWSE_ID = 'FEhistory';
/**
 * Search filter "Upload date: Today" + "Sort by: View count", as the web client encodes it.
 * "Today" is a rolling 24 hours, not since midnight (checked 2026-10-16).
 */
export const SEARCH_TODAY_BY_VIEWS = 'CAMSAggC';
/**
 * YouTube's own News hub: the day's top stories for the requesting region (`gl`), in YouTube's
 * editorial order, each a shelf of videos from several outlets. Localised per country (checked
 * 2026-10-17 for GB, NL, DE, FR and US).
 */
export const NEWS_HUB_BROWSE_ID = 'UCYfdidRxbB8Qhf0Nx7ioOYw';

export const DEFAULT_CLIENT: YtClientConfig = {
  clientName: 'WEB',
  clientNameId: 1,
  clientVersion: FALLBACK_CLIENT_VERSION,
  hl: 'en',
  gl: 'US',
  loggedIn: false,
};

/**
 * Every parser reads English relative times and view counts ("2 days ago", "5.8M views"), so
 * requests whose answers get parsed ask for English whatever the page language is.
 */
export function parsingClient(cfg: YtClientConfig): YtClientConfig {
  return { ...cfg, hl: 'en' };
}

export class InnertubeError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 for a network failure. */
    readonly status: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------
// Transport

export interface PostOptions {
  /** Send cookies + SAPISIDHASH so the request runs as the logged-in user (content scripts only). */
  authorization?: string;
  credentials?: RequestCredentials;
  signal?: AbortSignal;
}

export async function innertubePost(
  endpoint: string,
  body: Record<string, unknown>,
  cfg: YtClientConfig,
  opts: PostOptions = {},
): Promise<unknown> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-youtube-client-name': String(cfg.clientNameId),
    'x-youtube-client-version': cfg.clientVersion,
  };
  if (opts.authorization) {
    headers.authorization = opts.authorization;
    headers['x-origin'] = ORIGIN;
    headers['x-goog-authuser'] = cfg.sessionIndex ?? '0';
    if (cfg.delegatedSessionId) headers['x-goog-pageid'] = cfg.delegatedSessionId;
  }
  const context = {
    client: {
      clientName: cfg.clientName,
      clientVersion: cfg.clientVersion,
      hl: cfg.hl,
      gl: cfg.gl,
      ...(cfg.visitorData && opts.authorization ? { visitorData: cfg.visitorData } : {}),
    },
  };
  let res: Response;
  try {
    res = await fetch(`${ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ context, ...body }),
      credentials: opts.credentials ?? 'omit',
      signal: opts.signal,
    });
  } catch (err) {
    throw new InnertubeError(`network error: ${String(err)}`, 0);
  }
  if (!res.ok) throw new InnertubeError(`${endpoint} returned ${res.status}`, res.status);
  return res.json();
}

/** Builds the `SAPISIDHASH` Authorization header from the SAPISID cookie, as the web client does. */
export async function sapisidAuthorization(cookie: string, now = Date.now()): Promise<string | null> {
  const jar = new Map(
    cookie.split(/;\s*/).map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i), kv.slice(i + 1)] as const;
    }),
  );
  const sapisid = jar.get('SAPISID') ?? jar.get('__Secure-3PAPISID');
  if (!sapisid) return null;
  const ts = Math.floor(now / 1000);
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${ts} ${sapisid} ${ORIGIN}`));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `SAPISIDHASH ${ts}_${hex}`;
}

// ---------------------------------------------------------------------------------------------
// Generic helpers

type Json = Record<string, unknown>;

function obj(v: unknown): Json | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Follow a key path, returning undefined as soon as anything is missing. */
function dig(v: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = v;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

/** Text from either {simpleText} or {runs:[{text}]} or {content}. */
function text(v: unknown): string | undefined {
  const o = obj(v);
  if (!o) return undefined;
  if (typeof o.simpleText === 'string') return o.simpleText;
  if (typeof o.content === 'string') return o.content;
  const runs = arr(o.runs)
    .map((r) => str(obj(r)?.text) ?? '')
    .join('');
  return runs || undefined;
}

/** Depth-first visit of every object under `root` that has `key`. */
function* findAll(root: unknown, key: string): Generator<Json> {
  const stack: unknown[] = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (let i = cur.length - 1; i >= 0; i--) stack.push(cur[i]);
    } else if (cur && typeof cur === 'object') {
      const o = cur as Json;
      const hit = obj(o[key]);
      if (hit) yield hit;
      for (const v of Object.values(o).reverse()) if (v && typeof v === 'object') stack.push(v);
    }
  }
}

function isChannelId(v: unknown): v is ChannelId {
  return typeof v === 'string' && /^UC[\w-]{22}$/.test(v);
}

function absoluteUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  return u.startsWith('//') ? `https:${u}` : u;
}

function lastThumb(v: unknown): string | undefined {
  const thumbs = arr(dig(v, 'thumbnails'));
  return absoluteUrl(str(obj(thumbs[thumbs.length - 1])?.url));
}

function handleFromPath(path: string | undefined): string | undefined {
  return path?.startsWith('/@') ? path.slice(1) : undefined;
}

/** Thumbnails always come from i.ytimg.com, built from the video ID, so we never contact other hosts. */
export function videoThumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

/** "34:32" or "1:02:03" -> seconds. */
export function parseDuration(s: string | undefined): number | undefined {
  if (!s || !/^\d+(:\d{1,2}){1,2}$/.test(s.trim())) return undefined;
  return s
    .trim()
    .split(':')
    .reduce((acc, part) => acc * 60 + Number(part), 0);
}

const UNIT_MS: Record<string, number> = {
  s: 1000, sec: 1000, second: 1000,
  m: 60_000, min: 60_000, minute: 60_000,
  h: 3_600_000, hr: 3_600_000, hour: 3_600_000,
  d: DAY_MS, day: DAY_MS,
  w: 7 * DAY_MS, wk: 7 * DAY_MS, week: 7 * DAY_MS,
  mo: 30 * DAY_MS, month: 30 * DAY_MS,
  y: 365 * DAY_MS, yr: 365 * DAY_MS, year: 365 * DAY_MS,
};

/** Approximate publish time from English relative text like "2d ago" or "Streamed 3 weeks ago". */
export function parseRelativeTime(s: string | undefined, now: number): number | undefined {
  const m = s?.toLowerCase().match(/(\d+)\s*(mo|months?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|y|yrs?|years?)\b.*ago/);
  if (!m) return undefined;
  const unit = m[2]!.replace(/s$/, '');
  const ms = UNIT_MS[unit] ?? UNIT_MS[m[2]!];
  return ms === undefined ? undefined : now - Number(m[1]) * ms;
}

const VIEW_MULTIPLIER: Record<string, number> = {
  k: 1e3, thousand: 1e3,
  m: 1e6, million: 1e6,
  b: 1e9, billion: 1e9,
};

/** "5.8M views", "5.8 million views", "1,234 views", "1 view", "No views" -> number. */
export function parseViewCount(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const t = s.trim().toLowerCase();
  if (/^no views?$/.test(t)) return 0;
  const m = t.match(/^([\d.,]+)\s*(k|m|b|thousand|million|billion)?\s+views?$/);
  if (!m) return undefined;
  const mult = m[2] ? VIEW_MULTIPLIER[m[2]]! : 1;
  // With a multiplier "," can only be a decimal comma; without one it's a thousands separator.
  const num = Number(mult === 1 ? m[1]!.replace(/[.,]/g, '') : m[1]!.replace(',', '.'));
  return Number.isFinite(num) ? Math.round(num * mult) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Parsers

export function isLoggedOutResponse(json: unknown): boolean {
  return dig(json, 'responseContext', 'mainAppWebResponseContext', 'loggedOut') === true;
}

export function parseResolveUrl(json: unknown): ChannelId | null {
  const id = dig(json, 'endpoint', 'browseEndpoint', 'browseId');
  return isChannelId(id) ? id : null;
}

export interface ChannelSummary {
  id: ChannelId;
  title: string;
  handle?: string;
  thumbnailUrl?: string;
}

export interface ChannelPage {
  channel: ChannelSummary | null;
  featured: ChannelSummary[];
}

/** Channel metadata plus the "Featured Channels" shelf (gridChannelRenderer items) from the Home tab. */
export function parseChannelPage(json: unknown): ChannelPage {
  const meta = obj(dig(json, 'metadata', 'channelMetadataRenderer'));
  const id = meta?.externalId;
  const channel: ChannelSummary | null = isChannelId(id)
    ? {
        id,
        title: str(meta?.title) ?? '',
        handle: str(meta?.vanityChannelUrl)?.match(/\/(@[^/?#]+)/)?.[1],
        thumbnailUrl: lastThumb(meta?.avatar),
      }
    : null;

  const featured = new Map<ChannelId, ChannelSummary>();
  for (const g of findAll(dig(json, 'contents'), 'gridChannelRenderer')) {
    const cid = g.channelId ?? dig(g, 'navigationEndpoint', 'browseEndpoint', 'browseId');
    if (!isChannelId(cid) || cid === channel?.id || featured.has(cid)) continue;
    featured.set(cid, {
      id: cid,
      title: text(g.title) ?? '',
      handle: handleFromPath(str(dig(g, 'navigationEndpoint', 'browseEndpoint', 'canonicalBaseUrl'))),
      thumbnailUrl: lastThumb(g.thumbnail),
    });
  }
  return { channel, featured: [...featured.values()] };
}

/** What kind of item a video lockup is. Only plain videos become feed items. */
export type ItemKind = 'video' | 'short' | 'live' | 'upcoming';

export interface ParsedVideo {
  id: string;
  title: string;
  kind: ItemKind;
  channelId?: ChannelId;
  channelTitle?: string;
  publishedAt?: number;
  durationSec?: number;
  viewCount?: number;
  /** The channel has YouTube's verified badge (videoRenderer shape only). */
  verified?: boolean;
}

/** The channel's verified badge (not an artist badge) on a videoRenderer. */
function ownerVerified(v: Json): boolean {
  return [...findAll(v.ownerBadges, 'metadataBadgeRenderer')].some((b) => str(b.style) === 'BADGE_STYLE_TYPE_VERIFIED');
}

const LIVE_TEXT = /\bwatching\b|^live$/i;
const UPCOMING_TEXT = /^(scheduled for|premieres|upcoming|waiting)\b/i;

function firstChannelId(root: unknown): ChannelId | undefined {
  for (const b of findAll(root, 'browseEndpoint')) if (isChannelId(b.browseId)) return b.browseId;
  return undefined;
}

/** True when a navigation command opens the Shorts player. */
function isShortsCommand(cmd: unknown): boolean {
  if (!cmd) return false;
  if (findAll(cmd, 'reelWatchEndpoint').next().done === false) return true;
  for (const m of findAll(cmd, 'webCommandMetadata')) if (str(m.url)?.startsWith('/shorts/')) return true;
  return false;
}

/**
 * One lockupViewModel video (channel Videos tab, subscriptions feed, history, related videos).
 * Metadata rows hold the channel name, then views and age; views may be compact ("10M") with
 * the full text only in the accessibility label. Returns null for non-video lockups.
 */
export function parseVideoLockup(l: Json, now: number): ParsedVideo | null {
  const id = str(l.contentId);
  const type = str(l.contentType);
  if (!id || (type && !type.startsWith('LOCKUP_CONTENT_TYPE_VIDEO') && !type.includes('SHORT'))) return null;
  const md = obj(dig(l, 'metadata', 'lockupMetadataViewModel'));
  const title = text(md?.title);
  if (!title) return null;
  const rows = arr(dig(md, 'metadata', 'contentMetadataViewModel', 'metadataRows')).map((r) =>
    arr(obj(r)?.metadataParts).map((p) => ({
      text: text(obj(p)?.text) ?? '',
      label: str(obj(p)?.accessibilityLabel),
    })),
  );
  const parts = rows.flat();
  const read = <T>(f: (s: string) => T | undefined) =>
    parts.map((p) => f(p.text) ?? (p.label ? f(p.label) : undefined)).find((v) => v !== undefined);
  const publishedAt = read((t) => parseRelativeTime(t, now));
  const viewCount = read(parseViewCount);
  // The channel row is the first row whose first part is neither views nor an age.
  const channelRow = rows.find((r) => r[0] && parseViewCount(r[0].text) === undefined && parseRelativeTime(r[0].text, now) === undefined);
  const channelId = firstChannelId(md?.image) ?? firstChannelId(md?.metadata);

  let durationSec: number | undefined;
  let live = parts.some((p) => LIVE_TEXT.test(p.text));
  let upcoming = parts.some((p) => UPCOMING_TEXT.test(p.text));
  for (const b of findAll(l.contentImage, 'thumbnailBadgeViewModel')) {
    const t = str(b.text);
    const style = str(b.badgeStyle) ?? '';
    durationSec ??= parseDuration(t);
    if (style.includes('LIVE') || (t && LIVE_TEXT.test(t))) live = true;
    if (style.includes('UPCOMING') || (t && /^upcoming$/i.test(t))) upcoming = true;
  }
  const short = (type?.includes('SHORT') ?? false) || isShortsCommand(dig(l, 'rendererContext', 'commandContext', 'onTap'));
  const kind: ItemKind = short ? 'short' : upcoming ? 'upcoming' : live ? 'live' : 'video';
  return {
    id,
    title,
    kind,
    channelId,
    channelTitle: channelId ? channelRow?.[0]?.text || undefined : undefined,
    publishedAt,
    durationSec,
    viewCount,
  };
}

/** The older videoRenderer shape, still used by search and possibly by feeds in some experiments. */
export function parseVideoRenderer(v: Json, now: number): ParsedVideo | null {
  const id = str(v.videoId);
  const title = text(v.title);
  if (!id || !title) return null;
  const owner = obj(arr(dig(v, 'ownerText', 'runs'))[0]) ?? obj(arr(dig(v, 'shortBylineText', 'runs'))[0]) ?? obj(arr(dig(v, 'longBylineText', 'runs'))[0]);
  const channelId = dig(owner, 'navigationEndpoint', 'browseEndpoint', 'browseId');
  const overlayStyles = [...findAll(v.thumbnailOverlays, 'thumbnailOverlayTimeStatusRenderer')].map((o) => ({
    style: str(o.style) ?? '',
    text: text(o.text),
  }));
  const badgeStyles = [...findAll(v.badges, 'metadataBadgeRenderer')].map((b) => str(b.style) ?? '');
  const viewText = text(v.viewCountText) ?? '';
  const live = badgeStyles.some((b) => b.includes('LIVE')) || overlayStyles.some((o) => o.style === 'LIVE') || /watching/i.test(viewText);
  const upcoming = v.upcomingEventData !== undefined || overlayStyles.some((o) => o.style === 'UPCOMING');
  const url = str(dig(v, 'navigationEndpoint', 'commandMetadata', 'webCommandMetadata', 'url')) ?? '';
  const short = url.startsWith('/shorts/') || overlayStyles.some((o) => o.style === 'SHORTS') || isShortsCommand(v.navigationEndpoint);
  return {
    id,
    title,
    kind: short ? 'short' : upcoming ? 'upcoming' : live ? 'live' : 'video',
    channelId: isChannelId(channelId) ? channelId : undefined,
    channelTitle: isChannelId(channelId) ? str(owner?.text) : undefined,
    publishedAt: parseRelativeTime(text(v.publishedTimeText), now),
    durationSec: parseDuration(text(v.lengthText)) ?? overlayStyles.map((o) => parseDuration(o.text)).find((d) => d !== undefined),
    viewCount: parseViewCount(viewText),
    verified: ownerVerified(v),
  };
}

/** Every video item (lockups and videoRenderers) under `root`, in document order, deduplicated. */
export function parseVideoItems(root: unknown, now: number): ParsedVideo[] {
  const out = new Map<string, ParsedVideo>();
  // findAll is depth-first; a combined walk keeps the feed's order across both shapes.
  const stack: unknown[] = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (let i = cur.length - 1; i >= 0; i--) stack.push(cur[i]);
      continue;
    }
    const o = obj(cur);
    if (!o) continue;
    const lockup = obj(o.lockupViewModel);
    const renderer = obj(o.videoRenderer) ?? obj(o.gridVideoRenderer);
    const v = lockup ? parseVideoLockup(lockup, now) : renderer ? parseVideoRenderer(renderer, now) : null;
    if (v && !out.has(v.id)) out.set(v.id, v);
    if (lockup || renderer) continue;
    for (const val of Object.values(o).reverse()) if (val && typeof val === 'object') stack.push(val);
  }
  return [...out.values()];
}

function lastContinuation(json: unknown): string | null {
  let continuation: string | null = null;
  for (const c of findAll(json, 'continuationItemRenderer')) {
    const token = str(dig(c, 'continuationEndpoint', 'continuationCommand', 'token'));
    if (token) continuation = token;
  }
  return continuation;
}

/** Fallback for uploads when RSS fails, and candidate uploads: the channel's Videos tab. */
export function parseVideosTab(json: unknown, channelId: ChannelId, now: number): Video[] {
  const out: Video[] = [];
  for (const l of findAll(dig(json, 'contents'), 'lockupViewModel')) {
    const v = parseVideoLockup(l, now);
    if (!v || v.kind !== 'video' || v.publishedAt === undefined) continue;
    out.push({
      id: v.id,
      channelId,
      title: v.title,
      publishedAt: v.publishedAt,
      thumbnailUrl: videoThumbnail(v.id),
      durationSec: v.durationSec,
      viewCount: v.viewCount,
    });
  }
  return out;
}

/** A subscription upload, with the channel title the feed lists it under. */
export interface FeedVideo extends Video {
  channelTitle?: string;
  /**
   * In a shelf YouTube inserts into the feed (e.g. "Most relevant" on page 1: algorithm-picked,
   * up to ~11 days old, observed Oct 2026) rather than the newest-first grid. Stored like any
   * other upload, but never used to decide where the timeline is.
   */
  inShelf?: boolean;
}

export interface SubscriptionFeedPage {
  loggedOut: boolean;
  /** Plain videos with a channel and an age, in feed order (newest first, if YouTube keeps to it). */
  videos: FeedVideo[];
  /** Items left out, by reason. */
  skipped: { shorts: number; live: number; upcoming: number; incomplete: number };
  continuation: string | null;
}

/**
 * One page of the subscriptions feed (FEsubscriptions) or a continuation of it. Shorts (their
 * own shelf of shortsLockupViewModel, or lockups opening the Shorts player), live streams and
 * scheduled premieres are skipped: the feed shows finished uploads only.
 */
export function parseSubscriptionFeedPage(json: unknown, now: number): SubscriptionFeedPage {
  const skipped = { shorts: 0, live: 0, upcoming: 0, incomplete: 0 };
  skipped.shorts += [...findAll(json, 'shortsLockupViewModel')].length + [...findAll(json, 'reelItemRenderer')].length;
  const videos: FeedVideo[] = [];
  // Inserted shelves are richShelfRenderer ("Most relevant", "Shorts"); the "Latest" shelfRenderer
  // is only a header. "Most relevant" repeats some timeline videos, so a video counts as shelved
  // only when every copy of it is inside a shelf.
  const copies = (root: unknown) => {
    const n = new Map<string, number>();
    for (const l of findAll(root, 'lockupViewModel')) {
      const id = str(l.contentId);
      if (id) n.set(id, (n.get(id) ?? 0) + 1);
    }
    return n;
  };
  const total = copies(json);
  const inShelves = new Map<string, number>();
  for (const shelf of findAll(json, 'richShelfRenderer')) {
    for (const [id, k] of copies(shelf)) inShelves.set(id, (inShelves.get(id) ?? 0) + k);
  }
  const shelved = new Set([...inShelves].filter(([id, k]) => k >= (total.get(id) ?? 0)).map(([id]) => id));
  for (const v of parseVideoItems(json, now)) {
    if (v.kind === 'short') skipped.shorts++;
    else if (v.kind === 'live') skipped.live++;
    else if (v.kind === 'upcoming') skipped.upcoming++;
    else if (!v.channelId || v.publishedAt === undefined) skipped.incomplete++;
    else {
      videos.push({
        id: v.id,
        channelId: v.channelId,
        channelTitle: v.channelTitle,
        title: v.title,
        publishedAt: v.publishedAt,
        thumbnailUrl: videoThumbnail(v.id),
        durationSec: v.durationSec,
        viewCount: v.viewCount,
        ...(shelved.has(v.id) ? { inShelf: true } : {}),
      });
    }
  }
  return { loggedOut: isLoggedOutResponse(json), videos, skipped, continuation: lastContinuation(json) };
}

export interface HistoryPage {
  loggedOut: boolean;
  /** Watched long-form videos (Shorts excluded) and their channels, most recent first. */
  entries: { videoId: string; channelId: ChannelId }[];
  continuation: string | null;
}

/** One page of watch history (FEhistory). Only video and channel IDs are kept. */
export function parseHistoryPage(json: unknown, now: number): HistoryPage {
  const entries = parseVideoItems(json, now)
    .filter((v) => v.kind !== 'short' && v.channelId)
    .map((v) => ({ videoId: v.id, channelId: v.channelId! }));
  return { loggedOut: isLoggedOutResponse(json), entries, continuation: lastContinuation(json) };
}

/** Watched videos per channel. */
export function historyCounts(entries: HistoryPage['entries']): Record<ChannelId, number> {
  const seen = new Set<string>();
  const out: Record<ChannelId, number> = {};
  for (const e of entries) {
    if (seen.has(e.videoId)) continue;
    seen.add(e.videoId);
    out[e.channelId] = (out[e.channelId] ?? 0) + 1;
  }
  return out;
}

export interface WatchPageInfo {
  videoId: string;
  channelId: ChannelId;
  publishedAt?: number;
  /** Channels linked from the description (@handles and channel URLs, already resolved by YouTube). */
  mentions: ChannelId[];
}

/**
 * Watch page data (ytInitialData, or the response in yt-navigate-finish after SPA navigation).
 * Description links come as commandRuns whose browseEndpoint already names the channel ID, so no
 * resolve_url call is needed.
 */
export function parseWatchPage(json: unknown, now: number): WatchPageInfo | null {
  const videoId = str(dig(json, 'currentVideoEndpoint', 'watchEndpoint', 'videoId'));
  const results = dig(json, 'contents', 'twoColumnWatchNextResults', 'results');
  const secondary = findAll(results, 'videoSecondaryInfoRenderer').next().value as Json | undefined;
  const primary = findAll(results, 'videoPrimaryInfoRenderer').next().value as Json | undefined;
  const channelId = dig(secondary, 'owner', 'videoOwnerRenderer', 'navigationEndpoint', 'browseEndpoint', 'browseId');
  if (!videoId || !isChannelId(channelId)) return null;
  const mentions = new Set<ChannelId>();
  for (const run of arr(dig(secondary, 'attributedDescription', 'commandRuns'))) {
    const id = firstChannelId(run);
    if (id && id !== channelId) mentions.add(id);
  }
  const dateText = text(primary?.dateText);
  const parsedDate = dateText ? Date.parse(dateText.replace(/^(premiered|streamed live on|started streaming on)\s+/i, '')) : NaN;
  return {
    videoId,
    channelId,
    publishedAt: parseRelativeTime(text(primary?.relativeDateText), now) ?? (Number.isNaN(parsedDate) ? undefined : parsedDate),
    mentions: [...mentions],
  };
}

/** Channel root and Home tab paths: /@handle, /channel/UC…, /c/name, /user/name (+ /featured). */
export function isChannelHomePath(path: string): boolean {
  return /^\/(@[^/]+|channel\/UC[\w-]{22}|c\/[^/]+|user\/[^/]+)(\/featured)?\/?$/.test(path);
}

export type PageSummary =
  | { kind: 'watch'; watch: WatchPageInfo }
  | { kind: 'channel'; channel: ChannelPage }
  | { kind: 'other' };

/**
 * What the extension takes for free from a page the user opened: description mentions on watch
 * pages, featured channels on channel Home tabs. `path` is location.pathname.
 */
export function summarisePage(path: string, json: unknown, now: number): PageSummary {
  if (path === '/watch') {
    const watch = parseWatchPage(json, now);
    return watch ? { kind: 'watch', watch } : { kind: 'other' };
  }
  if (isChannelHomePath(path)) {
    const channel = parseChannelPage(json);
    return channel.channel ? { kind: 'channel', channel } : { kind: 'other' };
  }
  return { kind: 'other' };
}

/**
 * Search results (videoRenderer items). Live streams ("watching" instead of views), items without
 * a publish time, and Shorts are skipped.
 */
export function parseSearchResults(json: unknown, now: number): TrendingVideo[] {
  const out: TrendingVideo[] = [];
  for (const v of findAll(dig(json, 'contents'), 'videoRenderer')) {
    const id = str(v.videoId);
    const owner = obj(arr(dig(v, 'ownerText', 'runs'))[0]);
    const channelId = dig(owner, 'navigationEndpoint', 'browseEndpoint', 'browseId');
    const title = text(v.title);
    const viewCount = parseViewCount(text(v.viewCountText));
    const publishedAt = parseRelativeTime(text(v.publishedTimeText), now);
    const url = str(dig(v, 'navigationEndpoint', 'commandMetadata', 'webCommandMetadata', 'url')) ?? '';
    if (!id || !isChannelId(channelId) || !title || viewCount === undefined || publishedAt === undefined) continue;
    if (url.startsWith('/shorts/')) continue;
    out.push({
      id,
      channelId,
      channelTitle: str(owner?.text) ?? '',
      title,
      publishedAt,
      thumbnailUrl: videoThumbnail(id),
      durationSec: parseDuration(text(v.lengthText)),
      viewCount,
      verified: ownerVerified(v),
    });
  }
  return out;
}

/**
 * One video's public details from POST /youtubei/v1/player {videoId} (observed Oct 2026: works
 * signed out; playabilityStatus may say UNPLAYABLE for a non-browser client, but videoDetails and
 * microformat are still there). Used to show community-trending videos with YouTube's own title,
 * channel, length and views, never text supplied by other users. Live streams, upcoming
 * premieres and Shorts return null.
 */
export function parsePlayer(json: unknown): TrendingVideo | null {
  const d = obj(dig(json, 'videoDetails'));
  const mf = obj(dig(json, 'microformat', 'playerMicroformatRenderer'));
  const id = str(d?.videoId);
  const channelId = d?.channelId;
  const title = str(d?.title);
  const durationSec = Number(d?.lengthSeconds);
  const viewCount = Number(d?.viewCount);
  const publishedAt = Date.parse(str(mf?.publishDate) ?? str(mf?.uploadDate) ?? '');
  if (!id || !isChannelId(channelId) || !title || !Number.isFinite(publishedAt)) return null;
  if (!(durationSec > 0) || dig(mf, 'liveBroadcastDetails', 'isLiveNow') === true || d?.isUpcoming === true) return null;
  if (mf?.isShortsEligible === true && durationSec <= 180) return null;
  return {
    id,
    channelId,
    channelTitle: str(d?.author) ?? '',
    title,
    publishedAt,
    thumbnailUrl: videoThumbnail(id),
    durationSec,
    viewCount: Number.isFinite(viewCount) ? viewCount : 0,
  };
}

/** One top story on YouTube's News hub: its headline and the outlets' videos, YouTube's order. */
export interface NewsStory {
  headline: string;
  videos: TrendingVideo[];
}

/**
 * The News hub's story shelves, in YouTube's order. Shelves without plain videos (news posts,
 * "Live now") are skipped, as are live streams and premieres inside a story.
 */
export function parseNewsHub(json: unknown, now: number, maxStories = 10, maxPerStory = 6): NewsStory[] {
  const stories: NewsStory[] = [];
  for (const shelf of findAll(dig(json, 'contents'), 'richShelfRenderer')) {
    if (stories.length >= maxStories) break;
    const headline = text(shelf.title);
    if (!headline) continue;
    const videos: TrendingVideo[] = [];
    for (const v of parseVideoItems(shelf.contents, now)) {
      if (videos.length >= maxPerStory) break;
      if (v.kind !== 'video' || !v.channelId || v.publishedAt === undefined) continue;
      videos.push({
        id: v.id,
        channelId: v.channelId,
        channelTitle: v.channelTitle ?? '',
        title: v.title,
        publishedAt: v.publishedAt,
        thumbnailUrl: videoThumbnail(v.id),
        durationSec: v.durationSec,
        viewCount: v.viewCount ?? 0,
        verified: v.verified,
      });
    }
    if (videos.length) stories.push({ headline, videos });
  }
  return stories;
}

export async function fetchNewsHub(cfg: YtClientConfig, now = Date.now()): Promise<NewsStory[]> {
  return parseNewsHub(await innertubePost('browse', { browseId: NEWS_HUB_BROWSE_ID }, parsingClient(cfg)), now);
}

export async function fetchVideoDetails(videoId: string, cfg: YtClientConfig): Promise<TrendingVideo | null> {
  return parsePlayer(await innertubePost('player', { videoId }, cfg));
}

export async function fetchMostViewedThisWeek(query: string, cfg: YtClientConfig, now = Date.now()): Promise<TrendingVideo[]> {
  const json = await innertubePost('search', { query, params: SEARCH_TODAY_BY_VIEWS }, parsingClient(cfg));
  return parseSearchResults(json, now);
}

export interface SubscriptionsPage {
  loggedOut: boolean;
  channels: ChannelSummary[];
  continuation: string | null;
}

/**
 * Subscriptions page (/feed/channels) or one of its continuations. Collects channelRenderer items
 * and channel-type lockups wherever they appear, so small layout changes don't break it.
 */
export function parseSubscriptionsPage(json: unknown): SubscriptionsPage {
  const channels = new Map<ChannelId, ChannelSummary>();
  for (const c of findAll(json, 'channelRenderer')) {
    if (!isChannelId(c.channelId) || channels.has(c.channelId)) continue;
    const handle =
      handleFromPath(str(dig(c, 'navigationEndpoint', 'browseEndpoint', 'canonicalBaseUrl'))) ??
      text(c.subscriberCountText)?.match(/^@\S+$/)?.[0];
    channels.set(c.channelId, {
      id: c.channelId,
      title: text(c.title) ?? '',
      handle,
      thumbnailUrl: lastThumb(c.thumbnail),
    });
  }
  for (const l of findAll(json, 'lockupViewModel')) {
    const id = l.contentId;
    if (!isChannelId(id) || channels.has(id)) continue;
    if (l.contentType && !String(l.contentType).includes('CHANNEL')) continue;
    channels.set(id, { id, title: text(dig(l, 'metadata', 'lockupMetadataViewModel', 'title')) ?? '' });
  }
  return { loggedOut: isLoggedOutResponse(json), channels: [...channels.values()], continuation: lastContinuation(json) };
}

export interface RssVideo extends Video {
  description: string;
}

export interface RssFeed {
  channelId: ChannelId | null;
  title: string;
  videos: RssVideo[];
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function tag(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1]!).trim() : undefined;
}

/**
 * Channel RSS feed. Regex-based because the service worker has no DOMParser; the feed is a
 * small, stable Atom document.
 */
export function parseRss(xml: string): RssFeed {
  const head = xml.split('<entry>')[0] ?? '';
  // The feed-level <yt:channelId> omits the "UC" prefix (entries include it); the
  // alternate link has the full ID, so prefer that.
  const rawId = tag(head, 'yt:channelId');
  const channelId =
    head.match(/youtube\.com\/channel\/(UC[\w-]{22})/)?.[1] ??
    (rawId && /^[\w-]{22}$/.test(rawId) ? `UC${rawId}` : rawId);
  const videos: RssVideo[] = [];
  for (const entry of xml.split('<entry>').slice(1)) {
    const id = tag(entry, 'yt:videoId');
    const vcid = tag(entry, 'yt:channelId');
    const title = tag(entry, 'title');
    const published = Date.parse(tag(entry, 'published') ?? '');
    if (!id || !isChannelId(vcid) || !title || Number.isNaN(published)) continue;
    const link = entry.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? '';
    const views = entry.match(/<media:statistics[^>]*\sviews="(\d+)"/)?.[1];
    videos.push({
      id,
      channelId: vcid,
      title,
      publishedAt: published,
      thumbnailUrl: videoThumbnail(id),
      isShort: link.includes('/shorts/'),
      viewCount: views === undefined ? undefined : Number(views),
      description: tag(entry, 'media:description') ?? '',
    });
  }
  return {
    channelId: isChannelId(channelId) ? channelId : null,
    title: tag(head, 'title') ?? '',
    videos,
  };
}

// ---------------------------------------------------------------------------------------------
// High-level calls

/** Public calls (resolve, channel pages, RSS) are sent without cookies: they don't need the session. */
export async function resolveChannelUrl(url: string, cfg: YtClientConfig): Promise<ChannelId | null> {
  try {
    return parseResolveUrl(await innertubePost('navigation/resolve_url', { url }, cfg));
  } catch (err) {
    // Unknown handles come back as 400/404: that's an answer, not a failure.
    if (err instanceof InnertubeError && (err.status === 400 || err.status === 404)) return null;
    throw err;
  }
}

export async function fetchChannelPage(channelId: ChannelId, cfg: YtClientConfig): Promise<ChannelPage> {
  return parseChannelPage(await innertubePost('browse', { browseId: channelId }, cfg));
}

export async function fetchVideosTab(channelId: ChannelId, cfg: YtClientConfig, now = Date.now()): Promise<Video[]> {
  const json = await innertubePost('browse', { browseId: channelId, params: VIDEOS_TAB_PARAMS }, parsingClient(cfg));
  return parseVideosTab(json, channelId, now);
}

export async function fetchRss(channelId: ChannelId): Promise<RssFeed> {
  let res: Response;
  try {
    res = await fetch(`${ORIGIN}/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, {
      credentials: 'omit',
    });
  } catch (err) {
    throw new InnertubeError(`network error: ${String(err)}`, 0);
  }
  if (!res.ok) throw new InnertubeError(`rss returned ${res.status}`, res.status);
  return parseRss(await res.text());
}

const MAX_SUBSCRIPTION_PAGES = 60;
const SUBSCRIPTION_PAGE_GAP_MS = 1500;

/**
 * Full subscription list for the logged-in user, following continuation tokens.
 * Runs in a content script on youtube.com so it can use the page's session cookies.
 */
export async function fetchSubscriptions(
  cfg: YtClientConfig,
  cookie: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ loggedOut: true } | { loggedOut: false; channels: ChannelSummary[] }> {
  const auth = await sapisidAuthorization(cookie);
  if (!cfg.loggedIn || !auth) return { loggedOut: true };
  const all = new Map<ChannelId, ChannelSummary>();
  let body: Record<string, unknown> = { browseId: SUBSCRIPTIONS_BROWSE_ID };
  for (let page = 0; page < MAX_SUBSCRIPTION_PAGES; page++) {
    const json = await innertubePost('browse', body, cfg, {
      authorization: (await sapisidAuthorization(cookie)) ?? auth,
      credentials: 'include',
    });
    const parsed = parseSubscriptionsPage(json);
    if (page === 0 && parsed.loggedOut) return { loggedOut: true };
    for (const c of parsed.channels) all.set(c.id, c);
    if (!parsed.continuation) break;
    body = { continuation: parsed.continuation };
    await sleep(SUBSCRIPTION_PAGE_GAP_MS);
  }
  return { loggedOut: false, channels: [...all.values()] };
}

/**
 * A browse call as the logged-in user (cookies + SAPISIDHASH), from a content script on
 * youtube.com. Returns null when there is no session to use.
 */
async function sessionBrowse(body: Record<string, unknown>, cfg: YtClientConfig, cookie: string): Promise<unknown | null> {
  const auth = await sapisidAuthorization(cookie);
  if (!cfg.loggedIn || !auth) return null;
  return innertubePost('browse', body, parsingClient(cfg), { authorization: auth, credentials: 'include' });
}

/** One page of the subscriptions feed: `body` is {browseId: FEsubscriptions} or {continuation}. */
export async function fetchSubscriptionFeedPage(
  body: Record<string, unknown>,
  cfg: YtClientConfig,
  cookie: string,
  now = Date.now(),
): Promise<SubscriptionFeedPage> {
  const json = await sessionBrowse(body, cfg, cookie);
  if (json === null) return { loggedOut: true, videos: [], skipped: { shorts: 0, live: 0, upcoming: 0, incomplete: 0 }, continuation: null };
  return parseSubscriptionFeedPage(json, now);
}

export async function fetchHistoryPage(
  body: Record<string, unknown>,
  cfg: YtClientConfig,
  cookie: string,
  now = Date.now(),
): Promise<HistoryPage> {
  const json = await sessionBrowse(body, cfg, cookie);
  if (json === null) return { loggedOut: true, entries: [], continuation: null };
  return parseHistoryPage(json, now);
}

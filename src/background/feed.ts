import * as db from '../core/db';
import { channelEngagement, seedWeights } from '../core/engagement';
import { blendTopRow, buildArchive, buildFeed, drawOrder, explainCandidates, pickTrending, scoreCandidates, type ArchivePage } from '../core/ranker';
import { defaultSources, type RankContext } from '../core/sources';
import type { Via } from '../core/sources/types';
import {
  COMMUNITY_MIN_VIEWS,
  DAY_MS,
  IMPRESSION_DECAY,
  IMPRESSION_TTL_MS,
  NEWS_MAX_AGE_MS,
  NEWS_MIN_OUTLETS,
  NEWS_PUSH_RATIO,
  NEWS_SLOTS,
  NEWS_STORIES,
  NEWS_VIDEO_MAX_AGE_MS,
  MAX_IMPRESSIONS,
  TOP_CANDIDATES_FOR_UPLOADS,
  TRENDING_CANDIDATES,
  TRENDING_MAX_AGE_MS,
  TRENDING_POOL_MS,
  TRENDING_SLOTS,
} from '../shared/constants';
import { readable, userLanguages, type LanguageCheck } from '../core/language';
import { getSettings } from '../shared/settings';
import { recordDiscoverShown, sourceTuning } from './discover-stats';
import type { Channel, ChannelId, Edge, Feedback, FeedItem, FeedResponse, Reason, Video } from '../shared/types';

const SUB_WINDOW_MS = 30 * DAY_MS;
const DISCOVERY_WINDOW_MS = 120 * DAY_MS;
/** A video counts as already seen once this much of it was watched. */
const SEEN_COMPLETION = 0.9;

export interface Snapshot {
  now: number;
  channels: Map<ChannelId, Channel>;
  subscribed: Set<ChannelId>;
  edges: Edge[];
  engagement: Map<ChannelId, number>;
  feedback: Map<ChannelId, Feedback>;
  scores: Map<ChannelId, number>;
  community?: Map<ChannelId, [ChannelId, number, number?][]>;
  /** Where discovery starts: subscriptions plus much-watched channels, with weights. */
  seeds?: Map<ChannelId, number>;
  /** Per candidate, the seed (and in-between channel) that contributed most. */
  via?: Map<ChannelId, Via>;
}

/** Loads everything ranking needs and scores discovery candidates. */
export async function snapshot(now = Date.now()): Promise<Snapshot> {
  const [channelList, edges, events, feedbackList] = await Promise.all([
    db.getAllChannels(),
    db.getAllEdges(),
    db.getAllWatchEvents(),
    db.getAllFeedback(),
  ]);
  const channels = new Map(channelList.map((c) => [c.id, c]));
  const subscribed = new Set(channelList.filter((c) => c.isSubscribed).map((c) => c.id));
  const engagement = channelEngagement(events, now);
  const seeds = seedWeights(subscribed, engagement, events, now);
  const feedback = new Map(feedbackList.map((f) => [f.channelId, f]));
  const ctx: RankContext = { now, subscribed, edges, engagement, seeds, community: await communityGraph() };
  const tuning = await sourceTuning(now);
  const sources = defaultSources();
  const [scores, via] = await Promise.all([scoreCandidates(sources, ctx, feedback, tuning), explainCandidates(sources, ctx, tuning)]);
  return { now, channels, subscribed, edges, engagement, feedback, scores, community: ctx.community, seeds, via };
}

/** The downloaded community co-watch graph, merged from its shards (empty when the feature is off). */
async function communityGraph(): Promise<Map<ChannelId, [ChannelId, number, number?][]>> {
  const shards = (await db.getMeta('community'))?.graph?.shards ?? {};
  const graph = new Map<ChannelId, [ChannelId, number, number?][]>();
  for (const shard of Object.values(shards)) {
    for (const [channel, list] of Object.entries(shard.neighbours)) graph.set(channel, list);
  }
  return graph;
}

/** Candidates ordered by score, best first. */
export function topCandidates(snap: Snapshot, n: number): ChannelId[] {
  return [...snap.scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id]) => id);
}

const VERB: Record<string, string> = { featured: 'Featured by', mentions: 'Mentioned by' };

/**
 * Why each candidate is shown, naming the seed that contributed most across all sources:
 * "Featured by X", "Mentioned by X", "Popular with viewers of X", and for a second hop
 * "Featured by Y (via X)". Candidates whose channels have no known title get no reason.
 */
function reasonsFor(snap: Snapshot, candidates: ChannelId[]): Map<ChannelId, Reason> {
  const out = new Map<ChannelId, Reason>();
  const title = (id: ChannelId | undefined) => (id ? snap.channels.get(id)?.title : undefined);
  for (const id of candidates) {
    const v = snap.via?.get(id);
    if (!v) continue;
    const seed = title(v.seed);
    if (v.kind === 'community') {
      if (seed) out.set(id, { text: `Popular with viewers of ${seed}`, channelId: v.seed, source: v.kind });
      continue;
    }
    const verb = VERB[v.kind];
    if (!verb) continue;
    const through = title(v.through);
    if (v.through && through) {
      out.set(id, { text: seed ? `${verb} ${through} (via ${seed})` : `${verb} ${through}`, channelId: v.through, source: v.kind });
    } else if (!v.through && seed) {
      out.set(id, { text: `${verb} ${seed}`, channelId: v.seed, source: v.kind });
    } else {
      out.set(id, { source: v.kind });
    }
  }
  return out;
}

/** YouTube's own avatar hosts: the only image hosts besides i.ytimg.com a card may load from. */
const AVATAR_HOST = /^https:\/\/yt\d\.(ggpht|googleusercontent)\.com\//;

/** Adds each channel's stored avatar to its cards (left out when unknown). */
export function withAvatars<T extends FeedItem>(items: T[], channels: Iterable<Channel>): T[] {
  const avatars = new Map<ChannelId, string>();
  for (const c of channels) if (c.thumbnailUrl && AVATAR_HOST.test(c.thumbnailUrl)) avatars.set(c.id, c.thumbnailUrl);
  return items.map((i) => (avatars.has(i.channelId) ? { ...i, channelAvatarUrl: avatars.get(i.channelId) } : i));
}

/** Page of older subscription uploads for scrolling past the main feed. */
export async function computeArchive(offset: number, limit: number, onScreen: string[]): Promise<ArchivePage> {
  const [channels, videos, hidden] = await Promise.all([db.getAllChannels(), db.getVideosSince(0), hiddenVideos()]);
  const subscribed = new Set(channels.filter((c) => c.isSubscribed).map((c) => c.id));
  const titles = new Map(channels.map((c) => [c.id, c.title]));
  const exclude = new Set([...onScreen, ...hidden]);
  const page = buildArchive(
    videos.filter((v) => subscribed.has(v.channelId)),
    titles,
    exclude,
    Math.max(0, offset),
    Math.min(Math.max(1, limit), 100),
  );
  return { ...page, items: withAvatars(page.items, channels) };
}

/** Videos never to show again: hidden with "Not interested", or already watched to the end. */
async function hiddenVideos(): Promise<Set<string>> {
  const [events, feedback] = await Promise.all([db.getAllWatchEvents(), db.getAllVideoFeedback()]);
  return new Set([
    ...events.filter((e) => e.completion >= SEEN_COMPLETION).map((e) => e.videoId),
    ...feedback.map((f) => f.videoId),
  ]);
}

/** Community-trending videos whose details YouTube confirmed, as top-row candidates. */
async function communityTrending(exclude: Set<string>, hiddenChannels: Set<ChannelId>, now: number, check: LanguageCheck): Promise<FeedItem[]> {
  const file = (await db.getMeta('community'))?.trending?.file;
  if (!file?.videos.length) return [];
  const details = (await db.getMeta('communityVideos')) ?? {};
  const weekAgo = now - 7 * DAY_MS;
  const out: FeedItem[] = [];
  for (const entry of file.videos) {
    const v = details[entry.v]?.video;
    // Shown only with YouTube's own details, and only if YouTube agrees on the channel.
    if (!v || v.channelId !== entry.c || exclude.has(v.id) || hiddenChannels.has(v.channelId) || v.publishedAt < weekAgo) continue;
    if ((v.viewCount ?? 0) < COMMUNITY_MIN_VIEWS || !readable(v.title, check)) continue;
    out.push({
      videoId: v.id,
      title: v.title,
      channelId: v.channelId,
      channelTitle: v.channelTitle,
      thumbnailUrl: v.thumbnailUrl,
      publishedAt: v.publishedAt,
      durationSec: v.durationSec,
      viewCount: v.viewCount,
      discover: false,
      reason: 'Popular with Reborn users',
    });
  }
  return out;
}

/** Channels linked to `seeds` by a featured or mention edge (either way) or the community graph. */
function neighbours(snap: Snapshot, seeds: Set<ChannelId>): Set<ChannelId> {
  const out = new Set<ChannelId>();
  if (!seeds.size) return out;
  for (const e of snap.edges) {
    if (seeds.has(e.fromChannelId)) out.add(e.toChannelId);
    if (seeds.has(e.toChannelId)) out.add(e.fromChannelId);
  }
  for (const seed of seeds) for (const [nb] of snap.community?.get(seed) ?? []) out.add(nb);
  return out;
}

/** How much a top-row candidate suits this user, from neutral signals only (no profiling). */
function topRowAffinity(snap: Snapshot, hiddenChannels: Set<ChannelId>): (channel: ChannelId) => number {
  const near = neighbours(snap, snap.subscribed);
  const nearHidden = neighbours(snap, hiddenChannels);
  return (c) => {
    let w = 1;
    // Near what the user watches: subscriptions, discovery candidates, their graph neighbours.
    if (snap.subscribed.has(c) || (snap.scores.get(c) ?? 0) > 0 || near.has(c)) w *= 2;
    // Near a creator the user hid: one "not interested" teaches about similar channels too.
    if (nearHidden.has(c)) w *= 0.4;
    return w;
  };
}

const HOUR_MS = 3_600_000;

/** Views per hour since upload (at least one hour, so a brand-new video can't look huge). */
function velocity(v: { viewCount?: number; publishedAt: number }, now: number): number {
  return (v.viewCount ?? 0) / Math.max(1, (now - v.publishedAt) / HOUR_MS);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
}

/**
 * News YouTube is pushing right now, for the user's region, fastest first. Nothing on a quiet day.
 * Only established sources count: verified channels on YouTube's News hub. A story counts when at
 * least NEWS_MIN_OUTLETS different verified outlets each have a video gathering views at least
 * NEWS_PUSH_RATIO as fast as a typical "most viewed today" video; or when that many verified hub
 * outlets have videos among today's most viewed. One channel alone, however fast, never counts.
 * Everything here is the same for everyone in the region: the user's own viewing plays no part.
 */
async function pushedNews(
  now: number,
  exclude: Set<string>,
  hiddenChannels: Set<ChannelId>,
  check: LanguageCheck,
  mostViewed: FeedItem[],
): Promise<(FeedItem & { speed: number })[]> {
  const news = await db.getMeta('news');
  const region = await db.getMeta('region');
  if (!news || now - news.fetchedAt > NEWS_MAX_AGE_MS || (region && news.region && news.region !== region)) return [];
  // Without enough of today's most viewed there's nothing to measure a push against.
  if (mostViewed.length < 4) return [];
  const bar = NEWS_PUSH_RATIO * median(mostViewed.map((v) => velocity(v, now)));
  const out: (FeedItem & { speed: number })[] = [];
  const outlets = new Set<ChannelId>();
  for (const story of news.stories) for (const v of story.videos) if (v.verified) outlets.add(v.channelId);
  for (const story of news.stories.slice(0, NEWS_STORIES)) {
    const recent = story.videos.filter((x) => x.verified && now - x.publishedAt <= NEWS_VIDEO_MAX_AGE_MS);
    const fastOutlets = new Set(recent.filter((x) => velocity(x, now) >= bar).map((x) => x.channelId));
    if (fastOutlets.size < NEWS_MIN_OUTLETS) continue;
    // Show the fastest of those the user can watch: not hidden, not seen, readable.
    const v = recent
      .filter((x) => fastOutlets.has(x.channelId) && !exclude.has(x.id) && !hiddenChannels.has(x.channelId) && readable(x.title, { ...check, mode: 'script' }))
      .sort((a, b) => velocity(b, now) - velocity(a, now))[0];
    if (!v) continue;
    out.push({
      speed: velocity(v, now),
      videoId: v.id,
      title: v.title,
      channelId: v.channelId,
      channelTitle: v.channelTitle,
      thumbnailUrl: v.thumbnailUrl,
      publishedAt: v.publishedAt,
      durationSec: v.durationSec,
      viewCount: v.viewCount || undefined,
      discover: false,
      reason: story.headline.length > 90 ? `${story.headline.slice(0, 87)}…` : story.headline,
    });
  }
  // Several established outlets among today's most viewed at once: YouTube is clearly pushing news.
  const outletHits = mostViewed.filter((v) => outlets.has(v.channelId));
  if (new Set(outletHits.map((v) => v.channelId)).size >= NEWS_MIN_OUTLETS) {
    for (const v of outletHits) out.push({ ...v, speed: velocity(v, now), reason: 'In the news today' });
  }
  return out.sort((a, b) => b.speed - a.speed);
}

async function computeTrending(
  snap: Snapshot,
  exclude: Set<string>,
  view: FeedView | undefined,
  impressions: Map<string, number>,
  subscriptionVideos: Video[],
): Promise<{ trending: FeedItem[]; trendingPending: boolean }> {
  if (!(await getSettings()).showTrending) return { trending: [], trendingPending: false };
  const [queries, hl, region] = await Promise.all([db.getMeta('trendingQueries'), db.getMeta('language'), db.getMeta('region')]);
  const check: LanguageCheck = {
    languages: userLanguages(hl, region, subscriptionVideos.map((v) => v.title)),
    mode: 'full',
  };
  const hiddenChannels = new Set(
    [...snap.feedback.values()].filter((f) => f.kind === 'notInterested').map((f) => f.channelId),
  );
  const affinity = topRowAffinity(snap, hiddenChannels);
  const seen = (id: string) => Math.pow(IMPRESSION_DECAY, impressions.get(id) ?? 0);
  // Each visit draws a different few: earlier-ranked more often, passed-over ones less often.
  const draw = <T extends FeedItem>(list: T[], weight: (item: T, rank: number) => number): T[] =>
    view ? drawOrder(list, view.seed, (i) => i.videoId, (i, rank) => weight(i, rank) * seen(i.videoId)) : list;

  // Today's most viewed, in languages the user reads.
  const mostViewed = pickTrending({
    now: snap.now,
    queries: queries ?? {},
    maxAgeMs: TRENDING_POOL_MS,
    excludeVideos: exclude,
    hiddenChannels,
    slots: TRENDING_CANDIDATES,
    accept: (v) => readable(v.title, check),
  });

  // News YouTube is pushing hard goes first (at most NEWS_SLOTS, one per story and outlet).
  const news: FeedItem[] = [];
  for (const { speed: _speed, ...item } of await pushedNews(snap.now, exclude, hiddenChannels, check, mostViewed)) {
    if (news.length >= NEWS_SLOTS) break;
    if (!news.some((n) => n.channelId === item.channelId || n.videoId === item.videoId)) news.push(item);
  }
  const taken = new Set(news.flatMap((n) => [n.videoId, n.channelId]));
  const search = mostViewed.filter((v) => !taken.has(v.videoId) && !taken.has(v.channelId));
  const community = (await communityTrending(exclude, hiddenChannels, snap.now, check)).filter(
    (c) => !taken.has(c.videoId) && !taken.has(c.channelId),
  );
  const drawn = draw(search, (i, rank) => ((search.length - rank) / search.length) * affinity(i.channelId));
  const trending = [...news, ...blendTopRow(drawn, community, TRENDING_SLOTS - news.length)];
  const fresh = Object.values(queries ?? {}).some((q) => snap.now - q.fetchedAt <= TRENDING_MAX_AGE_MS);
  return { trending, trendingPending: !fresh && !community.length && !news.length };
}

/** One Home visit: its random draw, and when it started (impressions from it don't count yet). */
export interface FeedView {
  seed: number;
  startedAt: number;
}

/**
 * Impressions from visits before `view`: the visit in progress is left out, so cards being
 * looked at right now don't sink while they're on screen.
 */
async function earlierImpressions(view: FeedView | undefined, now: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!view) return out;
  for (const [id, { n, at }] of Object.entries((await db.getMeta('impressions')) ?? {})) {
    if (now - at > IMPRESSION_TTL_MS) continue;
    const before = at >= view.startedAt ? n - 1 : n;
    if (before > 0) out.set(id, before);
  }
  return out;
}

/**
 * Count one impression per video per visit; forget old ones. `discover` maps Discover cards to
 * the source that found them, for on-device measurement (discover-stats.ts).
 */
export async function recordImpressions(ids: string[], view: FeedView, now = Date.now(), discover: Record<string, string> = {}): Promise<void> {
  const all = (await db.getMeta('impressions')) ?? {};
  const counted: [string, string][] = [];
  for (const id of ids) {
    const cur = all[id];
    if (cur && cur.at >= view.startedAt) continue; // already counted this visit
    all[id] = { n: (cur && now - cur.at <= IMPRESSION_TTL_MS ? cur.n : 0) + 1, at: now };
    const source = discover[id];
    if (source) counted.push([id, source]);
  }
  await recordDiscoverShown(counted, now);
  const kept = Object.entries(all)
    .filter(([, v]) => now - v.at <= IMPRESSION_TTL_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_IMPRESSIONS);
  await db.setMeta('impressions', Object.fromEntries(kept));
}

export async function computeFeed(now = Date.now(), view?: FeedView): Promise<FeedResponse> {
  const snap = await snapshot(now);
  const [videos, hidden, loggedOut, lastSubsSync, impressions] = await Promise.all([
    db.getVideosSince(now - DISCOVERY_WINDOW_MS),
    hiddenVideos(),
    db.getMeta('loggedOut'),
    db.getMeta('lastSubsSync'),
    earlierImpressions(view, now),
  ]);
  const recentSubs = videos.filter((v) => snap.subscribed.has(v.channelId) && v.publishedAt >= now - SUB_WINDOW_MS);
  const { trending, trendingPending } = await computeTrending(snap, hidden, view, impressions, recentSubs);

  if (snap.subscribed.size === 0) {
    const status = loggedOut ? 'loggedOut' : lastSubsSync ? 'empty' : 'syncing';
    return { status, trending, trendingPending, items: [], coldStart: true };
  }

  const candidates = topCandidates(snap, TOP_CANDIDATES_FOR_UPLOADS);
  const candidateSet = new Set(candidates);
  // Never repeat a top-row video further down.
  const exclude = new Set([...hidden, ...trending.map((t) => t.videoId)]);
  const subscriptionVideos = videos.filter(
    (v) => snap.subscribed.has(v.channelId) && v.publishedAt >= now - SUB_WINDOW_MS,
  );
  // Candidate uploads come from the Videos tab, which always gives plain videos a duration. One
  // without is left over from pre-rebuild RSS (a Short, live stream or premiere the Videos tab
  // never lists), so it would never get one: leave it out.
  const discoveryVideos = videos.filter((v) => candidateSet.has(v.channelId) && v.durationSec);
  const channelTitles = new Map([...snap.channels.values()].map((c) => [c.id, c.title]));

  const items = buildFeed({
    now,
    subscriptionVideos,
    discoveryVideos,
    candidateScores: snap.scores,
    engagement: snap.engagement,
    channelTitles,
    reasons: reasonsFor(snap, candidates),
    exclude,
    seed: view?.seed,
    impressions,
    seedOf: new Map([...(snap.via ?? [])].map(([id, v]) => [id, v.seed])),
  });
  const coldStart = !items.some((i) => i.discover);
  const channels = [...snap.channels.values()];
  const [withTrending, withItems] = [withAvatars(trending, channels), withAvatars(items, channels)];
  if (items.length === 0) return { status: 'syncing', trending: withTrending, trendingPending, items: withItems, coldStart };
  return { status: 'ok', trending: withTrending, trendingPending, items: withItems, coldStart };
}

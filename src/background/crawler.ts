/**
 * Candidate discovery and the top row. The service worker plans jobs and owns the rate limiter:
 * one request every 3–5 s, a daily budget per purpose, exponential backoff, and a stop-for-the-day
 * after repeated failures. InnerTube jobs are leased one at a time to an open YouTube tab
 * (content/relay.ts), which sends them from the page's origin; RSS runs here on an alarm.
 *
 * Subscription uploads are not crawled per channel at all: they come from YouTube's own
 * subscriptions feed (see subsfeed.ts). What remains grows slowly with the subscription count:
 * featured channels are re-read every 60 days, so N subscriptions cost about N/60 requests a day.
 */
import * as db from '../core/db';
import { crawlPriority } from '../core/engagement';
import { extractMentions, refToUrl } from '../core/mentions';
import {
  CANDIDATE_RECRAWL_MS,
  CANDIDATE_UPLOADS_REFRESH_MS,
  CHANNEL_RECRAWL_MS,
  MAX_HANDLE_RESOLVE_ATTEMPTS,
  MENTIONS_RSS_REFRESH_MS,
  PURPOSE_BUDGETS,
  TOP_CANDIDATES_FOR_CRAWL,
  TOP_CANDIDATES_FOR_UPLOADS,
  TOP_SUBS_FOR_MENTIONS_RSS,
  NEWS_REFRESH_MS,
  TRENDING_POOL_MS,
  TRENDING_POOL_PER_QUERY,
  TRENDING_REFRESH_MS,
  trendingQueries,
  type Purpose,
} from '../shared/constants';
import type { NewsStory } from '../content/innertube';
import { jobKey, jobPurpose, jobRunner, type Job, type JobResult, type Runner } from '../shared/jobs';
import type { LeaseResponse } from '../shared/messages';
import { getSettings } from '../shared/settings';
import type { ChannelId, HandleRecord, TrendingQueryResult, Video, TrendingVideo } from '../shared/types';
import { InnertubeError, fetchRss, type ChannelPage, type RssVideo } from '../content/innertube';
import { isSiblingTitle } from '../core/sources/graph';
import { snapshot, topCandidates, type Snapshot } from './feed';
import {
  dayKey,
  decide,
  initialState,
  recordFailure,
  recordSent,
  recordSuccess,
  rollDay,
  spentOn,
  type LimiterState,
} from './ratelimit';

export type { Job } from '../shared/jobs';

/** Max bare handles per channel to resolve, so one link-heavy description can't eat the budget. */
const MAX_REFS_PER_CHANNEL = 15;
/** Keep each worker tick well under the service worker's idle timeout. */
const TICK_BUDGET_MS = 25_000;
/** A YouTube tab holding the crawl lease must check in this often or another tab takes over. */
const LEASE_TTL_MS = 90_000;
/** How long a tab waits before asking again when there is nothing to do. */
const IDLE_POLL_MS = 60_000;
/** A plan is reused for this long between leases (scoring every 3–5 s would be wasteful). */
const PLAN_TTL_MS = 60_000;

class StopCrawl extends Error {}

// ---------------------------------------------------------------------------------------------
// Planning

/** Deterministic 0..1 per ID (FNV-1a), used to spread re-crawls that all started on one day. */
export function spread(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32;
}

/**
 * Re-crawl age for a channel: 75–125% of `base`, fixed per channel. A bootstrap crawls ~150
 * channels a day; without this they'd all come due again on the same few days.
 */
export function recrawlAge(id: ChannelId, base: number): number {
  return base * (0.75 + 0.5 * spread(id));
}

/** Much-watched, unsubscribed channels whose featured channels are read (~20 requests per 60 days). */
export const WATCHED_SEEDS_TO_CRAWL = 20;

export interface TrendingState {
  show: boolean;
  queries: Record<string, TrendingQueryResult>;
  /** Community-trending video IDs still needing YouTube's details (Enhanced discoverability). */
  communityMissing?: string[];
  /** Last News hub read, and for which region. */
  news?: { fetchedAt: number; region: string };
  /** The user's current YouTube region. */
  region?: string;
}

/**
 * Ordered work list; earlier jobs matter more. Pure apart from its inputs. `priority` orders
 * subscriptions (watch-log engagement, else the history seed); it defaults to engagement.
 */
export function planJobs(
  snap: Snapshot,
  handles: HandleRecord[],
  now: number,
  trending: TrendingState = { show: false, queries: {} },
  priority: Map<ChannelId, number> = snap.engagement,
): Job[] {
  const jobs: Job[] = [];
  const seen = new Set<string>();
  const push = (j: Job) => {
    const key = jobKey(j);
    if (!seen.has(key)) {
      seen.add(key);
      jobs.push(j);
    }
  };
  const byPriority = (a: ChannelId, b: ChannelId) => (priority.get(b) ?? 0) - (priority.get(a) ?? 0) || a.localeCompare(b);
  const subs = [...snap.subscribed].sort(byPriority);
  const ch = (id: ChannelId) => snap.channels.get(id);
  const stale = (t: number | undefined, maxAge: number) => !t || now - t > maxAge;
  const hidden = (id: ChannelId) => snap.feedback.get(id)?.kind === 'notInterested';

  // 1. The top row: six cheap searches, once a day.
  if (trending.show) {
    for (const query of trendingQueries(now)) {
      const q = trending.queries[query];
      if (q?.filter !== 'today' || stale(q.fetchedAt, TRENDING_REFRESH_MS)) push({ kind: 'trending', query });
    }
    const news = trending.news;
    if (!news || news.region !== (trending.region ?? news.region) || stale(news.fetchedAt, NEWS_REFRESH_MS)) push({ kind: 'news' });
    for (const id of trending.communityMissing ?? []) push({ kind: 'video', id });
  }
  // 2. Uploads of the best candidates (Videos tab: durations, views, age in one request).
  for (const id of topCandidates(snap, TOP_CANDIDATES_FOR_UPLOADS)) {
    if (stale(ch(id)?.videosTabFetchedAt, CANDIDATE_UPLOADS_REFRESH_MS)) push({ kind: 'videos', id });
  }
  // 3. Featured channels of subscriptions, most-watched first: never-read ones (the bootstrap,
  //    capped by the discovery budget at ~150 a day), then those older than 60 days.
  for (const id of subs) if (!ch(id)?.lastCrawledAt) push({ kind: 'channel', id });
  for (const id of subs) {
    if (stale(ch(id)?.lastCrawledAt, recrawlAge(id, CHANNEL_RECRAWL_MS))) push({ kind: 'channel', id });
  }
  // 3b. Featured channels of channels the user watches a lot without subscribing (Discover seeds
  //     too), the most-watched WATCHED_SEEDS_TO_CRAWL, on the same 60-day cycle.
  const watchedSeeds = [...(snap.seeds ?? new Map<ChannelId, number>())]
    .filter(([id]) => !snap.subscribed.has(id) && !hidden(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, WATCHED_SEEDS_TO_CRAWL);
  for (const [id] of watchedSeeds) {
    if (stale(ch(id)?.lastCrawledAt, recrawlAge(id, CHANNEL_RECRAWL_MS))) push({ kind: 'channel', id });
  }
  // 4. Mentions: weekly RSS descriptions of the most-watched subscriptions only. Everything else
  //    comes free from the watch pages the user opens.
  for (const id of subs.slice(0, TOP_SUBS_FOR_MENTIONS_RSS)) {
    if (stale(ch(id)?.uploadsFetchedAt, MENTIONS_RSS_REFRESH_MS)) push({ kind: 'rss', id });
  }
  // 5. Resolve handles from those descriptions, most-mentioned-by-subscriptions first.
  const pending = handles
    .filter((h) => h.resolvedAt === undefined && h.attempts < MAX_HANDLE_RESOLVE_ATTEMPTS)
    .map((h) => ({
      h,
      weight: Object.keys(h.mentionedBy).filter((id) => snap.subscribed.has(id)).length,
    }))
    .sort((a, b) => b.weight - a.weight);
  for (const { h } of pending) push({ kind: 'resolve', ref: h.ref });
  // 6. Second hop: featured channels of the top candidates.
  for (const id of topCandidates(snap, TOP_CANDIDATES_FOR_CRAWL)) {
    if (hidden(id)) continue;
    if (stale(ch(id)?.lastCrawledAt, recrawlAge(id, CANDIDATE_RECRAWL_MS))) push({ kind: 'channel', id });
  }
  return jobs;
}

/** Purposes with budget left today. */
export function openPurposes(s: LimiterState, now: number, budgets: Record<Purpose, number> = PURPOSE_BUDGETS): Set<Purpose> {
  return new Set((Object.keys(budgets) as Purpose[]).filter((p) => spentOn(s, p, now) < budgets[p]));
}

/** The first planned job this runner can do whose purpose still has budget today. */
export function pickJob(
  jobs: Job[],
  s: LimiterState,
  now: number,
  runner: Runner,
  budgets: Record<Purpose, number> = PURPOSE_BUDGETS,
): Job | null {
  const open = openPurposes(s, now, budgets);
  return jobs.find((j) => jobRunner(j) === runner && open.has(jobPurpose(j))) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Rate limiter state

let limiter: LimiterState | null = null;

export async function loadLimiter(now = Date.now()): Promise<LimiterState> {
  limiter ??= (await db.getMeta('rateLimiter')) ?? initialState(now);
  limiter = rollDay(limiter, now);
  return limiter;
}

async function saveLimiter(s: LimiterState): Promise<void> {
  limiter = s;
  await db.setMeta('rateLimiter', s);
}

export function resetLimiterCache(): void {
  limiter = null;
  plan = null;
  lease = null;
}

/** Counts a request sent by a content script (subscriptions feed, history) against `purpose`. */
export async function countRequest(purpose: Purpose, n = 1): Promise<void> {
  let s = await loadLimiter();
  for (let i = 0; i < n; i++) s = recordSent(s, Date.now(), purpose, false);
  await saveLimiter(s);
}

/** Whether `purpose` may send another request today (budget, daily cap, stop-for-the-day). */
export async function mayRequest(purpose: Purpose): Promise<boolean> {
  const { dailyCap } = await getSettings();
  const d = decide(await loadLimiter(), Date.now(), dailyCap, 0, { purpose, cap: PURPOSE_BUDGETS[purpose] });
  return d.ok || d.reason === 'backoff';
}

/** Errors that mean "this resource doesn't exist" rather than "YouTube is unhappy with us". */
function isNotFoundStatus(status: number): boolean {
  return status === 404 || status === 400 || status === 410;
}

async function recordOutcome(error: { status: number } | undefined): Promise<void> {
  const s = await loadLimiter();
  if (!error || isNotFoundStatus(error.status)) await saveLimiter(recordSuccess(s));
  else await saveLimiter(recordFailure(s, Date.now()));
}

// ---------------------------------------------------------------------------------------------
// Planning cache

let plan: { at: number; jobs: Job[] } | null = null;

async function currentPlan(now: number): Promise<Job[]> {
  if (plan && now - plan.at < PLAN_TTL_MS) return plan.jobs;
  const settings = await getSettings();
  const snap = await snapshot(now);
  const seed = await db.getMeta('historySeed');
  const jobs = planJobs(
    snap,
    await db.getAllHandles(),
    now,
    {
      show: settings.showTrending,
      queries: (await db.getMeta('trendingQueries')) ?? {},
      communityMissing: await communityVideosMissing(now),
      news: await db.getMeta('news'),
      region: await db.getMeta('region'),
    },
    crawlPriority(snap.engagement, seed?.counts),
  );
  plan = { at: now, jobs };
  return jobs;
}

/** Videos needed to fill the top row (with spares for hidden ones) whose details are missing or stale. */
export const COMMUNITY_DETAILS_PER_DAY = 12;
const COMMUNITY_DETAILS_MAX_AGE = 24 * 3_600_000;

async function communityVideosMissing(now: number): Promise<string[]> {
  const file = (await db.getMeta('community'))?.trending?.file;
  if (!file) return [];
  const details = (await db.getMeta('communityVideos')) ?? {};
  return file.videos
    .slice(0, COMMUNITY_DETAILS_PER_DAY)
    .map((e) => e.v)
    .filter((v) => !details[v] || now - details[v]!.fetchedAt > COMMUNITY_DETAILS_MAX_AGE);
}

async function storeVideoDetails(id: string, video: TrendingVideo | null, now: number): Promise<void> {
  const all = (await db.getMeta('communityVideos')) ?? {};
  all[id] = { fetchedAt: now, video };
  // Keep only what the current list can use.
  const wanted = new Set(((await db.getMeta('community'))?.trending?.file?.videos ?? []).map((e) => e.v));
  for (const k of Object.keys(all)) if (!wanted.has(k) && k !== id) delete all[k];
  await db.setMeta('communityVideos', all);
}

function dropFromPlan(job: Job): void {
  if (plan) plan = { ...plan, jobs: plan.jobs.filter((j) => jobKey(j) !== jobKey(job)) };
}

/** Forget the cached plan, e.g. after settings or subscriptions change. */
export function invalidatePlan(): void {
  plan = null;
}

// ---------------------------------------------------------------------------------------------
// Tab lease: one YouTube tab at a time sends InnerTube jobs

let lease: { tabId: number; until: number } | null = null;

/** True while a YouTube tab is working through crawl jobs. */
export function tabCrawlerActive(now = Date.now()): boolean {
  return !!lease && lease.until > now;
}

/** Called by a YouTube tab: the next job to send, or how long to wait. */
export async function leaseJob(tabId: number, now = Date.now()): Promise<LeaseResponse> {
  const settings = await getSettings();
  if (!settings.enabled) return { waitMs: IDLE_POLL_MS, stop: true };
  if (lease && lease.tabId !== tabId && lease.until > now) return { waitMs: LEASE_TTL_MS / 2 };
  lease = { tabId, until: now + LEASE_TTL_MS };

  const s = await loadLimiter(now);
  let job = pickJob(await currentPlan(now), s, now, 'tab');
  if (!job && plan && plan.at < now) {
    // The cached plan ran dry; results since then (new candidates, say) may have added work.
    invalidatePlan();
    job = pickJob(await currentPlan(now), s, now, 'tab');
  }
  if (!job) return { waitMs: IDLE_POLL_MS };
  const purpose = jobPurpose(job);
  const d = decide(s, now, settings.dailyCap, Math.random(), { purpose, cap: PURPOSE_BUDGETS[purpose] });
  if (!d.ok) {
    if (d.reason === 'backoff') return { waitMs: Math.max(1000, (d.retryAt ?? now) - now) };
    return { waitMs: IDLE_POLL_MS * 10 }; // daily cap or stopped for the day
  }
  if (d.waitMs > 0) return { waitMs: d.waitMs };
  await saveLimiter(recordSent(s, now, purpose));
  dropFromPlan(job);
  return { job };
}

/** A tab reports a leased job's outcome. Results are stored; failures feed the backoff. */
export async function reportResult(
  job: Job,
  result: JobResult | undefined,
  error: { status: number; message: string } | undefined,
): Promise<void> {
  await recordOutcome(error);
  const now = Date.now();
  if (error) {
    if (!isNotFoundStatus(error.status)) {
      console.warn('[YouTube Reborn] crawl request failed', jobKey(job), error.message);
      invalidatePlan(); // the job stays planned and is retried after the backoff
      return;
    }
    await markMissing(job, now);
    return;
  }
  if (result) await applyResult(job, result, now);
  // Featured channels and candidate uploads change who the top candidates are.
  if (job.kind === 'channel' || job.kind === 'videos') invalidatePlan();
}

/** A channel or handle that doesn't exist: remember we asked, so it isn't retried every tick. */
async function markMissing(job: Job, now: number): Promise<void> {
  if (job.kind === 'channel') await db.upsertChannel({ id: job.id, lastCrawledAt: now });
  else if (job.kind === 'videos') await db.upsertChannel({ id: job.id, videosTabFetchedAt: now });
  else if (job.kind === 'rss') await db.upsertChannel({ id: job.id, uploadsFetchedAt: now });
  else if (job.kind === 'resolve') await applyResolve(job.ref, null, now);
  else if (job.kind === 'trending') await storeTrending(job.query, [], now);
  else if (job.kind === 'news') await storeNews([], now);
  else if (job.kind === 'video') await storeVideoDetails(job.id, null, now);
}

/** Stores what a job fetched. Exported for tests. */
export async function applyResult(job: Job, result: JobResult, now: number): Promise<void> {
  if (job.kind === 'trending' && result.kind === 'trending') await storeTrending(job.query, result.videos, now);
  else if (job.kind === 'news' && result.kind === 'news') await storeNews(result.stories, now);
  else if (job.kind === 'channel' && result.kind === 'channel') await storeChannelPage(job.id, result.page, now);
  else if (job.kind === 'videos' && result.kind === 'videos') {
    await db.putVideos(result.videos.filter((v) => v.channelId === job.id));
    await db.upsertChannel({ id: job.id, videosTabFetchedAt: now });
  } else if (job.kind === 'resolve' && result.kind === 'resolve') await applyResolve(job.ref, result.channelId, now);
  else if (job.kind === 'video' && result.kind === 'video') await storeVideoDetails(job.id, result.video, now);
}

// ---------------------------------------------------------------------------------------------
// Storing results

/**
 * Featured channels from a channel's Home tab, whether crawled or read from a channel page the
 * user opened. `id` is the channel the page belongs to.
 */
export async function storeChannelPage(id: ChannelId, page: ChannelPage, now: number): Promise<void> {
  const owner = page.channel?.id ?? id;
  if (page.channel) await db.upsertChannel({ ...page.channel, lastCrawledAt: now });
  else await db.upsertChannel({ id: owner, lastCrawledAt: now });
  for (const f of page.featured) await db.upsertChannel({ id: f.id, title: f.title, handle: f.handle, thumbnailUrl: f.thumbnailUrl });
  await db.replaceEdgesFrom(
    owner,
    'featured',
    page.featured.map((f) => ({
      toChannelId: f.id,
      lastSeenAt: now,
      count: 1,
      sibling: isSiblingTitle(page.channel?.title, f.title),
    })),
    now,
  );
}

/** The News hub read; an empty read keeps the previous stories (but counts as a read). */
async function storeNews(stories: NewsStory[], now: number): Promise<void> {
  const region = (await db.getMeta('region')) ?? '';
  const prev = await db.getMeta('news');
  const keep = !stories.length && prev?.region === region ? prev.stories : stories;
  await db.setMeta('news', { fetchedAt: now, region, stories: keep });
}

async function storeTrending(query: string, videos: TrendingQueryResult['videos'], now: number): Promise<void> {
  const all = (await db.getMeta('trendingQueries')) ?? {};
  // Drop queries no longer in the list (e.g. last year's) so they don't linger.
  const current = new Set(trendingQueries(now));
  for (const q of Object.keys(all)) if (!current.has(q)) delete all[q];
  // Keep the last few days' results as a backup pool, with the newest view counts. Results from
  // the old "this week" search are dropped, not merged.
  const prev = all[query]?.filter === 'today' ? all[query]!.videos : [];
  const merged = new Map(prev.filter((v) => now - v.publishedAt <= TRENDING_POOL_MS).map((v) => [v.id, v]));
  for (const v of videos) merged.set(v.id, v);
  const pool = [...merged.values()].sort((a, b) => b.viewCount - a.viewCount).slice(0, TRENDING_POOL_PER_QUERY);
  all[query] = { fetchedAt: now, filter: 'today', videos: pool };
  await db.setMeta('trendingQueries', all);
}

async function applyResolve(ref: string, id: ChannelId | null, now: number): Promise<void> {
  const rec = await db.getHandle(ref);
  if (!rec) return;
  rec.attempts += 1;
  rec.channelId = id;
  rec.resolvedAt = now;
  await db.putHandle(rec);
  if (!id) return;
  await db.upsertChannel({ id, handle: ref.startsWith('@') ? ref : undefined });
  for (const [from, m] of Object.entries(rec.mentionedBy)) {
    await db.putEdge({
      fromChannelId: from,
      toChannelId: id,
      type: 'mention',
      firstSeenAt: now,
      lastSeenAt: m.lastSeenAt,
      count: m.count,
    });
  }
}

/**
 * Turn RSS description mentions into edges (or pending handle lookups). RSS has no durations, so
 * it never adds videos: uploads come from the subscriptions feed and Videos tabs. It only refreshes
 * view counts of videos already stored.
 */
export async function processUploads(from: ChannelId, videos: RssVideo[], now: number): Promise<void> {
  await db.updateStoredVideos(videos.map(({ description: _d, ...v }): Video => v));

  const byRef = new Map<string, { lastSeenAt: number; count: number }>();
  const mentions: { toChannelId: ChannelId; videoId: string; at: number }[] = [];
  const refsByVideo: { videoId: string; at: number; refs: Set<string> }[] = [];
  for (const v of videos) {
    const { channelIds, refs } = extractMentions(v.description);
    for (const id of channelIds) mentions.push({ toChannelId: id, videoId: v.id, at: v.publishedAt });
    refsByVideo.push({ videoId: v.id, at: v.publishedAt, refs });
    for (const ref of refs) {
      const cur = byRef.get(ref) ?? { lastSeenAt: 0, count: 0 };
      byRef.set(ref, { lastSeenAt: Math.max(cur.lastSeenAt, v.publishedAt), count: cur.count + 1 });
    }
  }

  const refs = [...byRef.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, MAX_REFS_PER_CHANNEL);
  for (const [ref, mention] of refs) {
    const rec: HandleRecord = (await db.getHandle(ref)) ?? { ref, channelId: null, attempts: 0, mentionedBy: {} };
    rec.mentionedBy[from] = mention;
    await db.putHandle(rec);
    if (rec.channelId) {
      for (const r of refsByVideo) {
        if (r.refs.has(ref)) mentions.push({ toChannelId: rec.channelId, videoId: r.videoId, at: r.at });
      }
    }
  }

  for (const id of new Set(mentions.map((m) => m.toChannelId))) if (id !== from) await db.upsertChannel({ id });
  await db.addMentions(from, mentions, now);
}

/** Mentions from the description of a watch page the user opened (no request needed). */
export async function storeWatchMentions(
  watch: { videoId: string; channelId: ChannelId; publishedAt?: number; mentions: ChannelId[] },
  now: number,
): Promise<void> {
  const targets = watch.mentions.filter((id) => id !== watch.channelId);
  if (!targets.length) return;
  for (const id of targets) await db.upsertChannel({ id });
  await db.addMentions(
    watch.channelId,
    targets.map((toChannelId) => ({ toChannelId, videoId: watch.videoId, at: watch.publishedAt ?? now })),
    now,
  );
}

// ---------------------------------------------------------------------------------------------
// Worker tick: RSS, the only crawl work that doesn't need a YouTube tab

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function workerRequest<T>(purpose: Purpose, fn: () => Promise<T>, deadline: number): Promise<T> {
  const { dailyCap, enabled } = await getSettings();
  if (!enabled) throw new StopCrawl('disabled');
  const s = await loadLimiter(Date.now());
  const d = decide(s, Date.now(), dailyCap, Math.random(), { purpose, cap: PURPOSE_BUDGETS[purpose] });
  if (!d.ok) throw new StopCrawl(d.reason);
  if (Date.now() + d.waitMs > deadline) throw new StopCrawl('tick budget');
  await sleep(d.waitMs);
  await saveLimiter(recordSent(await loadLimiter(Date.now()), Date.now(), purpose));
  try {
    const result = await fn();
    await recordOutcome(undefined);
    return result;
  } catch (err) {
    const status = err instanceof InnertubeError ? err.status : 0;
    await recordOutcome({ status });
    if (!isNotFoundStatus(status)) console.warn('[YouTube Reborn] crawl request failed', err);
    throw err;
  }
}

let running = false;

/** Runs worker jobs (RSS) until the tick budget, the limiter or the work list says stop. */
export async function crawlTick(onProgress?: () => void): Promise<number> {
  if (running) return 0;
  running = true;
  let done = 0;
  try {
    if (!(await getSettings()).enabled) return 0;
    const deadline = Date.now() + TICK_BUDGET_MS;
    const jobs = (await currentPlan(Date.now())).filter((j) => jobRunner(j) === 'worker');
    for (const job of jobs) {
      if (Date.now() >= deadline || job.kind !== 'rss') break;
      try {
        const feed = await workerRequest('mentions', () => fetchRss(job.id), deadline);
        await processUploads(job.id, feed.videos, Date.now());
        await db.upsertChannel({ id: job.id, title: feed.title || undefined, uploadsFetchedAt: Date.now() });
        dropFromPlan(job);
        done++;
      } catch (err) {
        if (err instanceof InnertubeError && isNotFoundStatus(err.status)) {
          await db.upsertChannel({ id: job.id, uploadsFetchedAt: Date.now() });
          dropFromPlan(job);
          continue;
        }
        break; // budget, backoff, tick budget, toggle off, or a failure: try again next tick
      }
    }
  } finally {
    running = false;
    if (done > 0) onProgress?.();
  }
  return done;
}

/** Today's spend per purpose, for the popup. */
export async function spendToday(now = Date.now()): Promise<{ spent: Record<Purpose, number>; total: number; stopped: boolean }> {
  const s = await loadLimiter(now);
  const spent = Object.fromEntries((Object.keys(PURPOSE_BUDGETS) as Purpose[]).map((p) => [p, spentOn(s, p, now)])) as Record<Purpose, number>;
  return { spent, total: s.counter.day === dayKey(now) ? s.counter.count : 0, stopped: s.stoppedDay === dayKey(now) };
}

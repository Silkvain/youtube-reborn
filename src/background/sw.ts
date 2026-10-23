/**
 * Service worker: owns the database, scoring, the rate limiter and the crawl plan. Content
 * scripts and the popup talk to it with messages (see shared/messages.ts). Every InnerTube
 * request is sent by a YouTube tab (page origin, so no header rewriting); the worker itself only
 * fetches RSS.
 */
import * as db from '../core/db';
import type { FeedVideo } from '../content/innertube';
import { HISTORY_SEED_RETRY_MS, PURPOSE_BUDGETS, SUBS_REFRESH_MS, DAY_MS } from '../shared/constants';
import type { Broadcast, Request, ResponseMap, Stats, SyncStep } from '../shared/messages';
import { DEFAULT_SETTINGS, getSettings, onEnabledChange, onSettingsChange } from '../shared/settings';
import { communityAvailable } from '../shared/community/config';
import { communityOptedIn, communityTick, onCommunityToggle } from './community';
import { maybeShowWelcome } from './welcome';
import {
  countRequest,
  crawlTick,
  invalidatePlan,
  leaseJob,
  mayRequest,
  reportResult,
  resetLimiterCache,
  spendToday,
  storeChannelPage,
  storeWatchMentions,
  tabCrawlerActive,
} from './crawler';
import { discoverSummary, recordDiscoverWatch } from './discover-stats';
import { computeArchive, computeFeed, recordImpressions, snapshot } from './feed';
import { statusLine } from './status';
import { advanceSync, claimSync, failSync, initialSubsFeedState, stopSync, type SubsFeedState, feedTimeline, updateDeepest, deeperRequest, archiveNeedsDeeper } from './subsfeed';

const CRAWL_ALARM = 'ydx-crawl';
const MAINTENANCE_ALARM = 'ydx-maintenance';
/** A tab that claimed the subscription sync has this long to report back before another may try. */
const SUBS_CLAIM_TTL_MS = 2 * 60_000;
const VIDEO_RETENTION_MS = 180 * DAY_MS;

// ---- Lifecycle ----

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const missing = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).filter(([k]) => !(k in stored)));
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
  await ensureAlarms();
  // Fresh installs ask about Enhanced discoverability up front (it stays off unless they agree).
  await maybeShowWelcome(reason).catch((err) => console.warn('[YouTube Reborn] welcome window failed', err));
});

chrome.runtime.onStartup.addListener(() => void ensureAlarms());

async function ensureAlarms(): Promise<void> {
  if (!(await chrome.alarms.get(CRAWL_ALARM))) {
    await chrome.alarms.create(CRAWL_ALARM, { delayInMinutes: 0.5, periodInMinutes: 1 });
  }
  if (!(await chrome.alarms.get(MAINTENANCE_ALARM))) {
    await chrome.alarms.create(MAINTENANCE_ALARM, { delayInMinutes: 5, periodInMinutes: 24 * 60 });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CRAWL_ALARM) {
    void runCrawl();
    void runCommunity();
  }
  if (alarm.name === MAINTENANCE_ALARM) void pruneOldVideos();
});

onEnabledChange((enabled) => {
  invalidatePlan();
  if (enabled) void runCrawl();
});

// Turning the top row on should fill it promptly, and either way open feeds should redraw.
let lastEnhanced: boolean | null = null;

onSettingsChange(() => {
  invalidatePlan();
  void (async () => {
    const { enhancedDiscovery } = await getSettings();
    if (enhancedDiscovery !== lastEnhanced) {
      lastEnhanced = enhancedDiscovery;
      await onCommunityToggle(enhancedDiscovery);
      if (enhancedDiscovery) void runCommunity();
    }
    void broadcast({ type: 'feed:updated' });
  })();
});

/** Channels to fetch community graph shards for: subscriptions, most-watched first. */
async function communitySeeds(): Promise<string[]> {
  const snap = await snapshot();
  return [...snap.subscribed].sort((a, b) => (snap.engagement.get(b) ?? 0) - (snap.engagement.get(a) ?? 0));
}

async function runCommunity(): Promise<void> {
  try {
    if (await communityTick(communitySeeds)) {
      invalidatePlan();
      void broadcast({ type: 'feed:updated' });
    }
  } catch (err) {
    console.warn('[YouTube Reborn] enhanced discoverability tick failed', err);
  }
}

/** Drop old uploads from channels you don't subscribe to; subscription uploads feed the archive. */
async function pruneOldVideos(): Promise<void> {
  const keep = new Set((await db.getAllChannels()).filter((c) => c.isSubscribed).map((c) => c.id));
  await db.pruneVideos(Date.now() - VIDEO_RETENTION_MS, keep);
}

// ---- Broadcast to YouTube tabs ----

async function broadcast(msg: Broadcast): Promise<void> {
  const tabs = await chrome.tabs.query({ url: '*://www.youtube.com/*' });
  await Promise.all(
    tabs.map((t) => (t.id === undefined ? null : chrome.tabs.sendMessage(t.id, msg).catch(() => undefined))),
  );
}

// ---- Subscriptions feed ----

/** A sync is failing when the last few attempts all failed. */
const FEED_FAILING_AFTER = 3;

async function feedState(): Promise<SubsFeedState> {
  return (await db.getMeta('subsFeed')) ?? initialSubsFeedState();
}

/**
 * Stores one feed page and returns how its newest-first timeline relates to what was already
 * stored. Shelf items (YouTube's "Most relevant" picks) are stored but left out of `known` and
 * `timeline`: they're mostly old, known videos and would end a sync early.
 */
async function storeFeedPage(videos: FeedVideo[]): Promise<{ known: number; fresh: number; timeline: FeedVideo[] }> {
  const timeline = feedTimeline(videos);
  const knownAll = await db.knownFeedVideoIds(videos.map((v) => v.id));
  const known = timeline.filter((v) => knownAll.has(v.id)).length;
  await db.putVideos(videos.map(({ channelTitle: _t, inShelf: _s, ...v }) => ({ ...v, inSubsFeed: true })));
  for (const v of videos) {
    if (v.channelTitle && !(await db.getChannel(v.channelId))?.title) await db.upsertChannel({ id: v.channelId, title: v.channelTitle });
  }
  return { known, fresh: videos.length - knownAll.size, timeline };
}

// ---- Messages ----

type Handler<T extends Request['type']> = (
  msg: Extract<Request, { type: T }>,
  sender?: chrome.runtime.MessageSender,
) => Promise<ResponseMap[T]>;

const handlers: { [T in Request['type']]: Handler<T> } = {
  async 'subs:claim'() {
    if (!(await getSettings()).enabled) return { due: false };
    const now = Date.now();
    const [last, claimed] = await Promise.all([db.getMeta('lastSubsSync'), db.getMeta('subsSyncClaimedAt')]);
    const due = !last || now - last > SUBS_REFRESH_MS;
    if (!due || (claimed && now - claimed < SUBS_CLAIM_TTL_MS)) return { due: false };
    await db.setMeta('subsSyncClaimedAt', now);
    return { due: true };
  },

  async 'subs:result'({ channels, requests }) {
    if (!(await getSettings()).enabled) return;
    await countRequest('subs', requests ?? 1);
    invalidatePlan();
    if (channels.length > 0) {
      // An empty list from a logged-in session is far more likely a parser break than a real
      // "unsubscribed from everything", so it never wipes existing subscriptions.
      await db.replaceSubscriptions(channels);
    }
    await db.setMeta('lastSubsSync', Date.now());
    await db.setMeta('loggedOut', false);
    await db.setMeta('subsSyncClaimedAt', 0);
    void broadcast({ type: 'feed:updated' });
  },

  async 'subs:loggedOut'() {
    await db.setMeta('loggedOut', true);
    await db.setMeta('subsSyncClaimedAt', 0);
    void broadcast({ type: 'feed:updated' });
  },

  async 'subs:error'({ message }) {
    console.warn('[YouTube Reborn] subscription sync failed:', message);
    await db.setMeta('subsSyncClaimedAt', 0);
  },

  async 'subsfeed:claim'(): Promise<SyncStep> {
    if (!(await getSettings()).enabled || !(await mayRequest('subs'))) return { request: null };
    const claim = claimSync(await feedState(), Date.now());
    if (!claim.due) return { request: null };
    await db.setMeta('subsFeed', claim.state);
    await countRequest('subs');
    return { request: claim.request, waitMs: 0 };
  },

  async 'subsfeed:page'({ page }): Promise<SyncStep> {
    const now = Date.now();
    const state = await feedState();
    if (!(await getSettings()).enabled) {
      await db.setMeta('subsFeed', stopSync(state, now));
      return { request: null };
    }
    if (page.loggedOut) {
      await db.setMeta('subsFeed', stopSync(state, now));
      await db.setMeta('loggedOut', true);
      void broadcast({ type: 'feed:updated' });
      return { request: null };
    }
    const { known, fresh, timeline } = await storeFeedPage(page.videos);
    const oldestAt = timeline.length ? Math.min(...timeline.map((v) => v.publishedAt)) : undefined;
    const adv = advanceSync(state, { items: timeline.length, known, oldestAt, continuation: page.continuation }, now);
    let next = updateDeepest(adv.state, oldestAt, page.continuation);
    let request = adv.next;
    if (request && !(await mayRequest('subs'))) {
      next = stopSync(next, now);
      request = null;
    }
    await db.setMeta('subsFeed', next);
    if (fresh > 0) void broadcast({ type: 'feed:updated' });
    if (!request) {
      invalidatePlan();
      return { request: null };
    }
    await countRequest('subs');
    return { request, waitMs: adv.waitMs };
  },

  async 'subsfeed:deeper'() {
    if (!(await getSettings()).enabled || !(await mayRequest('subs'))) return { request: null };
    const request = deeperRequest(await feedState());
    if (!request) return { request: null };
    await countRequest('subs');
    return { request };
  },

  async 'subsfeed:deeperPage'({ page }) {
    if (!(await getSettings()).enabled || page.loggedOut) return { added: 0, more: false };
    const { fresh, timeline } = await storeFeedPage(page.videos);
    const oldestAt = timeline.length ? Math.min(...timeline.map((v) => v.publishedAt)) : undefined;
    const state = await feedState();
    // An empty page or no continuation means the feed goes no further back.
    const next =
      oldestAt === undefined || !page.continuation
        ? { ...state, deepest: { token: null, oldestAt: Math.min(oldestAt ?? Infinity, state.deepest?.oldestAt ?? Infinity) } }
        : updateDeepest(state, oldestAt, page.continuation);
    await db.setMeta('subsFeed', next);
    return { added: fresh, more: !!next.deepest?.token };
  },

  async 'subsfeed:deeperFailed'() {
    const state = await feedState();
    if (state.deepest) await db.setMeta('subsFeed', { ...state, deepest: { ...state.deepest, token: null } });
  },

  async 'subsfeed:error'({ message }) {
    console.warn('[YouTube Reborn] subscriptions feed sync failed:', message);
    await db.setMeta('subsFeed', failSync(await feedState(), Date.now()));
  },

  async 'history:claim'() {
    if (!(await getSettings()).enabled || !(await mayRequest('subs'))) return { due: false };
    const seed = await db.getMeta('historySeed');
    if (seed?.ok) return { due: false };
    if (seed && Date.now() - seed.fetchedAt < HISTORY_SEED_RETRY_MS) return { due: false };
    // Mark the attempt up front so two tabs don't both read history.
    await db.setMeta('historySeed', { fetchedAt: Date.now(), counts: seed?.counts ?? {}, ok: false });
    return { due: true };
  },

  async 'history:result'({ ok, counts, requests }) {
    await countRequest('subs', requests);
    if (!(await getSettings()).enabled) return;
    await db.setMeta('historySeed', { fetchedAt: Date.now(), counts, ok });
    invalidatePlan();
  },

  async 'crawl:lease'(_msg, sender) {
    if (sender?.tab?.id === undefined) return { waitMs: 60_000, stop: true };
    return leaseJob(sender.tab.id);
  },

  async 'crawl:result'({ job, result, error }) {
    if (!(await getSettings()).enabled) return;
    await reportResult(job, result, error);
    if (result) void broadcast({ type: 'feed:updated' });
  },

  async 'page:watch'({ watch }) {
    if (!(await getSettings()).enabled) return;
    await storeWatchMentions(watch, Date.now());
  },

  async 'page:channel'({ page }) {
    if (!(await getSettings()).enabled || !page.channel) return;
    await storeChannelPage(page.channel.id, page, Date.now());
    invalidatePlan();
  },

  async 'watch:event'({ event }) {
    if (!(await getSettings()).enabled) return;
    await db.putWatchEvent(event);
    await recordDiscoverWatch(event.videoId, event.completion);
  },

  async 'feed:get'({ view }) {
    if (!(await getSettings()).enabled) return { status: 'empty', trending: [], items: [], coldStart: true };
    return computeFeed(Date.now(), view);
  },

  async 'feed:impressions'({ ids, view, discover }) {
    if (!(await getSettings()).enabled) return;
    await recordImpressions(ids.slice(0, 200), view, Date.now(), discover ?? {});
  },

  async 'feed:more'({ offset, limit, exclude }) {
    if (!(await getSettings()).enabled) return { items: [], hasMore: false };
    const page = await computeArchive(offset, limit, exclude);
    return { ...page, deeper: archiveNeedsDeeper(await feedState(), page) };
  },

  async feedback({ channelId, kind }) {
    await db.putFeedback({ channelId, kind, at: Date.now() });
  },

  async 'feedback:video'({ videoId }) {
    await db.putVideoFeedback({ videoId, at: Date.now() });
  },

  async 'feedback:undo'({ videoId, channelId }) {
    if (videoId) await db.deleteVideoFeedback(videoId);
    if (channelId) await db.deleteFeedback(channelId);
  },

  async region({ gl, hl }) {
    if (/^[A-Z]{2}$/.test(gl)) await db.setMeta('region', gl);
    if (hl && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(hl)) await db.setMeta('language', hl);
  },

  async 'stats:get'(): Promise<Stats> {
    const settings = await getSettings();
    const [snap, edges, videos, watchEvents, spend, lastSubsSync, loggedOut, feed] = await Promise.all([
      snapshot(),
      db.count('edges'),
      db.count('videos'),
      db.count('watchEvents'),
      spendToday(),
      db.getMeta('lastSubsSync'),
      db.getMeta('loggedOut'),
      feedState(),
    ]);
    const covered = [...snap.subscribed].filter((id) => snap.channels.get(id)?.lastCrawledAt).length;
    const base = {
      enabled: settings.enabled,
      subscriptions: snap.subscribed.size,
      candidates: snap.scores.size,
      edges,
      videos,
      watchEvents,
      requestsToday: spend.total,
      dailyCap: settings.dailyCap,
      spent: spend.spent,
      budgets: PURPOSE_BUDGETS,
      lastSubsSync,
      lastFeedSync: feed.lastOkAt,
      loggedOut: loggedOut === true,
      stoppedForToday: spend.stopped,
    };
    const community = communityAvailable() ? await communityStats() : undefined;
    return {
      ...base,
      community,
      discover: await discoverSummary(),
      status: statusLine({
        ...base,
        covered,
        feedSynced: feed.firstSyncDone,
        feedFailing: feed.failures >= FEED_FAILING_AFTER,
        tabActive: tabCrawlerActive(),
      }),
    };
  },

  async 'data:clear'() {
    // Community data lives in the same database, so it goes too; the toggle itself is a setting.
    await db.clearAll();
    if ((await getSettings()).enhancedDiscovery) await onCommunityToggle(true);
    resetLimiterCache();
    void broadcast({ type: 'feed:updated' });
  },
};

chrome.runtime.onMessage.addListener((msg: Request, sender, sendResponse) => {
  // Only accept messages from this extension's own pages and content scripts.
  if (sender.id !== chrome.runtime.id) return false;
  const handler = handlers[msg?.type] as Handler<Request['type']> | undefined;
  if (!handler) return false;
  handler(msg as never, sender).then(sendResponse, (err: unknown) => {
    console.error(`[YouTube Reborn] "${msg.type}" failed`, err);
    sendResponse(undefined);
  });
  return true; // async response
});

void ensureAlarms();
// Earlier versions installed a declarativeNetRequest session rule to rewrite Origin. Session
// rules don't survive an extension update, and without the permission none could apply.

/** Worker-side crawl (RSS only); InnerTube jobs are leased to YouTube tabs. */
async function communityStats(): Promise<NonNullable<Stats['community']>> {
  const state = (await db.getMeta('community')) ?? {};
  const graphChannels = Object.values(state.graph?.shards ?? {}).reduce((n, s) => n + Object.keys(s.neighbours).length, 0);
  return {
    on: await communityOptedIn(),
    paused: !(await getSettings()).enabled,
    lastOkAt: state.lastOkAt,
    failing: (state.failures ?? 0) >= 3,
    trendingVideos: state.trending?.file?.videos.length ?? 0,
    graphChannels,
    dormant: state.trending?.file?.dormant === true,
  };
}

async function runCrawl(): Promise<void> {
  try {
    await crawlTick(() => void broadcast({ type: 'feed:updated' }));
  } catch (err) {
    console.error('[YouTube Reborn] crawl tick failed', err);
  }
}

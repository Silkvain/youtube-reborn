import { HISTORY_SEED_PAGES, SUBS_FEED_PAGE_GAP_MS } from '../shared/constants';
import { send } from '../shared/messages';
import type { YtClientConfig } from '../shared/types';
import {
  HISTORY_BROWSE_ID,
  fetchHistoryPage,
  fetchSubscriptionFeedPage,
  fetchSubscriptions,
  historyCounts,
  type HistoryPage,
} from './innertube';

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Reads the user's subscriptions with the page's session if the service worker says a sync is
 * due (first enable, then at most once per 24 h). Only one tab does it at a time.
 */
export async function syncSubscriptionsIfDue(cfg: YtClientConfig | null): Promise<void> {
  const claim = await send({ type: 'subs:claim' }).catch(() => null);
  if (!claim?.due) return;
  if (!cfg) {
    await send({ type: 'subs:error', message: 'page config unavailable' });
    return;
  }
  try {
    const result = await fetchSubscriptions(cfg, document.cookie);
    if (result.loggedOut) await send({ type: 'subs:loggedOut' });
    else await send({ type: 'subs:result', channels: result.channels });
  } catch (err) {
    console.warn('[YouTube Reborn] could not read subscriptions', err);
    await send({ type: 'subs:error', message: String(err) });
  }
}

let feedSyncing = false;

/**
 * Subscription uploads from YouTube's subscriptions feed. The service worker decides whether a
 * sync is due and which page comes next (stop on overlap, gaps, backfill: background/subsfeed.ts);
 * this loop only fetches what it is asked for, with the page's session.
 */
export async function syncSubscriptionFeedIfDue(
  cfg: YtClientConfig | null,
  cookie = document.cookie,
  sleep: Sleep = defaultSleep,
): Promise<void> {
  if (!cfg?.loggedIn || feedSyncing) return;
  feedSyncing = true;
  try {
    let step = await send({ type: 'subsfeed:claim' }).catch(() => null);
    try {
      while (step?.request) {
        if (step.waitMs) await sleep(step.waitMs);
        const page = await fetchSubscriptionFeedPage(step.request, cfg, cookie);
        step = await send({
          type: 'subsfeed:page',
          page: { loggedOut: page.loggedOut, videos: page.videos, continuation: page.continuation },
        });
      }
    } catch (err) {
      console.warn('[YouTube Reborn] could not read the subscriptions feed', err);
      await send({ type: 'subsfeed:error', message: String(err) }).catch(() => undefined);
    }
    await seedHistoryIfDue(cfg, cookie, sleep);
  } finally {
    feedSyncing = false;
  }
}

/**
 * Once: read the first page or two of watch history so discovery can start with the channels the
 * user actually watches, before any watch logs exist. Only channel counts leave this function.
 */
export async function seedHistoryIfDue(cfg: YtClientConfig, cookie: string, sleep: Sleep = defaultSleep): Promise<void> {
  const claim = await send({ type: 'history:claim' }).catch(() => null);
  if (!claim?.due) return;
  const entries: HistoryPage['entries'] = [];
  let requests = 0;
  let body: Record<string, unknown> = { browseId: HISTORY_BROWSE_ID };
  try {
    for (let i = 0; i < HISTORY_SEED_PAGES; i++) {
      if (i > 0) await sleep(SUBS_FEED_PAGE_GAP_MS);
      requests++;
      const page = await fetchHistoryPage(body, cfg, cookie);
      if (page.loggedOut) break;
      entries.push(...page.entries);
      if (!page.continuation) break;
      body = { continuation: page.continuation };
    }
  } catch (err) {
    console.warn('[YouTube Reborn] could not read watch history', err);
  }
  await send({ type: 'history:result', ok: entries.length > 0, counts: historyCounts(entries), requests }).catch(() => undefined);
}

/**
 * Scrolling "Earlier from your subscriptions": read one older page of the subscriptions feed, if
 * the feed goes further back and the budget allows. Returns whether a page was read.
 */
export async function readDeeperFeedPage(cfg: YtClientConfig, cookie = document.cookie): Promise<boolean> {
  if (!cfg.loggedIn) return false;
  const claim = await send({ type: 'subsfeed:deeper' }).catch(() => null);
  if (!claim?.request) return false;
  try {
    const page = await fetchSubscriptionFeedPage(claim.request, cfg, cookie);
    await send({
      type: 'subsfeed:deeperPage',
      page: { loggedOut: page.loggedOut, videos: page.videos, continuation: page.continuation },
    });
    return !page.loggedOut;
  } catch (err) {
    console.warn('[YouTube Reborn] could not read older subscription uploads', err);
    await send({ type: 'subsfeed:deeperFailed' }).catch(() => undefined);
    return false;
  }
}

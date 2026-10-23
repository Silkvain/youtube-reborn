/**
 * Subscription uploads come from YouTube's own subscriptions feed (FEsubscriptions), read by a
 * YouTube tab with the page's session. One request covers every channel, so the cost follows
 * how much your subscriptions upload, not how many there are.
 *
 * This file is the pure state machine; the service worker stores its state and the content
 * script (content/subsfeed.ts) fetches the pages it asks for. A sync ("session") runs up to
 * three phases, within a page cap:
 *   top       newest pages until reaching videos already stored (incremental sync). A first run
 *             stops after a few pages so the feed renders fast, and leaves the rest to backfill.
 *   gap       a later sync that hit its page cap without overlap left a continuation token
 *             between the new pages and the stored ones; follow it until the overlap.
 *   backfill  after the first run, follow the chain back ~30 days, a few pages per Home visit.
 */
import type { SubsFeedStateValue } from '../core/db';
import {
  SUBS_FEED_BACKFILL_MS,
  SUBS_FEED_CATCHUP_GAP_MS,
  SUBS_FEED_CATCHUP_PAGES,
  SUBS_FEED_FIRST_RUN_PAGES,
  SUBS_FEED_OVERLAP_STOP,
  SUBS_FEED_PAGE_GAP_MS,
  SUBS_FEED_SESSION_MAX_PAGES,
  SUBS_FEED_SYNC_MS,
  SUBS_FEED_TOP_MAX_PAGES,
} from '../shared/constants';
import { SUBSCRIPTION_FEED_BROWSE_ID } from '../content/innertube';

export type SubsFeedState = SubsFeedStateValue;
export type SyncSession = NonNullable<SubsFeedState['session']>;
export type PageRequest = { browseId: string } | { continuation: string };

/** Most gap tokens kept; older gaps are given up (their videos then only show via backfill depth). */
const MAX_GAPS = 3;
/** A session whose tab went quiet this long is abandoned so another tab may sync. */
export const SESSION_STALE_MS = 2 * 60_000;

export function initialSubsFeedState(): SubsFeedState {
  return { firstSyncDone: false, gaps: [], backfill: null, backfillDone: false, failures: 0 };
}

/** Starts a sync if one is due and none is running. */
export function claimSync(
  state: SubsFeedState,
  now: number,
): { due: false } | { due: true; state: SubsFeedState; request: PageRequest } {
  const s = state.session;
  if (s && now - s.startedAt < SESSION_STALE_MS) return { due: false };
  if (state.lastSyncAt && now - state.lastSyncAt < SUBS_FEED_SYNC_MS) return { due: false };
  return {
    due: true,
    state: {
      ...state,
      session: { phase: 'top', pages: 0, phasePages: 0, startedAt: now, firstRun: !state.firstSyncDone },
    },
    request: { browseId: SUBSCRIPTION_FEED_BROWSE_ID },
  };
}

/** What one fetched page looked like, as far as the state machine cares. */
export interface PageOutcome {
  /** Plain videos on the page (after filtering Shorts and live items). */
  items: number;
  /** Of those, how many were already stored from the feed before this page. */
  known: number;
  /** Publish time of the oldest item on the page, if any. */
  oldestAt?: number;
  continuation: string | null;
}

export interface Advance {
  state: SubsFeedState;
  /** Next page to fetch, or null when this sync is over. */
  next: PageRequest | null;
  waitMs: number;
}

/**
 * The page's newest-first timeline: everything except videos that only appear in an inserted
 * shelf (YouTube's "Most relevant" picks are old, mostly known, and would end a sync early).
 * Falls back to every video if YouTube ever nests the whole timeline in a shelf.
 */
export function feedTimeline<T extends { inShelf?: boolean }>(videos: T[]): T[] {
  const unshelved = videos.filter((v) => !v.inShelf);
  return unshelved.length ? unshelved : videos;
}

/** True when a page reaches what the previous syncs already stored. */
export function reachesKnown(page: PageOutcome): boolean {
  return page.items > 0 && page.known >= Math.min(SUBS_FEED_OVERLAP_STOP, page.items);
}

function startNextPhase(state: SubsFeedState, session: SyncSession): Advance {
  if (session.pages < SUBS_FEED_SESSION_MAX_PAGES) {
    if (state.gaps[0]) {
      return {
        state: { ...state, session: { ...session, phase: 'gap', phasePages: 0 } },
        next: { continuation: state.gaps[0] },
        waitMs: SUBS_FEED_CATCHUP_GAP_MS,
      };
    }
    if (state.backfill && !state.backfillDone) {
      return {
        state: { ...state, session: { ...session, phase: 'backfill', phasePages: 0 } },
        next: { continuation: state.backfill },
        waitMs: SUBS_FEED_CATCHUP_GAP_MS,
      };
    }
  }
  return end(state);
}

function end(state: SubsFeedState): Advance {
  const { session: _done, ...rest } = state;
  return { state: rest, next: null, waitMs: 0 };
}

/** Folds one fetched page into the state and decides what to fetch next. */
export function advanceSync(state: SubsFeedState, page: PageOutcome, now: number): Advance {
  const session = state.session;
  if (!session) return end(state);
  const s: SyncSession = { ...session, pages: session.pages + 1, phasePages: session.phasePages + 1 };
  const overSession = s.pages >= SUBS_FEED_SESSION_MAX_PAGES;
  let st: SubsFeedState = { ...state, session: s, failures: 0, lastOkAt: now };

  if (s.phase === 'top') {
    const cap = s.firstRun ? SUBS_FEED_FIRST_RUN_PAGES : SUBS_FEED_TOP_MAX_PAGES;
    const finished = reachesKnown(page) || !page.continuation;
    if (!finished && s.phasePages < cap && !overSession) {
      return { state: st, next: { continuation: page.continuation! }, waitMs: SUBS_FEED_PAGE_GAP_MS };
    }
    st = { ...st, lastSyncAt: now, firstSyncDone: true };
    if (!finished) {
      // Page cap reached without meeting stored videos: the rest is fetched later.
      if (s.firstRun) st = { ...st, backfill: page.continuation, backfillDone: false };
      else st = { ...st, gaps: [page.continuation!, ...st.gaps].slice(0, MAX_GAPS) };
    } else if (s.firstRun && !page.continuation) {
      st = { ...st, backfill: null, backfillDone: true };
    }
    return startNextPhase(st, s);
  }

  if (s.phase === 'gap') {
    const closed = reachesKnown(page) || !page.continuation;
    if (closed) return startNextPhase({ ...st, gaps: st.gaps.slice(1) }, s);
    st = { ...st, gaps: [page.continuation!, ...st.gaps.slice(1)] };
    if (s.phasePages >= SUBS_FEED_CATCHUP_PAGES || overSession) return end(st);
    return { state: st, next: { continuation: page.continuation! }, waitMs: SUBS_FEED_CATCHUP_GAP_MS };
  }

  // backfill
  const deepEnough = page.oldestAt !== undefined && page.oldestAt < now - SUBS_FEED_BACKFILL_MS;
  if (deepEnough || !page.continuation) return end({ ...st, backfill: null, backfillDone: true });
  st = { ...st, backfill: page.continuation };
  if (s.phasePages >= SUBS_FEED_CATCHUP_PAGES || overSession) return end(st);
  return { state: st, next: { continuation: page.continuation }, waitMs: SUBS_FEED_CATCHUP_GAP_MS };
}

/** Ends the session early (out of budget, toggle off) without counting a failure. */
export function stopSync(state: SubsFeedState, now: number): SubsFeedState {
  const top = state.session?.phase === 'top';
  return end(top ? { ...state, lastSyncAt: now } : state).state;
}

/**
 * A page failed (network, HTTP error): end the session. The next attempt waits for the usual
 * sync interval. A continuation token that failed is dropped so a stale token can't block
 * catching up forever (the gap is then left unfilled; backfill stops where it got to).
 */
export function failSync(state: SubsFeedState, now: number): SubsFeedState {
  const s = state.session;
  let st: SubsFeedState = { ...state, failures: state.failures + 1 };
  if (s?.phase === 'top') st = { ...st, lastSyncAt: now };
  if (s?.phase === 'gap') st = { ...st, gaps: st.gaps.slice(1) };
  if (s?.phase === 'backfill') st = { ...st, backfill: null, backfillDone: true };
  return end(st).state;
}

/** Remember the furthest point a page reached, so scrolling can read on from there. */
export function updateDeepest(state: SubsFeedState, oldestAt: number | undefined, continuation: string | null): SubsFeedState {
  if (oldestAt === undefined) return state;
  if (state.deepest && state.deepest.oldestAt <= oldestAt) return state;
  return { ...state, deepest: { token: continuation, oldestAt } };
}

/** The next older page to read for the archive, if the feed goes further back. */
export function deeperRequest(state: SubsFeedState): { continuation: string } | null {
  return state.deepest?.token ? { continuation: state.deepest.token } : null;
}

/**
 * Whether an archive page should read further back first: it reaches past what the feed has
 * covered (older videos there came from RSS before the rebuild and lack durations) or it ran out.
 */
export function archiveNeedsDeeper(
  state: SubsFeedState,
  page: { items: { publishedAt: number }[]; hasMore: boolean },
): boolean {
  if (!state.deepest?.token) return false;
  if (!page.hasMore) return true;
  return page.items.some((i) => i.publishedAt < state.deepest!.oldestAt);
}

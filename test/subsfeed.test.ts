import {
  archiveNeedsDeeper,
  deeperRequest,
  updateDeepest,
  advanceSync,
  claimSync,
  failSync,
  initialSubsFeedState,
  reachesKnown,
  stopSync,
  type PageOutcome,
  type SubsFeedState,
} from '../src/background/subsfeed';
import {
  SUBS_FEED_BACKFILL_MS,
  SUBS_FEED_CATCHUP_PAGES,
  SUBS_FEED_FIRST_RUN_PAGES,
  SUBS_FEED_SESSION_MAX_PAGES,
  SUBS_FEED_SYNC_MS,
  SUBS_FEED_TOP_MAX_PAGES,
} from '../src/shared/constants';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const page = (p: Partial<PageOutcome> = {}): PageOutcome => ({ items: 30, known: 0, oldestAt: NOW - DAY, continuation: 'next', ...p });

/** Runs a whole sync session against a scripted list of pages; returns the final state and requests made. */
function run(state: SubsFeedState, pages: PageOutcome[], now = NOW) {
  const claim = claimSync(state, now);
  if (!claim.due) return { state, requests: [] as unknown[] };
  let st = claim.state;
  const requests: unknown[] = [claim.request];
  for (const p of pages) {
    const adv = advanceSync(st, p, now);
    st = adv.state;
    if (!adv.next) return { state: st, requests };
    requests.push(adv.next);
  }
  throw new Error(`sync wanted more than ${pages.length} pages`);
}

describe('subscriptions feed sync', () => {
  it('first run: a few pages for the first render, then hands the rest to backfill', () => {
    const pages = Array.from({ length: SUBS_FEED_FIRST_RUN_PAGES }, (_, i) => page({ continuation: `c${i + 1}` }));
    const backfill = Array.from({ length: SUBS_FEED_CATCHUP_PAGES }, (_, i) => page({ continuation: `b${i + 1}` }));
    const { state, requests } = run(initialSubsFeedState(), [...pages, ...backfill]);
    expect(requests[0]).toEqual({ browseId: 'FEsubscriptions' });
    expect(requests).toHaveLength(SUBS_FEED_FIRST_RUN_PAGES + SUBS_FEED_CATCHUP_PAGES);
    expect(state).toMatchObject({ firstSyncDone: true, lastSyncAt: NOW, backfill: `b${SUBS_FEED_CATCHUP_PAGES}`, backfillDone: false });
    expect(state.session).toBeUndefined();
  });

  it('backfill stops once it reaches ~30 days back, or the end of the chain', () => {
    let state: SubsFeedState = { ...initialSubsFeedState(), firstSyncDone: true, lastSyncAt: NOW - SUBS_FEED_SYNC_MS - 1, backfill: 'b1' };
    // Top page overlaps immediately, then backfill: one page, then one older than 30 days.
    ({ state } = run(state, [page({ known: 30 }), page({ continuation: 'b2' }), page({ oldestAt: NOW - SUBS_FEED_BACKFILL_MS - DAY })]));
    expect(state).toMatchObject({ backfill: null, backfillDone: true });
    state = { ...initialSubsFeedState(), firstSyncDone: true, backfill: 'b1' };
    ({ state } = run(state, [page({ known: 30 }), page({ continuation: null })]));
    expect(state.backfillDone).toBe(true);
  });

  it('incremental sync stops on overlap with stored videos', () => {
    const state: SubsFeedState = { ...initialSubsFeedState(), firstSyncDone: true, backfillDone: true, lastSyncAt: NOW - SUBS_FEED_SYNC_MS - 1 };
    const { state: after, requests } = run(state, [page({ known: 0 }), page({ known: 12 })]);
    expect(requests).toEqual([{ browseId: 'FEsubscriptions' }, { continuation: 'next' }]);
    expect(after).toMatchObject({ lastSyncAt: NOW, gaps: [] });
  });

  it('one stray known video does not end a sync early', () => {
    expect(reachesKnown(page({ known: 1, items: 30 }))).toBe(false);
    expect(reachesKnown(page({ known: 3, items: 30 }))).toBe(true);
    expect(reachesKnown(page({ known: 2, items: 2 }))).toBe(true);
    expect(reachesKnown(page({ known: 0, items: 0 }))).toBe(false);
  });

  it('too many new uploads leave a gap, filled on later syncs until it meets stored videos', () => {
    let state: SubsFeedState = { ...initialSubsFeedState(), firstSyncDone: true, backfillDone: true, lastSyncAt: NOW - SUBS_FEED_SYNC_MS - 1 };
    const top = Array.from({ length: SUBS_FEED_TOP_MAX_PAGES }, (_, i) => page({ continuation: `t${i + 1}` }));
    const gap = Array.from({ length: SUBS_FEED_CATCHUP_PAGES }, (_, i) => page({ continuation: `g${i + 1}` }));
    let requests: unknown[];
    ({ state, requests } = run(state, [...top, ...gap]));
    expect(requests[SUBS_FEED_TOP_MAX_PAGES]).toEqual({ continuation: `t${SUBS_FEED_TOP_MAX_PAGES}` });
    expect(requests.length).toBeLessThanOrEqual(SUBS_FEED_SESSION_MAX_PAGES);
    expect(state.gaps).toEqual([`g${SUBS_FEED_CATCHUP_PAGES}`]);
    // Next sync: top overlaps, then the gap continues where it left off and closes on overlap.
    const later = NOW + SUBS_FEED_SYNC_MS + 1;
    ({ state, requests } = run(state, [page({ known: 30 }), page({ known: 0 }), page({ known: 20 })], later));
    expect(requests).toEqual([{ browseId: 'FEsubscriptions' }, { continuation: `g${SUBS_FEED_CATCHUP_PAGES}` }, { continuation: 'next' }]);
    expect(state.gaps).toEqual([]);
  });

  it('an empty feed (no subscriptions, or nothing parsed) ends the sync without looping', () => {
    const { state, requests } = run(initialSubsFeedState(), [page({ items: 0, known: 0, oldestAt: undefined, continuation: null })]);
    expect(requests).toHaveLength(1);
    expect(state).toMatchObject({ firstSyncDone: true, backfillDone: true, backfill: null });
  });

  it('a page with only Shorts and live items but a continuation keeps going', () => {
    const { requests } = run(initialSubsFeedState(), [
      page({ items: 0, known: 0, oldestAt: undefined, continuation: 'c1' }),
      page({ continuation: null }),
    ]);
    expect(requests).toEqual([{ browseId: 'FEsubscriptions' }, { continuation: 'c1' }]);
  });

  it('is not due again within 30 minutes, nor while another tab is syncing', () => {
    const done: SubsFeedState = { ...initialSubsFeedState(), firstSyncDone: true, lastSyncAt: NOW };
    expect(claimSync(done, NOW + SUBS_FEED_SYNC_MS - 1).due).toBe(false);
    expect(claimSync(done, NOW + SUBS_FEED_SYNC_MS + 1).due).toBe(true);
    const claimed = claimSync(initialSubsFeedState(), NOW);
    if (!claimed.due) throw new Error('expected a claim');
    expect(claimSync(claimed.state, NOW + 1000).due).toBe(false);
    // A tab that went quiet gives way after a couple of minutes.
    expect(claimSync(claimed.state, NOW + 5 * 60_000).due).toBe(true);
  });

  it('failures end the session, drop a bad token and wait for the next interval', () => {
    const claimed = claimSync({ ...initialSubsFeedState(), firstSyncDone: true, gaps: ['bad'] }, NOW);
    if (!claimed.due) throw new Error('expected a claim');
    let st = advanceSync(claimed.state, page({ known: 30 }), NOW).state; // now in the gap phase
    expect(st.session?.phase).toBe('gap');
    st = failSync(st, NOW);
    expect(st).toMatchObject({ gaps: [], failures: 1 });
    expect(st.session).toBeUndefined();
    const top = claimSync(initialSubsFeedState(), NOW);
    if (!top.due) throw new Error('expected a claim');
    expect(failSync(top.state, NOW).lastSyncAt).toBe(NOW);
    expect(stopSync(top.state, NOW)).toMatchObject({ lastSyncAt: NOW, failures: 0 });
  });
});

describe('reading further back for older uploads', () => {
  const base = initialSubsFeedState();

  it('remembers the furthest point reached and the token beyond it', () => {
    let st = updateDeepest(base, NOW - 10 * DAY, 'tok10');
    expect(st.deepest).toEqual({ token: 'tok10', oldestAt: NOW - 10 * DAY });
    // A newer page (e.g. the next top sync) never moves it forward again.
    expect(updateDeepest(st, NOW - DAY, 'tok1')).toBe(st);
    st = updateDeepest(st, NOW - 20 * DAY, 'tok20');
    expect(deeperRequest(st)).toEqual({ continuation: 'tok20' });
    expect(updateDeepest(st, undefined, 'x')).toBe(st);
  });

  it('nothing to read once the feed ends', () => {
    expect(deeperRequest(base)).toBeNull();
    expect(deeperRequest({ ...base, deepest: { token: null, oldestAt: NOW - 90 * DAY } })).toBeNull();
  });

  it('asks to read further when the archive passes the covered range or runs out', () => {
    const st = updateDeepest(base, NOW - 10 * DAY, 'tok');
    const at = (days: number) => ({ publishedAt: NOW - days * DAY });
    expect(archiveNeedsDeeper(st, { items: [at(2), at(5)], hasMore: true })).toBe(false);
    expect(archiveNeedsDeeper(st, { items: [at(5), at(12)], hasMore: true })).toBe(true);
    expect(archiveNeedsDeeper(st, { items: [at(5)], hasMore: false })).toBe(true);
    expect(archiveNeedsDeeper(base, { items: [at(50)], hasMore: false })).toBe(false);
  });
});

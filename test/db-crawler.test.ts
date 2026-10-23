import 'fake-indexeddb/auto';
import * as db from '../src/core/db';
import { applyResult, pickJob, planJobs, processUploads, storeChannelPage, storeWatchMentions } from '../src/background/crawler';
import { initialState, recordSent } from '../src/background/ratelimit';
import { PURPOSE_BUDGETS } from '../src/shared/constants';
import { snapshot } from '../src/background/feed';
import type { RssVideo } from '../src/content/innertube';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const X = 'UCxxxxxxxxxxxxxxxxxxxxxx';
const NOW = 1_800_000_000_000;

const rss = (id: string, description: string, publishedAt = NOW): RssVideo => ({
  id,
  channelId: A,
  title: id,
  publishedAt,
  thumbnailUrl: '',
  description,
});

beforeEach(async () => {
  await db.clearAll();
});

describe('database', () => {
  it('records the schema version', async () => {
    await db.getDB();
    expect(await db.getMeta('schemaVersion')).toBe(db.SCHEMA_VERSION);
  });

  it('v1 -> current migration marks uploads stale so view counts get fetched', async () => {
    await db.clearAll();
    // Build a version-1 database by hand, as the first release created it.
    const raw = indexedDB.open(db.DB_NAME, 1);
    raw.onupgradeneeded = () => {
      const d = raw.result;
      d.createObjectStore('channels', { keyPath: 'id' });
      const edges = d.createObjectStore('edges', { keyPath: ['fromChannelId', 'toChannelId', 'type'] });
      edges.createIndex('byFrom', 'fromChannelId');
      edges.createIndex('byTo', 'toChannelId');
      const videos = d.createObjectStore('videos', { keyPath: 'id' });
      videos.createIndex('byChannel', 'channelId');
      videos.createIndex('byPublished', 'publishedAt');
      const watch = d.createObjectStore('watchEvents', { keyPath: 'id' });
      watch.createIndex('byChannel', 'channelId');
      watch.createIndex('byVideo', 'videoId');
      d.createObjectStore('feedback', { keyPath: 'channelId' });
      d.createObjectStore('handles', { keyPath: 'ref' });
      d.createObjectStore('meta', { keyPath: 'key' });
    };
    const v1 = await new Promise<IDBDatabase>((r) => (raw.onsuccess = () => r(raw.result)));
    const tx = v1.transaction('channels', 'readwrite');
    tx.objectStore('channels').put({ id: A, title: 'A', isSubscribed: true, uploadsFetchedAt: 123, lastCrawledAt: 456 });
    tx.objectStore('channels').put({ id: B, title: 'B', isSubscribed: true });
    await new Promise((r) => (tx.oncomplete = r));
    v1.close();

    expect(await db.getChannel(A)).toMatchObject({ title: 'A', lastCrawledAt: 456 });
    expect((await db.getChannel(A))?.uploadsFetchedAt).toBeUndefined();
    expect(await db.getChannel(B)).toMatchObject({ title: 'B', isSubscribed: true });
    expect(await db.getMeta('schemaVersion')).toBe(db.SCHEMA_VERSION);
    // v3 store exists after migrating.
    await db.putVideoFeedback({ videoId: 'v', at: 1 });
    expect(await db.getAllVideoFeedback()).toEqual([{ videoId: 'v', at: 1 }]);
  });

  it('v3 -> v4 migration keeps user data and drops the old durations bookkeeping', async () => {
    await db.clearAll();
    const raw = indexedDB.open(db.DB_NAME, 3);
    raw.onupgradeneeded = () => {
      const d = raw.result;
      d.createObjectStore('channels', { keyPath: 'id' });
      const edges = d.createObjectStore('edges', { keyPath: ['fromChannelId', 'toChannelId', 'type'] });
      edges.createIndex('byFrom', 'fromChannelId');
      edges.createIndex('byTo', 'toChannelId');
      const videos = d.createObjectStore('videos', { keyPath: 'id' });
      videos.createIndex('byChannel', 'channelId');
      videos.createIndex('byPublished', 'publishedAt');
      const watch = d.createObjectStore('watchEvents', { keyPath: 'id' });
      watch.createIndex('byChannel', 'channelId');
      watch.createIndex('byVideo', 'videoId');
      d.createObjectStore('feedback', { keyPath: 'channelId' });
      d.createObjectStore('handles', { keyPath: 'ref' });
      d.createObjectStore('meta', { keyPath: 'key' });
      d.createObjectStore('videoFeedback', { keyPath: 'videoId' });
    };
    const v3 = await new Promise<IDBDatabase>((r) => (raw.onsuccess = () => r(raw.result)));
    const stores = ['channels', 'edges', 'videos', 'watchEvents', 'feedback', 'videoFeedback', 'meta'];
    const tx = v3.transaction(stores, 'readwrite');
    tx.objectStore('channels').put({ id: A, title: 'A', isSubscribed: true, lastCrawledAt: 456, uploadsFetchedAt: 789, durationsFetchedAt: 999 });
    tx.objectStore('edges').put({ fromChannelId: A, toChannelId: X, type: 'mention', firstSeenAt: 1, lastSeenAt: 2, count: 3 });
    tx.objectStore('videos').put({ id: 'old', channelId: A, title: 'Old', publishedAt: NOW, thumbnailUrl: '' });
    tx.objectStore('watchEvents').put({ id: 'w:1', videoId: 'old', channelId: A, watchedSec: 60, durationSec: 100, completion: 0.6, abandoned: false, at: 1 });
    tx.objectStore('feedback').put({ channelId: X, kind: 'more', at: 1 });
    tx.objectStore('videoFeedback').put({ videoId: 'hidden', at: 1 });
    tx.objectStore('meta').put({ key: 'lastSubsSync', value: 42 });
    await new Promise((r) => (tx.oncomplete = r));
    v3.close();

    const a = await db.getChannel(A);
    expect(a).toEqual({ id: A, title: 'A', isSubscribed: true, lastCrawledAt: 456, uploadsFetchedAt: 789 });
    expect(await db.getAllEdges()).toHaveLength(1);
    expect(await db.getAllWatchEvents()).toHaveLength(1);
    expect(await db.getAllFeedback()).toEqual([{ channelId: X, kind: 'more', at: 1 }]);
    expect(await db.getAllVideoFeedback()).toEqual([{ videoId: 'hidden', at: 1 }]);
    expect(await db.getMeta('lastSubsSync')).toBe(42);
    expect(await db.getMeta('schemaVersion')).toBe(4);
    // RSS-era videos aren't "from the feed", so the first feed sync can't stop on them.
    expect((await db.knownFeedVideoIds(['old'])).size).toBe(0);
    // A legacy mention edge (count only) keeps its count as a floor when new mentions arrive.
    await db.addMentions(A, [{ toChannelId: X, videoId: 'new', at: 5 }], NOW);
    expect((await db.getAllEdges())[0]).toMatchObject({ count: 3, videos: ['new'], lastSeenAt: 5, firstSeenAt: 1 });
  });

  it('replaceSubscriptions marks removed channels unsubscribed', async () => {
    await db.replaceSubscriptions([{ id: A, title: 'A' }, { id: B, title: 'B' }]);
    await db.replaceSubscriptions([{ id: A, title: 'A' }]);
    const chans = await db.getAllChannels();
    expect(chans.find((c) => c.id === A)?.isSubscribed).toBe(true);
    expect(chans.find((c) => c.id === B)?.isSubscribed).toBe(false);
  });

  it('upsertChannel never erases known fields', async () => {
    await db.upsertChannel({ id: X, title: 'Known', handle: '@x' });
    await db.upsertChannel({ id: X, title: '', lastCrawledAt: 5 });
    expect(await db.getChannel(X)).toMatchObject({ title: 'Known', handle: '@x', lastCrawledAt: 5, isSubscribed: false });
  });

  it('pruneVideos keeps old uploads from channels in the keep set', async () => {
    const v = (id: string, channelId: string, publishedAt: number) => ({ id, channelId, title: id, publishedAt, thumbnailUrl: '' });
    await db.putVideos([v('oldSub', A, 1), v('oldOther', X, 1), v('newOther', X, 1_000)]);
    expect(await db.pruneVideos(500, new Set([A]))).toBe(1);
    expect((await db.getVideosSince(0)).map((x) => x.id).sort()).toEqual(['newOther', 'oldSub']);
  });

  it('replaceEdgesFrom keeps firstSeenAt and drops edges no longer present', async () => {
    await db.replaceEdgesFrom(A, 'featured', [{ toChannelId: X, lastSeenAt: 1, count: 1 }, { toChannelId: B, lastSeenAt: 1, count: 1 }], 100);
    await db.replaceEdgesFrom(A, 'featured', [{ toChannelId: X, lastSeenAt: 2, count: 1 }], 200);
    const edges = await db.getAllEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ toChannelId: X, firstSeenAt: 100, lastSeenAt: 2 });
  });
});

describe('processUploads', () => {
  it('links direct mentions and queues handles, without adding duration-less videos', async () => {
    // v1 is already stored (from the subscriptions feed, with a duration); v2 and v3 are not.
    await db.putVideos([{ id: 'v1', channelId: A, title: 'old title', publishedAt: NOW - 1000, thumbnailUrl: '', durationSec: 300, viewCount: 5 }]);
    await processUploads(
      A,
      [
        rss('v1', `Thanks youtube.com/channel/${X} and @someone`, NOW - 1000),
        rss('v2', `Again https://www.youtube.com/channel/${X}`, NOW),
        rss('v3', `Self link youtube.com/channel/${A}`, NOW),
      ],
      NOW,
    );
    // RSS has no durations: it only refreshes what's stored, and never adds videos.
    expect(await db.getVideosSince(0)).toEqual([
      expect.objectContaining({ id: 'v1', title: 'v1', durationSec: 300 }),
    ]);
    const edges = await db.getAllEdges();
    expect(edges).toEqual([
      expect.objectContaining({ fromChannelId: A, toChannelId: X, type: 'mention', count: 2, lastSeenAt: NOW }),
    ]);
    expect(await db.getHandle('@someone')).toMatchObject({ channelId: null, attempts: 0, mentionedBy: { [A]: { count: 1 } } });
  });

  it('uses already-resolved handles immediately', async () => {
    await db.putHandle({ ref: '@known', channelId: X, resolvedAt: 1, attempts: 1, mentionedBy: {} });
    await processUploads(A, [rss('v1', 'with @known')], NOW);
    expect(await db.getAllEdges()).toEqual([expect.objectContaining({ toChannelId: X, type: 'mention' })]);
  });
});

describe('planJobs', () => {
  it('orders candidate uploads, then featured bootstrap, then mention work', async () => {
    await db.replaceSubscriptions([{ id: A, title: 'A' }]);
    await db.replaceSubscriptions([{ id: A, title: 'A' }, { id: B, title: 'B' }]);
    await db.upsertChannel({ id: B, lastCrawledAt: NOW, uploadsFetchedAt: NOW });
    await db.replaceEdgesFrom(B, 'featured', [{ toChannelId: X, lastSeenAt: NOW, count: 1 }], NOW);
    await db.putHandle({ ref: '@pending', channelId: null, attempts: 0, mentionedBy: { [B]: { lastSeenAt: NOW, count: 1 } } });
    await db.putHandle({ ref: '@givenup', channelId: null, attempts: 3, mentionedBy: {} });

    const jobs = planJobs(await snapshot(NOW), await db.getAllHandles(), NOW);
    expect(jobs.slice(0, 4)).toEqual([
      { kind: 'videos', id: X },
      { kind: 'channel', id: A },
      { kind: 'rss', id: A },
      { kind: 'resolve', ref: '@pending' },
    ]);
    expect(jobs).not.toContainEqual({ kind: 'resolve', ref: '@givenup' });
    // B was crawled just now: no channel job for it. No per-subscription upload polling at all.
    expect(jobs).not.toContainEqual({ kind: 'channel', id: B });
    expect(jobs.some((j) => j.kind === 'rss' && j.id === B)).toBe(false);
  });

  it('orders the featured bootstrap by engagement, with the history seed as a fallback', async () => {
    const C = 'UCcccccccccccccccccccccc';
    await db.replaceSubscriptions([{ id: A, title: 'A' }, { id: B, title: 'B' }, { id: C, title: 'C' }]);
    const snap = await snapshot(NOW);
    const channelOrder = (priority: Map<string, number>) =>
      planJobs(snap, [], NOW, undefined, priority).filter((j) => j.kind === 'channel').map((j) => ('id' in j ? j.id : ''));
    expect(channelOrder(new Map([[C, 0.9], [B, 0.2]]))).toEqual([C, B, A]);
  });

  it('re-reads featured channels only after ~60 days, spread so they don\'t all come due at once', async () => {
    await db.replaceSubscriptions([{ id: A, title: 'A' }]);
    await db.upsertChannel({ id: A, lastCrawledAt: NOW - 30 * 86_400_000, uploadsFetchedAt: NOW });
    expect(planJobs(await snapshot(NOW), [], NOW).some((j) => j.kind === 'channel')).toBe(false);
    await db.upsertChannel({ id: A, lastCrawledAt: NOW - 80 * 86_400_000 });
    expect(planJobs(await snapshot(NOW), [], NOW)).toContainEqual({ kind: 'channel', id: A });
  });

  it('puts stale trending searches first, and none when the row is off', async () => {
    await db.replaceSubscriptions([{ id: A, title: 'A' }]);
    const fresh = { fetchedAt: NOW, filter: 'today' as const, videos: [] };
    const jobs = planJobs(await snapshot(NOW), [], NOW, { show: true, queries: { the: fresh } });
    const trending = jobs.filter((j) => j.kind === 'trending');
    expect(trending.length).toBeGreaterThan(3);
    expect(trending).not.toContainEqual({ kind: 'trending', query: 'the' });
    expect(jobs[0]!.kind).toBe('trending');
    // Every 6 hours: 5 hours old is still fresh, 7 hours old is searched again.
    const fiveHoursOld = { fetchedAt: NOW - 5 * 3_600_000, filter: 'today' as const, videos: [] };
    const later = planJobs(await snapshot(NOW), [], NOW, { show: true, queries: { the: fiveHoursOld } });
    expect(later).not.toContainEqual({ kind: 'trending', query: 'the' });
    const sevenHoursOld = { ...fiveHoursOld, fetchedAt: NOW - 7 * 3_600_000 };
    const due = planJobs(await snapshot(NOW), [], NOW, { show: true, queries: { the: sevenHoursOld } });
    expect(due).toContainEqual({ kind: 'trending', query: 'the' });
    // Results from the old "this week" search are searched again at once, however fresh.
    const oldFilter = { fetchedAt: NOW, videos: [] };
    const redo = planJobs(await snapshot(NOW), [], NOW, { show: true, queries: { the: oldFilter } });
    expect(redo).toContainEqual({ kind: 'trending', query: 'the' });
    const off = planJobs(await snapshot(NOW), [], NOW, { show: false, queries: {} });
    expect(off.some((j) => j.kind === 'trending')).toBe(false);
  });

  it("reads the News hub every 2 hours, and at once when the user's region changes", async () => {
    await db.replaceSubscriptions([{ id: A, title: 'A' }]);
    const plan = async (news: { fetchedAt: number; region: string } | undefined, region = 'GB') =>
      planJobs(await snapshot(NOW), [], NOW, { show: true, queries: {}, news, region }).some((j) => j.kind === 'news');
    expect(await plan(undefined)).toBe(true);
    expect(await plan({ fetchedAt: NOW - 3_600_000, region: 'GB' })).toBe(false);
    expect(await plan({ fetchedAt: NOW - 3 * 3_600_000, region: 'GB' })).toBe(true);
    expect(await plan({ fetchedAt: NOW - 3_600_000, region: 'GB' }, 'NL')).toBe(true);
    const off = planJobs(await snapshot(NOW), [], NOW, { show: false, queries: {} });
    expect(off.some((j) => j.kind === 'news')).toBe(false);
  });

  it('skips candidates the user hid', async () => {
    await db.replaceSubscriptions([{ id: A, title: 'A' }]);
    await db.upsertChannel({ id: A, lastCrawledAt: NOW, uploadsFetchedAt: NOW });
    await db.replaceEdgesFrom(A, 'featured', [{ toChannelId: X, lastSeenAt: NOW, count: 1 }], NOW);
    await db.putFeedback({ channelId: X, kind: 'notInterested', at: NOW });
    const jobs = planJobs(await snapshot(NOW), [], NOW);
    expect(jobs.some((j) => 'id' in j && j.id === X)).toBe(false);
  });
});

describe('pickJob budgets', () => {
  const jobs = [
    { kind: 'trending', query: 'the' },
    { kind: 'channel', id: A },
    { kind: 'rss', id: B },
  ] as const;

  it('skips purposes whose budget is spent, so one can\'t starve the others', () => {
    let s = initialState(NOW);
    expect(pickJob([...jobs], s, NOW, 'tab')).toEqual(jobs[0]);
    for (let i = 0; i < PURPOSE_BUDGETS.top; i++) s = recordSent(s, NOW, 'top');
    expect(pickJob([...jobs], s, NOW, 'tab')).toEqual(jobs[1]);
    for (let i = 0; i < PURPOSE_BUDGETS.discovery; i++) s = recordSent(s, NOW, 'discovery');
    expect(pickJob([...jobs], s, NOW, 'tab')).toBeNull();
    // RSS is the service worker's, with its own budget.
    expect(pickJob([...jobs], s, NOW, 'worker')).toEqual(jobs[2]);
    // Budgets reset the next day.
    expect(pickJob([...jobs], s, NOW + 86_400_000, 'tab')).toEqual(jobs[0]);
  });
});

describe('storing results', () => {
  it('channel pages (crawled or visited) replace featured edges and count as crawled', async () => {
    const page = {
      channel: { id: A, title: 'Alpha' },
      featured: [{ id: X, title: 'Ex' }, { id: B, title: 'Alpha en Français' }],
    };
    await storeChannelPage(A, page, NOW);
    expect(await db.getChannel(A)).toMatchObject({ title: 'Alpha', lastCrawledAt: NOW });
    const edges = await db.getAllEdges();
    expect(edges.map((e) => [e.toChannelId, e.type, e.sibling ?? false]).sort()).toEqual([[B, 'featured', true], [X, 'featured', false]].sort());
  });

  it('candidate uploads from the Videos tab are stored with their refresh time', async () => {
    const v = { id: 'v1', channelId: X, title: 't', publishedAt: NOW, thumbnailUrl: '', durationSec: 60, viewCount: 5 };
    await applyResult({ kind: 'videos', id: X }, { kind: 'videos', videos: [v, { ...v, id: 'other', channelId: A }] }, NOW);
    expect((await db.getVideosSince(0)).map((x) => x.id)).toEqual(['v1']);
    expect((await db.getChannel(X))?.videosTabFetchedAt).toBe(NOW);
  });

  it('watch-page mentions add edges counted per video, without double counting re-reads', async () => {
    await storeWatchMentions({ videoId: 'w1', channelId: A, publishedAt: NOW - 1000, mentions: [X, A] }, NOW);
    await storeWatchMentions({ videoId: 'w1', channelId: A, publishedAt: NOW - 1000, mentions: [X] }, NOW);
    await storeWatchMentions({ videoId: 'w2', channelId: A, mentions: [X] }, NOW);
    const edges = await db.getAllEdges();
    expect(edges).toEqual([expect.objectContaining({ fromChannelId: A, toChannelId: X, type: 'mention', count: 2, lastSeenAt: NOW })]);
    // The same video read again from RSS doesn't add to the count either.
    await processUploads(A, [rss('w2', `see youtube.com/channel/${X}`)], NOW);
    expect((await db.getAllEdges())[0]!.count).toBe(2);
  });
});

describe('subscriptions-feed storage', () => {
  it('knows which videos came from the feed, not from RSS', async () => {
    const v = (id: string, inSubsFeed?: boolean) => ({ id, channelId: A, title: id, publishedAt: NOW, thumbnailUrl: '', ...(inSubsFeed ? { inSubsFeed } : {}) });
    await db.putVideos([v('rss1'), v('feed1', true)]);
    expect([...(await db.knownFeedVideoIds(['rss1', 'feed1', 'unknown']))]).toEqual(['feed1']);
    // A later RSS write of the same video keeps the flag.
    await db.putVideos([v('feed1')]);
    expect([...(await db.knownFeedVideoIds(['feed1']))]).toEqual(['feed1']);
  });

  it('setDurations only patches stored videos', async () => {
    const v = (id: string, extra: object = {}) => ({ id, channelId: A, title: id, publishedAt: 1, thumbnailUrl: '', ...extra });
    await db.putVideos([v('a1', { viewCount: 5 })]);
    expect(await db.setDurations([{ id: 'a1', durationSec: 125 }, { id: 'unknown', durationSec: 10 }, { id: 'a1' }])).toBe(1);
    expect(await db.getVideosSince(0)).toEqual([expect.objectContaining({ id: 'a1', durationSec: 125, viewCount: 5, title: 'a1' })]);
  });
});

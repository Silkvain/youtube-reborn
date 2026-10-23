import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } } });

const db = await import('../src/core/db');
const { buildEvents, buildPairs, jitteredTime, PAIRS_TOP_CHANNELS } = await import('../src/core/community');
const { blendTopRow } = await import('../src/core/ranker');
const { communitySource } = await import('../src/core/sources/community');
const { parsePlayer } = await import('../src/content/innertube');
const { CommunityClient } = await import('../src/background/community-client');
const { communityStep, onCommunityToggle } = await import('../src/background/community');
// The real backend request handler, with in-memory Cloudflare stand-ins.
const backend = await import('../backend/src/app');
const { fakeEnv, allowAll } = await import('../backend/test/fakes');
const { Aggregator } = await import('../backend/src/objects');

import type { WatchEvent } from '../src/shared/types';
import type { FeedItem } from '../src/shared/types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-15T12:00:00Z');
const ch = (n: number) => `UC${String(n).padStart(22, 'x')}`;
const vid = (n: number) => `video${String(n).padStart(6, '0')}`;
const watch = (n: number, channel: number, at: number, watchedSec = 600, completion = 0.8): WatchEvent => ({
  id: `${vid(n)}:${at}`,
  videoId: vid(n),
  channelId: ch(channel),
  watchedSec,
  durationSec: 900,
  completion,
  abandoned: false,
  at,
});

describe('what gets uploaded (computed on the device)', () => {
  it('events: one per video, day only, rough completion, nothing before "since"', () => {
    const log = [
      watch(1, 1, NOW - 3 * HOUR, 600, 0.95),
      watch(1, 1, NOW - 2 * HOUR, 60, 0.1), // same video again: the better session wins
      watch(2, 2, NOW - HOUR, 30, 0.02), // too short to count
      watch(3, 3, NOW - 30 * DAY), // too old
      watch(4, 4, NOW - 10 * HOUR), // before "since"
    ];
    const { events, through } = buildEvents(log, NOW - 5 * HOUR, NOW);
    expect(events).toEqual([{ v: vid(1), c: ch(1), d: '2026-10-15', q: 3 }]);
    expect(through).toBe(NOW - HOUR);
    for (const e of events) expect(Object.keys(e).sort()).toEqual(['c', 'd', 'q', 'v']);
  });

  it('pairs: only the top channels, sorted, weighted, and none for very few channels', () => {
    const many = Array.from({ length: 20 }, (_, i) => watch(i, i, NOW - DAY, 100 + i * 500));
    const pairs = buildPairs(many, NOW);
    const channels = new Set(pairs.flatMap(([a, b]) => [a, b]));
    expect(channels.size).toBe(PAIRS_TOP_CHANNELS);
    expect(pairs.every(([a, b]) => a < b)).toBe(true);
    expect(pairs.every(([, , w]) => w >= 1 && w <= 3)).toBe(true);
    expect(buildPairs([watch(1, 1, NOW - DAY), watch(2, 2, NOW - DAY)], NOW)).toEqual([]);
  });

  it('upload times are randomised within the window', () => {
    expect(jitteredTime(1000, 10, 20, () => 0)).toBe(1010);
    expect(jitteredTime(1000, 10, 20, () => 0.999)).toBe(1019);
  });
});

describe('using community data', () => {
  const item = (id: string, channel: string): FeedItem => ({
    videoId: id, title: id, channelId: channel, channelTitle: channel, thumbnailUrl: '', publishedAt: 0, discover: false,
  });

  it('top row alternates search and community picks, one per creator', () => {
    const search = [item('s1', 'A'), item('s2', 'B'), item('s3', 'C')];
    const community = [item('c1', 'D'), item('c2', 'A'), item('c3', 'E')];
    expect(blendTopRow(search, community, 4).map((i) => i.videoId)).toEqual(['s1', 'c1', 's2', 'c3']);
    expect(blendTopRow(search, [], 4).map((i) => i.videoId)).toEqual(['s1', 's2', 's3']);
    expect(blendTopRow([], community, 2).map((i) => i.videoId)).toEqual(['c1', 'c2']);
  });

  it('community source: neighbours of subscriptions, weighted by link strength', async () => {
    const ctx = {
      now: NOW,
      subscribed: new Set(['S']),
      edges: [],
      engagement: new Map(),
      community: new Map<string, [string, number][]>([['S', [['X', 100], ['Y', 10]]], ['Other', [['Z', 100]]]]),
    };
    const scores = await communitySource.score(ctx);
    expect(scores.get('X')!).toBeGreaterThan(scores.get('Y')!);
    expect(scores.has('Z')).toBe(false); // not linked from a subscription
    expect((await communitySource.score({ ...ctx, community: new Map() })).size).toBe(0);
  });

  it('YouTube player details (real response): title, channel, length, views, date', () => {
    const json = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'player.json'), 'utf8'));
    expect(parsePlayer(json)).toEqual({
      id: 'NiCgcUTL9_Q',
      channelId: 'UCHnyfMqiRRG1u-2MsSQLbXA',
      channelTitle: 'Veritasium',
      title: 'The Absurd Engineering Behind the Internet',
      publishedAt: Date.parse('2026-10-12T10:11:45-07:00'),
      thumbnailUrl: 'https://i.ytimg.com/vi/NiCgcUTL9_Q/mqdefault.jpg',
      durationSec: 2072,
      viewCount: 6221569,
    });
    expect(parsePlayer({ videoDetails: { ...json.videoDetails, lengthSeconds: '0' }, microformat: json.microformat })).toBeNull();
  });
});

describe('extension client ↔ real backend handler (in memory)', () => {
  beforeEach(async () => {
    await db.clearAll();
  });

  function connect(env = fakeEnv({ TOKEN_LIMITER: allowAll() })) {
    const fetchFn = async (url: string, init?: RequestInit) => {
      const req = new Request(url, init);
      Object.defineProperty(req, 'cf', { value: { country: 'GB' } });
      return backend.handle(req, env, NOW);
    };
    return { env, client: new CommunityClient('https://community.test', fetchFn) };
  }

  it('opt-in → uploads with fresh tokens → published → downloaded back', async () => {
    const { env, client } = connect();
    // Four people watch the same video and the same channels; each has their own device.
    for (let person = 0; person < 4; person++) {
      await db.clearAll();
      await onCommunityToggle(true, NOW - 2 * DAY);
      await db.putWatchEvent(watch(1, 1, NOW - HOUR));
      for (let c = 2; c <= 4; c++) await db.putWatchEvent(watch(100 + c, c, NOW - 2 * HOUR, 3000));
      await db.putWatchEvent(watch(9, 9, NOW - 3 * DAY)); // before opting in: never sent
      const state = { ...(await db.getMeta('community'))!, nextEventsAt: NOW - 1, nextPairsAt: NOW - 1 };
      const after = await communityStep(state, { now: NOW, client, seeds: [ch(2)] });
      expect(after.failures).toBe(0);
      expect(after.pairsWeekSent).toBeDefined();
      expect(after.tokens?.list.length).toBe(1); // 3 fetched, 2 spent (events + pairs)
    }
    for (const agg of env.AGG.instances.values()) await (agg as InstanceType<typeof Aggregator>).alarm();
    await backend.publishTrending(env, NOW);
    await backend.publishGraph(env, NOW);

    const trending = await client.getTrending('GB');
    // Everything all four watched is published (video 1 and each channel's video), with count 4.
    expect(trending?.videos.map((v) => v.v)).toEqual([vid(1), vid(102), vid(103), vid(104)]);
    expect(trending?.videos.every((v) => v.n === 4)).toBe(true);
    // Nothing from before opt-in reached the server.
    expect(JSON.stringify([...env.PUBLIC.objects.values()])).not.toContain(vid(9));

    // A fresh device downloads the results.
    await db.clearAll();
    await db.setMeta('region', 'GB');
    const fresh = await communityStep({ optedInAt: NOW }, { now: NOW, client, seeds: [ch(2)] });
    expect(fresh.trending?.file?.videos[0]?.v).toBe(vid(1));
    const neighbours = Object.values(fresh.graph!.shards).flatMap((s) => Object.entries(s.neighbours));
    expect(neighbours.find(([c]) => c === ch(2))?.[1].map(([n]) => n).sort()).toEqual([ch(1), ch(3), ch(4)].sort());
  });

  it('server down: backs off and keeps nothing half-done', async () => {
    const client = new CommunityClient('https://community.test', async () => {
      throw new Error('offline');
    });
    const after = await communityStep({ optedInAt: NOW }, { now: NOW, client, seeds: [] });
    expect(after.failures).toBe(1);
    expect(after.retryAt).toBeGreaterThan(NOW);
    const skipped = await communityStep(after, { now: NOW + 1000, client, seeds: [] });
    expect(skipped.failures).toBe(1); // didn't even try before retryAt
  });

  it('turning it off forgets everything', async () => {
    await onCommunityToggle(true, NOW);
    await db.setMeta('community', { optedInAt: NOW, trending: { fetchedAt: NOW, region: 'GB', file: null } });
    await onCommunityToggle(false, NOW);
    expect(await db.getMeta('community')).toEqual({});
  });

  it('shared upload pool: shard uploads are stored as videos and the crawler skips those channels', async () => {
    const { env, client } = connect();
    const { shardOf } = await import('../src/shared/community/protocol');
    const s = shardOf(ch(2));
    const fetchedAt = NOW - 6 * HOUR;
    env.PUBLIC.objects.set(
      `graph/${s}.json`,
      JSON.stringify({
        generatedAt: NOW,
        shard: s,
        neighbours: { [ch(2)]: [[ch(3), 9, 0.1]] },
        uploads: {
          [ch(3)]: {
            t: 'Neighbour',
            f: fetchedAt,
            v: [
              [vid(31), 'A long video', Math.floor((NOW - DAY) / 1000), 1234, 5000],
              ['not-an-id', 'Junk', 1, 60, 1], // malformed: dropped
              [vid(32), 'No duration', 1, 0, 1], // no duration: dropped (Discover hides those)
            ],
          },
          'not-a-channel': { t: 'x', f: NOW, v: [[vid(33), 'x', 1, 60, 1]] },
        },
      }),
    );
    await db.clearAll();
    await db.upsertChannel({ id: ch(3), title: 'Known title', isSubscribed: false });
    await communityStep({ optedInAt: NOW }, { now: NOW, client, seeds: [ch(2)] });

    const videos = await db.getVideosSince(0);
    expect(videos.map((v) => v.id)).toEqual([vid(31)]);
    expect(videos[0]).toMatchObject({
      channelId: ch(3),
      title: 'A long video',
      durationSec: 1234,
      viewCount: 5000,
      publishedAt: Math.floor((NOW - DAY) / 1000) * 1000,
      thumbnailUrl: `https://i.ytimg.com/vi/${vid(31)}/mqdefault.jpg`,
    });
    const channel = await db.getChannel(ch(3));
    expect(channel?.videosTabFetchedAt).toBe(fetchedAt); // so the crawler's 2-day refresh skips it
    expect(channel?.title).toBe('Known title'); // never overwrites what YouTube showed the user

    // Opting out deletes the pool's videos and leaves the channel for the crawler to read itself.
    await db.putVideos([{ id: vid(40), channelId: ch(3), title: 'Crawled', publishedAt: NOW, thumbnailUrl: '' }]);
    await onCommunityToggle(false, NOW);
    expect((await db.getVideosSince(0)).map((v) => v.id)).toEqual([vid(40)]);
    expect((await db.getChannel(ch(3)))?.videosTabFetchedAt).toBe(0);
    expect(await db.getMeta('communityPool')).toEqual({});
  });

  it('shared upload pool: skips subscriptions (the subscriptions feed covers them)', async () => {
    const { storePoolUploads } = await import('../src/background/community');
    await db.clearAll();
    await db.upsertChannel({ id: ch(5), title: 'Mine', isSubscribed: true });
    const shard = {
      generatedAt: NOW,
      shard: 0,
      neighbours: {},
      uploads: { [ch(5)]: { t: 'Mine', f: NOW, v: [[vid(50), 'x', 1, 600, 1] as [string, string, number, number, number]] } },
    };
    expect(await storePoolUploads({ 0: shard }, NOW)).toBe(0);
    expect(await db.getVideosSince(0)).toEqual([]);
  });
});

describe('switching Reborn off only pauses sharing', () => {
  it('the user’s choice survives; sharing just stops until Reborn is back on', async () => {
    // A backend-enabled build (the define esbuild sets), loaded fresh for this test.
    (globalThis as Record<string, unknown>).__COMMUNITY_API__ = 'https://community.test';
    vi.resetModules();
    const { communityActive, communityOptedIn, communityTick } = await import('../src/background/community');
    const settings: Record<string, unknown> = { enabled: false, enhancedDiscovery: true };
    const real = globalThis.chrome;
    vi.stubGlobal('chrome', {
      ...real,
      storage: { ...real.storage, local: { get: async () => ({ ...settings }) } },
      permissions: { contains: async () => true },
    });
    try {
      expect(await communityOptedIn()).toBe(true);
      expect(await communityActive()).toBe(false);
      const fetchFn = vi.fn();
      expect(await communityTick(async () => [], fetchFn)).toBe(false); // paused: no requests
      expect(fetchFn).not.toHaveBeenCalled();
      settings.enabled = true;
      expect(await communityActive()).toBe(true);
      settings.enhancedDiscovery = false; // only the user's own switch opts out
      expect(await communityOptedIn()).toBe(false);
    } finally {
      vi.stubGlobal('chrome', real);
      delete (globalThis as Record<string, unknown>).__COMMUNITY_API__;
    }
  });
});

import 'fake-indexeddb/auto';
import { channelEngagement, seedWeights } from '../src/core/engagement';
import { buildFeed, channelMedianViews, explainCandidates, standoutFactor } from '../src/core/ranker';
import { communitySource } from '../src/core/sources/community';
import { featuredSource } from '../src/core/sources/featured';
import type { RankContext } from '../src/core/sources/types';
import type { Edge, Video, WatchEvent } from '../src/shared/types';

vi.stubGlobal('chrome', {
  storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
});
const db = await import('../src/core/db');
const { computeFeed } = await import('../src/background/feed');

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const ev = (channelId: string, completion: number, daysAgo: number, i = 0): WatchEvent => ({
  id: `${channelId}:${daysAgo}:${i}`,
  videoId: `v${i}`,
  channelId,
  watchedSec: 600,
  durationSec: 600,
  completion,
  abandoned: false,
  at: NOW - daysAgo * DAY,
});
const edge = (from: string, to: string, type: Edge['type'] = 'featured'): Edge => ({
  fromChannelId: from,
  toChannelId: to,
  type,
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  count: 1,
});

describe('R2: engagement follows current habits', () => {
  it('recent viewing counts more than viewing from months ago', () => {
    const e = channelEngagement([...Array.from({ length: 6 }, (_, i) => ev('Old', 1, 200, i)), ...Array.from({ length: 6 }, (_, i) => ev('New', 1, 2, i))], NOW);
    expect(e.get('New')!).toBeGreaterThan(e.get('Old')! * 3);
  });

  it('a channel watched 30 times outranks one watched 9 times', () => {
    const e = channelEngagement([...Array.from({ length: 30 }, (_, i) => ev('Lots', 1, 1, i)), ...Array.from({ length: 9 }, (_, i) => ev('Some', 1, 1, i))], NOW);
    expect(e.get('Lots')!).toBeGreaterThan(e.get('Some')!);
  });

  it('channels watched a lot without subscribing become seeds; casual or old viewing does not', () => {
    const events = [
      ...[0, 1, 2].map((i) => ev('Binge', 0.9, 3, i)),
      ...[0, 1].map((i) => ev('Twice', 0.9, 3, i)),
      ...[0, 1, 2].map((i) => ev('Skimmed', 0.2, 3, i)),
      ...[0, 1, 2].map((i) => ev('LongAgo', 0.9, 90, i)),
    ];
    const seeds = seedWeights(new Set(['Sub']), channelEngagement(events, NOW), events, NOW);
    expect([...seeds.keys()].sort()).toEqual(['Binge', 'Sub']);
  });
});

describe('R3: each pick remembers the seed it came from', () => {
  const ctx = (edges: Edge[], extra: Partial<RankContext> = {}): RankContext => ({
    now: NOW,
    subscribed: new Set(['S1', 'S2']),
    edges,
    engagement: new Map([['S1', 0.9]]),
    ...extra,
  });

  it('first hop names the seed; second hop names the channel in between too', async () => {
    const via = await featuredSource.explain!(ctx([edge('S1', 'A'), edge('A', 'B')]));
    expect(via.get('A')).toMatchObject({ kind: 'featured', seed: 'S1' });
    expect(via.get('A')!.through).toBeUndefined();
    expect(via.get('B')).toMatchObject({ kind: 'featured', seed: 'S1', through: 'A' });
  });

  it('the strongest seed wins across sources', async () => {
    const c = ctx([edge('S2', 'X')], { community: new Map([['S1', [['X', 500, 0.9] as [string, number, number]]]]) });
    const via = await explainCandidates([featuredSource, communitySource], c);
    expect(via.get('X')).toMatchObject({ kind: 'community', seed: 'S1' });
  });

  it('the community graph uses the popularity-normalised strength when the server sends it', async () => {
    // By raw count the mega-channel leads; by strength the niche channel does.
    const c = ctx([], { community: new Map([['S1', [['Mega', 900, 0.05], ['Niche', 40, 0.4]] as [string, number, number][]]]) });
    const s = await communitySource.score(c);
    expect(s.get('Niche')!).toBeGreaterThan(s.get('Mega')!);
  });

  it('at most 4 Discover items come from any one seed', () => {
    const disc: Video[] = Array.from({ length: 10 }, (_, i) => ({
      id: `d${i}`,
      channelId: `C${i}`,
      title: `d${i}`,
      publishedAt: NOW - DAY,
      thumbnailUrl: '',
    }));
    const feed = buildFeed({
      now: NOW,
      subscriptionVideos: [],
      discoveryVideos: disc,
      candidateScores: new Map(disc.map((v) => [v.channelId, 0.5])),
      engagement: new Map(),
      channelTitles: new Map(),
      seedOf: new Map(disc.map((v, i) => [v.channelId, i < 8 ? 'Busy' : 'Quiet'])),
    });
    expect(feed.filter((i) => Number(i.videoId.slice(1)) < 8)).toHaveLength(4);
    expect(feed).toHaveLength(6);
  });
});

describe("R4: a channel's standout video first", () => {
  it('scores a video by its views against the channel median', () => {
    expect(standoutFactor(1_000_000, 100_000)).toBeGreaterThan(standoutFactor(100_000, 100_000));
    expect(standoutFactor(10_000, 100_000)).toBeLessThan(standoutFactor(100_000, 100_000));
    expect(standoutFactor(undefined, 100_000)).toBeCloseTo(0.8);
  });

  it('within a Discover channel, the breakout video leads even if slightly older', () => {
    const v = (id: string, views: number, daysAgo: number): Video => ({ id, channelId: 'C', title: id, publishedAt: NOW - daysAgo * DAY, thumbnailUrl: '', viewCount: views });
    const videos = [v('newest', 20_000, 1), v('typical', 25_000, 5), v('breakout', 2_000_000, 6), v('older', 22_000, 9)];
    expect(channelMedianViews(videos).get('C')).toBe(25_000);
    const feed = buildFeed({
      now: NOW,
      subscriptionVideos: [],
      discoveryVideos: videos,
      candidateScores: new Map([['C', 0.5]]),
      engagement: new Map(),
      channelTitles: new Map(),
    });
    expect(feed[0]!.videoId).toBe('breakout');
  });
});

describe('explanations on the card', () => {
  beforeEach(async () => {
    await db.clearAll();
  });

  it('a second-hop pick reads "Featured by Y (via X)" and links to Y', async () => {
    await db.upsertChannel({ id: 'UCsubxxxxxxxxxxxxxxxxxxxx', title: 'My Sub', isSubscribed: true });
    await db.upsertChannel({ id: 'UCmidxxxxxxxxxxxxxxxxxxxx', title: 'Middle' });
    await db.upsertChannel({ id: 'UCfarxxxxxxxxxxxxxxxxxxxx', title: 'Far' });
    await db.putEdge(edge('UCsubxxxxxxxxxxxxxxxxxxxx', 'UCmidxxxxxxxxxxxxxxxxxxxx'));
    await db.putEdge(edge('UCmidxxxxxxxxxxxxxxxxxxxx', 'UCfarxxxxxxxxxxxxxxxxxxxx'));
    await db.putVideos([
      { id: 'mid1', channelId: 'UCmidxxxxxxxxxxxxxxxxxxxx', title: 'm', publishedAt: NOW - DAY, thumbnailUrl: '', durationSec: 600 },
      { id: 'far1', channelId: 'UCfarxxxxxxxxxxxxxxxxxxxx', title: 'f', publishedAt: NOW - DAY, thumbnailUrl: '', durationSec: 600 },
    ]);
    const items = (await computeFeed(NOW)).items;
    expect(items.find((i) => i.videoId === 'mid1')).toMatchObject({ reason: 'Featured by My Sub', reasonChannelId: 'UCsubxxxxxxxxxxxxxxxxxxxx', source: 'featured' });
    expect(items.find((i) => i.videoId === 'far1')).toMatchObject({ reason: 'Featured by Middle (via My Sub)', reasonChannelId: 'UCmidxxxxxxxxxxxxxxxxxxxx' });
  });

  it('a channel you watch a lot without subscribing leads to new Discover picks', async () => {
    await db.upsertChannel({ id: 'UCsubxxxxxxxxxxxxxxxxxxxx', title: 'My Sub', isSubscribed: true });
    await db.upsertChannel({ id: 'UCbingexxxxxxxxxxxxxxxxxx', title: 'Binge' });
    await db.upsertChannel({ id: 'UCnewxxxxxxxxxxxxxxxxxxxx', title: 'Newfound' });
    await db.putEdge(edge('UCbingexxxxxxxxxxxxxxxxxx', 'UCnewxxxxxxxxxxxxxxxxxxxx'));
    for (let i = 0; i < 4; i++) await db.putWatchEvent({ ...ev('UCbingexxxxxxxxxxxxxxxxxx', 0.95, 2, i), at: Date.now() - 2 * DAY });
    await db.putVideos([{ id: 'new1', channelId: 'UCnewxxxxxxxxxxxxxxxxxxxx', title: 'n', publishedAt: Date.now() - DAY, thumbnailUrl: '', durationSec: 600 }]);
    const items = (await computeFeed()).items;
    expect(items.find((i) => i.videoId === 'new1')).toMatchObject({ discover: true, reason: 'Featured by Binge' });
  });
});

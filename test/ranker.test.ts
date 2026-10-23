import { applyDiversity, buildArchive, buildFeed, pickTrending, feedbackMultiplier, interleave, scoreCandidates } from '../src/core/ranker';
import type { SignalSource, RankContext } from '../src/core/sources';
import type { Video } from '../src/shared/types';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const ctx = (subscribed: string[] = []): RankContext => ({
  now: NOW,
  subscribed: new Set(subscribed),
  edges: [],
  engagement: new Map(),
});

const fixed = (id: string, weight: number, scores: Record<string, number>): SignalSource => ({
  id,
  weight,
  score: async () => new Map(Object.entries(scores)),
});

describe('scoreCandidates', () => {
  it('takes the weighted average of sources', async () => {
    const s = await scoreCandidates(
      [fixed('a', 3, { X: 1, Y: 0 }), fixed('b', 1, { X: 0, Y: 1 })],
      ctx(),
      new Map(),
    );
    expect(s.get('X')).toBeCloseTo(0.75);
    expect(s.get('Y')).toBeCloseTo(0.25);
  });

  it('excludes subscribed channels', async () => {
    const s = await scoreCandidates([fixed('a', 1, { SUB: 1, X: 0.5 })], ctx(['SUB']), new Map());
    expect(s.has('SUB')).toBe(false);
    expect(s.get('X')).toBeCloseTo(0.5);
  });

  it('applies feedback: hidden channels vanish, "more" boosts', async () => {
    const s = await scoreCandidates(
      [fixed('a', 1, { X: 0.4, Y: 0.4 })],
      ctx(),
      new Map([
        ['X', { channelId: 'X', kind: 'notInterested' as const, at: 0 }],
        ['Y', { channelId: 'Y', kind: 'more' as const, at: 0 }],
      ]),
    );
    expect(s.has('X')).toBe(false);
    expect(s.get('Y')).toBeCloseTo(0.4 * feedbackMultiplier({ channelId: 'Y', kind: 'more', at: 0 }));
  });

  it('clamps bad source output and survives a throwing source', async () => {
    const broken: SignalSource = { id: 'boom', weight: 1, score: async () => { throw new Error('x'); } };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await scoreCandidates([fixed('a', 1, { X: 7, Y: Number.NaN }), broken], ctx(), new Map());
    err.mockRestore();
    // The failed source sits out instead of halving everyone's score.
    expect(s.get('X')).toBeCloseTo(1);
    expect(s.get('Y')).toBe(0);
  });

  it('a source with no data yet does not water down the others', async () => {
    const silent = fixed('community', 1, {});
    const s = await scoreCandidates([fixed('a', 1, { X: 0.6 }), silent], ctx(), new Map());
    expect(s.get('X')).toBeCloseTo(0.6);
  });
});

describe('interleave', () => {
  it('keeps the subscription share at the mix ratio', () => {
    const subs = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const disc = Array.from({ length: 20 }, (_, i) => `d${i}`);
    const out = interleave(subs, disc, 0.6, 10);
    expect(out).toHaveLength(10);
    expect(out.filter((o) => !o.discover)).toHaveLength(6);
    expect(out.slice(0, 5).map((o) => o.item)).toEqual(['s0', 's1', 'd0', 's2', 'd1']);
  });

  it('fills from the other list when one runs out', () => {
    expect(interleave(['s0'], ['d0', 'd1', 'd2'], 0.6, 10).map((o) => o.item)).toEqual(['s0', 'd0', 'd1', 'd2']);
    expect(interleave(['s0', 's1', 's2'], [], 0.6, 10).map((o) => o.item)).toEqual(['s0', 's1', 's2']);
  });
});

describe('applyDiversity', () => {
  const ch = (s: string) => s[0]!;
  const maxRun = (xs: string[]) => {
    let best = 0;
    let run = 0;
    xs.forEach((x, i) => {
      run = i > 0 && ch(xs[i - 1]!) === ch(x) ? run + 1 : 1;
      best = Math.max(best, run);
    });
    return best;
  };

  it('never allows more than 2 in a row when avoidable', () => {
    const out = applyDiversity(['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'c1'], ch);
    expect(maxRun(out)).toBeLessThanOrEqual(2);
    expect(out.sort()).toEqual(['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'c1']);
  });

  it('keeps order otherwise', () => {
    expect(applyDiversity(['a1', 'b1', 'a2', 'b2'], ch)).toEqual(['a1', 'b1', 'a2', 'b2']);
    expect(applyDiversity(['a1', 'a2', 'a3', 'b1'], ch)).toEqual(['a1', 'a2', 'b1', 'a3']);
  });

  it('appends leftovers when nothing else is available', () => {
    expect(applyDiversity(['a1', 'a2', 'a3'], ch)).toEqual(['a1', 'a2', 'a3']);
  });
});

describe('buildFeed', () => {
  const vid = (id: string, channelId: string, ageDays: number, extra: Partial<Video> = {}): Video => ({
    id,
    channelId,
    title: id,
    publishedAt: NOW - ageDays * DAY,
    thumbnailUrl: '',
    ...extra,
  });

  it('mixes subscriptions and discovery, marks discovery items and reasons', () => {
    const feed = buildFeed({
      now: NOW,
      subscriptionVideos: [vid('s1', 'S1', 1), vid('s2', 'S2', 2), vid('s3', 'S3', 3)],
      discoveryVideos: [vid('d1', 'D1', 5), vid('d2', 'D2', 5)],
      candidateScores: new Map([['D1', 0.9], ['D2', 0.1]]),
      engagement: new Map(),
      channelTitles: new Map([['D1', 'Disc One']]),
      reasons: new Map([['D1', 'Featured by S1']]),
      size: 5,
    });
    expect(feed.map((f) => f.videoId)).toEqual(['s1', 's2', 'd1', 's3', 'd2']);
    expect(feed[2]).toMatchObject({ discover: true, channelTitle: 'Disc One', reason: 'Featured by S1' });
    expect(feed[0]!.discover).toBe(false);
  });

  it('boosts subscriptions the user engages with', () => {
    const feed = buildFeed({
      now: NOW,
      subscriptionVideos: [vid('new', 'Meh', 0.5), vid('older', 'Loved', 2)],
      discoveryVideos: [],
      candidateScores: new Map(),
      engagement: new Map([['Loved', 1], ['Meh', 0]]),
      channelTitles: new Map(),
    });
    expect(feed[0]!.videoId).toBe('older');
  });

  it('drops shorts, excluded videos and zero-score discovery', () => {
    const feed = buildFeed({
      now: NOW,
      subscriptionVideos: [vid('short', 'S', 1, { isShort: true }), vid('seen', 'S', 1), vid('ok', 'S', 1)],
      discoveryVideos: [vid('dz', 'Z', 1)],
      candidateScores: new Map([['Z', 0]]),
      engagement: new Map(),
      channelTitles: new Map(),
      exclude: new Set(['seen']),
    });
    expect(feed.map((f) => f.videoId)).toEqual(['ok']);
  });

  it('caps uploads per channel', () => {
    const feed = buildFeed({
      now: NOW,
      subscriptionVideos: Array.from({ length: 10 }, (_, i) => vid(`s${i}`, 'S', i)),
      discoveryVideos: Array.from({ length: 10 }, (_, i) => vid(`d${i}`, 'D', i)),
      candidateScores: new Map([['D', 1]]),
      engagement: new Map(),
      channelTitles: new Map(),
    });
    expect(feed.filter((f) => f.channelId === 'S')).toHaveLength(3);
    expect(feed.filter((f) => f.channelId === 'D')).toHaveLength(2);
  });
});

describe('buildArchive', () => {
  const vid = (id: string, channelId: string, ageDays: number, extra: Partial<Video> = {}): Video => ({
    id, channelId, title: id, publishedAt: NOW - ageDays * DAY, thumbnailUrl: '', ...extra,
  });
  const videos = [
    vid('a1', 'A', 1), vid('a2', 'A', 2), vid('a3', 'A', 3), vid('b1', 'B', 10),
    vid('c1', 'C', 400), vid('short', 'C', 0, { isShort: true }), vid('onscreen', 'B', 0),
  ];
  const titles = new Map([['A', 'Alpha']]);

  it('pages through every older upload, newest first, without repeats', () => {
    const p1 = buildArchive(videos, titles, new Set(['onscreen']), 0, 3);
    const p2 = buildArchive(videos, titles, new Set(['onscreen']), 3, 3);
    expect(p1.items.map((i) => i.videoId)).toEqual(['a1', 'a2', 'b1']);
    expect(p1.hasMore).toBe(true);
    expect(p2.items.map((i) => i.videoId)).toEqual(['a3', 'c1']);
    expect(p2.hasMore).toBe(false);
    expect(p1.items[0]).toMatchObject({ channelTitle: 'Alpha', discover: false });
  });

  it('skips shorts and excluded videos, and applies the diversity rule', () => {
    const all = buildArchive(videos, titles, new Set(['onscreen']), 0, 100).items.map((i) => i.videoId);
    expect(all).not.toContain('short');
    expect(all).not.toContain('onscreen');
    expect(all.slice(0, 3)).toEqual(['a1', 'a2', 'b1']); // a3 pushed back: no 3 in a row
  });
});

describe('pickTrending', () => {
  const tv = (id: string, channelId: string, viewCount: number, ageDays = 1) => ({
    id, channelId, channelTitle: channelId, title: id, publishedAt: NOW - ageDays * DAY, thumbnailUrl: '', viewCount,
  });
  const base = {
    now: NOW,
    maxAgeMs: DAY,
    excludeVideos: new Set<string>(),
    hiddenChannels: new Set<string>(),
    slots: 4,
  };
  const queries = {
    the: { fetchedAt: NOW - 3_600_000, videos: [tv('beast', 'MrBeast', 90e6), tv('logan', 'Logan', 50e6), tv('ltt', 'LTT', 5e6)] },
    a: { fetchedAt: NOW - 3_600_000, videos: [tv('beast', 'MrBeast', 91e6), tv('beast2', 'MrBeast', 80e6), tv('roblox', 'Roblox', 8e6), tv('extra', 'Other', 1e6)] },
  };

  it('merges searches and takes the top 4 by views, one per creator', () => {
    const out = pickTrending({ ...base, queries });
    expect(out.map((i) => i.videoId)).toEqual(['beast', 'logan', 'roblox', 'ltt']);
    expect(out[0]).toMatchObject({ viewCount: 91e6, channelTitle: 'MrBeast', discover: false });
  });

  it('hiding a video or channel lets the next biggest video in', () => {
    const out = pickTrending({ ...base, queries, excludeVideos: new Set(['logan']), hiddenChannels: new Set(['MrBeast']) });
    expect(out.map((i) => i.videoId)).toEqual(['roblox', 'ltt', 'extra']);
  });

  it('a hidden video does not hide the rest of that creator', () => {
    const out = pickTrending({ ...base, queries, excludeVideos: new Set(['beast']) });
    expect(out[0]!.videoId).toBe('beast2');
  });

  it('ignores stale searches and videos older than a week', () => {
    const out = pickTrending({
      ...base,
      queries: {
        old: { fetchedAt: NOW - 2 * DAY, videos: [tv('stale', 'S', 1e9)] },
        new: { fetchedAt: NOW, videos: [tv('ancient', 'A', 1e9, 30), tv('fresh', 'F', 10)] },
      },
    });
    expect(out.map((i) => i.videoId)).toEqual(['fresh']);
  });
});

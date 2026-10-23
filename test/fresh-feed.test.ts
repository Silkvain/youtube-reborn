import 'fake-indexeddb/auto';
import { buildFeed, unitRandom, type FeedInput } from '../src/core/ranker';
import type { Video } from '../src/shared/types';

vi.stubGlobal('chrome', {
  storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
});
const db = await import('../src/core/db');
const { recordImpressions } = await import('../src/background/feed');

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

/** `n` subscription channels with `per` uploads each, spread over the last 20 days. */
function pool(n: number, per: number): Video[] {
  const out: Video[] = [];
  for (let c = 0; c < n; c++) {
    for (let k = 0; k < per; k++) {
      out.push({
        id: `c${c}v${k}`,
        channelId: `UC${c}`,
        title: `c${c}v${k}`,
        publishedAt: NOW - 3 * DAY - ((c * per + k) % 17) * DAY,
        thumbnailUrl: '',
        durationSec: 600,
      });
    }
  }
  return out;
}

const base = (videos: Video[], extra: Partial<FeedInput> = {}): FeedInput => ({
  now: NOW,
  subscriptionVideos: videos,
  discoveryVideos: [],
  candidateScores: new Map(),
  engagement: new Map(),
  channelTitles: new Map(),
  size: 20,
  ...extra,
});
const ids = (input: FeedInput) => buildFeed(input).map((i) => i.videoId);

describe('fresh feed: a new draw per Home visit', () => {
  const videos = pool(30, 5);

  it('the same visit (seed) always gives the same feed; another visit gives a different one', () => {
    const a = ids(base(videos, { seed: 1 }));
    expect(ids(base(videos, { seed: 1 }))).toEqual(a);
    const b = ids(base(videos, { seed: 2 }));
    expect(b).not.toEqual(a);
    expect(b.filter((id) => !a.includes(id)).length).toBeGreaterThan(5);
  });

  it('without a seed the feed is the plain ranked list, as before', () => {
    expect(ids(base(videos))).toEqual(ids(base(videos)));
  });

  it('better matches still show up more often across visits', () => {
    const fresh: Video = { ...videos[0]!, id: 'fresh', channelId: 'UCfresh', publishedAt: NOW - 3 * DAY };
    const stale: Video = { ...videos[0]!, id: 'stale', channelId: 'UCstale', publishedAt: NOW - 25 * DAY };
    let f = 0;
    let s = 0;
    for (let seed = 0; seed < 200; seed++) {
      const feed = ids(base([...videos, fresh, stale], { seed }));
      if (feed.includes('fresh')) f++;
      if (feed.includes('stale')) s++;
    }
    expect(f).toBeGreaterThan(s * 2);
  });

  it('videos already shown on earlier visits come up less often', () => {
    const impressions = new Map(videos.slice(0, 75).map((v) => [v.id, 3]));
    let shownBefore = 0;
    let notShown = 0;
    for (let seed = 0; seed < 50; seed++) {
      for (const id of ids(base(videos, { seed, impressions }))) {
        if (impressions.has(id)) shownBefore++;
        else notShown++;
      }
    }
    expect(notShown).toBeGreaterThan(shownBefore * 3);
  });

  it('a brand-new upload is pinned at the top until it has been seen twice', () => {
    const brandNew: Video = { ...videos[0]!, id: 'new', channelId: 'UCnew', publishedAt: NOW - 2 * HOUR };
    for (let seed = 0; seed < 20; seed++) expect(ids(base([...videos, brandNew], { seed }))[0]).toBe('new');
    const seenTwice = new Map([['new', 2]]);
    const tops = new Set(Array.from({ length: 20 }, (_, seed) => ids(base([...videos, brandNew], { seed, impressions: seenTwice }))[0]));
    expect(tops.size).toBeGreaterThan(1);
  });

  it('a video arriving mid-visit does not reshuffle the rest', () => {
    const before = ids(base(videos, { seed: 7 }));
    const late: Video = { ...videos[0]!, id: 'late', channelId: 'UClate', publishedAt: NOW - 4 * DAY };
    const after = ids(base([...videos, late], { seed: 7 })).filter((id) => id !== 'late');
    // Same relative order for everything that's still there.
    expect(after).toEqual(before.filter((id) => after.includes(id)));
  });

  it('unitRandom is stable and inside (0, 1)', () => {
    expect(unitRandom(5, 'abc')).toBe(unitRandom(5, 'abc'));
    expect(unitRandom(5, 'abc')).not.toBe(unitRandom(6, 'abc'));
    for (let i = 0; i < 1000; i++) {
      const u = unitRandom(i, `v${i}`);
      expect(u).toBeGreaterThan(0);
      expect(u).toBeLessThan(1);
    }
  });
});

describe('impressions', () => {
  beforeEach(async () => {
    await db.clearAll();
  });

  it('count once per visit, however often the card is reported', async () => {
    const visit1 = { seed: 1, startedAt: NOW };
    await recordImpressions(['a', 'b'], visit1, NOW + 1000);
    await recordImpressions(['a'], visit1, NOW + 2000);
    const visit2 = { seed: 2, startedAt: NOW + HOUR };
    await recordImpressions(['a'], visit2, NOW + HOUR + 1000);
    expect(await db.getMeta('impressions')).toEqual({
      a: { n: 2, at: NOW + HOUR + 1000 },
      b: { n: 1, at: NOW + 1000 },
    });
  });

  it('are forgotten after 3 weeks', async () => {
    await recordImpressions(['old'], { seed: 1, startedAt: NOW }, NOW);
    await recordImpressions(['new'], { seed: 2, startedAt: NOW + 22 * DAY }, NOW + 22 * DAY);
    expect(Object.keys((await db.getMeta('impressions')) ?? {})).toEqual(['new']);
  });
});

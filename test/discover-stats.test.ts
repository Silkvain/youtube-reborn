import 'fake-indexeddb/auto';
import { scoreCandidates } from '../src/core/ranker';
import type { SignalSource } from '../src/core/sources/types';

vi.stubGlobal('chrome', {
  storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
});
const db = await import('../src/core/db');
const { recordImpressions } = await import('../src/background/feed');
const { discoverSummary, recordDiscoverShown, recordDiscoverWatch, sourceTuning, tuningFrom } = await import('../src/background/discover-stats');

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

beforeEach(async () => {
  await db.clearAll();
});

describe('R5: Discover measured on the device', () => {
  it('a seen Discover card watched half-way credits its source, once', async () => {
    await recordDiscoverShown([['v1', 'featured'], ['v2', 'community']], NOW);
    await recordDiscoverWatch('v1', 0.8, NOW + 1000);
    await recordDiscoverWatch('v1', 0.9, NOW + 2000); // same video again: no double credit
    await recordDiscoverWatch('v2', 0.2, NOW + 1000); // a peek, not a watch
    const sum = await discoverSummary(NOW + 2000);
    expect(sum).toEqual(
      expect.arrayContaining([
        { source: 'featured', shown: 1, watched: 1, tuning: 1 },
        { source: 'community', shown: 1, watched: 0, tuning: 1 },
      ]),
    );
  });

  it('watches long after the card was shown, or of videos never shown in Discover, do not count', async () => {
    await recordDiscoverShown([['v1', 'featured']], NOW);
    await recordDiscoverWatch('v1', 1, NOW + 30 * DAY);
    await recordDiscoverWatch('elsewhere', 1, NOW);
    expect((await discoverSummary(NOW))[0]).toMatchObject({ watched: 0 });
  });

  it('counts a card once per Home visit, through the normal impression path', async () => {
    const visit = { seed: 1, startedAt: NOW };
    await recordImpressions(['v1', 'sub1'], visit, NOW, { v1: 'mentions' });
    await recordImpressions(['v1'], visit, NOW + 500, { v1: 'mentions' });
    expect(await discoverSummary(NOW + 500)).toEqual([{ source: 'mentions', shown: 1, watched: 0, tuning: 1 }]);
  });

  it('tunes sources by how often their picks get watched, gently and only with enough data', () => {
    const at = NOW;
    const few = { sources: { featured: { impressions: 10, longClicks: 9, at } }, shown: {} };
    expect(tuningFrom(few, NOW)).toBeUndefined();
    const t = tuningFrom(
      {
        sources: {
          featured: { impressions: 100, longClicks: 20, at },
          mentions: { impressions: 100, longClicks: 2, at },
          community: { impressions: 5, longClicks: 5, at },
        },
        shown: {},
      },
      NOW,
    )!;
    expect(t.get('featured')!).toBeGreaterThan(1);
    expect(t.get('mentions')!).toBeLessThan(1);
    expect(t.get('mentions')!).toBeGreaterThanOrEqual(0.5);
    expect(t.has('community')).toBe(false); // not enough seen yet
  });

  it('old results fade (30-day half-life)', async () => {
    await db.setMeta('discoverStats', { sources: { featured: { impressions: 100, longClicks: 20, at: NOW - 60 * DAY } }, shown: {} });
    expect((await discoverSummary(NOW))[0]).toMatchObject({ shown: 25, watched: 5 });
  });

  it('tuning shifts which source leads the candidates', async () => {
    const fixed = (id: string, scores: Record<string, number>): SignalSource => ({ id, weight: 1, score: async () => new Map(Object.entries(scores)) });
    const sources = [fixed('featured', { A: 1 }), fixed('mentions', { B: 1 })];
    const ctx = { now: NOW, subscribed: new Set<string>(), edges: [], engagement: new Map() };
    const even = await scoreCandidates(sources, ctx, new Map());
    expect(even.get('A')).toBeCloseTo(even.get('B')!);
    await db.setMeta('discoverStats', {
      sources: { featured: { impressions: 100, longClicks: 30, at: NOW }, mentions: { impressions: 100, longClicks: 1, at: NOW } },
      shown: {},
    });
    const tuned = await scoreCandidates(sources, ctx, new Map(), await sourceTuning(NOW));
    expect(tuned.get('A')!).toBeGreaterThan(tuned.get('B')! * 2);
  });
});

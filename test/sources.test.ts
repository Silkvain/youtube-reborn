import { channelEngagement, subscriptionWeight } from '../src/core/engagement';
import { featuredSource } from '../src/core/sources/featured';
import { mentionCountFactor, mentionDecay, mentionsSource } from '../src/core/sources/mentions';
import { isSiblingTitle, SECOND_HOP_DAMPING, SIBLING_WEIGHT } from '../src/core/sources/graph';
import { saturate, type RankContext } from '../src/core/sources/types';
import type { Edge, WatchEvent } from '../src/shared/types';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const edge = (from: string, to: string, type: Edge['type'], extra: Partial<Edge> = {}): Edge => ({
  fromChannelId: from,
  toChannelId: to,
  type,
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  count: 1,
  ...extra,
});

const ctx = (edges: Edge[], engagement: Record<string, number> = {}, subs = ['A', 'B']): RankContext => ({
  now: NOW,
  subscribed: new Set(subs),
  edges,
  engagement: new Map(Object.entries(engagement)),
});

describe('featured source', () => {
  it('grows with the number of subscriptions featuring a candidate', async () => {
    const s = await featuredSource.score(ctx([edge('A', 'X', 'featured'), edge('B', 'X', 'featured'), edge('A', 'Y', 'featured')]));
    expect(s.get('X')!).toBeGreaterThan(s.get('Y')!);
    expect(s.get('Y')).toBeCloseTo(saturate(subscriptionWeight(undefined)));
  });

  it('weights by how much the user watches the featuring subscription', async () => {
    const s = await featuredSource.score(
      ctx([edge('A', 'X', 'featured'), edge('B', 'Y', 'featured')], { A: 1, B: 0 }),
    );
    expect(s.get('X')!).toBeGreaterThan(s.get('Y')!);
  });

  it('ignores mention edges and keeps scores in 0..1', async () => {
    const many = Array.from({ length: 50 }, (_, i) => edge(`S${i}`, 'X', 'featured'));
    const s = await featuredSource.score(ctx([...many, edge('A', 'Z', 'mention')], {}, many.map((e) => e.fromChannelId)));
    expect(s.get('X')!).toBeLessThanOrEqual(1);
    expect(s.has('Z')).toBe(false);
  });

  it('adds damped second-hop candidates', async () => {
    const s = await featuredSource.score(ctx([edge('A', 'X', 'featured'), edge('X', 'Q', 'featured')]));
    expect(s.get('Q')!).toBeGreaterThan(0);
    expect(s.get('Q')!).toBeLessThan(s.get('X')! * SECOND_HOP_DAMPING + 1e-9);
  });

  it('weights sister channels down', async () => {
    const s = await featuredSource.score(ctx([edge('A', 'Dub', 'featured', { sibling: true }), edge('A', 'Peer', 'featured')]));
    expect(s.get('Dub')).toBeCloseTo(saturate(subscriptionWeight(undefined) * SIBLING_WEIGHT));
    expect(s.get('Peer')!).toBeGreaterThan(s.get('Dub')!);
  });

  it('detects sister channel titles', () => {
    expect(isSiblingTitle('Veritasium', 'Veritasium en Français')).toBe(true);
    expect(isSiblingTitle('Veritasium', '2veritasium')).toBe(true);
    expect(isSiblingTitle('SmarterEveryDay', 'Smarter Every Day 2')).toBe(true);
    expect(isSiblingTitle('Veritasium', 'Sciencium')).toBe(false);
    expect(isSiblingTitle('Veritasium', 'Mentour Pilot')).toBe(false);
    expect(isSiblingTitle('Abc', 'Abcdef')).toBe(false);
  });

  it('only counts edges from subscriptions or first-hop candidates', async () => {
    const s = await featuredSource.score(ctx([edge('Stranger', 'X', 'featured')]));
    expect(s.size).toBe(0);
  });
});

describe('mentions source', () => {
  it('decays with age', async () => {
    const s = await mentionsSource.score(
      ctx([edge('A', 'Fresh', 'mention'), edge('A', 'Old', 'mention', { lastSeenAt: NOW - 365 * DAY })]),
    );
    expect(s.get('Fresh')!).toBeGreaterThan(s.get('Old')!);
  });

  it('half-life and count factor', () => {
    expect(mentionDecay(NOW - 90 * DAY, NOW)).toBeCloseTo(0.5);
    expect(mentionDecay(NOW + DAY, NOW)).toBe(1);
    expect(mentionCountFactor(1)).toBe(0.5);
    expect(mentionCountFactor(2)).toBe(0.75);
    expect(mentionCountFactor(10)).toBeLessThan(1);
  });
});

describe('engagement', () => {
  const ev = (channelId: string, completion: number, abandoned = false): WatchEvent => ({
    id: Math.random().toString(),
    videoId: 'v',
    channelId,
    watchedSec: 0,
    durationSec: 0,
    completion,
    abandoned,
    at: 0,
  });

  it('rewards completion and gains confidence with more sessions', () => {
    const e = channelEngagement([ev('A', 1), ev('A', 1), ev('A', 1), ev('A', 1), ev('A', 1), ev('B', 1), ev('C', 0.05, true)]);
    expect(e.get('A')!).toBeGreaterThan(e.get('B')!);
    expect(e.get('B')!).toBeGreaterThan(e.get('C')!);
    expect(e.get('A')!).toBeLessThanOrEqual(1);
  });

  it('subscription weight has a floor for unwatched channels', () => {
    expect(subscriptionWeight(undefined)).toBeCloseTo(0.3);
    expect(subscriptionWeight(1)).toBeCloseTo(1);
  });
});

describe('history seed', () => {
  it('orders crawling when there are no watch logs, and never overrides real engagement', async () => {
    const { crawlPriority, historySeedValue, HISTORY_SEED_MAX } = await import('../src/core/engagement');
    expect(historySeedValue(0)).toBe(0);
    expect(historySeedValue(1)).toBeLessThan(historySeedValue(5));
    expect(historySeedValue(1000)).toBeLessThanOrEqual(HISTORY_SEED_MAX);
    const p = crawlPriority(new Map([['A', 0.1]]), { A: 50, B: 3 });
    expect(p.get('A')).toBe(0.1); // real logs win
    expect(p.get('B')).toBeCloseTo(historySeedValue(3));
    expect(crawlPriority(new Map(), undefined).size).toBe(0);
  });
});

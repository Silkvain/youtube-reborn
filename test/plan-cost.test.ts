/**
 * Requests per day under the real planner, budgets and subscriptions-feed state machine, for
 * 60 and 1,000 subscriptions. Crawl jobs are simulated as instant successes; the subscriptions
 * feed is simulated as a newest-first list of uploads served in pages.
 *
 * Assumptions (stated, not measured): each subscription uploads 0.3 long-form videos a day
 * (~2 a week); a feed page holds 30 videos; Home is opened 10 times a day; 300 discovery
 * candidates exist; every planned request succeeds.
 */
import { pickJob, planJobs } from '../src/background/crawler';
import type { Snapshot } from '../src/background/feed';
import { initialState, recordSent, rollDay, spentOn, type LimiterState } from '../src/background/ratelimit';
import { advanceSync, claimSync, initialSubsFeedState, type PageRequest, type SubsFeedState } from '../src/background/subsfeed';
import { DEFAULT_DAILY_CAP, type Purpose } from '../src/shared/constants';
import { jobPurpose, type Job } from '../src/shared/jobs';
import type { Channel, TrendingQueryResult } from '../src/shared/types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = new Date(2026, 9, 1).getTime(); // local midnight, like the limiter's day key
const UPLOADS_PER_SUB_PER_DAY = 0.3;
const PAGE_SIZE = 30;
const HOME_VISIT_HOURS = [8, 9.5, 12, 13, 17, 18.5, 20, 21, 22, 23];
const CANDIDATES = 300;

type Tally = Record<Purpose, number>;
const zero = (): Tally => ({ subs: 0, top: 0, discovery: 0, mentions: 0 });

function world(n: number) {
  const id = (p: string, i: number) => `UC${p}${String(i).padStart(22 - p.length, '0')}`;
  const channels = new Map<string, Channel>();
  const subscribed = new Set<string>();
  const engagement = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const c = id('s', i);
    channels.set(c, { id: c, title: c, isSubscribed: true });
    subscribed.add(c);
    if (i % 5 === 0) engagement.set(c, (i % 7) / 7); // a fifth of channels have watch history
  }
  const scores = new Map<string, number>();
  for (let i = 0; i < CANDIDATES; i++) {
    const c = id('c', i);
    channels.set(c, { id: c, title: c, isSubscribed: false });
    scores.set(c, 1 / (i + 1));
  }
  const snap: Snapshot = { now: START, channels, subscribed, edges: [], engagement, feedback: new Map(), scores };
  return snap;
}

/** Crawl jobs (everything except the subscriptions feed), per day. */
function simulateCrawl(n: number, days: number): Tally[] {
  const snap = world(n);
  const queries: Record<string, TrendingQueryResult> = {};
  let news: { fetchedAt: number; region: string } | undefined;
  let s: LimiterState = initialState(START);
  const perDay: Tally[] = [];
  for (let h = 0; h < days * 24; h++) {
    const now = START + h * HOUR;
    s = rollDay(s, now);
    const day = Math.floor(h / 24);
    perDay[day] ??= zero();
    const remaining = planJobs(snap, [], now, { show: true, queries, news, region: 'GB' });
    for (;;) {
      if (s.counter.count >= DEFAULT_DAILY_CAP) break;
      const job: Job | null = pickJob(remaining, s, now, 'tab') ?? pickJob(remaining, s, now, 'worker');
      if (!job) break;
      remaining.splice(remaining.indexOf(job), 1);
      const purpose = jobPurpose(job);
      s = recordSent(s, now, purpose);
      perDay[day]![purpose]++;
      if (job.kind === 'trending') queries[job.query] = { fetchedAt: now, filter: 'today', videos: [] };
      else if (job.kind === 'news') news = { fetchedAt: now, region: 'GB' };
      else if (job.kind === 'channel') snap.channels.get(job.id)!.lastCrawledAt = now;
      else if (job.kind === 'videos') snap.channels.get(job.id)!.videosTabFetchedAt = now;
      else if (job.kind === 'rss') snap.channels.get(job.id)!.uploadsFetchedAt = now;
    }
  }
  return perDay;
}

/** Subscriptions-feed requests per day: Home visits drive syncs; uploads arrive steadily. */
function simulateFeed(n: number, days: number): number[] {
  const gap = DAY / (n * UPLOADS_PER_SUB_PER_DAY);
  // Uploads at START - 60 days .. end, oldest first; index = id.
  const first = START - 60 * DAY;
  const times: number[] = [];
  for (let t = first; t < START + days * DAY; t += gap) times.push(t);
  const stored = new Set<number>();
  /** Newest-first page of uploads published before `before` and by `now`. */
  const page = (req: PageRequest, now: number) => {
    const before = Math.min('browseId' in req ? now + 1 : Number(req.continuation), now + 1);
    // Index of the newest upload published before `before` (binary search; times ascend).
    let lo = 0;
    let hi = times.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! < before) lo = mid + 1;
      else hi = mid - 1;
    }
    const ids: number[] = [];
    while (hi >= 0 && ids.length < PAGE_SIZE) ids.push(hi--);
    return { ids, continuation: hi >= 0 ? String(times[ids[ids.length - 1]!]) : null };
  };
  let state: SubsFeedState = initialSubsFeedState();
  const perDay: number[] = [];
  for (let d = 0; d < days; d++) {
    perDay[d] = 0;
    for (const hour of HOME_VISIT_HOURS) {
      const now = START + d * DAY + hour * HOUR;
      const claim = claimSync(state, now);
      if (!claim.due) continue;
      state = claim.state;
      let req: PageRequest | null = claim.request;
      while (req) {
        perDay[d] = perDay[d]! + 1;
        const p = page(req, now);
        const known = p.ids.filter((i) => stored.has(i)).length;
        for (const i of p.ids) stored.add(i);
        const oldestAt = p.ids.length ? times[p.ids[p.ids.length - 1]!] : undefined;
        const adv = advanceSync(state, { items: p.ids.length, known, oldestAt, continuation: p.continuation }, now);
        state = adv.state;
        req = adv.next;
      }
    }
  }
  return perDay;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function costReport(n: number) {
  const DAYS = 200;
  const crawl = simulateCrawl(n, DAYS);
  const feed = simulateFeed(n, DAYS);
  const steady = { from: 100, to: DAYS }; // after the bootstrap and the first 45–75 day re-crawl wave
  const window = crawl.slice(steady.from, steady.to);
  const avg = (p: Purpose) => mean(window.map((t) => t[p]));
  const feedAvg = mean(feed.slice(steady.from, steady.to));
  const totals = window.map((t, i) => t.top + t.discovery + t.mentions + feed[steady.from + i]!);
  const bootstrapDays = crawl.findIndex((t, i) => i > 0 && t.discovery < 100);
  return {
    n,
    subsFeed: feedAvg,
    top: avg('top'),
    discovery: avg('discovery'),
    mentions: avg('mentions'),
    total: mean(totals),
    maxDay: Math.max(...totals),
    firstDay: crawl[0]!.top + crawl[0]!.discovery + crawl[0]!.mentions + feed[0]!,
    bootstrapDays,
  };
}

describe('request cost per day (planner simulation)', () => {
  const r60 = costReport(60);
  const r1000 = costReport(1000);

  it('prints the estimate', () => {
    const row = (r: ReturnType<typeof costReport>) =>
      `N=${String(r.n).padStart(4)}  subsFeed ${r.subsFeed.toFixed(1)}  top ${r.top.toFixed(1)}  discovery ${r.discovery.toFixed(1)}  mentions ${r.mentions.toFixed(1)}  => ${r.total.toFixed(1)}/day (max day ${r.maxDay}; first day ${r.firstDay}; bootstrap ${r.bootstrapDays} day(s))`;
    console.log(`steady state, days 100–200:\n${row(r60)}\n${row(r1000)}`);
  });

  it('stays near the targets: ~65/day at 60 subscriptions, ~90/day at 1,000', () => {
    // Includes the top row: 24 searches a day ("today", every 6 hours) and 12 News hub reads.
    expect(r60.total).toBeLessThan(75);
    expect(r1000.total).toBeLessThan(105);
    // 16× the subscriptions costs well under 2× the requests.
    expect(r1000.total / r60.total).toBeLessThan(2);
  });

  it('keeps every day under the hard cap, even while bootstrapping 1,000 channels', () => {
    for (const r of [r60, r1000]) expect(r.maxDay).toBeLessThan(DEFAULT_DAILY_CAP);
    expect(r1000.firstDay).toBeLessThanOrEqual(DEFAULT_DAILY_CAP);
    expect(r1000.bootstrapDays).toBeGreaterThan(1); // spread over a week, not one burst
    expect(r1000.bootstrapDays).toBeLessThan(10);
  });

  it('refreshes the top row every six hours (six searches) and the news every two, not more', () => {
    expect(r60.top).toBeGreaterThan(18 + 9);
    expect(r60.top).toBeLessThanOrEqual(24 + 12);
  });

  it('spends the discovery budget per purpose: never more than its allowance', () => {
    const crawl = simulateCrawl(1000, 3);
    for (const t of crawl) expect(t.discovery).toBeLessThanOrEqual(165);
    expect(spentOn(initialState(START), 'discovery', START)).toBe(0);
  });
});

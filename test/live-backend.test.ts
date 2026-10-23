/**
 * Optional: the extension's client against a real local Worker (workerd, real Durable Objects,
 * real rate limiter). Start it first, then run with LIVE_BACKEND=1:
 *   cd backend && npx wrangler dev --local --port 8787 --test-scheduled --var MIN_CONTRIBUTORS:2 --var DP_EPSILON:1000
 *   LIVE_BACKEND=http://127.0.0.1:8787 npx vitest run test/live-backend.test.ts
 */
import { CommunityClient, CommunityError } from '../src/background/community-client';
import { utcDay } from '../src/shared/community/protocol';

const BASE = process.env.LIVE_BACKEND ?? '';
const ch = (n: number) => `UC${String(n).padStart(22, 'x')}`;
const vid = (n: number) => `video${String(n).padStart(6, '0')}`;

describe.skipIf(!BASE)('live local backend', () => {
  const client = new CommunityClient(BASE);
  const today = utcDay(Date.now());

  it('tokens, uploads, double-spend refusal, publish, download', async () => {
    // Three "people", each with one token request (the limiter allows 3 a minute per address).
    for (let i = 0; i < 3; i++) {
      const [eventsToken, pairsToken] = await client.getTokens(2);
      await client.sendEvents(eventsToken!, [{ v: vid(1), c: ch(1), d: today, q: 3 }]);
      await client.sendPairs(pairsToken!, [[ch(1), ch(2), 2]]);
      if (i === 0) {
        await expect(client.sendEvents(eventsToken!, [{ v: vid(1), c: ch(1), d: today, q: 3 }])).rejects.toBeInstanceOf(
          CommunityError,
        );
      }
    }
    // A fourth token request inside the minute is refused by the edge rate limiter.
    await expect(client.getTokens(1)).rejects.toMatchObject({ status: 429 });

    // Let the aggregators flush (5 s buffer), then run both scheduled jobs.
    await new Promise((r) => setTimeout(r, 6500));
    for (const cron of ['17+*+*+*+*', '23+3+*+*+*']) expect((await fetch(`${BASE}/__scheduled?cron=${cron}`)).ok).toBe(true);

    const trending = await client.getTrending('global');
    expect(trending?.videos).toEqual([{ v: vid(1), c: ch(1), n: 3 }]);
    const { shardOf } = await import('../src/shared/community/protocol');
    const shard = await client.getGraphShard(shardOf(ch(1)));
    expect(shard?.neighbours[ch(1)]).toEqual([[ch(2), 3, expect.any(Number)]]);
  }, 60_000);
});

/**
 * Optional, and it uses real YouTube Data API quota (a few units): the shared upload pool with two
 * real public channels. Start the Worker with `--var YOUTUBE_API_KEY:…` on a fresh `--persist-to`
 * folder, then run with LIVE_BACKEND=… LIVE_POOL=1 and `-t "upload pool"` (on its own, because of
 * the token rate limit).
 */
describe.skipIf(!BASE || !process.env.LIVE_POOL)('live local backend: upload pool', () => {
  const client = new CommunityClient(BASE);
  const today = utcDay(Date.now());
  const YOUTUBE = 'UCBR8-60-B28hp2BmDPdntcQ';
  const VERITASIUM = 'UCHnyfMqiRRG1u-2MsSQLbXA';

  it('graph → pool cron fetches from YouTube → uploads in the shard', async () => {
    const [a, b] = [YOUTUBE, VERITASIUM].sort() as [string, string];
    // Three people (the limiter allows 3 token requests a minute), 3 uploads each: past the
    // local activation threshold of 6.
    for (let i = 0; i < 3; i++) {
      const [t1, t2, t3] = await client.getTokens(3);
      await client.sendPairs(t1!, [[a, b, 2]]);
      await client.sendEvents(t2!, [{ v: vid(1), c: ch(1), d: today, q: 3 }]);
      await client.sendEvents(t3!, [{ v: vid(2), c: ch(1), d: today, q: 3 }]);
    }
    await new Promise((r) => setTimeout(r, 6500));
    const cron = (pattern: string) => fetch(`${BASE}/__scheduled?cron=${pattern}`);
    expect((await cron('23+3+*+*+*')).ok).toBe(true); // graph: plans the pool
    expect((await cron('*/10+*+*+*+*')).ok).toBe(true); // pool: fetches from YouTube
    expect((await cron('23+3+*+*+*')).ok).toBe(true); // graph again: embeds the uploads

    const { shardOf } = await import('../src/shared/community/protocol');
    const shard = await client.getGraphShard(shardOf(VERITASIUM));
    const uploads = shard?.uploads?.[VERITASIUM];
    expect(uploads?.t).toBe('Veritasium');
    expect(uploads?.v.length).toBeGreaterThan(0);
    for (const [id, title, published, duration, views] of uploads!.v) {
      expect(id).toMatch(/^[\w-]{11}$/);
      expect(title.length).toBeGreaterThan(0);
      expect(published * 1000).toBeLessThan(Date.now());
      expect(duration).toBeGreaterThan(60); // long-form only: no Shorts
      expect(views).toBeGreaterThan(0);
    }
    expect(shard?.uploads?.[YOUTUBE]?.v.length).toBeGreaterThan(0); // the neighbour's uploads too
    console.log('pool sample:', JSON.stringify(uploads!.v[0]));
  }, 60_000);
});

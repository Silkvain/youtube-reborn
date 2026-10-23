import { shardOf, utcDay, utcWeek, type GraphShard } from '../../src/shared/community/protocol';
import { handle, publishGraph, runPool, scheduled, POOL_CRON } from '../src/app';
import type { Aggregator } from '../src/objects';
import { fetchUploads, parseIsoDuration, POOL_MAX_AGE_MS } from '../src/pool';
import { blockGraph } from '../src/publish';
import { fakeEnv, type FakeEnv } from './fakes';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const DAY_MS = 86_400_000;
const ch = (n: number) => `UC${String(n).padStart(22, 'x')}`;
const vid = (c: number, i: number) => `v${String(c).padStart(4, '0')}x${String(i).padStart(5, '0')}`;

/** A stand-in for the YouTube Data API: each channel has 4 long-form uploads, a day apart. */
function fakeYouTube(opts: { missing?: Set<string>; live?: Set<string>; quotaAfter?: number } = {}) {
  const calls: string[] = [];
  const fetchFn = async (input: string) => {
    calls.push(input);
    const url = new URL(input);
    if (opts.quotaAfter !== undefined && calls.length > opts.quotaAfter) {
      return new Response(JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }] } }), { status: 403 });
    }
    if (url.pathname.endsWith('/playlistItems')) {
      const channel = `UC${url.searchParams.get('playlistId')!.slice(4)}`;
      if (opts.missing?.has(channel)) return new Response('{}', { status: 404 });
      const n = Number(channel.replace(/^UCx*/, ''));
      return Response.json({ items: [0, 1, 2, 3].map((i) => ({ contentDetails: { videoId: vid(n, i) } })) });
    }
    if (url.pathname.endsWith('/videos')) {
      const ids = url.searchParams.get('id')!.split(',');
      return Response.json({
        items: ids.map((id) => {
          const n = Number(id.slice(1, 5));
          const i = Number(id.slice(6));
          return {
            id,
            snippet: {
              channelId: ch(n),
              channelTitle: `Channel ${n}`,
              title: `Video ${i} of ${n}`,
              publishedAt: new Date(NOW - (i + 1) * DAY_MS).toISOString(),
              liveBroadcastContent: opts.live?.has(id) ? 'upcoming' : 'none',
            },
            contentDetails: { duration: 'PT12M3S' },
            statistics: { viewCount: String(1000 * (i + 1)) },
          };
        }),
      });
    }
    return new Response('{}', { status: 500 });
  };
  return { fetchFn, calls };
}

/** Four people's pairs for each channel pair, plus enough uploads to leave dormancy. */
async function seedGraph(env: FakeEnv, pairs: [number, number][], now = NOW) {
  const week = utcWeek(now);
  for (const [a, b] of pairs) {
    const [x, y] = [ch(a), ch(b)].sort() as [string, string];
    const agg = env.AGG.get(env.AGG.idFromName(`pairs-${shardOf(x, 16)}`));
    for (let i = 0; i < 4; i++) {
      await agg.fetch('https://agg/add', { method: 'POST', body: JSON.stringify({ increments: [{ key: `p|${week}|${x}|${y}`, w: 2 }] }) });
    }
  }
  const uploads = env.AGG.get(env.AGG.idFromName('uploads'));
  await uploads.fetch('https://agg/add', { method: 'POST', body: JSON.stringify({ increments: [{ key: `u|${utcDay(now)}` }] }) });
  for (const agg of env.AGG.instances.values()) await (agg as Aggregator).alarm();
}

const shardFor = (env: FakeEnv, c: string) => JSON.parse(env.PUBLIC.objects.get(`graph/${shardOf(c)}.json`)!) as GraphShard;

describe('shared upload pool', () => {
  it('parses ISO 8601 durations', () => {
    expect(parseIsoDuration('PT12M3S')).toBe(723);
    expect(parseIsoDuration('PT1H')).toBe(3600);
    expect(parseIsoDuration('P1DT2S')).toBe(86_402);
    expect(parseIsoDuration('P0D')).toBe(0);
    expect(parseIsoDuration('nonsense')).toBe(0);
  });

  it('fetches long-form uploads (UULF playlist), newest first, skipping live and upcoming', async () => {
    const yt = fakeYouTube({ live: new Set([vid(1, 0)]), missing: new Set([ch(2)]) });
    const got = await fetchUploads([ch(1), ch(2)], 'KEY', yt.fetchFn, NOW);
    expect(yt.calls[0]).toContain(`playlistId=UULF${ch(1).slice(2)}`);
    expect(got.units).toBe(3); // two playlists + one videos.list for all IDs
    const [one, two] = [got.results.find(([c]) => c === ch(1))![1]!, got.results.find(([c]) => c === ch(2))![1]];
    expect(one.t).toBe('Channel 1');
    expect(one.v.map(([id]) => id)).toEqual([vid(1, 1), vid(1, 2), vid(1, 3)]);
    expect(one.v[0]).toEqual([vid(1, 1), 'Video 1 of 1', Math.floor((NOW - 2 * DAY_MS) / 1000), 723, 2000]);
    expect(two).toBeNull();
  });

  it('stops at the quota and stores nothing half-fetched', async () => {
    const yt = fakeYouTube({ quotaAfter: 1 });
    const got = await fetchUploads([ch(1), ch(2)], 'KEY', yt.fetchFn, NOW);
    expect(got.quotaHit).toBe(true);
    expect(got.results).toEqual([]);
  });

  it('dormant or no key: no API calls at all', async () => {
    const yt = fakeYouTube();
    const env = fakeEnv({ YOUTUBE_API_KEY: 'KEY', ACTIVATION_UPLOADS: '160' });
    await seedGraph(env, [[1, 2]]);
    await publishGraph(env, NOW); // dormant: empty graph, so the pool holds nothing
    expect(await runPool(env, NOW, yt.fetchFn)).toBe(0);
    const noKey = fakeEnv();
    await seedGraph(noKey, [[1, 2]]);
    await publishGraph(noKey, NOW);
    expect(await runPool(noKey, NOW, yt.fetchFn)).toBe(0);
    expect(yt.calls).toEqual([]);
  });

  it('graph → pool fetch → uploads embedded in the next graph publish', async () => {
    const yt = fakeYouTube();
    const env = fakeEnv({ YOUTUBE_API_KEY: 'KEY' });
    await seedGraph(env, [[1, 2], [1, 3]]);
    await publishGraph(env, NOW);
    expect(shardFor(env, ch(1)).uploads).toBeUndefined(); // nothing fetched yet

    expect(await runPool(env, NOW + 60_000, yt.fetchFn)).toBe(3);
    expect(await runPool(env, NOW + 120_000, yt.fetchFn)).toBe(0); // all fresh: nothing due
    await publishGraph(env, NOW + DAY_MS);

    // The shard holding channel 1 carries its uploads and its neighbours' uploads.
    const shard = shardFor(env, ch(1));
    expect(Object.keys(shard.uploads!).sort()).toEqual([ch(1), ch(2), ch(3)].sort());
    expect(shard.uploads![ch(2)]!.v).toHaveLength(4);
    // Served through the Worker too.
    const served = (await (await handle(new Request(`https://x/v1/graph/${shardOf(ch(1))}.json`), env, NOW)).json()) as GraphShard;
    expect(served.uploads?.[ch(3)]?.t).toBe('Channel 3');
  });

  it('runs from the 10-minute cron, re-fetches stalest first, and forgets channels that leave the graph', async () => {
    const yt = fakeYouTube();
    const env = fakeEnv({ YOUTUBE_API_KEY: 'KEY' });
    await seedGraph(env, [[1, 2]]);
    await publishGraph(env, NOW);
    await runPool(env, NOW, yt.fetchFn);
    const calls = yt.calls.length;
    // A day later both are due again.
    expect(await runPool(env, NOW + DAY_MS, yt.fetchFn)).toBe(2);
    expect(yt.calls.length).toBeGreaterThan(calls);

    // Next week the graph only has 3–4: the pool drops 1 and 2.
    const later = NOW + 35 * DAY_MS;
    await seedGraph(env, [[3, 4]], later);
    await publishGraph(env, later);
    const pool = env.POOL.get('pool');
    const { uploads } = (await (await pool.fetch('https://pool/lookup', { method: 'POST', body: JSON.stringify({ channels: [ch(1), ch(2)] }) })).json()) as {
      uploads: Record<string, unknown>;
    };
    expect(uploads).toEqual({});

    // The 10-minute cron fetches the new channels (global fetch stubbed: no real requests).
    const real = globalThis.fetch;
    globalThis.fetch = ((input: string) => yt.fetchFn(String(input))) as typeof fetch;
    try {
      yt.calls.length = 0;
      await scheduled(POOL_CRON, later, env);
    } finally {
      globalThis.fetch = real;
    }
    expect(yt.calls.filter((u) => u.includes('playlistItems')).map((u) => new URL(u).searchParams.get('playlistId')).sort()).toEqual(
      [ch(3), ch(4)].map((c) => `UULF${c.slice(2)}`).sort(),
    );
  });

  it('never publishes entries older than 30 days', async () => {
    const yt = fakeYouTube();
    const env = fakeEnv({ YOUTUBE_API_KEY: 'KEY' });
    await seedGraph(env, [[1, 2]]);
    await publishGraph(env, NOW);
    await runPool(env, NOW, yt.fetchFn);
    const later = NOW + POOL_MAX_AGE_MS + DAY_MS;
    await seedGraph(env, [[1, 2]], later);
    await publishGraph(env, later);
    expect(shardFor(env, ch(1)).uploads).toBeUndefined();
  });

  it('kill switch: no fetching', async () => {
    const yt = fakeYouTube();
    const env = fakeEnv({ YOUTUBE_API_KEY: 'KEY' });
    await seedGraph(env, [[1, 2]]);
    await publishGraph(env, NOW);
    expect(await runPool({ ...env, PUBLISHING: 'off' }, NOW, yt.fetchFn)).toBe(0);
    expect(yt.calls).toEqual([]);
  });

  it('daily quota cap: a run never plans past the units left', async () => {
    const yt = fakeYouTube();
    const env = fakeEnv({ YOUTUBE_API_KEY: 'KEY' });
    await seedGraph(env, [[1, 2]]);
    await publishGraph(env, NOW);
    const pool = env.POOL.get('pool');
    await pool.fetch('https://pool/store', { method: 'POST', body: JSON.stringify({ results: [], units: 9_000, quotaHit: false, now: NOW }) });
    expect(await runPool(env, NOW, yt.fetchFn)).toBe(0);
    expect(yt.calls).toEqual([]);
  });

  it('blocklist removes blocked channels and videos from pooled uploads', () => {
    const shard: GraphShard = {
      generatedAt: NOW,
      shard: 1,
      neighbours: { [ch(1)]: [[ch(2), 9]] },
      uploads: {
        [ch(1)]: { t: 'A', f: NOW, v: [[vid(1, 0), 'a', 1, 60, 1], [vid(1, 1), 'b', 1, 60, 1]] },
        [ch(2)]: { t: 'B', f: NOW, v: [[vid(2, 0), 'c', 1, 60, 1]] },
      },
    };
    const out = blockGraph(shard, new Set([ch(2), vid(1, 0)]));
    expect(Object.keys(out.uploads!)).toEqual([ch(1)]);
    expect(out.uploads![ch(1)]!.v.map(([id]) => id)).toEqual([vid(1, 1)]);
  });
});

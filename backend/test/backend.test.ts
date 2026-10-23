import {
  blind,
  decodeInt,
  encodeInt,
  finalize,
  generateKeyJwk,
  privateKeyFromJwk,
  signBlinded,
  toBase64Url,
  verify,
  type PublicKey,
} from '../../src/shared/community/blindrsa';
import { utcDay, utcWeek, type KeyResponse, type Token, type TrendingFile, type GraphShard } from '../../src/shared/community/protocol';
import { tokenMessage } from '../../src/shared/community/token-message';
import { handle, publishGraph, publishTrending } from '../src/app';
import { Aggregator } from '../src/objects';
import { laplace, noisyCount } from '../src/privacy';
import { buildGraph, buildTrending } from '../src/publish';
import { BadRequest, parseEvents, parsePairs, parseTokenRequest } from '../src/validate';
import { allowAll, fakeEnv, fakeState } from './fakes';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const DAY = utcDay(NOW);
const ch = (n: number) => `UC${String(n).padStart(22, 'x')}`;
const vid = (n: number) => `video${String(n).padStart(6, '0')}`;

describe('blind signatures', () => {
  it('a blinded token verifies after unblinding, and the server never sees the message', async () => {
    const key = privateKeyFromJwk(await generateKeyJwk(1024));
    const message = crypto.getRandomValues(new Uint8Array(32));
    const { blinded, r } = await blind(message, key);
    const sig = await finalize(message, signBlinded(blinded, key), r, key);
    expect(await verify(message, sig, key)).toBe(true);
    // Another message doesn't verify with this signature.
    expect(await verify(crypto.getRandomValues(new Uint8Array(32)), sig, key)).toBe(false);
    // The blinded value the server saw is unrelated to the final signature.
    expect(blinded).not.toBe(sig);
  });

  it('two tokens from the same key can not be told apart by what the server signed', async () => {
    const key = privateKeyFromJwk(await generateKeyJwk(1024));
    const m = new Uint8Array(32);
    const a = await blind(m, key);
    const b = await blind(m, key);
    expect(a.blinded).not.toBe(b.blinded); // random blinding: same message, different requests
  });
});

describe('validation', () => {
  const event = (v = vid(1)) => ({ v, c: ch(1), d: DAY, q: 2 });

  it('accepts well-formed events and pairs', () => {
    expect(parseEvents([event()], NOW)).toEqual([{ v: vid(1), c: ch(1), d: DAY, q: 2 }]);
    expect(parsePairs([[ch(1), ch(2), 3]])).toEqual([[ch(1), ch(2), 3]]);
  });

  it('drops anything extra (no titles, no times, no ids)', () => {
    const [e] = parseEvents([{ ...event(), t: 'title', userId: 'x', at: 123 }], NOW);
    expect(Object.keys(e!).sort()).toEqual(['c', 'd', 'q', 'v']);
  });

  it('rejects malformed, duplicate, old or oversized input', () => {
    expect(() => parseEvents([event(), event()], NOW)).toThrow(BadRequest);
    expect(() => parseEvents([{ ...event(), d: '2026-09-01' }], NOW)).toThrow(BadRequest);
    expect(() => parseEvents([{ ...event(), q: 7 }], NOW)).toThrow(BadRequest);
    expect(() => parseEvents(Array.from({ length: 51 }, (_, i) => event(vid(i))), NOW)).toThrow(BadRequest);
    expect(() => parsePairs([[ch(2), ch(1), 1]])).toThrow(BadRequest); // not sorted
    expect(() => parsePairs([[ch(1), ch(1), 1]])).toThrow(BadRequest);
    expect(() => parsePairs([[ch(1), ch(2), 1], [ch(1), ch(2), 2]])).toThrow(BadRequest);
    expect(() => parseTokenRequest({ epoch: '2026-10-14', blinded: ['AQ'] }, NOW)).toThrow(BadRequest);
    expect(() => parseTokenRequest({ epoch: DAY, blinded: ['AQ', 'AQ', 'AQ', 'AQ'] }, NOW)).toThrow(BadRequest);
  });
});

describe('privacy', () => {
  const p = { minContributors: 20, epsilon: 1, secret: 's' };

  it('withholds small counts and adds noise to the rest', async () => {
    expect(await noisyCount(2, 'a', p)).toBeNull();
    const big = await noisyCount(500, 'b', p);
    expect(big).not.toBeNull();
    expect(Math.abs(big! - 500)).toBeLessThan(30);
  });

  it('noise is fixed per aggregate and period, so republishing can not be averaged away', async () => {
    expect(await noisyCount(100, 'same|week', p)).toBe(await noisyCount(100, 'same|week', p));
    const values = await Promise.all(Array.from({ length: 20 }, (_, i) => noisyCount(100, `x|week${i}`, p)));
    expect(new Set(values).size).toBeGreaterThan(1);
  });

  it('laplace is symmetric around zero', () => {
    expect(laplace(0.5, 1)).toBeCloseTo(0);
    expect(laplace(0.25, 1)).toBeCloseTo(-laplace(0.75, 1));
  });
});

describe('aggregator', () => {
  it('buffers increments and writes them in batches', async () => {
    const state = fakeState();
    const agg = new Aggregator(state);
    const add = (key: string) =>
      agg.fetch(new Request('https://agg/add', { method: 'POST', body: JSON.stringify({ increments: [{ key, w: 2 }] }) }));
    for (let i = 0; i < 5; i++) await add('t|d|GB|v1');
    expect(state.storage.data.size).toBe(0); // nothing written yet
    expect(state.storage.alarm).not.toBeNull();
    await agg.alarm();
    expect(state.storage.data.get('t|d|GB|v1')).toEqual({ n: 5, w: 10 });
  });

  it('prunes aggregates older than a bucket', async () => {
    const state = fakeState();
    const agg = new Aggregator(state);
    await state.storage.put({ 't|2026-10-01|GB|v': { n: 1, w: 1 }, 't|2026-10-14|GB|v': { n: 1, w: 1 } });
    await agg.fetch(new Request('https://agg/prune', { method: 'POST', body: JSON.stringify({ prefix: 't|', before: '2026-10-08' }) }));
    expect([...state.storage.data.keys()]).toEqual(['t|2026-10-14|GB|v']);
  });
});

describe('publishing', () => {
  const p = { minContributors: 3, epsilon: 1000, secret: 's' };

  it('trending: per region and global, threshold applied, IDs only', async () => {
    const entries: [string, { n: number; w: number; meta?: Record<string, string> }][] = [
      [`t|${DAY}|GB|${vid(1)}`, { n: 5, w: 10, meta: { c: ch(1) } }],
      [`t|${DAY}|US|${vid(1)}`, { n: 4, w: 8, meta: { c: ch(1) } }],
      [`t|${DAY}|GB|${vid(2)}`, { n: 1, w: 1, meta: { c: ch(2) } }],
      [`t|2026-09-01|GB|${vid(3)}`, { n: 99, w: 99, meta: { c: ch(3) } }], // outside the window
    ];
    const files = await buildTrending(entries, new Set([DAY]), 'W', p, NOW);
    const by = Object.fromEntries(files.map((f) => [f.region, f.videos]));
    expect(by.GB).toEqual([{ v: vid(1), c: ch(1), n: 5 }]);
    expect(by.global).toEqual([{ v: vid(1), c: ch(1), n: 9 }]);
    expect(by.US).toEqual([{ v: vid(1), c: ch(1), n: 4 }]);
  });

  it('graph: thresholded pairs become neighbours of both channels', async () => {
    const week = utcWeek(NOW);
    const files = await buildGraph(
      [
        [`p|${week}|${ch(1)}|${ch(2)}`, { n: 6, w: 12 }],
        [`p|${week}|${ch(1)}|${ch(3)}`, { n: 2, w: 2 }],
      ],
      new Set([week]),
      week,
      p,
      NOW,
    );
    const neighbours = Object.assign({}, ...files.map((f) => f.neighbours));
    expect(neighbours[ch(1)]).toEqual([[ch(2), 6, expect.any(Number)]]);
    expect(neighbours[ch(2)]).toEqual([[ch(1), 6, expect.any(Number)]]);
    expect(neighbours[ch(3)]).toBeUndefined();
  });

  it('graph: neighbours are ranked by popularity-normalised strength, not raw count', async () => {
    const week = utcWeek(NOW);
    // ch(9) is a giant channel paired with everyone; ch(2) is niche but strongly tied to ch(1).
    const entries: [string, { n: number; w: number }][] = [
      [`p|${week}|${ch(1)}|${ch(9)}`, { n: 300, w: 300 }],
      [`p|${week}|${ch(1)}|${ch(2)}`, { n: 120, w: 120 }],
    ];
    for (let i = 10; i < 40; i++) entries.push([`p|${week}|${ch(9)}|${ch(i)}`, { n: 400, w: 400 }]);
    const files = await buildGraph(entries, new Set([week]), week, p, NOW);
    const neighbours = Object.assign({}, ...files.map((f) => f.neighbours));
    const list = neighbours[ch(1)] as [string, number, number][];
    expect(list.map((x) => x[0])).toEqual([ch(2), ch(9)]); // niche first despite fewer co-watches
    expect(list[1]![1]).toBeGreaterThan(list[0]![1]); // the raw counts say otherwise
  });
});

// ---- end to end through the request handler ----

async function getKey(env: ReturnType<typeof fakeEnv>): Promise<{ res: KeyResponse; key: PublicKey }> {
  const res = (await (await handle(new Request('https://x/v1/keys'), env, NOW)).json()) as KeyResponse;
  return { res, key: { n: decodeInt(res.n), e: decodeInt(res.e) } };
}

async function getTokens(env: ReturnType<typeof fakeEnv>, count: number): Promise<Token[]> {
  const { res, key } = await getKey(env);
  const nonces = Array.from({ length: count }, () => crypto.getRandomValues(new Uint8Array(32)));
  const blinded = await Promise.all(nonces.map((n) => blind(tokenMessage(res.epoch, n), key)));
  const resp = await handle(
    new Request('https://x/v1/tokens', {
      method: 'POST',
      body: JSON.stringify({ epoch: res.epoch, blinded: blinded.map((b) => encodeInt(b.blinded, key.n)) }),
    }),
    env,
    NOW,
  );
  const { signatures } = (await resp.json()) as { signatures: string[] };
  return Promise.all(
    signatures.map(async (s, i) => ({
      epoch: res.epoch,
      nonce: toBase64Url(nonces[i]!),
      sig: encodeInt(await finalize(tokenMessage(res.epoch, nonces[i]!), decodeInt(s), blinded[i]!.r, key), key.n),
    })),
  );
}

const post = (env: ReturnType<typeof fakeEnv>, path: string, body: unknown, country = 'GB') => {
  const req = new Request(`https://x${path}`, { method: 'POST', body: JSON.stringify(body) });
  Object.defineProperty(req, 'cf', { value: { country } });
  return handle(req, env, NOW);
};

describe('end to end', () => {
  it('tokens → events → published trending, with no way to reuse a token', async () => {
    const env = fakeEnv({ TOKEN_LIMITER: allowAll() });
    const people = 4;
    for (let i = 0; i < people; i++) {
      const [token] = await getTokens(env, 1);
      const res = await post(env, '/v1/events', { token, events: [{ v: vid(1), c: ch(1), d: DAY, q: 3 }] });
      expect(res.status).toBe(200);
      if (i === 0) {
        const again = await post(env, '/v1/events', { token, events: [{ v: vid(1), c: ch(1), d: DAY, q: 3 }] });
        expect(again.status).toBe(400);
        expect(await again.json()).toEqual({ error: 'token already used' });
      }
    }
    // One person watched another video: below the threshold, never published.
    const [token] = await getTokens(env, 1);
    await post(env, '/v1/events', { token, events: [{ v: vid(2), c: ch(2), d: DAY, q: 1 }] });

    await (env.AGG.instances.get('trending') as Aggregator).alarm();
    await publishTrending(env, NOW);
    const gb = (await (await handle(new Request('https://x/v1/trending/GB.json'), env, NOW)).json()) as TrendingFile;
    expect(gb.videos).toEqual([{ v: vid(1), c: ch(1), n: people }]);
    const res = await handle(new Request('https://x/v1/trending/GB.json'), env, NOW);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('pairs → published graph shards, every shard rewritten', async () => {
    const env = fakeEnv({ TOKEN_LIMITER: allowAll() });
    // 4 people: with a threshold of 3, exactly 3 could land just under it once noise is added.
    for (let i = 0; i < 4; i++) {
      const [token] = await getTokens(env, 1);
      expect((await post(env, '/v1/pairs', { token, pairs: [[ch(1), ch(2), 2]] })).status).toBe(200);
    }
    for (const agg of env.AGG.instances.values()) await (agg as Aggregator).alarm();
    await publishGraph(env, NOW);
    expect(env.PUBLIC.objects.size).toBe(256);
    const { shardOf } = await import('../../src/shared/community/protocol');
    const shard = JSON.parse(env.PUBLIC.objects.get(`graph/${shardOf(ch(1))}.json`)!) as GraphShard;
    expect(shard.neighbours[ch(1)]).toEqual([[ch(2), 4, expect.any(Number)]]);
  });

  it('rejects forged tokens and enforces the rate limit', async () => {
    const env = fakeEnv({ TOKEN_LIMITER: { limit: async () => ({ success: false }) } });
    const { res } = await getKey(env);
    const limited = await handle(
      new Request('https://x/v1/tokens', { method: 'POST', body: JSON.stringify({ epoch: res.epoch, blinded: ['AQ'] }) }),
      env,
      NOW,
    );
    expect(limited.status).toBe(429);
    const forged = { epoch: res.epoch, nonce: toBase64Url(new Uint8Array(32)), sig: 'AQAB' };
    const r = await post(env, '/v1/events', { token: forged, events: [{ v: vid(1), c: ch(1), d: DAY, q: 1 }] });
    expect(r.status).toBe(400);
  });

  async function uploadsBy(env: ReturnType<typeof fakeEnv>, people: number, video = vid(1), channel = ch(1)) {
    for (let i = 0; i < people; i++) {
      const [token] = await getTokens(env, 1);
      await post(env, '/v1/events', { token, events: [{ v: video, c: channel, d: DAY, q: 3 }] });
    }
    for (const agg of env.AGG.instances.values()) await (agg as Aggregator).alarm();
  }
  const trendingGB = async (env: ReturnType<typeof fakeEnv>) => {
    const res = await handle(new Request('https://x/v1/trending/GB.json'), env, NOW);
    return res.ok ? ((await res.json()) as TrendingFile) : res.status;
  };

  it('stays dormant until enough uploads arrive, then publishes', async () => {
    const env = fakeEnv({ TOKEN_LIMITER: allowAll(), ACTIVATION_UPLOADS: '6' });
    await uploadsBy(env, 5);
    await publishTrending(env, NOW);
    expect(await trendingGB(env)).toEqual({ generatedAt: NOW, region: 'GB', videos: [], dormant: true });
    await uploadsBy(env, 1);
    await publishTrending(env, NOW);
    expect((await trendingGB(env)) as TrendingFile).toMatchObject({ videos: [{ v: vid(1), n: 6 }] });
    expect(((await trendingGB(env)) as TrendingFile).dormant).toBeUndefined();
  });

  it('kill switch: nothing is served or published while publishing is off', async () => {
    const env = fakeEnv({ TOKEN_LIMITER: allowAll() });
    await uploadsBy(env, 4);
    await publishTrending(env, NOW);
    expect(((await trendingGB(env)) as TrendingFile).videos).toHaveLength(1);
    // Switched off: served files disappear at once, and the next publish writes empty files.
    const off = { ...env, PUBLISHING: 'off' };
    expect(await trendingGB(off)).toBe(404);
    expect((await handle(new Request('https://x/v1/graph/0.json'), off, NOW)).status).toBe(404);
    await publishTrending(off, NOW);
    expect(((await trendingGB(env)) as TrendingFile).videos).toEqual([]);
  });

  it('blocklist: blocked videos and channels never appear, even in files published earlier', async () => {
    const env = fakeEnv({ TOKEN_LIMITER: allowAll() });
    await uploadsBy(env, 4, vid(1), ch(1));
    await uploadsBy(env, 4, vid(2), ch(2));
    await publishTrending(env, NOW);
    expect(((await trendingGB(env)) as TrendingFile).videos.map((v) => v.v).sort()).toEqual([vid(1), vid(2)]);
    // Added to the blocklist after publishing: applied when serving, straight away.
    expect(((await trendingGB({ ...env, BLOCKLIST: vid(1) })) as TrendingFile).videos.map((v) => v.v)).toEqual([vid(2)]);
    expect(((await trendingGB({ ...env, BLOCKLIST: ` ${ch(2)} , x` })) as TrendingFile).videos.map((v) => v.v)).toEqual([vid(1)]);
    // And at the next publish.
    await publishTrending({ ...env, BLOCKLIST: ch(1) }, NOW);
    expect(((await trendingGB(env)) as TrendingFile).videos.map((v) => v.v)).toEqual([vid(2)]);
  });

  it('blocklist removes a channel from the graph as a key and as a neighbour', async () => {
    const { blockGraph } = await import('../src/publish');
    const shard: GraphShard = { generatedAt: NOW, shard: 1, neighbours: { [ch(1)]: [[ch(2), 9], [ch(3), 5]], [ch(2)]: [[ch(1), 9]] } };
    expect(blockGraph(shard, new Set([ch(2)])).neighbours).toEqual({ [ch(1)]: [[ch(3), 5]] });
  });

  it('the key is the same for everyone all day, so it can not single anyone out', async () => {
    const env = fakeEnv();
    const a = await getKey(env);
    const b = await getKey(env);
    expect(a.res).toEqual(b.res);
    expect(a.res.epoch).toBe(DAY);
  });
});

describe('privacy policy page', () => {
  it('is served as HTML at /privacy and covers the store and YouTube API requirements', async () => {
    const res = await handle(new Request('https://x/privacy'), fakeEnv(), NOW);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    for (const must of ['YouTube API Services', 'https://www.youtube.com/t/terms', 'https://policies.google.com/privacy', 'IP addresses', 'Silkvain']) {
      expect(html).toContain(must);
    }
  });
});

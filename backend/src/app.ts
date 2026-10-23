/**
 * Request handling and publishing for the "Enhanced discoverability" backend.
 *
 *   GET  /v1/keys                today's public token key
 *   POST /v1/tokens              sign blinded tokens (rate-limited per connection; IP never stored)
 *   POST /v1/events              "these videos were watched" (spends one token)
 *   POST /v1/pairs               channel co-watch pairs (spends one token)
 *   GET  /v1/trending/{XX}.json  published trending list for a region ("global" too)
 *   GET  /privacy                the privacy policy (a public URL the store needs)
 *   GET  /v1/graph/{n}.json      published channel graph shard 0–255 (with the shared upload pool)
 *
 * Privacy: no request is logged, no IP address or header is stored, uploads carry no identifier,
 * and only thresholded, noisy aggregates are published (see docs/enhanced-discoverability.md).
 */
import {
  decodeInt,
  encodeInt,
  privateKeyFromJwk,
  signBlinded,
  verify,
  fromBase64Url,
  type PrivateKey,
  type PrivateKeyJwk,
} from '../../src/shared/community/blindrsa';
import {
  GRAPH_SHARDS,
  isRegion,
  shardOf,
  utcDay,
  utcWeek,
  type KeyResponse,
  type Token,
} from '../../src/shared/community/protocol';
import { tokenMessage } from '../../src/shared/community/token-message';
import type { Aggregate, Increment } from './objects';
import {
  blockGraph,
  blockTrending,
  buildGraph,
  buildTrending,
  GRAPH_WEEKS,
  TRENDING_DAYS,
  uploadsInWindow,
} from './publish';
import type { GraphShard, TrendingFile } from '../../src/shared/community/protocol';
import type { PrivacyParams } from './privacy';
import {
  embeddedChannels,
  fetchUploads,
  POOL_CHANNELS_PER_RUN,
  POOL_DAILY_UNITS,
  POOL_REFRESH_MS,
  publishable,
  type Fetch,
} from './pool';
import type { PoolChannel } from '../../src/shared/community/protocol';
import { privacyPage } from './privacy-page';
import { BadRequest, acceptedEpochs, parseEvents, parsePairs, parseToken, parseTokenRequest } from './validate';

/** Minimal binding shapes (the real ones come from Cloudflare; tests pass fakes). */
export interface ObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}
export interface Bucket {
  get(key: string): Promise<{ body: ReadableStream | string; httpEtag?: string } | null>;
  put(key: string, value: string, options?: unknown): Promise<unknown>;
}
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  KEYS: ObjectNamespace;
  SPENT: ObjectNamespace;
  AGG: ObjectNamespace;
  /** The shared upload pool (one instance). */
  POOL?: ObjectNamespace;
  PUBLIC: Bucket;
  TOKEN_LIMITER?: RateLimiter;
  MIN_CONTRIBUTORS?: string;
  DP_EPSILON?: string;
  NOISE_SECRET?: string;
  /** YouTube Data API v3 key (a secret). Without it the upload pool stays empty. */
  YOUTUBE_API_KEY?: string;
  /** Uploads needed over the last 7 days before anything is published (default 160, about 20 people sharing). */
  ACTIVATION_UPLOADS?: string;
  /** "off" stops all publishing and serving of community data at once (default "on"). */
  PUBLISHING?: string;
  /** Comma-separated video and channel IDs never to publish. */
  BLOCKLIST?: string;
}

const publishingOff = (env: Env) => (env.PUBLISHING ?? 'on').trim().toLowerCase() === 'off';
const blocklist = (env: Env) =>
  new Set((env.BLOCKLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const activationUploads = (env: Env) => Number(env.ACTIVATION_UPLOADS ?? 160);

export const SPENT_SHARDS = 16;
export const PAIR_AGGREGATOR_SHARDS = 16;
const MAX_BODY_BYTES = 64 * 1024;
const DAY_MS = 86_400_000;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const stub = (ns: ObjectNamespace, name: string) => ns.get(ns.idFromName(name));

function privacy(env: Env): PrivacyParams {
  if (!env.NOISE_SECRET) throw new Error('NOISE_SECRET is not set');
  return {
    minContributors: Number(env.MIN_CONTRIBUTORS ?? 20),
    epsilon: Number(env.DP_EPSILON ?? 1),
    secret: env.NOISE_SECRET,
  };
}

// ---- keys ----

const keyCache = new Map<string, PrivateKey>();

async function privateKey(env: Env, epoch: string, now: number): Promise<PrivateKey | null> {
  const cached = keyCache.get(epoch);
  if (cached) return cached;
  const res = await stub(env.KEYS, 'keys').fetch(`https://keys/?epoch=${epoch}&now=${now}`);
  if (!res.ok) return null;
  const { jwk } = (await res.json()) as { jwk: PrivateKeyJwk };
  const key = privateKeyFromJwk(jwk);
  keyCache.set(epoch, key);
  for (const k of keyCache.keys()) if (!acceptedEpochs(now).includes(k)) keyCache.delete(k);
  return key;
}

/** Checks the signature, then marks the nonce spent. Throws BadRequest if either fails. */
async function spendToken(env: Env, token: Token, now: number): Promise<void> {
  const key = await privateKey(env, token.epoch, now);
  if (!key) throw new BadRequest('unknown token key');
  const ok = await verify(tokenMessage(token.epoch, fromBase64Url(token.nonce)), decodeInt(token.sig), key);
  if (!ok) throw new BadRequest('invalid token');
  const shard = shardOf(token.nonce, SPENT_SHARDS);
  const res = await stub(env.SPENT, `spent-${shard}`).fetch('https://spent/', {
    method: 'POST',
    body: JSON.stringify({ epoch: token.epoch, nonce: token.nonce }),
  });
  const { fresh } = (await res.json()) as { fresh: boolean };
  if (!fresh) throw new BadRequest('token already used');
}

// ---- handlers ----

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new BadRequest('body too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest('body is not JSON');
  }
}

async function handleKeys(env: Env, now: number): Promise<Response> {
  const key = await privateKey(env, utcDay(now), now);
  if (!key) return json({ error: 'key unavailable' }, 503);
  const body: KeyResponse = { epoch: utcDay(now), n: encodeInt(key.n, key.n), e: encodeInt(key.e, key.e) };
  // Everyone gets the same key for the day (and caches agree), so a key can't single anyone out.
  return json(body, 200, { 'cache-control': 'public, max-age=300' });
}

async function handleTokens(request: Request, env: Env, now: number): Promise<Response> {
  // The limiter keys on the connecting address at the edge; it is never stored or logged by us.
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (env.TOKEN_LIMITER && !(await env.TOKEN_LIMITER.limit({ key: ip })).success) {
    return json({ error: 'slow down' }, 429);
  }
  const req = parseTokenRequest(await readJson(request), now);
  const key = await privateKey(env, req.epoch, now);
  if (!key) return json({ error: 'key unavailable' }, 503);
  const signatures = req.blinded.map((b) => {
    const blinded = decodeInt(b);
    if (blinded <= 1n || blinded >= key.n) throw new BadRequest('blinded value out of range');
    return encodeInt(signBlinded(blinded, key), key.n);
  });
  return json({ signatures });
}

function regionOf(request: Request): string {
  const c = (request as Request & { cf?: { country?: string } }).cf?.country;
  return typeof c === 'string' && /^[A-Z]{2}$/.test(c) ? c : 'ZZ';
}

async function handleEvents(request: Request, env: Env, now: number): Promise<Response> {
  const body = (await readJson(request)) as Record<string, unknown>;
  const token = parseToken(body?.token, now);
  const events = parseEvents(body?.events, now);
  await spendToken(env, token, now);
  const region = regionOf(request);
  const increments: Increment[] = events.map((e) => ({
    key: `t|${e.d}|${region}|${e.v}`,
    w: e.q,
    meta: { c: e.c },
  }));
  await stub(env.AGG, 'trending').fetch('https://agg/add', { method: 'POST', body: JSON.stringify({ increments }) });
  await countUpload(env, now);
  return json({ ok: true });
}

/** One per accepted upload, per day: how many uploads arrive decides when publishing starts. */
async function countUpload(env: Env, now: number): Promise<void> {
  await stub(env.AGG, 'uploads').fetch('https://agg/add', {
    method: 'POST',
    body: JSON.stringify({ increments: [{ key: `u|${utcDay(now)}` }] }),
  });
}

async function handlePairs(request: Request, env: Env, now: number): Promise<Response> {
  const body = (await readJson(request)) as Record<string, unknown>;
  const token = parseToken(body?.token, now);
  const pairs = parsePairs(body?.pairs);
  await spendToken(env, token, now);
  const week = utcWeek(now);
  const byShard = new Map<number, Increment[]>();
  for (const [a, b, w] of pairs) {
    const s = shardOf(a, PAIR_AGGREGATOR_SHARDS);
    const list = byShard.get(s) ?? [];
    list.push({ key: `p|${week}|${a}|${b}`, w });
    byShard.set(s, list);
  }
  await Promise.all(
    [...byShard].map(([s, increments]) =>
      stub(env.AGG, `pairs-${s}`).fetch('https://agg/add', { method: 'POST', body: JSON.stringify({ increments }) }),
    ),
  );
  await countUpload(env, now);
  return json({ ok: true });
}

async function servePublic(env: Env, key: string, maxAge: number): Promise<Response> {
  // Kill switch: nothing is served while publishing is off.
  if (publishingOff(env)) return json({ error: 'paused' }, 404, { 'cache-control': 'public, max-age=300' });
  const obj = await env.PUBLIC.get(key);
  if (!obj) return json({ error: 'not published yet' }, 404, { 'cache-control': 'public, max-age=600' });
  const headers = { 'content-type': 'application/json', 'cache-control': `public, max-age=${maxAge}` };
  const blocked = blocklist(env);
  if (!blocked.size) return new Response(obj.body, { headers });
  // Blocklist applies immediately, not just at the next publish.
  const data = JSON.parse(typeof obj.body === 'string' ? obj.body : await new Response(obj.body).text());
  const filtered = key.startsWith('trending/') ? blockTrending(data as TrendingFile, blocked) : blockGraph(data as GraphShard, blocked);
  return new Response(JSON.stringify(filtered), { headers });
}

export async function handle(request: Request, env: Env, now = Date.now()): Promise<Response> {
  const { pathname } = new URL(request.url);
  try {
    if (request.method === 'GET' && pathname === '/v1/keys') return await handleKeys(env, now);
    if (request.method === 'POST' && pathname === '/v1/tokens') return await handleTokens(request, env, now);
    if (request.method === 'POST' && pathname === '/v1/events') return await handleEvents(request, env, now);
    if (request.method === 'POST' && pathname === '/v1/pairs') return await handlePairs(request, env, now);
    const trending = pathname.match(/^\/v1\/trending\/([A-Za-z]{2}|global)\.json$/);
    if (request.method === 'GET' && trending) {
      const region = trending[1]!.length === 2 ? trending[1]!.toUpperCase() : 'global';
      return await servePublic(env, `trending/${isRegion(region) ? region : 'global'}.json`, 3600);
    }
    const graph = pathname.match(/^\/v1\/graph\/(\d{1,3})\.json$/);
    if (request.method === 'GET' && graph && Number(graph[1]) < GRAPH_SHARDS) {
      return await servePublic(env, `graph/${Number(graph[1])}.json`, 6 * 3600);
    }
    if (request.method === 'GET' && pathname === '/v1/health') return json({ ok: true });
    if (request.method === 'GET' && pathname === '/privacy') {
      return new Response(privacyPage(), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
    }
    return json({ error: 'not found' }, 404);
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    // No request details in logs: only the error itself.
    console.error('[reborn-community] internal error', err instanceof Error ? err.message : 'unknown');
    return json({ error: 'internal error' }, 500);
  }
}

// ---- publishing (cron) ----

async function snapshot(env: Env, name: string, prefix: string): Promise<[string, Aggregate][]> {
  const res = await stub(env.AGG, name).fetch(`https://agg/snapshot?prefix=${encodeURIComponent(prefix)}`);
  return ((await res.json()) as { entries: [string, Aggregate][] }).entries;
}

async function prune(env: Env, name: string, prefix: string, before: string): Promise<void> {
  await stub(env.AGG, name).fetch('https://agg/prune', { method: 'POST', body: JSON.stringify({ prefix, before }) });
}

/** Hourly: republish trending. Raw per-day counts older than the window are deleted. */
/** Too few uploads in the last 7 days to publish anything (stays true for a brand-new server). */
export async function isDormant(env: Env, now: number): Promise<boolean> {
  const days = new Set(Array.from({ length: TRENDING_DAYS }, (_, i) => utcDay(now - i * DAY_MS)));
  await prune(env, 'uploads', 'u|', utcDay(now - TRENDING_DAYS * DAY_MS));
  return uploadsInWindow(await snapshot(env, 'uploads', 'u|'), days) < activationUploads(env);
}

export async function publishTrending(env: Env, now = Date.now()): Promise<number> {
  const days = new Set(Array.from({ length: TRENDING_DAYS }, (_, i) => utcDay(now - i * DAY_MS)));
  await prune(env, 'trending', 't|', utcDay(now - TRENDING_DAYS * DAY_MS));
  const entries = await snapshot(env, 'trending', 't|');
  const quiet = publishingOff(env) || (await isDormant(env, now));
  let files: TrendingFile[];
  if (quiet) {
    // Dormant or switched off: every region's file is replaced by an empty one.
    const regions = new Set(['global', ...entries.map(([k]) => k.split('|')[2]!).filter(Boolean)]);
    files = [...regions].map((region) => ({ generatedAt: now, region, videos: [], dormant: true }));
  } else {
    const blocked = blocklist(env);
    files = (await buildTrending(entries, days, utcWeek(now), privacy(env), now)).map((f) => blockTrending(f, blocked));
  }
  for (const f of files) await env.PUBLIC.put(`trending/${f.region}.json`, JSON.stringify(f));
  return quiet ? 0 : files.length;
}

/** Daily: republish the channel graph. Every shard is rewritten so stale data can't linger. */
export async function publishGraph(env: Env, now = Date.now()): Promise<number> {
  const weeks = new Set(Array.from({ length: GRAPH_WEEKS }, (_, i) => utcWeek(now - i * 7 * DAY_MS)));
  const oldest = utcWeek(now - (GRAPH_WEEKS - 1) * 7 * DAY_MS);
  const entries: [string, Aggregate][] = [];
  for (let s = 0; s < PAIR_AGGREGATOR_SHARDS; s++) {
    await prune(env, `pairs-${s}`, 'p|', oldest);
    entries.push(...(await snapshot(env, `pairs-${s}`, 'p|')));
  }
  const quiet = publishingOff(env) || (await isDormant(env, now));
  const blocked = blocklist(env);
  const built = quiet ? [] : await buildGraph(entries, weeks, utcWeek(now), privacy(env), now);
  await embedUploads(env, built, now);
  const shards = built.map((s) => blockGraph(s, blocked));
  const byIndex = new Map(shards.map((s) => [s.shard, s]));
  for (let i = 0; i < GRAPH_SHARDS; i++) {
    const shard = byIndex.get(i) ?? { generatedAt: now, shard: i, neighbours: {}, ...(quiet ? { dormant: true } : {}) };
    await env.PUBLIC.put(`graph/${i}.json`, JSON.stringify(shard));
  }
  return shards.length;
}

// ---- the shared upload pool (cron) ----

/**
 * Tells the pool which channels to hold (every channel in the graph being published; none when
 * dormant or switched off) and adds each shard's stored uploads to it.
 */
async function embedUploads(env: Env, shards: GraphShard[], now: number): Promise<void> {
  if (!env.POOL) return;
  const pool = stub(env.POOL, 'pool');
  const all = new Set(shards.flatMap((s) => Object.keys(s.neighbours)));
  await pool.fetch('https://pool/plan', { method: 'POST', body: JSON.stringify({ channels: [...all] }) });
  for (const shard of shards) {
    const wanted = [...embeddedChannels(shard.neighbours)];
    const res = await pool.fetch('https://pool/lookup', { method: 'POST', body: JSON.stringify({ channels: wanted }) });
    const { uploads } = (await res.json()) as { uploads: Record<string, PoolChannel | null> };
    const kept = Object.entries(uploads).filter((e): e is [string, PoolChannel] => publishable(e[1], now));
    if (kept.length) shard.uploads = Object.fromEntries(kept);
  }
}

/**
 * Every 10 minutes: fetch recent uploads for the channels most overdue, within the day's quota.
 * Does nothing without an API key, while switched off, or while the pool is empty (dormant).
 */
export async function runPool(env: Env, now = Date.now(), fetchFn: Fetch = (i, init) => fetch(i, init)): Promise<number> {
  if (!env.POOL || !env.YOUTUBE_API_KEY || publishingOff(env)) return 0;
  const pool = stub(env.POOL, 'pool');
  const next = await pool.fetch(
    `https://pool/next?n=${POOL_CHANNELS_PER_RUN}&now=${now}&refresh=${POOL_REFRESH_MS}&max=${POOL_DAILY_UNITS}`,
  );
  const { channels, unitsLeft } = (await next.json()) as { channels: string[]; unitsLeft: number };
  // A run costs at most one unit per channel plus one per 50 videos (about one per 10 channels).
  const affordable = channels.slice(0, Math.max(0, unitsLeft - Math.ceil(channels.length / 10)));
  if (!affordable.length) return 0;
  const got = await fetchUploads(affordable, env.YOUTUBE_API_KEY, fetchFn, now);
  await pool.fetch('https://pool/store', { method: 'POST', body: JSON.stringify({ ...got, now }) });
  return got.results.length;
}

/** Cron patterns from wrangler.toml: trending hourly, the graph once a day, the pool every 10 minutes. */
export const TRENDING_CRON = '17 * * * *';
export const GRAPH_CRON = '23 3 * * *';
export const POOL_CRON = '*/10 * * * *';

export async function scheduled(cron: string, scheduledTime: number, env: Env): Promise<void> {
  if (cron === GRAPH_CRON) await publishGraph(env, scheduledTime);
  else if (cron === POOL_CRON) await runPool(env, scheduledTime);
  else await publishTrending(env, scheduledTime);
}

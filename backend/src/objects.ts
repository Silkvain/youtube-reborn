/**
 * Durable Objects. They speak small JSON-over-fetch APIs and are only reachable from this Worker.
 *
 * - KeyStore (one instance): the daily RSA key. A new key each UTC day; keys older than two days
 *   are deleted, so tokens can't be linked across days.
 * - SpentTokens (sharded by nonce): remembers spent token nonces for two days so each token
 *   counts once.
 * - UploadPool (one instance): the shared upload pool of recent uploads, fetched from the
 *   YouTube Data API for channels in the published graph (see pool.ts).
 * - Aggregator (one for trending, several for pairs): adds up counts. Increments are buffered in
 *   memory and written in batches every few seconds, so cost follows the number of distinct
 *   aggregates touched, not the number of uploads.
 */
import { generateKeyJwk, type PrivateKeyJwk } from '../../src/shared/community/blindrsa';
import { utcDay } from '../../src/shared/community/protocol';

/** The subset of DurableObjectStorage used here (a fake implements it in tests). */
export interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  get<T>(keys: string[]): Promise<Map<string, T>>;
  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T>(options: { prefix?: string; start?: string; limit?: number }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
}

export interface ObjectState {
  storage: Storage;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const DAY_MS = 86_400_000;
const BATCH = 128; // Durable Object storage limit per get/put/delete call

async function* listAll<T>(storage: Storage, prefix: string): AsyncGenerator<[string, T]> {
  let start: string | undefined;
  for (;;) {
    const page = await storage.list<T>({ prefix, start, limit: 1000 });
    let last: string | undefined;
    for (const [k, v] of page) {
      if (k === start) continue;
      last = k;
      yield [k, v];
    }
    if (!last || page.size < 1000) return;
    start = last;
  }
}

async function deleteKeys(storage: Storage, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += BATCH) await storage.delete(keys.slice(i, i + BATCH));
}

// ---------------------------------------------------------------------------------------------

export class KeyStore {
  constructor(private readonly state: ObjectState) {}

  /** The key for `epoch`, created on first use for today only. */
  private async key(epoch: string, now: number): Promise<PrivateKeyJwk | null> {
    const existing = await this.state.storage.get<PrivateKeyJwk>(`key|${epoch}`);
    if (existing || epoch !== utcDay(now)) return existing ?? null;
    return this.state.blockConcurrencyWhile(async () => {
      const again = await this.state.storage.get<PrivateKeyJwk>(`key|${epoch}`);
      if (again) return again;
      const jwk = await generateKeyJwk();
      await this.state.storage.put(`key|${epoch}`, jwk);
      // Old keys go: a token from three days ago is worthless, and so is the key that signed it.
      const old: string[] = [];
      for await (const [k] of listAll(this.state.storage, 'key|')) {
        if (k.slice(4) < utcDay(now - 2 * DAY_MS)) old.push(k);
      }
      await deleteKeys(this.state.storage, old);
      return jwk;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Number(url.searchParams.get('now') ?? Date.now());
    const epoch = url.searchParams.get('epoch') ?? utcDay(now);
    const jwk = await this.key(epoch, now);
    if (!jwk) return json({ error: 'no key for that day' }, 404);
    return json({ epoch, jwk });
  }
}

// ---------------------------------------------------------------------------------------------

export class SpentTokens {
  constructor(private readonly state: ObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const { epoch, nonce } = (await request.json()) as { epoch: string; nonce: string };
    const key = `s|${epoch}|${nonce}`;
    const fresh = await this.state.blockConcurrencyWhile(async () => {
      if (await this.state.storage.get(key)) return false;
      await this.state.storage.put(key, 1);
      return true;
    });
    if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(Date.now() + DAY_MS);
    return json({ fresh });
  }

  /** Daily: forget nonces from epochs that can no longer be spent. */
  async alarm(): Promise<void> {
    const cutoff = utcDay(Date.now() - 2 * DAY_MS);
    const old: string[] = [];
    for await (const [k] of listAll(this.state.storage, 's|')) if (k.split('|')[1]! < cutoff) old.push(k);
    await deleteKeys(this.state.storage, old);
    await this.state.storage.setAlarm(Date.now() + DAY_MS);
  }
}

// ---------------------------------------------------------------------------------------------

/** One aggregate: contributor count, a summed weight, and optional public metadata. */
export interface Aggregate {
  n: number;
  w: number;
  meta?: Record<string, string | number>;
}

export interface Increment {
  key: string;
  w?: number;
  meta?: Record<string, string | number>;
}

export const FLUSH_DELAY_MS = 5_000;

export class Aggregator {
  private buffer = new Map<string, Aggregate>();

  constructor(private readonly state: ObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/add') {
      const { increments } = (await request.json()) as { increments: Increment[] };
      for (const inc of increments) {
        const cur = this.buffer.get(inc.key) ?? { n: 0, w: 0 };
        cur.n += 1;
        cur.w += inc.w ?? 1;
        if (inc.meta && !cur.meta) cur.meta = inc.meta;
        this.buffer.set(inc.key, cur);
      }
      if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(Date.now() + FLUSH_DELAY_MS);
      return json({ ok: true });
    }
    if (url.pathname === '/snapshot') {
      await this.flush();
      const prefix = url.searchParams.get('prefix') ?? '';
      const out: [string, Aggregate][] = [];
      for await (const entry of listAll<Aggregate>(this.state.storage, prefix)) out.push(entry);
      return json({ entries: out });
    }
    if (url.pathname === '/prune') {
      // Delete aggregates whose time bucket (second key segment) sorts before `before`.
      const { prefix, before } = (await request.json()) as { prefix: string; before: string };
      await this.flush();
      const old: string[] = [];
      for await (const [k] of listAll(this.state.storage, prefix)) if (k.split('|')[1]! < before) old.push(k);
      await deleteKeys(this.state.storage, old);
      return json({ deleted: old.length });
    }
    return json({ error: 'not found' }, 404);
  }

  async alarm(): Promise<void> {
    await this.flush();
  }

  /** Merge buffered increments into storage, at most BATCH keys per call. */
  async flush(): Promise<void> {
    if (!this.buffer.size) return;
    const pending = [...this.buffer.entries()];
    this.buffer = new Map();
    for (let i = 0; i < pending.length; i += BATCH) {
      const slice = pending.slice(i, i + BATCH);
      const existing = await this.state.storage.get<Aggregate>(slice.map(([k]) => k));
      const merged: Record<string, Aggregate> = {};
      for (const [k, add] of slice) {
        const cur = existing.get(k);
        merged[k] = { n: (cur?.n ?? 0) + add.n, w: (cur?.w ?? 0) + add.w, meta: cur?.meta ?? add.meta };
      }
      await this.state.storage.put(merged);
    }
  }
}

// ---------------------------------------------------------------------------------------------

/** A channel the pool should hold: its fetched uploads (absent until first fetched). */
interface PoolEntry {
  /** Last fetch attempt (ms); 0 = never. */
  f: number;
  uploads?: import('../../src/shared/community/protocol').PoolChannel | null;
}

/**
 * UploadPool (one instance): the shared upload pool. Holds an entry per channel in the
 * published graph (`c|{channel}`) and the quota units used per UTC day (`units|{day}`).
 *
 *   POST /plan   { channels }               keep exactly these channels; forget the rest
 *   GET  /next?n=&now=&refresh=&max=       stalest channels due a fetch, and units left today
 *   POST /store  { results, units, quotaHit, now }
 *   POST /lookup { channels }               stored uploads for these channels
 */
export class UploadPool {
  constructor(private readonly state: ObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const storage = this.state.storage;
    if (url.pathname === '/plan') {
      const { channels } = (await request.json()) as { channels: string[] };
      const wanted = new Set(channels);
      const gone: string[] = [];
      const have = new Set<string>();
      for await (const [k] of listAll(storage, 'c|')) {
        const c = k.slice(2);
        if (wanted.has(c)) have.add(c);
        else gone.push(k);
      }
      await deleteKeys(storage, gone);
      const added = [...wanted].filter((c) => !have.has(c));
      for (let i = 0; i < added.length; i += BATCH) {
        await storage.put(Object.fromEntries(added.slice(i, i + BATCH).map((c) => [`c|${c}`, { f: 0 } satisfies PoolEntry])));
      }
      return json({ channels: wanted.size, added: added.length, removed: gone.length });
    }
    if (url.pathname === '/next') {
      const n = Number(url.searchParams.get('n') ?? 0);
      const now = Number(url.searchParams.get('now') ?? Date.now());
      const refresh = Number(url.searchParams.get('refresh') ?? DAY_MS);
      const max = Number(url.searchParams.get('max') ?? 0);
      const day = utcDay(now);
      const used = (await storage.get<number>(`units|${day}`)) ?? 0;
      const stopped = (await storage.get<string>('quotaStop')) === day;
      const due: [string, number][] = [];
      for await (const [k, e] of listAll<PoolEntry>(storage, 'c|')) if (now - e.f >= refresh) due.push([k.slice(2), e.f]);
      due.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
      return json({ channels: due.slice(0, n).map(([c]) => c), unitsLeft: stopped ? 0 : Math.max(0, max - used) });
    }
    if (url.pathname === '/store') {
      const { results, units, quotaHit, now } = (await request.json()) as {
        results: [string, PoolEntry['uploads']][];
        units: number;
        quotaHit: boolean;
        now: number;
      };
      const day = utcDay(now);
      await storage.put(`units|${day}`, ((await storage.get<number>(`units|${day}`)) ?? 0) + units);
      if (quotaHit) await storage.put('quotaStop', day);
      // Only channels still planned are written (the plan may have changed mid-run).
      for (let i = 0; i < results.length; i += BATCH) {
        const slice = results.slice(i, i + BATCH);
        const existing = await storage.get<PoolEntry>(slice.map(([c]) => `c|${c}`));
        const writes: Record<string, PoolEntry> = {};
        for (const [c, uploads] of slice) if (existing.has(`c|${c}`)) writes[`c|${c}`] = { f: now, uploads };
        if (Object.keys(writes).length) await storage.put(writes);
      }
      // Old daily counters go.
      const old: string[] = [];
      for await (const [k] of listAll(storage, 'units|')) if (k.slice(6) < utcDay(now - 2 * DAY_MS)) old.push(k);
      await deleteKeys(storage, old);
      return json({ ok: true });
    }
    if (url.pathname === '/lookup') {
      const { channels } = (await request.json()) as { channels: string[] };
      const out: Record<string, PoolEntry['uploads']> = {};
      for (let i = 0; i < channels.length; i += BATCH) {
        const got = await storage.get<PoolEntry>(channels.slice(i, i + BATCH).map((c) => `c|${c}`));
        for (const [k, e] of got) if (e.uploads) out[k.slice(2)] = e.uploads;
      }
      return json({ uploads: out });
    }
    return json({ error: 'not found' }, 404);
  }
}

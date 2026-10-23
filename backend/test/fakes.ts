/** In-memory stand-ins for Durable Object storage, namespaces, R2 and the rate limiter. */
import type { ObjectState, Storage } from '../src/objects';
import type { Bucket, Env, ObjectNamespace, RateLimiter } from '../src/app';
import { Aggregator, KeyStore, SpentTokens, UploadPool } from '../src/objects';

export class FakeStorage implements Storage {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(keyOrKeys: string | string[]): Promise<any> {
    if (Array.isArray(keyOrKeys)) {
      const m = new Map<string, T>();
      for (const k of keyOrKeys) if (this.data.has(k)) m.set(k, structuredClone(this.data.get(k)) as T);
      return m;
    }
    return structuredClone(this.data.get(keyOrKeys)) as T | undefined;
  }
  async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    if (typeof keyOrEntries === 'string') this.data.set(keyOrEntries, structuredClone(value));
    else for (const [k, v] of Object.entries(keyOrEntries)) this.data.set(k, structuredClone(v));
  }
  async delete(keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.data.delete(k)) n++;
    return n;
  }
  async list<T>({ prefix = '', start, limit = Infinity }: { prefix?: string; start?: string; limit?: number }) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix) && (!start || k >= start)).sort();
    return new Map(keys.slice(0, limit).map((k) => [k, structuredClone(this.data.get(k)) as T]));
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(t: number) {
    this.alarm = t;
  }
}

export function fakeState(): ObjectState & { storage: FakeStorage } {
  return { storage: new FakeStorage(), blockConcurrencyWhile: (fn) => fn() };
}

type Obj = { fetch(r: Request): Promise<Response> };

export class FakeNamespace<T extends Obj> implements ObjectNamespace {
  instances = new Map<string, T>();
  constructor(private readonly make: () => T) {}
  idFromName(name: string) {
    return name;
  }
  get(id: unknown) {
    const name = String(id);
    if (!this.instances.has(name)) this.instances.set(name, this.make());
    const inst = this.instances.get(name)!;
    return { fetch: (input: string, init?: RequestInit) => inst.fetch(new Request(input, init)) };
  }
}

export class FakeBucket implements Bucket {
  objects = new Map<string, string>();
  async get(key: string) {
    const v = this.objects.get(key);
    return v === undefined ? null : { body: v };
  }
  async put(key: string, value: string) {
    this.objects.set(key, value);
  }
}

export interface FakeEnv extends Env {
  KEYS: FakeNamespace<KeyStore>;
  SPENT: FakeNamespace<SpentTokens>;
  AGG: FakeNamespace<Aggregator>;
  POOL: FakeNamespace<UploadPool>;
  PUBLIC: FakeBucket;
}

export function fakeEnv(
  overrides: Partial<Pick<Env, 'TOKEN_LIMITER' | 'YOUTUBE_API_KEY' | 'MIN_CONTRIBUTORS' | 'DP_EPSILON' | 'ACTIVATION_UPLOADS' | 'PUBLISHING' | 'BLOCKLIST'>> = {},
): FakeEnv {
  return {
    KEYS: new FakeNamespace(() => new KeyStore(fakeState())),
    SPENT: new FakeNamespace(() => new SpentTokens(fakeState())),
    AGG: new FakeNamespace(() => new Aggregator(fakeState())),
    POOL: new FakeNamespace(() => new UploadPool(fakeState())),
    PUBLIC: new FakeBucket(),
    MIN_CONTRIBUTORS: '3',
    DP_EPSILON: '1000', // tiny noise so tests can assert counts
    NOISE_SECRET: 'test-secret',
    ACTIVATION_UPLOADS: '1', // tests publish from a handful of uploads; production waits for 160
    ...overrides,
  };
}

export function allowAll(): RateLimiter {
  return { limit: async () => ({ success: true }) };
}

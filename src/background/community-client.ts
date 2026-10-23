/**
 * Network side of "Enhanced discoverability". Every request goes only to the configured backend,
 * carries no cookies, no identifier and no extension-specific headers, and uploads are each
 * authorised by a fresh anonymous token.
 */
import { blind, decodeInt, encodeInt, finalize, toBase64Url } from '../shared/community/blindrsa';
import {
  NONCE_BYTES,
  type ChannelPair,
  type GraphShard,
  type KeyResponse,
  type Token,
  type TrendingFile,
  type WatchedEvent,
} from '../shared/community/protocol';
import { tokenMessage } from '../shared/community/token-message';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class CommunityError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class CommunityClient {
  constructor(
    private readonly base: string,
    private readonly fetchFn: Fetch = (i, init) => fetch(i, init),
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T | null> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        ...init,
        credentials: 'omit',
        cache: init?.method === 'POST' ? 'no-store' : 'default',
        referrerPolicy: 'no-referrer',
        headers: init?.body ? { 'content-type': 'application/json' } : undefined,
      });
    } catch (err) {
      throw new CommunityError(`network error: ${String(err)}`, 0);
    }
    if (res.status === 404 && (!init || init.method !== 'POST')) return null;
    if (!res.ok) throw new CommunityError(`${path} returned ${res.status}`, res.status);
    return (await res.json()) as T;
  }

  /** Today's tokens: blinded locally, signed by the server, unblinded and checked locally. */
  async getTokens(count: number): Promise<Token[]> {
    const key = await this.request<KeyResponse>('/v1/keys');
    if (!key) throw new CommunityError('no key', 404);
    const pub = { n: decodeInt(key.n), e: decodeInt(key.e) };
    const nonces = Array.from({ length: count }, () => crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
    const blinded = await Promise.all(nonces.map((n) => blind(tokenMessage(key.epoch, n), pub)));
    const res = await this.request<{ signatures: string[] }>('/v1/tokens', {
      method: 'POST',
      body: JSON.stringify({ epoch: key.epoch, blinded: blinded.map((b) => encodeInt(b.blinded, pub.n)) }),
    });
    if (!res || res.signatures.length !== count) throw new CommunityError('bad token response', 502);
    return Promise.all(
      res.signatures.map(async (s, i) => ({
        epoch: key.epoch,
        nonce: toBase64Url(nonces[i]!),
        sig: encodeInt(await finalize(tokenMessage(key.epoch, nonces[i]!), decodeInt(s), blinded[i]!.r, pub), pub.n),
      })),
    );
  }

  async sendEvents(token: Token, events: WatchedEvent[]): Promise<void> {
    await this.request('/v1/events', { method: 'POST', body: JSON.stringify({ token, events }) });
  }

  async sendPairs(token: Token, pairs: ChannelPair[]): Promise<void> {
    await this.request('/v1/pairs', { method: 'POST', body: JSON.stringify({ token, pairs }) });
  }

  /** Published trending for a region (two-letter code) or "global"; null until published. */
  getTrending(region: string): Promise<TrendingFile | null> {
    return this.request<TrendingFile>(`/v1/trending/${region}.json`);
  }

  getGraphShard(shard: number): Promise<GraphShard | null> {
    return this.request<GraphShard>(`/v1/graph/${shard}.json`);
  }
}

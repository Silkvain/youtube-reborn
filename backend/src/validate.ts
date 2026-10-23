/** Strict validation of everything clients send. Anything unexpected is rejected, never stored. */
import {
  MAX_EVENTS_PER_SUBMISSION,
  MAX_PAIRS_PER_SUBMISSION,
  MAX_TOKENS_PER_REQUEST,
  NONCE_BYTES,
  isChannelId,
  isDay,
  isVideoId,
  utcDay,
  type ChannelPair,
  type Token,
  type TokenRequest,
  type WatchedEvent,
} from '../../src/shared/community/protocol';

export class BadRequest extends Error {}

const DAY_MS = 86_400_000;

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BadRequest(`${what} must be an object`);
  return v as Record<string, unknown>;
}

const b64u = (s: unknown, maxLen: number): s is string =>
  typeof s === 'string' && s.length > 0 && s.length <= maxLen && /^[A-Za-z0-9_-]+$/.test(s);

/** Epochs a token may belong to: today, or yesterday for uploads that straddle midnight UTC. */
export function acceptedEpochs(now: number): string[] {
  return [utcDay(now), utcDay(now - DAY_MS)];
}

export function parseTokenRequest(body: unknown, now: number): TokenRequest {
  const o = obj(body, 'body');
  if (o.epoch !== utcDay(now)) throw new BadRequest('tokens are only issued for today');
  if (!Array.isArray(o.blinded) || o.blinded.length < 1 || o.blinded.length > MAX_TOKENS_PER_REQUEST) {
    throw new BadRequest(`blinded must hold 1–${MAX_TOKENS_PER_REQUEST} values`);
  }
  if (!o.blinded.every((b) => b64u(b, 400))) throw new BadRequest('bad blinded value');
  return { epoch: o.epoch, blinded: o.blinded as string[] };
}

export function parseToken(v: unknown, now: number): Token {
  const t = obj(v, 'token');
  if (!acceptedEpochs(now).includes(t.epoch as string)) throw new BadRequest('token expired');
  // NONCE_BYTES of base64url is 43 characters.
  if (!b64u(t.nonce, Math.ceil((NONCE_BYTES * 4) / 3))) throw new BadRequest('bad nonce');
  if (!b64u(t.sig, 400)) throw new BadRequest('bad signature');
  return { epoch: t.epoch as string, nonce: t.nonce as string, sig: t.sig as string };
}

export function parseEvents(v: unknown, now: number): WatchedEvent[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_EVENTS_PER_SUBMISSION) {
    throw new BadRequest(`events must hold 1–${MAX_EVENTS_PER_SUBMISSION} items`);
  }
  const days = new Set([utcDay(now), utcDay(now - DAY_MS), utcDay(now - 2 * DAY_MS)]);
  const seen = new Set<string>();
  return v.map((raw) => {
    const e = obj(raw, 'event');
    if (!isVideoId(e.v) || !isChannelId(e.c)) throw new BadRequest('bad video or channel id');
    if (!isDay(e.d) || !days.has(e.d)) throw new BadRequest('events must be from the last 3 days');
    if (e.q !== 0 && e.q !== 1 && e.q !== 2 && e.q !== 3) throw new BadRequest('bad completion bucket');
    // One count per video per submission: a person can't inflate a video by repeating it.
    if (seen.has(e.v)) throw new BadRequest('duplicate video');
    seen.add(e.v);
    return { v: e.v, c: e.c, d: e.d, q: e.q };
  });
}

export function parsePairs(v: unknown): ChannelPair[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_PAIRS_PER_SUBMISSION) {
    throw new BadRequest(`pairs must hold 1–${MAX_PAIRS_PER_SUBMISSION} items`);
  }
  const seen = new Set<string>();
  return v.map((raw) => {
    if (!Array.isArray(raw) || raw.length !== 3) throw new BadRequest('bad pair');
    const [a, b, w] = raw;
    if (!isChannelId(a) || !isChannelId(b) || !(a < b)) throw new BadRequest('pair must be two channel ids, sorted');
    if (w !== 1 && w !== 2 && w !== 3) throw new BadRequest('bad pair weight');
    const key = `${a}|${b}`;
    if (seen.has(key)) throw new BadRequest('duplicate pair');
    seen.add(key);
    return [a, b, w];
  });
}

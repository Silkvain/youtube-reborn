import { MAX_CONSECUTIVE_FAILURES, MAX_REQUEST_GAP_MS, MIN_REQUEST_GAP_MS, type Purpose } from '../shared/constants';

export interface LimiterState {
  lastRequestAt: number;
  consecutiveFailures: number;
  backoffUntil: number;
  /** Local date (YYYY-MM-DD) on which crawling was stopped after repeated failures. */
  stoppedDay?: string;
  counter: { day: string; count: number };
  /** Requests sent today, per purpose (absent in state saved before budgets existed: zeros). */
  spent?: Partial<Record<Purpose, number>>;
}

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 60 * 60_000;

export function dayKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function initialState(now: number): LimiterState {
  return { lastRequestAt: 0, consecutiveFailures: 0, backoffUntil: 0, counter: { day: dayKey(now), count: 0 } };
}

/** Roll the daily counter (and clear a "stopped" flag) when the day changes. */
export function rollDay(s: LimiterState, now: number): LimiterState {
  const today = dayKey(now);
  if (s.counter.day === today) return s;
  return { ...s, counter: { day: today, count: 0 }, spent: {}, stoppedDay: undefined, consecutiveFailures: 0 };
}

/** Requests spent today on `purpose`. */
export function spentOn(s: LimiterState, purpose: Purpose, now: number): number {
  return s.counter.day === dayKey(now) ? (s.spent?.[purpose] ?? 0) : 0;
}

export type Decision =
  | { ok: true; waitMs: number }
  | { ok: false; reason: 'dailyCap' | 'budget' | 'stoppedForDay' | 'backoff'; retryAt?: number };

/**
 * Purposes held only to their own budget, not the overall daily cap. The subscriptions feed
 * loads because the user opened Home and is paced like YouTube's own page; the cap exists to
 * keep background crawling gentle, and a heavy crawl day must never leave Home without new uploads.
 */
export const EXEMPT_FROM_DAILY_CAP: ReadonlySet<Purpose> = new Set<Purpose>(['subs']);

/**
 * Whether another request may be sent, and how long to wait first. The gap between requests
 * is MIN..MAX_REQUEST_GAP_MS, chosen by `jitter` (0..1). With `budget`, the request is also
 * held to that purpose's daily allowance.
 */
export function decide(
  s: LimiterState,
  now: number,
  dailyCap: number,
  jitter: number,
  budget?: { purpose: Purpose; cap: number },
): Decision {
  const today = dayKey(now);
  if (s.stoppedDay === today) return { ok: false, reason: 'stoppedForDay' };
  const capped = !(budget && EXEMPT_FROM_DAILY_CAP.has(budget.purpose));
  if (capped && s.counter.day === today && s.counter.count >= dailyCap) return { ok: false, reason: 'dailyCap' };
  if (budget && spentOn(s, budget.purpose, now) >= budget.cap) return { ok: false, reason: 'budget' };
  if (now < s.backoffUntil) return { ok: false, reason: 'backoff', retryAt: s.backoffUntil };
  const gap = MIN_REQUEST_GAP_MS + (MAX_REQUEST_GAP_MS - MIN_REQUEST_GAP_MS) * Math.min(1, Math.max(0, jitter));
  return { ok: true, waitMs: Math.max(0, s.lastRequestAt + gap - now) };
}

/**
 * Call right before a request goes out: counts it against the daily cap (and its purpose's
 * budget). `spaced: false` is for subscriptions-feed pages, which the content script paces itself
 * and which shouldn't delay the next crawl request.
 */
export function recordSent(s: LimiterState, now: number, purpose?: Purpose, spaced = true): LimiterState {
  const rolled = rollDay(s, now);
  const spent = { ...rolled.spent };
  if (purpose) spent[purpose] = (spent[purpose] ?? 0) + 1;
  return {
    ...rolled,
    lastRequestAt: spaced ? now : rolled.lastRequestAt,
    counter: { ...rolled.counter, count: rolled.counter.count + 1 },
    spent,
  };
}

export function recordSuccess(s: LimiterState): LimiterState {
  return { ...s, consecutiveFailures: 0, backoffUntil: 0 };
}

/** Exponential backoff; after MAX_CONSECUTIVE_FAILURES in a row, stop for the rest of the day. */
export function recordFailure(s: LimiterState, now: number): LimiterState {
  const failures = s.consecutiveFailures + 1;
  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    return { ...s, consecutiveFailures: failures, stoppedDay: dayKey(now), backoffUntil: 0 };
  }
  const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
  return { ...s, consecutiveFailures: failures, backoffUntil: now + delay };
}

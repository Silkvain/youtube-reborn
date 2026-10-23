import { DEFAULT_DAILY_CAP, MAX_CONSECUTIVE_FAILURES, MAX_REQUEST_GAP_MS, MIN_REQUEST_GAP_MS } from '../src/shared/constants';
import { BACKOFF_BASE_MS, dayKey, decide, initialState, recordFailure, recordSent, recordSuccess, rollDay, spentOn } from '../src/background/ratelimit';

const T0 = new Date(2026, 9, 15, 10, 0, 0).getTime();

describe('rate limiter', () => {
  it('spaces requests 3–5 s apart', () => {
    let s = recordSent(initialState(T0), T0);
    const d0 = decide(s, T0, DEFAULT_DAILY_CAP, 0);
    const d1 = decide(s, T0, DEFAULT_DAILY_CAP, 1);
    expect(d0).toEqual({ ok: true, waitMs: MIN_REQUEST_GAP_MS });
    expect(d1).toEqual({ ok: true, waitMs: MAX_REQUEST_GAP_MS });
    s = recordSent(s, T0 + 10_000);
    expect(decide(s, T0 + 20_000, DEFAULT_DAILY_CAP, 0.5)).toEqual({ ok: true, waitMs: 0 });
  });

  it('enforces the daily cap and resets the next day', () => {
    let s = initialState(T0);
    for (let i = 0; i < 3; i++) s = recordSent(s, T0 + i * 10_000);
    expect(s.counter.count).toBe(3);
    expect(decide(s, T0 + 60_000, 3, 0)).toEqual({ ok: false, reason: 'dailyCap' });
    expect(decide(s, T0 + 60_000, 3, 0, { purpose: 'discovery', cap: 100 })).toEqual({ ok: false, reason: 'dailyCap' });
    // The subscriptions feed only answers to its own budget: Home still loads new uploads.
    expect(decide(s, T0 + 60_000, 3, 0, { purpose: 'subs', cap: 60 }).ok).toBe(true);
    const subsSpent = { ...s, spent: { subs: 60 } };
    expect(decide(subsSpent, T0 + 60_000, 3, 0, { purpose: 'subs', cap: 60 })).toEqual({ ok: false, reason: 'budget' });
    const tomorrow = T0 + 24 * 3_600_000;
    expect(decide(rollDay(s, tomorrow), tomorrow, 3, 0).ok).toBe(true);
  });

  it('backs off exponentially and stops for the day after repeated failures', () => {
    let s = initialState(T0);
    s = recordFailure(s, T0);
    expect(s.backoffUntil).toBe(T0 + BACKOFF_BASE_MS);
    expect(decide(s, T0 + 1000, DEFAULT_DAILY_CAP, 0)).toMatchObject({ ok: false, reason: 'backoff' });
    s = recordFailure(s, T0);
    expect(s.backoffUntil).toBe(T0 + 2 * BACKOFF_BASE_MS);
    for (let i = 2; i < MAX_CONSECUTIVE_FAILURES; i++) s = recordFailure(s, T0);
    expect(decide(s, T0 + 3_600_000, DEFAULT_DAILY_CAP, 0)).toEqual({ ok: false, reason: 'stoppedForDay' });
    const tomorrow = T0 + 24 * 3_600_000;
    expect(decide(rollDay(s, tomorrow), tomorrow, DEFAULT_DAILY_CAP, 0).ok).toBe(true);
  });

  it('success clears failures', () => {
    const s = recordSuccess(recordFailure(initialState(T0), T0));
    expect(s.consecutiveFailures).toBe(0);
    expect(decide(s, T0, DEFAULT_DAILY_CAP, 0).ok).toBe(true);
  });
});

describe('per-purpose budgets', () => {
  it('holds each purpose to its own allowance and resets daily', () => {
    let s = initialState(T0);
    for (let i = 0; i < 3; i++) s = recordSent(s, T0 + i * 10_000, 'top');
    expect(spentOn(s, 'top', T0)).toBe(3);
    expect(decide(s, T0 + 60_000, DEFAULT_DAILY_CAP, 0, { purpose: 'top', cap: 3 })).toEqual({ ok: false, reason: 'budget' });
    expect(decide(s, T0 + 60_000, DEFAULT_DAILY_CAP, 0, { purpose: 'discovery', cap: 3 }).ok).toBe(true);
    const tomorrow = T0 + 24 * 3_600_000;
    expect(spentOn(rollDay(s, tomorrow), 'top', tomorrow)).toBe(0);
  });

  it('unspaced requests (content-script feed pages) count but do not delay the crawler', () => {
    const s = recordSent(initialState(T0), T0, 'subs', false);
    expect(s.counter.count).toBe(1);
    expect(decide(s, T0, DEFAULT_DAILY_CAP, 0)).toEqual({ ok: true, waitMs: 0 });
  });

  it('reads limiter state saved before budgets existed', () => {
    const legacy = { lastRequestAt: 0, consecutiveFailures: 0, backoffUntil: 0, counter: { day: dayKey(T0), count: 7 } };
    expect(spentOn(legacy, 'discovery', T0)).toBe(0);
    expect(recordSent(legacy, T0, 'discovery').spent).toEqual({ discovery: 1 });
  });
});

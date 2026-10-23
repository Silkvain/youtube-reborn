import { DAY_MS } from '../../shared/constants';
import { scoreEdges } from './graph';
import type { SignalSource } from './types';

export const MENTION_HALF_LIFE_DAYS = 90;

/** Recency decay: a mention loses half its value every MENTION_HALF_LIFE_DAYS. */
export function mentionDecay(lastSeenAt: number, now: number): number {
  const ageDays = Math.max(0, (now - lastSeenAt) / DAY_MS);
  return Math.pow(0.5, ageDays / MENTION_HALF_LIFE_DAYS);
}

/** Repeated mentions count, with diminishing returns: 1 → 0.5, 2 → 0.75, 3+ → ~1. */
export function mentionCountFactor(count: number): number {
  return 1 - Math.pow(0.5, Math.max(1, count));
}

/** Candidates mentioned in the descriptions of subscriptions' recent uploads, decayed by age. */
export const mentionsSource: SignalSource = {
  id: 'mentions',
  weight: 0.8,
  async score(ctx) {
    return scoreEdges(ctx, 'mention', (e) => mentionCountFactor(e.count) * mentionDecay(e.lastSeenAt, ctx.now), 'mentions').scores;
  },
  async explain(ctx) {
    return scoreEdges(ctx, 'mention', (e) => mentionCountFactor(e.count) * mentionDecay(e.lastSeenAt, ctx.now), 'mentions').via;
  },
};

import type { ChannelId } from '../../shared/types';
import { keepBest, saturate, seedsOf, type RankContext, type SignalSource, type Via } from './types';

/**
 * Link strength of a neighbour: the popularity-normalised strength the server publishes (third
 * element) when present, else the raw co-watch count (older servers).
 */
function strength(entry: [ChannelId, number, number?]): number {
  return entry[2] ?? entry[1];
}

function score(ctx: RankContext): { scores: Map<ChannelId, number>; via: Map<ChannelId, Via> } {
  const raw = new Map<ChannelId, number>();
  const via = new Map<ChannelId, Via>();
  if (!ctx.community?.size) return { scores: raw, via };
  for (const [seed, w] of seedsOf(ctx)) {
    const list = ctx.community.get(seed);
    if (!list?.length) continue;
    const top = Math.max(...list.map(strength));
    if (!(top > 0)) continue;
    for (const entry of list) {
      const c = (w * strength(entry)) / top;
      raw.set(entry[0], (raw.get(entry[0]) ?? 0) + c);
      keepBest(via, entry[0], { kind: 'community', seed, weight: c });
    }
  }
  const scores = new Map<ChannelId, number>();
  for (const [id, r] of raw) scores.set(id, saturate(r));
  return { scores, via };
}

/**
 * "People who watch your channels also watch…": the community co-watch graph from Enhanced
 * discoverability. Each seed vouches for its neighbours in proportion to how strongly they're
 * linked (relative to its strongest neighbour) and how much the user watches it.
 * Returns nothing when the feature is off or no graph has been published yet.
 */
export const communitySource: SignalSource = {
  id: 'community',
  weight: 1,
  async score(ctx) {
    return score(ctx).scores;
  },
  async explain(ctx) {
    return score(ctx).via;
  },
};

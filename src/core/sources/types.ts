import type { ChannelId, Edge } from '../../shared/types';
import { subscriptionWeight } from '../engagement';

export interface RankContext {
  now: number;
  subscribed: Set<ChannelId>;
  edges: Edge[];
  /** Engagement 0..1 per channel from watch logs. */
  engagement: Map<ChannelId, number>;
  /**
   * Where discovery starts, with a weight each: subscriptions plus channels the user watches a lot
   * without subscribing (see seedWeights). Defaults to the subscriptions alone.
   */
  seeds?: Map<ChannelId, number>;
  /** Community co-watch graph (Enhanced discoverability): channel → [neighbour, count, strength?][]. */
  community?: Map<ChannelId, [ChannelId, number, number?][]>;
}

/** The seeds to start from: `ctx.seeds`, or every subscription weighted by engagement. */
export function seedsOf(ctx: RankContext): Map<ChannelId, number> {
  return ctx.seeds ?? new Map([...ctx.subscribed].map((id) => [id, subscriptionWeight(ctx.engagement.get(id))]));
}

/** Why a candidate was found: the seed that contributed most, and the channel in between if two hops. */
export interface Via {
  /** Source id: 'featured', 'mentions', 'community'. */
  kind: string;
  seed: ChannelId;
  /** Second hop: the first-hop candidate that links to this one. */
  through?: ChannelId;
  /** That seed's raw contribution, comparable across candidates of one source. */
  weight: number;
}

/** A pluggable signal. New signals (embeddings, co-subscription graphs) implement this; the ranker doesn't change. */
export interface SignalSource {
  id: string;
  /** Default weight in the ranker. */
  weight: number;
  /** Score in 0..1 per candidate channel. */
  score(ctx: RankContext): Promise<Map<ChannelId, number>>;
  /** For each candidate, the seed that contributed most (for explanations and per-seed limits). */
  explain?(ctx: RankContext): Promise<Map<ChannelId, Via>>;
}

/** Maps an unbounded non-negative sum to 0..1; raw = 1 gives ~0.63. */
export function saturate(raw: number): number {
  return 1 - Math.exp(-raw);
}

/** Keep the strongest contribution per candidate. */
export function keepBest(best: Map<ChannelId, Via>, candidate: ChannelId, via: Via): void {
  const cur = best.get(candidate);
  if (!cur || via.weight > cur.weight) best.set(candidate, via);
}

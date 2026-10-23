import type { ChannelId, Edge, EdgeType } from '../../shared/types';
import { keepBest, saturate, seedsOf, type RankContext, type Via } from './types';

/**
 * Weight of a featured link to a sister channel (dubs, second channels). They are real channels,
 * but rarely the "similar creator" discovery this is for.
 */
export const SIBLING_WEIGHT = 0.15;

function normaliseTitle(t: string): string {
  return t.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
}

/** True when one channel title contains the other, e.g. "Veritasium" / "Veritasium en Français". */
export function isSiblingTitle(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const [x, y] = [normaliseTitle(a), normaliseTitle(b)];
  if (x.length < 4 || y.length < 4) return false;
  return x.includes(y) || y.includes(x);
}

/** Weight of an edge whose source is itself a discovery candidate (two hops from the user). */
export const SECOND_HOP_DAMPING = 0.25;

/**
 * Shared scoring for edge-based sources. First hop: sum of seed weights of the seeds (subscriptions
 * and much-watched channels) pointing at a candidate. Second hop: edges from first-hop candidates,
 * damped. `edgeValue` lets a source scale each edge (e.g. recency decay for mentions). Also
 * returns, per candidate, the seed (and in-between channel) that contributed most.
 */
export function scoreEdges(
  ctx: RankContext,
  type: EdgeType,
  edgeValue: (e: Edge) => number,
  kind: string = type,
): { scores: Map<ChannelId, number>; via: Map<ChannelId, Via> } {
  const seeds = seedsOf(ctx);
  const edges = ctx.edges.filter((e) => e.type === type);
  const firstHop = new Map<ChannelId, number>();
  const via = new Map<ChannelId, Via>();
  for (const e of edges) {
    const seedWeight = seeds.get(e.fromChannelId);
    if (seedWeight === undefined) continue;
    const w = seedWeight * edgeValue(e);
    firstHop.set(e.toChannelId, (firstHop.get(e.toChannelId) ?? 0) + w);
    keepBest(via, e.toChannelId, { kind, seed: e.fromChannelId, weight: w });
  }
  const raw = new Map(firstHop);
  for (const e of edges) {
    const hop = firstHop.get(e.fromChannelId);
    if (hop === undefined || seeds.has(e.fromChannelId)) continue;
    const w = SECOND_HOP_DAMPING * saturate(hop) * edgeValue(e);
    raw.set(e.toChannelId, (raw.get(e.toChannelId) ?? 0) + w);
    const from = via.get(e.fromChannelId);
    if (from && !firstHop.has(e.toChannelId)) keepBest(via, e.toChannelId, { kind, seed: from.seed, through: e.fromChannelId, weight: w });
  }
  const scores = new Map<ChannelId, number>();
  for (const [id, r] of raw) if (r > 0) scores.set(id, saturate(r));
  for (const id of via.keys()) if (!scores.has(id)) via.delete(id);
  return { scores, via };
}

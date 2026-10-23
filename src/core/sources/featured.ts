import { SIBLING_WEIGHT, scoreEdges } from './graph';
import type { SignalSource } from './types';

/** Candidates featured on the channel pages of subscriptions, weighted by how much the user watches those subscriptions. */
export const featuredSource: SignalSource = {
  id: 'featured',
  weight: 1,
  async score(ctx) {
    return scoreEdges(ctx, 'featured', (e) => (e.sibling ? SIBLING_WEIGHT : 1)).scores;
  },
  async explain(ctx) {
    return scoreEdges(ctx, 'featured', (e) => (e.sibling ? SIBLING_WEIGHT : 1)).via;
  },
};

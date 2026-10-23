import { communitySource } from './community';
import { featuredSource } from './featured';
import { mentionsSource } from './mentions';
import type { SignalSource } from './types';

/** Active signal sources. v2 embedding similarity slots in here. */
export function defaultSources(): SignalSource[] {
  return [featuredSource, mentionsSource, communitySource];
}

export type { RankContext, SignalSource } from './types';

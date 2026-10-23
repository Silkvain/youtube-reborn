/**
 * Crawl jobs. The service worker plans them and keeps the rate limiter; InnerTube jobs are
 * leased to an open YouTube tab, which sends them from the page's own origin (no header
 * rewriting needed). Only RSS, which isn't InnerTube, runs in the service worker.
 */
import type { ChannelPage, NewsStory } from '../content/innertube';
import type { Purpose } from './constants';
import type { ChannelId, TrendingVideo, Video } from './types';

export type Job =
  /** Top row: one "today, by views" search. */
  | { kind: 'trending'; query: string }
  /** Top row: YouTube's News hub for the user's region. */
  | { kind: 'news' }
  /** Featured channels from the channel's Home tab. */
  | { kind: 'channel'; id: ChannelId }
  /** Recent uploads of a discovery candidate from its Videos tab (durations, views, age). */
  | { kind: 'videos'; id: ChannelId }
  /** Resolve an @handle or legacy URL found in an RSS description. */
  | { kind: 'resolve'; ref: string }
  /** RSS (descriptions -> mentions) for one of the most-watched subscriptions. */
  | { kind: 'rss'; id: ChannelId }
  /** Details of one community-trending video (title, channel, length, views) from YouTube. */
  | { kind: 'video'; id: string };

export type JobResult =
  | { kind: 'trending'; videos: TrendingVideo[] }
  | { kind: 'news'; stories: NewsStory[] }
  | { kind: 'channel'; page: ChannelPage }
  | { kind: 'videos'; videos: Video[] }
  | { kind: 'resolve'; channelId: ChannelId | null }
  | { kind: 'video'; video: TrendingVideo | null };

/** Where a job runs. */
export type Runner = 'tab' | 'worker';

export function jobPurpose(job: Job): Purpose {
  switch (job.kind) {
    case 'trending':
    case 'news':
    case 'video':
      return 'top';
    case 'channel':
    case 'videos':
      return 'discovery';
    case 'resolve':
    case 'rss':
      return 'mentions';
  }
}

export function jobRunner(job: Job): Runner {
  return job.kind === 'rss' ? 'worker' : 'tab';
}

export function jobKey(job: Job): string {
  if (job.kind === 'resolve') return `r:${job.ref}`;
  if (job.kind === 'trending') return `t:${job.query}`;
  if (job.kind === 'news') return 'news';
  return `${job.kind}:${job.id}`;
}

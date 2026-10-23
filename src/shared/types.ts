/** YouTube channel ID ("UC..."). Everything is keyed by IDs, never by handle or name. */
export type ChannelId = string;
export type VideoId = string;

export interface Channel {
  id: ChannelId;
  title: string;
  handle?: string;
  thumbnailUrl?: string;
  isSubscribed: boolean;
  /** Last time featured channels were read for this channel (crawled, or seen on a visited channel page). */
  lastCrawledAt?: number;
  /**
   * Last time recent uploads were fetched for this channel: the Videos tab for discovery
   * candidates, weekly RSS (for description mentions) for the most-watched subscriptions.
   * Subscription uploads otherwise come from the subscriptions feed and don't set this.
   */
  uploadsFetchedAt?: number;
  /**
   * Last time the channel's Videos tab was read (durations, views, ages). Separate from
   * uploadsFetchedAt, which RSS also sets: an RSS fetch has no durations and must not count as one.
   */
  videosTabFetchedAt?: number;
}

export type EdgeType = 'featured' | 'mention';

export interface Edge {
  fromChannelId: ChannelId;
  toChannelId: ChannelId;
  type: EdgeType;
  firstSeenAt: number;
  /** For mentions: publish time of the newest video that mentions the target. */
  lastSeenAt: number;
  count: number;
  /** Target looks like a sister channel of the source (e.g. "Veritasium en Français"); weighted down. */
  sibling?: boolean;
  /** Mentions: IDs of the videos whose descriptions mention the target, so re-reads don't double count. */
  videos?: VideoId[];
}

export interface Video {
  id: VideoId;
  channelId: ChannelId;
  title: string;
  publishedAt: number;
  thumbnailUrl: string;
  durationSec?: number;
  isShort?: boolean;
  /** View count as of the last uploads refresh. */
  viewCount?: number;
  /** Stored from YouTube's subscriptions feed; incremental syncs stop when they reach these. */
  inSubsFeed?: boolean;
}

/** A most-viewed-this-week video from search, with the channel title it was listed under. */
export interface TrendingVideo extends Video {
  channelTitle: string;
  viewCount: number;
  /** The channel has YouTube's verified badge. */
  verified?: boolean;
}

/** Results of one "today, by views" search, cached by the crawler. */
export interface TrendingQueryResult {
  fetchedAt: number;
  /** Which search filter produced it; results without "today" (the old "this week") are re-searched. */
  filter?: 'today';
  /** Today's results plus the last few days' (the backup pool), newest view counts kept. */
  videos: TrendingVideo[];
}

export interface WatchEvent {
  /** `${videoId}:${startedAt}` so checkpoints of the same session overwrite each other. */
  id: string;
  videoId: VideoId;
  channelId: ChannelId;
  watchedSec: number;
  durationSec: number;
  completion: number;
  abandoned: boolean;
  at: number;
}

export type FeedbackKind = 'more' | 'notInterested';

export interface Feedback {
  channelId: ChannelId;
  kind: FeedbackKind;
  at: number;
}

/** "Not interested" in one video only; the channel is unaffected. */
export interface VideoFeedback {
  videoId: VideoId;
  at: number;
}

/** A channel reference found in a description that still needs resolving to an ID. */
export interface HandleRecord {
  /** Normalised reference: "@handle", "/c/name" or "/user/name" (lowercase). */
  ref: string;
  channelId: ChannelId | null;
  resolvedAt?: number;
  attempts: number;
  /** Channels whose uploads mention this ref, with the newest mention time and video count. */
  mentionedBy: Record<ChannelId, { lastSeenAt: number; count: number }>;
}

export interface FeedItem {
  videoId: VideoId;
  title: string;
  channelId: ChannelId;
  channelTitle: string;
  /** The channel's avatar, when we know it (YouTube's image host only). */
  channelAvatarUrl?: string;
  thumbnailUrl: string;
  publishedAt: number;
  durationSec?: number;
  viewCount?: number;
  discover: boolean;
  /** Short explanation for discovery items, e.g. "Featured by Veritasium". */
  reason?: string;
  /** The channel the explanation names (linked on the card). */
  reasonChannelId?: ChannelId;
  /** Discover items: the signal source that found it (for on-device measurement). */
  source?: string;
}

/** Why a discovery candidate is shown: text, the channel it names, and the source behind it. */
export interface Reason {
  /** Absent when the channels involved have no known title yet. */
  text?: string;
  channelId?: ChannelId;
  source?: string;
}

export type FeedStatus = 'ok' | 'loggedOut' | 'syncing' | 'empty';

export interface FeedResponse {
  status: FeedStatus;
  /** Most-viewed videos today, shown above everything else (empty when turned off). */
  trending: FeedItem[];
  /** The top row is on but its first searches haven't come back yet. */
  trendingPending?: boolean;
  items: FeedItem[];
  /** True while the crawler has not produced discovery candidates yet. */
  coldStart: boolean;
}

/** Minimal client context needed for public InnerTube calls, captured from the page's ytcfg. */
export interface YtClientConfig {
  apiKey?: string;
  clientName: string;
  clientNameId: number;
  clientVersion: string;
  hl: string;
  gl: string;
  loggedIn: boolean;
  sessionIndex?: string;
  delegatedSessionId?: string;
  visitorData?: string;
}

/** Video IDs and their channels from one page of the user's watch history (engagement seed). */
export interface HistorySeed {
  fetchedAt: number;
  /** Watched videos per channel, from the most recent history pages. Empty if unavailable. */
  counts: Record<ChannelId, number>;
  /** False when history could not be read (paused, logged out, or a parser break). */
  ok: boolean;
}

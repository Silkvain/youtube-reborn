import type { ArchivePage } from '../core/ranker';
import type { ChannelPage, FeedVideo, WatchPageInfo } from '../content/innertube';
import type { Purpose } from './constants';
import type { Job, JobResult } from './jobs';
import type { ChannelId, FeedResponse, FeedbackKind, WatchEvent } from './types';

export interface SubscribedChannel {
  id: ChannelId;
  title: string;
  handle?: string;
  thumbnailUrl?: string;
}

export interface Stats {
  enabled: boolean;
  subscriptions: number;
  candidates: number;
  edges: number;
  videos: number;
  watchEvents: number;
  requestsToday: number;
  dailyCap: number;
  /** Requests sent today, per purpose, and each purpose's daily budget. */
  spent: Record<Purpose, number>;
  budgets: Record<Purpose, number>;
  lastSubsSync?: number;
  /** Last successful read of the subscriptions feed. */
  lastFeedSync?: number;
  loggedOut: boolean;
  stoppedForToday: boolean;
  /** One plain-English line on what the extension is doing and why, for the popup. */
  status: string;
  /** Enhanced discoverability, when built in. */
  community?: {
    /** The user agreed to share (their choice; switching the extension off doesn't change it). */
    on: boolean;
    /** The extension is switched off, so sharing is paused. */
    paused?: boolean;
    lastOkAt?: number;
    failing: boolean;
    trendingVideos: number;
    graphChannels: number;
    /** The server is waiting for more people to share before it publishes anything. */
    dormant: boolean;
  };
  /** Discover, measured on this device: per source, cards seen, watched half-way, current tuning. */
  discover?: { source: string; shown: number; watched: number; tuning: number }[];
}

/** A page of the subscriptions feed as the content script read it. */
export interface FeedPageReport {
  loggedOut: boolean;
  videos: FeedVideo[];
  continuation: string | null;
}

export type LeaseResponse =
  | { job: Job }
  /** Nothing to send right now: ask again after this long. `stop`: the extension is off. */
  | { waitMs: number; stop?: boolean };

export type SyncStep = { request: Record<string, unknown>; waitMs: number } | { request: null };

/** Messages sent from content scripts / popup to the service worker. */
export type Request =
  /** The YouTube tab reports the region the user browses in (two letters, e.g. "GB"). */
  | { type: 'region'; gl: string; hl?: string }
  | { type: 'subs:claim' }
  | { type: 'subs:result'; channels: SubscribedChannel[]; requests?: number }
  | { type: 'subs:loggedOut' }
  | { type: 'subs:error'; message: string }
  /** Start a subscriptions-feed sync if one is due (Home mounted). */
  | { type: 'subsfeed:claim' }
  /** One fetched feed page; the answer says which page to fetch next, if any. */
  | { type: 'subsfeed:page'; page: FeedPageReport }
  | { type: 'subsfeed:error'; message: string }
  /** Scrolling the archive: the next older feed page to read, if any (counts against 'subs'). */
  | { type: 'subsfeed:deeper' }
  | { type: 'subsfeed:deeperPage'; page: FeedPageReport }
  /** The saved older-page token failed (e.g. expired): stop reading further back. */
  | { type: 'subsfeed:deeperFailed' }
  /** Whether the one-time watch-history seed should be read now. */
  | { type: 'history:claim' }
  | { type: 'history:result'; ok: boolean; counts: Record<ChannelId, number>; requests: number }
  /** A YouTube tab asks for the next InnerTube crawl job. */
  | { type: 'crawl:lease' }
  | { type: 'crawl:result'; job: Job; result?: JobResult; error?: { status: number; message: string } }
  /** Free data from a page the user opened. */
  | { type: 'page:watch'; watch: WatchPageInfo }
  | { type: 'page:channel'; page: ChannelPage }
  | { type: 'watch:event'; event: WatchEvent }
  /** `view`: this Home visit's random draw (a fresh mix per visit); absent = the plain ranked list. */
  | { type: 'feed:get'; view?: { seed: number; startedAt: number } }
  /** Feed cards that came on screen during this visit. */
  | { type: 'feed:impressions'; ids: string[]; view: { seed: number; startedAt: number }; discover?: Record<string, string> }
  /** Older subscription uploads below the main feed. `exclude`: video IDs already shown. */
  | { type: 'feed:more'; offset: number; limit: number; exclude: string[] }
  /** Channel-level feedback: "more like this", or "don't recommend this channel". */
  | { type: 'feedback'; channelId: ChannelId; kind: FeedbackKind }
  /** "Not interested in this video": hides only this video. */
  | { type: 'feedback:video'; videoId: string }
  /** Undo a hide (video or channel). */
  | { type: 'feedback:undo'; videoId?: string; channelId?: ChannelId }
  | { type: 'stats:get' }
  | { type: 'data:clear' };

export interface ResponseMap {
  region: void;
  'subs:claim': { due: boolean };
  'subs:result': void;
  'subs:loggedOut': void;
  'subs:error': void;
  'subsfeed:claim': SyncStep;
  'subsfeed:page': SyncStep;
  'subsfeed:deeper': { request: { continuation: string } | null };
  'subsfeed:deeperPage': { added: number; more: boolean };
  'subsfeed:deeperFailed': void;
  'subsfeed:error': void;
  'history:claim': { due: boolean };
  'history:result': void;
  'crawl:lease': LeaseResponse;
  'crawl:result': void;
  'page:watch': void;
  'page:channel': void;
  'watch:event': void;
  'feed:get': FeedResponse;
  'feed:impressions': void;
  'feed:more': ArchivePage;
  feedback: void;
  'feedback:video': void;
  'feedback:undo': void;
  'stats:get': Stats;
  'data:clear': void;
}

/** Broadcast from the service worker to YouTube tabs. */
export type Broadcast = { type: 'feed:updated' };

export function send<T extends Request>(msg: T): Promise<ResponseMap[T['type']]> {
  return chrome.runtime.sendMessage(msg);
}


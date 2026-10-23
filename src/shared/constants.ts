/** Share of the feed taken by subscription uploads; the rest is discovery. */
export const SUBSCRIPTION_MIX = 0.6;
export const FEED_SIZE = 60;
/** Max consecutive items from the same channel. */
export const MAX_CHANNEL_RUN = 2;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The subscription list (FEchannels) is re-read at most this often. */
export const SUBS_REFRESH_MS = DAY_MS;

// ---- Subscription uploads: YouTube's own subscriptions feed (FEsubscriptions) ----

/** A Home visit syncs the subscriptions feed when the last sync is older than this. */
export const SUBS_FEED_SYNC_MS = 30 * 60 * 1000;
/** First run: pages fetched before the first render; the rest is backfilled later. */
export const SUBS_FEED_FIRST_RUN_PAGES = 3;
/** Later syncs stop on overlap; this many pages without overlap leaves a gap to fill later. */
export const SUBS_FEED_TOP_MAX_PAGES = 5;
/** Gap and backfill pages per sync, so catching up is spread over several Home visits. */
export const SUBS_FEED_CATCHUP_PAGES = 3;
export const SUBS_FEED_SESSION_MAX_PAGES = 8;
/** How far back the first run backfills. */
export const SUBS_FEED_BACKFILL_MS = 30 * DAY_MS;
/**
 * Known (already synced) videos on one page that end an incremental sync. More than one, so a
 * single item out of order (a premiere or a re-surfaced stream) can't stop a sync early.
 */
export const SUBS_FEED_OVERLAP_STOP = 3;
export const SUBS_FEED_PAGE_GAP_MS = 1500;
/** Gap and backfill pages are not on screen yet: go slower. */
export const SUBS_FEED_CATCHUP_GAP_MS = 4000;
/** Watch-history pages read once to seed engagement before watch logs exist. */
export const HISTORY_SEED_PAGES = 2;
/** A failed history read is retried after this long. */
export const HISTORY_SEED_RETRY_MS = 7 * DAY_MS;

// ---- Discovery graph and candidate uploads ----

/** Featured channels of subscriptions are re-read this rarely; they change slowly. */
export const CHANNEL_RECRAWL_MS = 60 * DAY_MS;
/** Second hop: featured channels of top candidates. */
export const CANDIDATE_RECRAWL_MS = 45 * DAY_MS;
/** Candidate uploads (Videos tab: durations, views and age in one request). */
export const CANDIDATE_UPLOADS_REFRESH_MS = 2 * DAY_MS;
/** Weekly RSS (descriptions -> mentions) for the most-watched subscriptions only. */
export const MENTIONS_RSS_REFRESH_MS = 7 * DAY_MS;
export const TOP_SUBS_FOR_MENTIONS_RSS = 20;

/** Hard ceiling over all purposes together (setting `dailyCap`). */
export const DEFAULT_DAILY_CAP = 300;
export const MIN_REQUEST_GAP_MS = 3000;
export const MAX_REQUEST_GAP_MS = 5000;
export const MAX_CONSECUTIVE_FAILURES = 5;

/** How many top discovery candidates get their uploads fetched / featured channels crawled. */
export const TOP_CANDIDATES_FOR_UPLOADS = 30;
export const TOP_CANDIDATES_FOR_CRAWL = 15;
export const MAX_HANDLE_RESOLVE_ATTEMPTS = 3;

/** Feedback multipliers applied to a candidate's channel score. */
export const MORE_LIKE_THIS_MULTIPLIER = 1.5;

// ---- Fresh feed: every Home visit draws a new mix from the stored pool ----

/** Items are drawn with probability rising with score^SHARPNESS: higher keeps good matches commoner. */
export const FEED_SAMPLING_SHARPNESS = 1.5;
/** Each earlier visit a video was on screen (and not opened) multiplies its weight by this. */
export const IMPRESSION_DECAY = 0.5;
/** Impressions older than this are forgotten. */
export const IMPRESSION_TTL_MS = 21 * DAY_MS;
/** Impressions kept at most (oldest dropped first). */
export const MAX_IMPRESSIONS = 5000;
/** Brand-new subscription uploads pinned at the top of the feed, at most this many... */
export const ANCHOR_SLOTS = 3;
/** ...if uploaded within this long... */
export const ANCHOR_MAX_AGE_MS = 2 * DAY_MS;
/** ...and shown on fewer earlier visits than this. */
export const ANCHOR_MAX_IMPRESSIONS = 2;

/** Client version observed on www.youtube.com (2026-10); used only until a page reports its own. */
export const FALLBACK_CLIENT_VERSION = '2.20261014.01.00';

/**
 * YouTube retired its Trending page (FEtrending now returns 400). The closest public signal is
 * search filtered to "uploaded today" (a rolling 24 hours, checked 2026-10-16) and sorted by view
 * count; merging several very common words approximates "the most-viewed videos on YouTube today"
 * in the user's region.
 */
export function trendingQueries(now = Date.now()): string[] {
  return ['the', 'a', 'i', 'you', 'how', String(new Date(now).getFullYear())];
}
/** "Today" moves fast: re-run the searches this often. */
export const TRENDING_REFRESH_MS = 6 * 60 * 60 * 1000;
/** Ignore cached search results older than this. */
export const TRENDING_MAX_AGE_MS = 12 * 60 * 60 * 1000;
/** Videos older than this never show in the top row (24 h at search time, plus refresh slack). */
export const TRENDING_WINDOW_MS = 36 * 60 * 60 * 1000;
/**
 * Today's results are kept this long as a backup pool: when hides or a thin day leave fewer than
 * enough of today's videos, the row tops up with the biggest from the last few days.
 */
export const TRENDING_POOL_MS = 7 * DAY_MS;
/** Backup pool size per search word. */
export const TRENDING_POOL_PER_QUERY = 60;
export const TRENDING_SLOTS = 4;
/** YouTube's News hub is re-read this often (top stories move through the day). */
export const NEWS_REFRESH_MS = 2 * 60 * 60 * 1000;
/** Stories older than this are not shown. */
export const NEWS_MAX_AGE_MS = 12 * 60 * 60 * 1000;
/**
 * News only takes top-row slots when YouTube is pushing it: a story whose fastest video gathers
 * views at least this fraction as fast as a typical (median) "most viewed today" video. On a
 * normal day news grows ~10–20k views/hour against 100k+ for the biggest videos; a big story
 * reaches the hundreds of thousands (checked 2026-10-17).
 */
export const NEWS_PUSH_RATIO = 0.25;
/**
 * ...and only when at least this many different verified news outlets are each over that bar:
 * a big story is covered hard by established sources at once, not by one channel.
 */
export const NEWS_MIN_OUTLETS = 2;
/** At most this many of the top row's slots go to pushed news, from the top NEWS_STORIES stories. */
export const NEWS_SLOTS = 2;
export const NEWS_STORIES = 6;
/** A story's video must be at most this old. */
export const NEWS_VIDEO_MAX_AGE_MS = 2 * DAY_MS;
/** The top row draws its 4 from this many of the biggest, so each visit shows a different few. */
export const TRENDING_CANDIDATES = 12;
/**
 * Community picks need real traction on YouTube itself (YouTube's own view count, looked up by
 * the extension), so nobody can push an unknown video into everyone's top row.
 */
export const COMMUNITY_MIN_VIEWS = 10_000;
/** What a request is for. Each purpose has its own daily budget so none can starve the others. */
export type Purpose = 'subs' | 'top' | 'discovery' | 'mentions';

/**
 * Requests per day per purpose. Together well under DEFAULT_DAILY_CAP.
 * - subs: subscriptions feed syncs (1–2 pages per Home visit), the subscription list, history seed.
 * - top: the six "today by views" searches, every 6 hours (24 a day), and the News hub every
 *   2 hours (12 a day).
 * - discovery: featured channels (bootstrap ≤ ~150/day, then N/60 per day) and candidate uploads.
 * - mentions: weekly RSS of the top subscriptions plus a few handle lookups.
 */
export const PURPOSE_BUDGETS: Record<Purpose, number> = {
  subs: 60,
  top: 45,
  discovery: 165,
  mentions: 25,
};

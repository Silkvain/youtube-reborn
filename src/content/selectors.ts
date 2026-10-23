/** Every YouTube DOM selector the extension depends on. Update here when YouTube's markup changes. */
export const SEL = {
  /** The home page's browse element. */
  homeBrowse: 'ytd-browse[page-subtype="home"]',
  /** Where our feed is inserted inside the home browse element. */
  homeMount: 'ytd-browse[page-subtype="home"] ytd-two-column-browse-results-renderer #primary',
  /** Native home grid (hidden by boot.css). */
  homeGrid: 'ytd-browse[page-subtype="home"] ytd-rich-grid-renderer',
  player: '#movie_player',
  mainVideo: '#movie_player video.html5-main-video, #movie_player video',
  /** Class on the player while an ad is playing. */
  adShowingClass: 'ad-showing',
} as const;

/** YouTube's SPA navigation events (fired on document). */
export const YT_EVENTS = {
  navigateStart: 'yt-navigate-start',
  navigateFinish: 'yt-navigate-finish',
} as const;

export const ENABLED_CLASS = 'ydx-enabled';
/**
 * On <html> while our feed is on screen. feed.css uses it to shrink YouTube's fixed translucent
 * header (#frosted-glass.with-chipbar) from 112px to 56px: the extra 56px is reserved for the
 * category chips, which live in the native grid we hide, so it would otherwise cover our top row.
 */
export const FEED_MOUNTED_CLASS = 'ydx-feed-mounted';
export const FEED_ROOT_ID = 'ydx-feed';

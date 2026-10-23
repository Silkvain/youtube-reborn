/**
 * Visual comparison on the real YouTube home page: mounts our real feed (home.ts + feed.css,
 * injected by the caller) with the same videos YouTube is showing, so the two can be compared
 * side by side. Toggle with window.__ydxCompare(true|false). A development aid; not shipped.
 */
import { HomeFeed } from '../../src/content/home';
import { parseVideoItems } from '../../src/content/innertube';
import { ENABLED_CLASS } from '../../src/content/selectors';
import type { FeedItem } from '../../src/shared/types';

type Win = { ytInitialData?: unknown; __ydxCompare?: (on: boolean) => void };
const w = window as unknown as Win;

/** Channel avatars as YouTube's own cards show them, by channel ID. */
function avatars(): Map<string, string> {
  const out = new Map<string, string>();
  for (const card of document.querySelectorAll('ytd-rich-item-renderer')) {
    const ch = card.querySelector<HTMLAnchorElement>('a[href^="/@"], a[href^="/channel/"]');
    const img = card.querySelector<HTMLImageElement>('yt-avatar-shape img, .yt-spec-avatar-shape img, img.ytCoreImageHost[src*="yt3."]');
    const id = /\/channel\/(UC[\w-]{22})/.exec(ch?.href ?? '')?.[1];
    if (id && img?.src) out.set(id, img.src);
  }
  return out;
}

const now = Date.now();
const parsed = parseVideoItems(w.ytInitialData, now).filter((v) => v.kind === 'video' && v.channelId);
const pics = avatars();
const items: FeedItem[] = parsed.map((v, i) => ({
  videoId: v.id,
  title: v.title,
  channelId: v.channelId!,
  channelTitle: v.channelTitle ?? '',
  channelAvatarUrl: pics.get(v.channelId!),
  thumbnailUrl: '',
  publishedAt: v.publishedAt ?? now - 86_400_000,
  durationSec: v.durationSec,
  viewCount: v.viewCount,
  discover: i % 4 === 2,
  reason: i % 4 === 2 ? 'Featured by a channel you watch' : undefined,
}));

(globalThis as Record<string, unknown>).chrome = {
  runtime: {
    id: 'compare',
    sendMessage: async (msg: { type: string }) => {
      if (msg.type === 'feed:get') return { status: 'ok', trending: [], items, coldStart: false };
      if (msg.type === 'feed:more') return { items: [], hasMore: false, deeper: false };
      return undefined;
    },
    onMessage: { addListener() {} },
  },
};

const feed = new HomeFeed();
w.__ydxCompare = (on: boolean) => {
  document.documentElement.classList.toggle(ENABLED_CLASS, on);
  if (on) void feed.mount();
  else feed.unmount();
};
w.__ydxCompare(true);

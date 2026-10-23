/**
 * The real feed (src/content/home.ts and feed.css) on a plain dark page, fed made-up data.
 * Served at "/" because the feed only mounts on the home route.
 */
import { HomeFeed } from '../../src/content/home';
import { ENABLED_CLASS } from '../../src/content/selectors';
import { feed, thumbWords } from './demo-data';
import { drawThumb } from './thumbs';

const byId = new Map([...feed.trending, ...feed.items].map((i) => [i.videoId, i]));

(globalThis as Record<string, unknown>).chrome = {
  runtime: {
    id: 'demo',
    sendMessage: async (msg: { type: string }) => {
      if (msg.type === 'feed:get') return feed;
      if (msg.type === 'feed:more') return { items: [], hasMore: false, deeper: false };
      return undefined;
    },
    onMessage: { addListener() {} },
  },
};

// Swap i.ytimg.com thumbnails for drawn ones (the made-up IDs have no real thumbnails).
new MutationObserver(() => {
  for (const img of document.querySelectorAll<HTMLImageElement>('img[src*="i.ytimg.com"]')) {
    const id = /\/vi\/([^/]+)\//.exec(img.src)?.[1] ?? '';
    const v = byId.get(id);
    img.removeAttribute('loading');
    img.src = drawThumb(id, v ? (thumbWords[v.title] ?? '') : '');
  }
}).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

document.documentElement.setAttribute('dark', '');
document.documentElement.classList.add(ENABLED_CLASS);
void new HomeFeed().mount();

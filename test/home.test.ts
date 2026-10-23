// @vitest-environment jsdom
import { BRIDGE_REQUEST, BRIDGE_RESPONSE } from '../src/content/bridge-protocol';
import { ENABLED_CLASS, FEED_ROOT_ID } from '../src/content/selectors';
import type { FeedResponse } from '../src/shared/types';

let feedResponse: FeedResponse | Error;
let archive: { id: string; channel: string }[] = [];
let archiveError = false;
const hiddenVideoIds = new Set<string>();
const hiddenChannelIds = new Set<string>();
/** Optional longer "most viewed" list the fake service worker picks the top 4 from. */
let trendingPool: ReturnType<typeof item>[] | null = null;
/** Archive pages report `deeper` until this many deeper reads have happened. */
let deeperUntil = 0;
let deeperReads = 0;
const observers: { cb: IntersectionObserverCallback; disconnected: boolean; archive: boolean; targets: Element[] }[] = [];
class FakeObserver {
  entry: { cb: IntersectionObserverCallback; disconnected: boolean; archive: boolean; targets: Element[] };
  constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    // The archive sentinel uses a rootMargin; the seen-card observer uses a threshold.
    this.entry = { cb, disconnected: false, archive: options?.rootMargin !== undefined, targets: [] };
    observers.push(this.entry);
  }
  observe(t: Element) { this.entry.targets.push(t); }
  unobserve() {}
  disconnect() { this.entry.disconnected = true; }
}
vi.stubGlobal('IntersectionObserver', FakeObserver);
/** Pretend the sentinel scrolled into view. */
async function scrollToBottom() {
  const o = observers.filter((x) => !x.disconnected && x.archive).at(-1)!;
  o.cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
  await new Promise((r) => setTimeout(r, 0));
}
const sent: unknown[] = [];

vi.stubGlobal('chrome', {
  runtime: {
    sendMessage: vi.fn(async (msg: { type: string }) => {
      sent.push(msg);
      if (msg.type === 'feed:more') {
        if (archiveError) throw new Error('boom');
        const m = msg as unknown as { offset: number; limit: number; exclude: string[] };
        const list = archive.filter((v) => !m.exclude.includes(v.id));
        return {
          items: list.slice(m.offset, m.offset + m.limit).map((v) => item(v.id, false, v.channel)),
          hasMore: m.offset + m.limit < list.length,
          deeper: deeperReads < deeperUntil,
        };
      }
      const m = msg as { type: string; videoId?: string; channelId?: string; kind?: string };
      if (m.type === 'feedback:video') hiddenVideoIds.add(m.videoId!);
      if (m.type === 'feedback' && m.kind === 'notInterested') hiddenChannelIds.add(m.channelId!);
      if (m.type === 'feedback:undo') {
        if (m.videoId) hiddenVideoIds.delete(m.videoId);
        if (m.channelId) hiddenChannelIds.delete(m.channelId);
      }
      if (msg.type !== 'feed:get') return undefined;
      if (feedResponse instanceof Error) throw feedResponse;
      const visible = (i: { videoId: string; channelId: string }) => !hiddenVideoIds.has(i.videoId) && !hiddenChannelIds.has(i.channelId);
      return { ...feedResponse, trending: (trendingPool ?? feedResponse.trending).filter(visible).slice(0, 4) };
    }),
  },
});
vi.stubGlobal('CSS', { escape: (s: string) => s });

const { HomeFeed, formatAge, formatDuration, formatViews, formatViewsShort, thumbnailImage } = await import('../src/content/home');

function youtubeHome() {
  document.body.innerHTML = `
    <ytd-browse page-subtype="home"><ytd-two-column-browse-results-renderer>
      <div id="primary"><ytd-rich-grid-renderer></ytd-rich-grid-renderer></div>
    </ytd-two-column-browse-results-renderer></ytd-browse>`;
  document.documentElement.classList.add(ENABLED_CLASS);
}

const item = (id: string, discover: boolean, channelId = `UC${id}`) => ({
  videoId: id,
  title: `Video ${id}`,
  channelId,
  channelTitle: `Channel ${id}`,
  thumbnailUrl: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
  publishedAt: Date.now() - 3 * 86_400_000,
  durationSec: 125,
  viewCount: 5_894_861,
  discover,
  reason: discover ? 'Featured by Someone' : undefined,
});

beforeEach(() => {
  youtubeHome();
  sent.length = 0;
  observers.length = 0;
  archiveError = false;
  archive = [];
  deeperUntil = 0;
  deeperReads = 0;
  hiddenVideoIds.clear();
  hiddenChannelIds.clear();
  trendingPool = null;
  // jsdom has no layout, so keep the "sentinel still in reach" check false.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 1e9 } as DOMRect);
  feedResponse = { status: 'ok', trending: [], coldStart: false, items: [item('a', false), item('b', true)] };
});

describe('HomeFeed', () => {
  it('renders cards with the Discover badge and a menu', async () => {
    const feed = new HomeFeed();
    await feed.mount();
    const root = document.getElementById(FEED_ROOT_ID)!;
    expect(root.parentElement?.id).toBe('primary');
    const cards = root.querySelectorAll('.ydx-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.querySelector('.ydx-badge')).toBeNull();
    expect(cards[1]!.querySelector('.ydx-badge')?.textContent).toBe('Discover');
    expect(cards[1]!.querySelector('.ydx-menu-btn')).not.toBeNull();
    expect(cards[0]!.querySelector('a.ydx-title')?.getAttribute('href')).toBe('/watch?v=a');
    expect(cards[0]!.querySelector('.ydx-duration')?.textContent).toBe('2:05');
    // One line like YouTube's: channel, ▷ views (full count for screen readers), age.
    expect(cards[0]!.querySelector('.ydx-sub')?.textContent).toBe('Channel a5.8M3 days ago');
    expect(cards[0]!.querySelector('.ydx-views')?.getAttribute('aria-label')).toBe('5.8M views');
    expect(cards[1]!.querySelector('.ydx-sub')?.textContent).toBe('Channel b5.8M3 days agoDiscover');
  });

  it('shows the channel avatar beside the title, or its first letter when there is none', async () => {
    feedResponse = {
      status: 'ok',
      trending: [],
      coldStart: false,
      items: [{ ...item('a', false), channelAvatarUrl: 'https://yt3.ggpht.com/abc=s88' }, item('b', true)],
    };
    await new HomeFeed().mount();
    const avatar = (v: string) => document.querySelector(`.ydx-card[data-video="${v}"] .ydx-avatar`)!;
    expect(avatar('a').querySelector('img')?.getAttribute('src')).toBe('https://yt3.ggpht.com/abc=s88');
    expect(avatar('a').getAttribute('href')).toBe('/channel/UCa');
    expect(avatar('b').querySelector('img')).toBeNull();
    expect(avatar('b').textContent).toBe('C');
  });

  it('asks for a new draw on every visit to Home, and reports cards once they are seen', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const feed = new HomeFeed();
      await feed.mount();
      const views = () => sent.filter((m) => (m as { type: string }).type === 'feed:get').map((m) => (m as { view: { seed: number } }).view);
      expect(views()).toHaveLength(1);

      // Both cards scroll into view: reported once, in one batch, with this visit's draw.
      const seen = observers.find((o) => !o.archive && !o.disconnected)!;
      expect(seen.targets).toHaveLength(2);
      const entries = seen.targets.map((target) => ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry);
      seen.cb(entries, {} as IntersectionObserver);
      seen.cb(entries, {} as IntersectionObserver);
      vi.advanceTimersByTime(2500);
      const reports = sent.filter((m) => (m as { type: string }).type === 'feed:impressions');
      expect(reports).toEqual([{ type: 'feed:impressions', ids: ['a', 'b'], view: views()[0] }]);

      // Coming back to Home (or clicking the logo) is a new visit with a new draw.
      await feed.mount();
      expect(views()).toHaveLength(2);
      expect(views()[1]!.seed).not.toBe(views()[0]!.seed);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports which source found each Discover card it saw', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      feedResponse = { status: 'ok', trending: [], coldStart: false, items: [item('a', false), { ...item('b', true), source: 'featured' }] };
      const feed = new HomeFeed();
      await feed.mount();
      const seen = observers.find((o) => !o.archive && !o.disconnected)!;
      seen.cb(seen.targets.map((target) => ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry), {} as IntersectionObserver);
      vi.advanceTimersByTime(2500);
      expect(sent.find((m) => (m as { type: string }).type === 'feed:impressions')).toMatchObject({ ids: ['a', 'b'], discover: { b: 'featured' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks <html> while mounted so the chip-bar header space collapses', async () => {
    const feed = new HomeFeed();
    await feed.mount();
    expect(document.documentElement.classList.contains('ydx-feed-mounted')).toBe(true);
    feed.unmount();
    expect(document.documentElement.classList.contains('ydx-feed-mounted')).toBe(false);
  });

  it('fills in durations and views that arrive later, without redrawing', async () => {
    const bare = (id: string) => ({ ...item(id, false), durationSec: undefined, viewCount: undefined });
    feedResponse = { status: 'ok', trending: [], coldStart: false, items: [bare('a'), bare('b')] };
    const feed = new HomeFeed();
    await feed.mount();
    const cardA = document.querySelector('.ydx-card[data-video="a"]')!;
    expect(cardA.querySelector('.ydx-duration')).toBeNull();
    expect(cardA.querySelector('.ydx-sub')?.textContent).toBe('Channel a3 days ago');

    feedResponse = { status: 'ok', trending: [], coldStart: false, items: [item('a', false), bare('b')] };
    feed.onDataUpdated();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector('.ydx-card[data-video="a"]')).toBe(cardA); // same node: not redrawn
    expect(cardA.querySelector('.ydx-duration')?.textContent).toBe('2:05');
    expect(cardA.querySelector('.ydx-sub')?.textContent).toBe('Channel a5.8M3 days ago');
    expect(document.querySelector('.ydx-card[data-video="b"] .ydx-duration')).toBeNull();
  });

  it('patches in new subscription uploads after a sync, when the user is at the top', async () => {
    const feed = new HomeFeed();
    await feed.mount();
    feedResponse = { status: 'ok', trending: [], coldStart: false, items: [item('new', false), item('a', false), item('b', true)] };
    feed.onDataUpdated();
    await new Promise((r) => setTimeout(r, 0));
    expect([...document.querySelectorAll('.ydx-card')].map((c) => c.getAttribute('data-video'))).toEqual(['new', 'a', 'b']);
  });

  it('never redraws under the user: scrolled down or mid-undo, it only fills in details', async () => {
    const bare = (id: string) => ({ ...item(id, false), durationSec: undefined });
    feedResponse = { status: 'ok', trending: [], coldStart: false, items: [bare('a'), item('b', true)] };
    const feed = new HomeFeed();
    await feed.mount();
    const cardA = document.querySelector('.ydx-card[data-video="a"]')!;
    Object.defineProperty(window, 'scrollY', { value: 900, configurable: true });
    feedResponse = { status: 'ok', trending: [], coldStart: false, items: [item('new', false), item('a', false), item('b', true)] };
    feed.onDataUpdated();
    await new Promise((r) => setTimeout(r, 0));
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    expect(document.querySelector('.ydx-card[data-video="new"]')).toBeNull();
    expect(document.querySelector('.ydx-card[data-video="a"]')).toBe(cardA);
    expect(cardA.querySelector('.ydx-duration')?.textContent).toBe('2:05');
  });

  it('mounting repeatedly never duplicates the feed', async () => {
    const feed = new HomeFeed();
    await Promise.all([feed.mount(), feed.mount()]);
    await feed.mount();
    expect(document.querySelectorAll(`#${FEED_ROOT_ID}`)).toHaveLength(1);
    expect(document.querySelectorAll('.ydx-card')).toHaveLength(2);
  });

  it('shows the cold-start note and logged-out message', async () => {
    feedResponse = { status: 'ok', trending: [], coldStart: true, items: [item('a', false)] };
    const feed = new HomeFeed();
    await feed.mount();
    expect(document.querySelector('.ydx-note')?.textContent).toMatch(/Building your recommendations/);
    feedResponse = { status: 'loggedOut', trending: [], coldStart: true, items: [] };
    await feed.refresh();
    expect(document.querySelector('.ydx-message h2')?.textContent).toMatch(/Sign in/);
  });

  it('fails open when the feed cannot be loaded', async () => {
    feedResponse = new Error('service worker gone');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await new HomeFeed().mount();
    err.mockRestore();
    expect(document.documentElement.classList.contains(ENABLED_CLASS)).toBe(false);
    expect(document.getElementById(FEED_ROOT_ID)).toBeNull();
  });
});

describe('most viewed row and card menus', () => {
  const menuOf = (card: Element) => [...card.querySelectorAll('.ydx-menu-item')].map((b) => b.textContent);
  const click = async (card: Element, label: string) => {
    (card.querySelector('.ydx-menu-btn') as HTMLButtonElement).click();
    const btn = [...card.querySelectorAll<HTMLButtonElement>('.ydx-menu-item')].find((b) => b.textContent === label)!;
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
  };

  beforeEach(() => {
    trendingPool = [
      item('beast', false, 'UCbeast'),
      item('logan', false, 'UClogan'),
      item('ltt', false, 'UCltt'),
      item('roblox', false, 'UCroblox'),
      item('fifth', false, 'UCfifth'),
    ];
    feedResponse = {
      status: 'ok',
      coldStart: false,
      trending: trendingPool.slice(0, 4),
      items: [item('sub', false, 'UCsub'), item('disc', true, 'UCbeast'), item('disc2', true, 'UCother')],
    };
  });

  it('shows the 4 most viewed videos above the feed', async () => {
    await new HomeFeed().mount();
    const top = document.querySelector('.ydx-top')!;
    expect(top.querySelector('h2')?.textContent).toBe('Most viewed today');
    expect([...top.querySelectorAll('.ydx-card')].map((c) => c.getAttribute('data-video'))).toEqual(['beast', 'logan', 'ltt', 'roblox']);
    expect(document.querySelector('#ydx-feed > .ydx-top')).toBe(document.getElementById(FEED_ROOT_ID)!.firstElementChild);
  });

  it('offers video and channel options where they make sense', async () => {
    await new HomeFeed().mount();
    const card = (v: string) => document.querySelector(`.ydx-card[data-video="${v}"]`)!;
    // Without YouTube's app (as here), our own menu appears with our actions.
    expect(menuOf(card('beast'))).toEqual(['Not interested in this video', 'Don’t recommend this channel']);
    expect(menuOf(card('disc'))).toEqual(['More like this', 'Not interested in this video', 'Don’t recommend this channel']);
    expect(menuOf(card('sub'))).toEqual(['Not interested in this video']);
  });

  it('⋮ opens YouTube’s own menu for that video, and our items in it run our actions', async () => {
    const asked: Record<string, unknown>[] = [];
    const answer = (e: Event) => {
      const req = JSON.parse(String((e as CustomEvent).detail));
      asked.push(req);
      window.dispatchEvent(new CustomEvent(BRIDGE_RESPONSE, { detail: JSON.stringify({ id: req.id, payload: { ok: true } }) }));
    };
    window.addEventListener(BRIDGE_REQUEST, answer);
    try {
      await new HomeFeed().mount();
      const card = document.querySelector('.ydx-card[data-video="disc"]')!;
      const button = card.querySelector('.ydx-menu-btn') as HTMLButtonElement;
      button.click();
      await new Promise((r) => setTimeout(r, 0));
      expect(asked[0]).toMatchObject({
        kind: 'menu',
        videoId: 'disc',
        anchor: button.dataset.ydxAnchor,
        own: [
          { title: 'More like this', icon: 'THUMB_UP' },
          { title: 'Not interested in this video', icon: 'HIDE' },
          { title: 'Don’t recommend this channel', icon: 'REMOVE' },
        ],
      });
      expect(card.querySelector<HTMLElement>('.ydx-menu')!.hidden).toBe(true); // ours stays closed

      // YouTube draws the sheet; the user taps our item in it.
      const row = document.createElement('yt-list-item-view-model');
      row.append(Object.assign(document.createElement('span'), { textContent: 'Not interested in this video' }));
      document.body.append(row);
      const youtubeSaw = vi.fn();
      row.addEventListener('click', youtubeSaw);
      (row.firstChild as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 0));
      expect(youtubeSaw).not.toHaveBeenCalled(); // caught before YouTube
      expect(sent).toContainEqual({ type: 'feedback:video', videoId: 'disc' });
      expect(asked.at(-1)).toMatchObject({ kind: 'closeMenu' });

      // YouTube's own items are left to YouTube.
      const other = document.createElement('yt-list-item-view-model');
      other.textContent = 'Save to playlist';
      document.body.append(other);
      other.addEventListener('click', youtubeSaw);
      other.click();
      expect(youtubeSaw).toHaveBeenCalledTimes(1);
      row.remove();
      other.remove();
    } finally {
      window.removeEventListener(BRIDGE_REQUEST, answer);
    }
  });

  const topRow = () => [...document.querySelectorAll('.ydx-top .ydx-card')].map((c) => c.getAttribute('data-video'));

  it('top row: hiding a video moves the next one up at once, with Undo above the row', async () => {
    await new HomeFeed().mount();
    await click(document.querySelector('.ydx-card[data-video="logan"]')!, 'Not interested in this video');
    expect(sent).toContainEqual({ type: 'feedback:video', videoId: 'logan' });
    expect(topRow()).toEqual(['beast', 'ltt', 'roblox', 'fifth']);
    expect(document.querySelector('.ydx-top-status')?.textContent).toMatch(/Video hidden.*Undo/);
    (document.querySelector('.ydx-top-status .ydx-undo') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toContainEqual({ type: 'feedback:undo', videoId: 'logan' });
    expect(topRow()).toEqual(['beast', 'logan', 'ltt', 'roblox']);
    expect(document.querySelector('.ydx-top-status')).toBeNull();
  });

  it('top row: hiding a creator removes them everywhere (#1, #2, #4, #5 when #3 is hidden), with Undo', async () => {
    trendingPool!.splice(0, 3, item('one', false, 'UCone'), item('two', false, 'UCtwo'), item('beast', false, 'UCbeast'));
    trendingPool!.splice(3, 0, item('four', false, 'UCfour'));
    feedResponse = { ...(feedResponse as FeedResponse), trending: trendingPool!.slice(0, 4) };
    await new HomeFeed().mount();
    expect(topRow()).toEqual(['one', 'two', 'beast', 'four']);
    await click(document.querySelector('.ydx-card[data-video="beast"]')!, 'Don’t recommend this channel');
    expect(sent).toContainEqual({ type: 'feedback', channelId: 'UCbeast', kind: 'notInterested' });
    expect(topRow()).toEqual(['one', 'two', 'four', 'roblox']);
    // The creator's Discover card further down is hidden too; subscriptions are untouched.
    expect(document.querySelector<HTMLElement>('.ydx-card[data-video="disc"]')!.hidden).toBe(true);
    expect(document.querySelector('.ydx-top-status')?.textContent).toMatch(/won’t recommend Channel beast/);
    (document.querySelector('.ydx-top-status .ydx-undo') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toContainEqual({ type: 'feedback:undo', channelId: 'UCbeast' });
    expect(topRow()).toEqual(['one', 'two', 'beast', 'four']);
    expect(document.querySelector<HTMLElement>('.ydx-card[data-video="disc"]')!.hidden).toBe(false);
  });

  it('Discover: hiding a creator leaves Undo in place and also refreshes the top row', async () => {
    await new HomeFeed().mount();
    await click(document.querySelector('.ydx-card[data-video="disc"]')!, 'Don’t recommend this channel');
    expect(document.querySelector('.ydx-card[data-video="disc"]')).toBeNull();
    expect(document.querySelector('.ydx-hidden-note')?.textContent).toMatch(/won’t recommend Channel disc/);
    expect(topRow()).toEqual(['logan', 'ltt', 'roblox', 'fifth']);
    (document.querySelector('.ydx-undo') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector('.ydx-card[data-video="disc"]')).not.toBeNull();
    expect(topRow()).toEqual(['beast', 'logan', 'ltt', 'roblox']);
  });

  it('subscriptions: hiding a video leaves Undo in its place', async () => {
    await new HomeFeed().mount();
    await click(document.querySelector('.ydx-card[data-video="sub"]')!, 'Not interested in this video');
    expect(document.querySelector('.ydx-card[data-video="sub"]')).toBeNull();
    expect(document.querySelector('.ydx-hidden-note')?.textContent).toMatch(/Video hidden/);
  });

  it('the menu closes on Escape and outside clicks', async () => {
    await new HomeFeed().mount();
    const card = document.querySelector('.ydx-card[data-video="beast"]')!;
    const btn = card.querySelector<HTMLButtonElement>('.ydx-menu-btn')!;
    const menu = card.querySelector<HTMLElement>('.ydx-menu')!;
    // Without YouTube's app our own menu opens once the bridge gives up (0.5 s).
    const opened = async () => {
      btn.click();
      await new Promise((r) => setTimeout(r, 600));
    };
    await opened();
    expect(menu.hidden).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(menu.hidden).toBe(true);
    await opened();
    document.body.click();
    expect(menu.hidden).toBe(true);
  });

  it('the older-uploads section never repeats top-row videos', async () => {
    await new HomeFeed().mount();
    await scrollToBottom();
    const more = sent.find((m) => (m as { type: string }).type === 'feed:more') as { exclude: string[] };
    expect(more.exclude).toEqual(expect.arrayContaining(['beast', 'logan', 'ltt', 'roblox', 'sub']));
  });
});

describe('older uploads below the feed', () => {
  const sectionCards = () => [...document.querySelectorAll('.ydx-archive .ydx-card')].map((c) => c.querySelector('.ydx-title')?.textContent);

  it('loads pages as you scroll, skips what is already shown, then says it is done', async () => {
    archive = [
      { id: 'a', channel: 'UCa' }, // already in the main feed
      ...Array.from({ length: 30 }, (_, i) => ({ id: `old${i}`, channel: `UC${i % 5}` })),
    ];
    await new HomeFeed().mount();
    const heading = document.querySelector<HTMLElement>('.ydx-section-title')!;
    expect(heading.hidden).toBe(true);
    expect(sectionCards()).toHaveLength(0);

    await scrollToBottom();
    expect(heading.hidden).toBe(false);
    expect(sectionCards()).toHaveLength(24);
    expect(sectionCards()).not.toContain('Video a');
    const first = sent.find((m) => (m as { type: string }).type === 'feed:more');
    expect(first).toMatchObject({ offset: 0, limit: 24, exclude: ['a', 'b'] });

    await scrollToBottom();
    expect(sectionCards()).toHaveLength(30);
    expect(document.querySelector('.ydx-sentinel')?.textContent).toMatch(/everything/);
    expect(observers.filter((o) => o.archive).every((o) => o.disconnected)).toBe(true);
  });

  it('reads further back in the subscriptions feed before showing older uploads', async () => {
    archive = Array.from({ length: 30 }, (_, i) => ({ id: `old${i}`, channel: `UC${i % 5}` }));
    deeperUntil = 2;
    const deepen = vi.fn(async () => {
      deeperReads++;
      return true;
    });
    await new HomeFeed({ deepen }).mount();
    await scrollToBottom();
    expect(deepen).toHaveBeenCalledTimes(2);
    // The page is re-requested after each read, then shown.
    expect(sent.filter((m) => (m as { type: string }).type === 'feed:more')).toHaveLength(3);
    expect(document.querySelectorAll('.ydx-archive .ydx-card')).toHaveLength(24);
  });

  it('stops reading further back when it cannot, and at most 3 pages per scroll', async () => {
    archive = Array.from({ length: 30 }, (_, i) => ({ id: `old${i}`, channel: `UC${i % 5}` }));
    deeperUntil = 99;
    const deepen = vi.fn(async () => {
      deeperReads++;
      return true;
    });
    await new HomeFeed({ deepen }).mount();
    await scrollToBottom();
    expect(deepen).toHaveBeenCalledTimes(3);

    const refusing = vi.fn(async () => false);
    youtubeHome();
    await new HomeFeed({ deepen: refusing }).mount();
    await scrollToBottom();
    expect(refusing).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('.ydx-archive .ydx-card')).toHaveLength(24);
  });

  it('a failed page stops loading without breaking the feed', async () => {
    archiveError = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await new HomeFeed().mount();
    await scrollToBottom();
    warn.mockRestore();
    expect(document.querySelectorAll('#ydx-feed > .ydx-grid .ydx-card')).toHaveLength(2);
    expect(document.documentElement.classList.contains(ENABLED_CLASS)).toBe(true);
  });

  it('a redraw replaces the section instead of duplicating it', async () => {
    const feed = new HomeFeed();
    await feed.mount();
    await feed.refresh();
    expect(document.querySelectorAll('.ydx-archive')).toHaveLength(1);
    expect(observers.filter((o) => !o.disconnected && o.archive)).toHaveLength(1);
  });
});

describe('thumbnails', () => {
  it('uses the 1280×720 thumbnail on cards', async () => {
    await new HomeFeed().mount();
    expect(document.querySelector('.ydx-card img')?.getAttribute('src')).toBe('https://i.ytimg.com/vi/a/hq720.jpg');
  });

  it('falls back to hqdefault when hq720 errors', () => {
    const img = thumbnailImage('old');
    img.dispatchEvent(new Event('error'));
    expect(img.src).toBe('https://i.ytimg.com/vi/old/hqdefault.jpg');
    img.dispatchEvent(new Event('error'));
    expect(img.src).toBe('https://i.ytimg.com/vi/old/hqdefault.jpg'); // no further fallbacks, no loop
  });

  it('falls back when hq720 loads as the 120×90 placeholder', () => {
    const img = thumbnailImage('old');
    Object.defineProperty(img, 'naturalWidth', { value: 120, configurable: true });
    img.dispatchEvent(new Event('load'));
    expect(img.src).toBe('https://i.ytimg.com/vi/old/hqdefault.jpg');
  });

  it('keeps a real hq720 image', () => {
    const img = thumbnailImage('new');
    Object.defineProperty(img, 'naturalWidth', { value: 1280, configurable: true });
    img.dispatchEvent(new Event('load'));
    expect(img.src).toBe('https://i.ytimg.com/vi/new/hq720.jpg');
  });
});

describe('formatting', () => {
  it('ages and durations', () => {
    const now = Date.now();
    expect(formatAge(now - 2 * 86_400_000, now)).toBe('2 days ago');
    expect(formatAge(now - 3_600_000, now)).toBe('1 hour ago');
    expect(formatAge(now, now)).toBe('just now');
    expect(formatDuration(3723)).toBe('1:02:03');
    expect(formatDuration(undefined)).toBeNull();
  });

  it('short view counts like YouTube’s home cards', () => {
    expect(formatViewsShort(864_123)).toBe('864k');
    expect(formatViewsShort(5_894_861)).toBe('5.8M');
    expect(formatViewsShort(999)).toBe('999');
    expect(formatViewsShort(1)).toBe('1');
    expect(formatViewsShort(0)).toBe('No views');
    expect(formatViewsShort(undefined)).toBeNull();
  });

  it('views like YouTube', () => {
    expect(formatViews(undefined)).toBeNull();
    expect(formatViews(0)).toBe('No views');
    expect(formatViews(1)).toBe('1 view');
    expect(formatViews(999)).toBe('999 views');
    expect(formatViews(1000)).toBe('1K views');
    expect(formatViews(1234)).toBe('1.2K views');
    expect(formatViews(12_345)).toBe('12K views');
    expect(formatViews(123_456)).toBe('123K views');
    expect(formatViews(999_999)).toBe('999K views');
    expect(formatViews(1_999_999)).toBe('1.9M views');
    expect(formatViews(5_894_861)).toBe('5.8M views');
    expect(formatViews(45_600_000)).toBe('45M views');
    expect(formatViews(1_230_000_000)).toBe('1.2B views');
  });
});

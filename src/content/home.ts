/**
 * Renders our feed in place of the native home grid on "/". Mounting is idempotent: there is
 * only ever one #ydx-feed root. If anything goes wrong we fail open: drop the hide class so
 * YouTube's own feed shows, and log the error.
 */
import { send } from '../shared/messages';
import type { FeedItem, FeedResponse } from '../shared/types';
import { closeYtMenu, openYtMenu } from './bridge';
import { ENABLED_CLASS, FEED_MOUNTED_CLASS, FEED_ROOT_ID, SEL } from './selectors';

const MOUNT_TIMEOUT_MS = 10_000;
const ARCHIVE_PAGE_SIZE = 24;
/** Older subscriptions-feed pages read at most per archive page shown (each covers days of uploads). */
const MAX_DEEPER_PER_PAGE = 3;

export interface HomeFeedOptions {
  /** Read one older subscriptions-feed page; resolves to whether a page was read. */
  deepen?: () => Promise<boolean>;
}
/** Start loading the next archive page this far before the user reaches the bottom. */
const ARCHIVE_PREFETCH_PX = 1000;
/** New uploads are patched in by redrawing only while the page is scrolled less than this. */
const REDRAW_MAX_SCROLL_PX = 200;
/** A card counts as seen once this much of it is on screen. */
const SEEN_THRESHOLD = 0.6;
/** Seen cards are reported in batches. */
const SEEN_FLUSH_MS = 2000;

/** One Home visit: a new random draw, so each visit shows a different mix. */
function newView(): { seed: number; startedAt: number } {
  return { seed: Math.floor(Math.random() * 0x100000000), startedAt: Date.now() };
}

/** Which part of the feed a card is in; decides its menu actions and badge. */
type Section = 'trending' | 'subscription' | 'discover';

interface ArchiveState {
  grid: HTMLElement;
  heading: HTMLElement;
  sentinel: HTMLElement;
  observer: IntersectionObserver;
  /** Video IDs already on screen; sent so the archive never repeats them. */
  exclude: string[];
  shown: Set<string>;
  offset: number;
  hasMore: boolean;
  loading: boolean;
}

export function isHomeRoute(): boolean {
  return location.pathname === '/';
}

const UNITS: [number, string][] = [
  [365 * 86_400_000, 'year'],
  [30 * 86_400_000, 'month'],
  [7 * 86_400_000, 'week'],
  [86_400_000, 'day'],
  [3_600_000, 'hour'],
  [60_000, 'minute'],
];

export function formatAge(publishedAt: number, now = Date.now()): string {
  const diff = Math.max(0, now - publishedAt);
  for (const [ms, unit] of UNITS) {
    const n = Math.floor(diff / ms);
    if (n >= 1) return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** YouTube-style view count: "No views", "1 view", "999 views", "12K views", "5.8M views". */
export function formatViews(n: number | undefined): string | null {
  if (n === undefined || !Number.isFinite(n) || n < 0) return null;
  if (n === 0) return 'No views';
  if (n === 1) return '1 view';
  // Like YouTube: one decimal only below 10 of a unit (1.2K, 5.8M; then 12K, 123K), and
  // truncated rather than rounded so 1,999,999 never reads as "2M".
  const digits = Math.floor(Math.log10(n));
  const unitDigits = digits - (digits % 3);
  const step = n < 1000 ? 1 : digits % 3 === 0 ? 10 ** (unitDigits - 1) : 10 ** unitDigits;
  return `${compact.format(Math.floor(n / step) * step)} views`;
}

/** The view count as YouTube's home cards show it beside the play icon: "525k", "1.2M". */
export function formatViewsShort(n: number | undefined): string | null {
  const full = formatViews(n);
  if (!full || n === 0) return full;
  return full.replace(/ views?$/, '').replace(/K$/, 'k');
}

export function formatDuration(sec: number | undefined): string | null {
  if (!sec || sec <= 0) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/**
 * Thumbnail URLs to try, best first. hq720 (1280×720, what YouTube's own grid uses) exists for
 * almost every video; very old or low-res uploads only have hqdefault (480×360, letterboxed, so
 * object-fit: cover crops the bars). Both come from i.ytimg.com.
 */
export function thumbnailSources(videoId: string): string[] {
  const id = encodeURIComponent(videoId);
  return [`https://i.ytimg.com/vi/${id}/hq720.jpg`, `https://i.ytimg.com/vi/${id}/hqdefault.jpg`];
}

/** Width of the grey placeholder i.ytimg.com serves (with a 404) for a missing size. */
const PLACEHOLDER_MAX_WIDTH = 120;

/** <img> that falls back to the next thumbnail size if one is missing. */
export function thumbnailImage(videoId: string): HTMLImageElement {
  const sources = thumbnailSources(videoId);
  let i = 0;
  const img = el('img', { attrs: { src: sources[0]!, alt: '', loading: 'lazy', decoding: 'async' } });
  const next = () => {
    if (++i < sources.length) img.src = sources[i]!;
  };
  img.addEventListener('error', next);
  // A missing size may still "load" as the 120×90 placeholder instead of erroring.
  img.addEventListener('load', () => {
    if (img.naturalWidth > 0 && img.naturalWidth <= PLACEHOLDER_MAX_WIDTH) next();
  });
  return img;
}

/** Icons (Material Design, 24×24), as SVG paths so no innerHTML is needed. */
const ICONS = {
  // YouTube's own ⋮ and the small play icon before view counts.
  moreVert: 'M12 4a2 2 0 100 4 2 2 0 000-4Zm0 6a2 2 0 100 4 2 2 0 000-4Zm0 6a2 2 0 100 4 2 2 0 000-4Z',
  views: 'M8 5v14l11-7z',
  more:
    'M9 21h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.58 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2zM9 9l4.34-4.34L12 10h9v2l-3 7H9V9zM1 9h4v12H1z',
  notInterested:
    'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9C4.63 15.55 4 13.85 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1C19.37 8.45 20 10.15 20 12c0 4.42-3.58 8-8 8z',
  noChannel:
    'M7 11v2h10v-2H7zm5-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
};

function icon(path: string, cls = 'ydx-menu-icon'): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}

/** Tiny element builder: never uses innerHTML (YouTube enforces Trusted Types). */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; attrs?: Record<string, string> } = {},
  ...children: (Node | null)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  for (const c of children) if (c) node.append(c);
  return node;
}

function waitFor(selector: string, timeoutMs: number): Promise<Element | null> {
  const found = document.querySelector(selector);
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const obs = new MutationObserver(() => {
      const hit = document.querySelector(selector);
      if (hit) {
        obs.disconnect();
        clearTimeout(timer);
        resolve(hit);
      }
    });
    const timer = setTimeout(() => {
      obs.disconnect();
      resolve(null);
    }, timeoutMs);
    obs.observe(document.documentElement, { childList: true, subtree: true });
  });
}

export class HomeFeed {
  constructor(private readonly options: HomeFeedOptions = {}) {
    window.addEventListener('click', this.onYtMenuClick, true);
  }

  private lastResponse: FeedResponse | null = null;
  /** This visit's draw; replaced on every navigation to Home (including the logo). */
  private view = newView();
  private seenObserver: IntersectionObserver | null = null;
  private seenPending = new Set<string>();
  /** Discover cards among them, with the source that found each (for on-device measurement). */
  private seenSources = new Map<string, string>();
  private seenCounted = new Set<string>();
  private seenTimer: ReturnType<typeof setTimeout> | null = null;
  private mounting: Promise<void> | null = null;
  private archive: ArchiveState | null = null;

  private root(): HTMLElement | null {
    return document.getElementById(FEED_ROOT_ID);
  }

  /** Mount (or refresh) the feed on the home route. Safe to call repeatedly. */
  mount(): Promise<void> {
    if (!this.mounting) {
      this.flushSeen();
      this.view = newView();
      this.seenCounted.clear();
    }
    this.mounting ??= this.doMount().finally(() => {
      this.mounting = null;
    });
    return this.mounting;
  }

  private async doMount(): Promise<void> {
    try {
      const host = await waitFor(SEL.homeMount, MOUNT_TIMEOUT_MS);
      if (!isHomeRoute() || !document.documentElement.classList.contains(ENABLED_CLASS)) return;
      if (!host) throw new Error(`home container not found (${SEL.homeMount})`);
      let root = this.root();
      if (root && root.parentElement !== host) {
        root.remove();
        root = null;
      }
      if (!root) {
        root = el('div', { attrs: { id: FEED_ROOT_ID, role: 'feed', 'aria-label': 'Recommended videos' } });
        host.prepend(root);
        document.documentElement.classList.add(FEED_MOUNTED_CLASS);
        if (!this.lastResponse) root.append(el('p', { class: 'ydx-note', text: 'Loading your feed…' }));
      }
      await this.refresh();
    } catch (err) {
      this.failOpen(err);
    }
  }

  unmount(): void {
    this.flushSeen();
    this.seenObserver?.disconnect();
    this.seenObserver = null;
    this.closeMenu();
    this.teardownArchive();
    this.root()?.remove();
    document.documentElement.classList.remove(FEED_MOUNTED_CLASS);
  }

  /** Re-request the feed and redraw it in the existing root. */
  async refresh(): Promise<void> {
    const root = this.root();
    if (!root) return;
    try {
      const res = await send({ type: 'feed:get', view: this.view });
      if (!res) throw new Error('no feed response from service worker');
      this.lastResponse = res;
      this.render(root, res);
    } catch (err) {
      this.failOpen(err);
    }
  }

  /**
   * Called when the service worker reports new data. While waiting on data, redraw. Otherwise
   * new uploads (a subscriptions-feed sync finishing after the cached render) are patched in by
   * redrawing only if the user is still at the top with nothing open; anything else just fills in
   * details on the cards already on screen.
   */
  onDataUpdated(): void {
    const r = this.lastResponse;
    if (!this.root() || !isHomeRoute()) return;
    // Never redraw under someone who has scrolled into the older-uploads section.
    if (this.archive && this.archive.offset > 0) return;
    if (!r || r.status !== 'ok' || r.coldStart || r.trendingPending) void this.refresh();
    else void this.patch();
  }

  /** True when redrawing wouldn't move anything the user is looking at or working with. */
  private canRedraw(root: HTMLElement): boolean {
    return (
      window.scrollY < REDRAW_MAX_SCROLL_PX &&
      !this.openMenu &&
      !root.querySelector('.ydx-card-hidden') &&
      !(this.archive && this.archive.offset > 0)
    );
  }

  /** New videos at the top: redraw if that's safe, else only enrich what's shown. */
  async patch(): Promise<void> {
    const root = this.root();
    if (!root) return;
    try {
      const res = await send({ type: 'feed:get', view: this.view });
      if (!res || this.root() !== root) return;
      const onScreen = new Set([...root.querySelectorAll<HTMLElement>('.ydx-card[data-video]')].map((c) => c.dataset.video));
      const added = [...res.trending, ...res.items].some((i) => !onScreen.has(i.videoId));
      if (added && res.status === 'ok' && this.canRedraw(root)) {
        this.lastResponse = res;
        this.render(root, res);
      } else {
        await this.enrich(res);
      }
    } catch (err) {
      console.warn('[YouTube Reborn] could not refresh the feed', err);
    }
  }

  /**
   * Fill in details that arrived after the cards were drawn (durations and view counts are
   * fetched in the background) without redrawing or moving anything on screen.
   */
  async enrich(prefetched?: FeedResponse): Promise<void> {
    const root = this.root();
    if (!root) return;
    const cards = [...root.querySelectorAll<HTMLElement>('.ydx-card[data-video]')];
    const missing = (c: HTMLElement) => !c.querySelector('.ydx-duration') || !c.dataset.views;
    if (!cards.some(missing)) return;
    try {
      const latest = new Map<string, FeedItem>();
      const res = prefetched ?? (await send({ type: 'feed:get', view: this.view }));
      for (const i of [...(res?.trending ?? []), ...(res?.items ?? [])]) latest.set(i.videoId, i);
      const a = this.archive;
      for (let offset = 0; a && offset < a.offset; offset += 100) {
        const page = await send({ type: 'feed:more', offset, limit: Math.min(100, a.offset - offset), exclude: a.exclude });
        for (const i of page?.items ?? []) latest.set(i.videoId, i);
      }
      for (const card of cards) {
        const item = latest.get(card.dataset.video ?? '');
        if (!item || !card.isConnected) continue;
        const duration = formatDuration(item.durationSec);
        if (duration && !card.querySelector('.ydx-duration')) {
          card.querySelector('.ydx-thumb')?.append(el('span', { class: 'ydx-duration', text: duration }));
        }
        if (!card.dataset.views && item.viewCount !== undefined) {
          card.querySelector('.ydx-sub')?.replaceWith(this.subLine(item, card.dataset.section as Section));
          card.dataset.views = String(item.viewCount);
        }
      }
    } catch (err) {
      console.warn('[YouTube Reborn] could not refresh video details', err);
    }
  }

  private failOpen(err: unknown): void {
    console.error('[YouTube Reborn] feed failed; showing YouTube’s feed instead', err);
    document.documentElement.classList.remove(ENABLED_CLASS);
    this.unmount();
  }

  private render(root: HTMLElement, res: FeedResponse): void {
    this.teardownArchive();
    this.closeMenu();
    const nodes: Node[] = [];
    if (res.trending.length) {
      nodes.push(
        el(
          'section',
          { class: 'ydx-top', attrs: { 'aria-label': 'Most viewed today' } },
          el('h2', { class: 'ydx-section-title', text: 'Most viewed today' }),
          el('div', { class: 'ydx-grid' }, ...res.trending.map((item) => this.card(item, 'trending'))),
        ),
      );
    }
    if (res.status === 'loggedOut') {
      nodes.push(
        this.message(
          'Sign in to YouTube to get your feed',
          'Reborn builds recommendations from the channels you subscribe to. Sign in, then reload this page.',
        ),
      );
    } else if (res.status === 'syncing') {
      nodes.push(this.message('Building your feed…', 'Reading your subscriptions and their latest uploads. This takes a minute or two the first time.'));
    } else if (res.status === 'empty') {
      nodes.push(this.message('Nothing here yet', 'Subscribe to a few channels and their uploads will show up here.'));
    } else {
      if (res.coldStart) {
        nodes.push(el('p', { class: 'ydx-note', text: 'Building your recommendations… for now, here are your subscriptions.' }));
      }
      if (res.trending.length) nodes.push(el('h2', { class: 'ydx-section-title', text: 'For you' }));
      nodes.push(
        el('div', { class: 'ydx-grid' }, ...res.items.map((item) => this.card(item, item.discover ? 'discover' : 'subscription'))),
      );
      nodes.push(this.archiveSection([...res.trending, ...res.items].map((i) => i.videoId)));
    }
    root.replaceChildren(...nodes);
    this.watchSeen(root);
  }

  /** Report cards that come on screen, once per visit, so videos passed over sink next time. */
  private watchSeen(root: HTMLElement): void {
    this.seenObserver?.disconnect();
    if (typeof IntersectionObserver === 'undefined') return;
    this.seenObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.video;
          if (!e.isIntersecting || !id || this.seenCounted.has(id)) continue;
          this.seenCounted.add(id);
          this.seenPending.add(id);
          const source = (e.target as HTMLElement).dataset.source;
          if (source) this.seenSources.set(id, source);
          this.seenObserver?.unobserve(e.target);
        }
        if (this.seenPending.size && !this.seenTimer) this.seenTimer = setTimeout(() => this.flushSeen(), SEEN_FLUSH_MS);
      },
      { threshold: SEEN_THRESHOLD },
    );
    for (const card of root.querySelectorAll<HTMLElement>('.ydx-grid > .ydx-card[data-video]')) {
      if (!card.closest('.ydx-archive')) this.seenObserver.observe(card);
    }
  }

  private flushSeen(): void {
    if (this.seenTimer) clearTimeout(this.seenTimer);
    this.seenTimer = null;
    if (!this.seenPending.size) return;
    const ids = [...this.seenPending];
    const discover = Object.fromEntries(ids.flatMap((id) => (this.seenSources.has(id) ? [[id, this.seenSources.get(id)!]] : [])));
    this.seenPending.clear();
    this.seenSources.clear();
    void send({ type: 'feed:impressions', ids, view: this.view, ...(Object.keys(discover).length ? { discover } : {}) }).catch(() => undefined);
  }

  /**
   * "Earlier from your subscriptions": older uploads below the main feed, loaded a page at a
   * time as the user scrolls near the bottom.
   */
  private archiveSection(onScreen: string[]): HTMLElement {
    const heading = el('h2', { class: 'ydx-section-title', text: 'Earlier from your subscriptions' });
    heading.hidden = true;
    const grid = el('div', { class: 'ydx-grid' });
    const sentinel = el('div', { class: 'ydx-sentinel', attrs: { 'aria-hidden': 'true' } });
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void this.loadMore();
      },
      { rootMargin: `0px 0px ${ARCHIVE_PREFETCH_PX}px 0px` },
    );
    observer.observe(sentinel);
    this.archive = {
      grid,
      heading,
      sentinel,
      observer,
      exclude: onScreen,
      shown: new Set(onScreen),
      offset: 0,
      hasMore: true,
      loading: false,
    };
    return el('section', { class: 'ydx-archive', attrs: { 'aria-label': 'Earlier from your subscriptions' } }, heading, grid, sentinel);
  }

  private teardownArchive(): void {
    this.archive?.observer.disconnect();
    this.archive = null;
  }

  /** Fetch and append the next page of older uploads. */
  async loadMore(): Promise<void> {
    const a = this.archive;
    if (!a || a.loading || !a.hasMore) return;
    a.loading = true;
    a.sentinel.textContent = 'Loading more…';
    try {
      const request = { type: 'feed:more', offset: a.offset, limit: ARCHIVE_PAGE_SIZE, exclude: a.exclude } as const;
      let page = await send(request);
      // Past what the subscriptions feed has covered (or at the end): read further back first, so
      // these uploads come with durations and older ones appear.
      for (let i = 0; page?.deeper && this.options.deepen && i < MAX_DEEPER_PER_PAGE; i++) {
        if (!(await this.options.deepen().catch(() => false))) break;
        if (this.archive !== a) return;
        page = await send(request);
      }
      if (this.archive !== a) return; // feed was redrawn meanwhile
      if (!page) throw new Error('no archive response from service worker');
      a.offset += ARCHIVE_PAGE_SIZE;
      a.hasMore = page.hasMore;
      const fresh = page.items.filter((i) => !a.shown.has(i.videoId));
      for (const i of fresh) a.shown.add(i.videoId);
      if (fresh.length) {
        a.heading.hidden = false;
        a.grid.append(...fresh.map((item) => this.card(item, 'subscription')));
      }
    } catch (err) {
      console.warn('[YouTube Reborn] could not load older uploads', err);
      a.hasMore = false;
    } finally {
      a.loading = false;
    }
    if (this.archive !== a) return;
    if (!a.hasMore) {
      a.observer.disconnect();
      a.sentinel.textContent = a.shown.size > a.exclude.length
        ? 'That’s everything from your subscriptions for now.'
        : '';
      a.sentinel.classList.add('ydx-end');
      return;
    }
    a.sentinel.textContent = '';
    // If the page was short and the bottom is still in reach, the observer won't fire again.
    if (a.sentinel.getBoundingClientRect().top < window.innerHeight + ARCHIVE_PREFETCH_PX) void this.loadMore();
  }

  private message(title: string, body: string): HTMLElement {
    return el('div', { class: 'ydx-message' }, el('h2', { text: title }), el('p', { text: body }));
  }

  private card(item: FeedItem, section: Section): HTMLElement {
    const href = `/watch?v=${encodeURIComponent(item.videoId)}`;
    const duration = formatDuration(item.durationSec);
    const thumb = el(
      'a',
      { class: 'ydx-thumb', attrs: { href, tabindex: '-1', 'aria-hidden': 'true' } },
      thumbnailImage(item.videoId),
      duration ? el('span', { class: 'ydx-duration', text: duration }) : null,
    );
    // Like YouTube's cards: the channel's avatar, then title and one line of details.
    const meta = el(
      'div',
      { class: 'ydx-meta' },
      this.avatar(item),
      el(
        'div',
        { class: 'ydx-text' },
        el('a', { class: 'ydx-title', text: item.title, attrs: { href, title: item.title } }),
        this.subLine(item, section),
        (section === 'discover' || section === 'trending') && item.reason ? this.reasonLine(item.reason, item.reasonChannelId) : null,
      ),
    );
    const card = el(
      'div',
      { class: 'ydx-card', attrs: { 'data-channel': item.channelId, 'data-video': item.videoId, 'data-section': section } },
      thumb,
      meta,
    );
    if (item.viewCount !== undefined) card.dataset.views = String(item.viewCount);
    if (section === 'discover' && item.source) card.dataset.source = item.source;
    meta.append(this.menu(item, section, card));
    return card;
  }

  /** The explanation under a card; the channel it names links to that channel. */
  private reasonLine(text: string, channelId?: string): HTMLElement {
    if (!channelId) return el('div', { class: 'ydx-reason', text });
    return el('div', { class: 'ydx-reason' }, el('a', { text, attrs: { href: `/channel/${encodeURIComponent(channelId)}` } }));
  }

  /** The channel's avatar (a letter when we don't have the picture), linking to the channel. */
  private avatar(item: FeedItem): HTMLElement {
    const link = el('a', { class: 'ydx-avatar', attrs: { href: `/channel/${encodeURIComponent(item.channelId)}`, tabindex: '-1', 'aria-hidden': 'true' } });
    const letter = el('span', { class: 'ydx-avatar-letter', text: (item.channelTitle || '?').trim().charAt(0).toUpperCase() });
    if (!item.channelAvatarUrl) {
      link.append(letter);
      return link;
    }
    const img = el('img', { attrs: { src: item.channelAvatarUrl, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' } });
    img.addEventListener('error', () => img.replaceWith(letter));
    link.append(img);
    return link;
  }

  /** "Channel  ▷ 5.8M  3 days ago  Discover", on one line like YouTube's home cards. */
  private subLine(item: FeedItem, section: Section): HTMLElement {
    const views = formatViewsShort(item.viewCount);
    return el(
      'div',
      { class: 'ydx-sub' },
      el('a', { class: 'ydx-channel', text: item.channelTitle || 'Unknown channel', attrs: { href: `/channel/${encodeURIComponent(item.channelId)}` } }),
      views ? el('span', { class: 'ydx-views', attrs: { 'aria-label': formatViews(item.viewCount) ?? '' } }, icon(ICONS.views, 'ydx-views-icon'), el('span', { text: views })) : null,
      el('span', { text: formatAge(item.publishedAt) }),
      section === 'discover' ? el('span', { class: 'ydx-badge', text: 'Discover' }) : null,
    );
  }

  /**
   * The ⋮ menu. It opens YouTube's own menu for the video (queue, Watch Later, playlists,
   * Download, Share, Report: all run by YouTube), with our feed actions added to it. If YouTube's
   * app can't open it, our own menu with just our actions appears instead.
   */
  private menu(item: FeedItem, section: Section, card: HTMLElement): HTMLElement {
    const anchor = `m${++this.menuSeq}`;
    const button = el('button', {
      class: 'ydx-menu-btn',
      attrs: { type: 'button', 'aria-label': 'More actions', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-ydx-anchor': anchor },
    });
    button.append(icon(ICONS.moreVert));
    // Ours shape this feed: [title, YouTube icon name, our fallback icon, action].
    const own: [string, string, string, () => void][] = [];
    if (section === 'discover') own.push(['More like this', 'THUMB_UP', ICONS.more, () => void this.moreLikeThis(item, card)]);
    own.push(['Not interested in this video', 'HIDE', ICONS.notInterested, () => void this.hideVideo(item, card)]);
    if (section !== 'subscription') own.push(['Don’t recommend this channel', 'REMOVE', ICONS.noChannel, () => void this.hideChannel(item, card)]);

    const list = el('div', { class: 'ydx-menu', attrs: { role: 'menu' } });
    list.hidden = true;
    for (const [label, , path, run] of own) {
      const b = el('button', { class: 'ydx-menu-item', attrs: { type: 'button', role: 'menuitem' } }, icon(path), el('span', { text: label }));
      b.addEventListener('click', () => {
        this.closeMenu();
        run();
      });
      list.append(b);
    }

    button.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (this.openMenu?.list === list) return this.closeMenu();
      this.closeMenu();
      if (await openYtMenu(item.videoId, anchor, own.map(([title, icon]) => ({ title, icon })))) {
        this.ownInYtMenu = new Map(own.map(([title, , , run]) => [title, run]));
      } else {
        this.showMenu({ button, list });
      }
    });
    list.addEventListener('keydown', (e) => {
      const items = [...list.querySelectorAll<HTMLButtonElement>('.ydx-menu-item')];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus();
      else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus();
      else return;
      e.preventDefault();
    });
    return el('div', { class: 'ydx-menu-wrap' }, button, list);
  }

  private openMenu: { button: HTMLElement; list: HTMLElement } | null = null;

  private showMenu(m: { button: HTMLElement; list: HTMLElement }): void {
    this.closeMenu();
    this.openMenu = m;
    m.list.hidden = false;
    m.button.setAttribute('aria-expanded', 'true');
    m.list.querySelector<HTMLButtonElement>('.ydx-menu-item')?.focus();
    document.addEventListener('click', this.onOutsideClick, true);
    document.addEventListener('keydown', this.onMenuKey, true);
  }

  private closeMenu(refocus = false): void {
    const m = this.openMenu;
    if (!m) return;
    this.openMenu = null;
    m.list.hidden = true;
    m.button.setAttribute('aria-expanded', 'false');
    if (refocus) m.button.focus();
    document.removeEventListener('click', this.onOutsideClick, true);
    document.removeEventListener('keydown', this.onMenuKey, true);
  }

  private onOutsideClick = (e: Event): void => {
    const m = this.openMenu;
    if (m && !m.list.contains(e.target as Node) && !m.button.contains(e.target as Node)) this.closeMenu();
  };

  private onMenuKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.closeMenu(true);
  };

  private menuSeq = 0;
  /** Our own items in YouTube's open menu, by title; they run our code, not YouTube's. */
  private ownInYtMenu: Map<string, () => void> | null = null;

  /** Catches taps on our own items in YouTube's menu before YouTube handles them. */
  private onYtMenuClick = (e: Event): void => {
    const own = this.ownInYtMenu;
    if (!own) return;
    const row = (e.target as Element | null)?.closest?.('yt-list-item-view-model');
    if (!row) return;
    const run = own.get(row.textContent?.trim() ?? '');
    if (!run) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.ownInYtMenu = null;
    void closeYtMenu();
    run();
  };

  private async moreLikeThis(item: FeedItem, card: HTMLElement): Promise<void> {
    await send({ type: 'feedback', channelId: item.channelId, kind: 'more' });
    const note = card.querySelector('.ydx-reason') ?? card.querySelector('.ydx-meta')?.appendChild(el('div', { class: 'ydx-reason' }));
    if (note) note.textContent = 'Got it: you’ll see more like this.';
  }

  /** Swap `cards` for one placeholder with an Undo button; Undo puts everything back. */
  private hideWithUndo(cards: HTMLElement[], message: string, undo: () => Promise<unknown>): void {
    const [first, ...rest] = cards;
    if (!first) return;
    const placeholder = el('div', { class: 'ydx-card ydx-card-hidden', attrs: { role: 'status' } });
    const undoBtn = el('button', { class: 'ydx-undo', text: 'Undo', attrs: { type: 'button' } });
    placeholder.append(el('p', { class: 'ydx-hidden-note', text: message }), undoBtn);
    first.replaceWith(placeholder);
    for (const c of rest) c.hidden = true;
    undoBtn.focus();
    undoBtn.addEventListener('click', async () => {
      undoBtn.disabled = true;
      await undo();
      placeholder.replaceWith(first);
      for (const c of rest) c.hidden = false;
      first.querySelector<HTMLElement>('.ydx-menu-btn')?.focus();
    });
  }

  private async hideVideo(item: FeedItem, card: HTMLElement): Promise<void> {
    await send({ type: 'feedback:video', videoId: item.videoId });
    const message = 'Video hidden. You won’t see it again.';
    const undo = () => send({ type: 'feedback:undo', videoId: item.videoId });
    if (card.dataset.section === 'trending') await this.refillTopRow(message, undo, []);
    else this.hideWithUndo([card], message, undo);
  }

  private async hideChannel(item: FeedItem, card: HTMLElement): Promise<void> {
    await send({ type: 'feedback', channelId: item.channelId, kind: 'notInterested' });
    const message = `We won’t recommend ${item.channelTitle || 'this channel'} anymore.`;
    const undo = () => send({ type: 'feedback:undo', channelId: item.channelId });
    // Every recommendation from that channel on the page goes; your subscriptions stay.
    const all = [
      ...(this.root()?.querySelectorAll<HTMLElement>(`.ydx-card[data-channel="${CSS.escape(item.channelId)}"]`) ?? []),
    ].filter((c) => c.dataset.section !== 'subscription');
    const inTopRow = all.some((c) => c.dataset.section === 'trending');
    const elsewhere = all.filter((c) => c.dataset.section !== 'trending');
    if (card.dataset.section === 'trending') {
      await this.refillTopRow(message, undo, elsewhere);
    } else {
      const restoreTop = inTopRow ? await this.swapTopRow() : null;
      this.hideWithUndo([card, ...elsewhere.filter((c) => c !== card)], message, async () => {
        await undo();
        restoreTop?.();
      });
    }
  }

  /**
   * Redraw the "Most viewed today" cards from a fresh feed, which already leaves out hidden
   * videos and creators, so the next biggest video moves up at once. Returns a function that puts
   * the previous cards back (for Undo), or null if there is no top row.
   */
  private async swapTopRow(): Promise<(() => void) | null> {
    const grid = this.root()?.querySelector<HTMLElement>('.ydx-top .ydx-grid');
    if (!grid) return null;
    const before = [...grid.children];
    const res = await send({ type: 'feed:get', view: this.view }).catch(() => null);
    if (!res || !grid.isConnected) return null;
    grid.replaceChildren(...res.trending.map((i) => this.card(i, 'trending')));
    return () => grid.replaceChildren(...before);
  }

  /** Top-row hide: refill the row now and offer Undo in a note above it. */
  private async refillTopRow(message: string, undo: () => Promise<unknown>, alsoHide: HTMLElement[]): Promise<void> {
    for (const c of alsoHide) c.hidden = true;
    const restore = await this.swapTopRow();
    const section = this.root()?.querySelector<HTMLElement>('.ydx-top');
    if (!section) return;
    section.querySelector('.ydx-top-status')?.remove();
    const undoBtn = el('button', { class: 'ydx-undo', text: 'Undo', attrs: { type: 'button' } });
    const note = el('div', { class: 'ydx-top-status', attrs: { role: 'status' } }, el('span', { text: message }), undoBtn);
    section.querySelector('.ydx-section-title')?.after(note);
    undoBtn.focus();
    undoBtn.addEventListener('click', async () => {
      undoBtn.disabled = true;
      await undo();
      restore?.();
      for (const c of alsoHide) c.hidden = false;
      note.remove();
    });
  }
}


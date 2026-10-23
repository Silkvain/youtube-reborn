import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isLoggedOutResponse,
  parseChannelPage,
  parseDuration,
  parseNewsHub,
  parseRelativeTime,
  parseResolveUrl,
  parseRss,
  parseSearchResults,
  parseSubscriptionsPage,
  parseVideosTab,
  parseViewCount,
  sapisidAuthorization,
} from '../src/content/innertube';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const json = (name: string) => JSON.parse(fixture(name));
const VERITASIUM = 'UCHnyfMqiRRG1u-2MsSQLbXA';

describe('real InnerTube fixtures', () => {
  it('resolve_url gives the channel ID', () => {
    expect(parseResolveUrl(json('resolve-url.json'))).toBe(VERITASIUM);
  });

  it('channel home page gives metadata and featured channels', () => {
    const page = parseChannelPage(json('channel-home.json'));
    expect(page.channel).toMatchObject({ id: VERITASIUM, title: 'Veritasium', handle: '@veritasium' });
    expect(page.featured.length).toBeGreaterThanOrEqual(5);
    for (const f of page.featured) {
      expect(f.id).toMatch(/^UC[\w-]{22}$/);
      expect(f.id).not.toBe(VERITASIUM);
      expect(f.title).not.toBe('');
    }
    expect(page.featured.find((f) => f.title === 'Veritasium en Français')?.handle).toBe('@VeritasiumFR');
  });

  it('videos tab gives uploads with durations and approximate dates', () => {
    const now = Date.parse('2026-10-15T12:00:00Z');
    const videos = parseVideosTab(json('channel-videos.json'), VERITASIUM, now);
    expect(videos.length).toBe(3);
    for (const v of videos) {
      expect(v.id).toMatch(/^[\w-]{11}$/);
      expect(v.channelId).toBe(VERITASIUM);
      expect(v.title.length).toBeGreaterThan(0);
      expect(v.publishedAt).toBeLessThan(now);
      expect(v.thumbnailUrl).toMatch(/^https:\/\/i\.ytimg\.com\/vi\//);
    }
    expect(videos[0]!.durationSec).toBe(34 * 60 + 32);
    expect(videos[0]!.viewCount).toBe(5_800_000);
    expect(videos.every((v) => typeof v.viewCount === 'number' && v.viewCount > 0)).toBe(true);
  });

  it('logged-out subscriptions response is detected', () => {
    const r = json('subscriptions-logged-out.json');
    expect(isLoggedOutResponse(r)).toBe(true);
    expect(parseSubscriptionsPage(r)).toEqual({ loggedOut: true, channels: [], continuation: null });
  });

  it('"this week, by views" search gives videos with channels, views and dates', () => {
    const now = Date.parse('2026-10-15T12:00:00Z');
    const videos = parseSearchResults(json('search-this-week-by-views.json'), now);
    expect(videos).toHaveLength(6);
    expect(videos[0]).toMatchObject({
      id: 'gDJ-ini7fF0',
      channelId: 'UCWOA1ZGywLbqmigxE4Qlvuw',
      channelTitle: 'Netflix',
      viewCount: 30_132_128,
      durationSec: 161,
      thumbnailUrl: 'https://i.ytimg.com/vi/gDJ-ini7fF0/mqdefault.jpg',
    });
    expect(videos[0]!.publishedAt).toBe(now - 86_400_000);
    for (const v of videos) {
      expect(v.channelId).toMatch(/^UC[\w-]{22}$/);
      expect(v.viewCount).toBeGreaterThan(1_000_000);
      expect(now - v.publishedAt).toBeLessThanOrEqual(7 * 86_400_000);
    }
  });

  it('search parser skips live streams and shorts', () => {
    const base = (id: string, extra: object) => ({
      videoRenderer: {
        videoId: id,
        title: { runs: [{ text: id }] },
        ownerText: { runs: [{ text: 'C', navigationEndpoint: { browseEndpoint: { browseId: 'UCaaaaaaaaaaaaaaaaaaaaaa' } } }] },
        viewCountText: { simpleText: '1,000 views' },
        publishedTimeText: { simpleText: '1 day ago' },
        ...extra,
      },
    });
    const res = { contents: [
      base('ok', {}),
      base('live', { viewCountText: { runs: [{ text: '5,000' }, { text: ' watching' }] }, publishedTimeText: undefined }),
      base('short', { navigationEndpoint: { commandMetadata: { webCommandMetadata: { url: '/shorts/short' } } } }),
    ] };
    expect(parseSearchResults(res, 0).map((v) => v.id)).toEqual(['ok']);
  });

  it('signed-in subscriptions page (structure captured Oct 2026, channels anonymised)', () => {
    const r = parseSubscriptionsPage(json('subscriptions-logged-in.json'));
    expect(r.loggedOut).toBe(false);
    // All subscriptions arrive in one response; there is no pagination token.
    expect(r.continuation).toBeNull();
    expect(r.channels).toEqual([1, 2, 3].map((i) => ({
      id: `UCfixture0${i}xxxxxxxxxxxxx`,
      title: `Fixture Channel ${i}`,
      handle: `@fixturechannel${i}`,
      thumbnailUrl: `https://yt3.example/fixture${i}=s176`,
    })));
  });

  it('RSS feed gives 15 entries with descriptions and flags shorts', () => {
    const feed = parseRss(fixture('rss-veritasium.xml'));
    expect(feed.channelId).toBe(VERITASIUM);
    expect(feed.title).toBe('Veritasium');
    expect(feed.videos).toHaveLength(15);
    expect(feed.videos.every((v) => v.channelId === VERITASIUM && !Number.isNaN(v.publishedAt))).toBe(true);
    expect(feed.videos.some((v) => v.description.length > 50)).toBe(true);
    expect(feed.videos.some((v) => v.isShort)).toBe(true);
    expect(feed.videos.some((v) => !v.isShort)).toBe(true);
    expect(feed.videos.every((v) => Number.isInteger(v.viewCount))).toBe(true);
    expect(feed.videos[0]!.viewCount).toBe(6761);
  });
});

describe('subscriptions parser', () => {
  // Shape of the logged-in /feed/channels page: channelRenderer items plus a continuation.
  const page = {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [{ shelfRenderer: { content: { expandedShelfContentsRenderer: { items: [
          { channelRenderer: { channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', title: { simpleText: 'Alpha' }, navigationEndpoint: { browseEndpoint: { browseId: 'UCaaaaaaaaaaaaaaaaaaaaaa', canonicalBaseUrl: '/@alpha' } }, thumbnail: { thumbnails: [{ url: '//yt3.example/a.jpg' }] } } },
          { channelRenderer: { channelId: 'UCbbbbbbbbbbbbbbbbbbbbbb', title: { simpleText: 'Beta' }, subscriberCountText: { simpleText: '@beta' } } },
          { channelRenderer: { title: { simpleText: 'No ID, skipped' } } },
        ] } } } }] } },
        { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'TOKEN1' } } } }] } } } }],
      },
    },
  };

  it('collects channels and the continuation token', () => {
    const r = parseSubscriptionsPage(page);
    expect(r.loggedOut).toBe(false);
    expect(r.continuation).toBe('TOKEN1');
    expect(r.channels).toEqual([
      { id: 'UCaaaaaaaaaaaaaaaaaaaaaa', title: 'Alpha', handle: '@alpha', thumbnailUrl: 'https://yt3.example/a.jpg' },
      { id: 'UCbbbbbbbbbbbbbbbbbbbbbb', title: 'Beta', handle: '@beta', thumbnailUrl: undefined },
    ]);
  });

  it('parses continuation responses', () => {
    const cont = {
      onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [
        { channelRenderer: { channelId: 'UCcccccccccccccccccccccc', title: { runs: [{ text: 'Gam' }, { text: 'ma' }] } } },
      ] } }],
    };
    const r = parseSubscriptionsPage(cont);
    expect(r.channels.map((c) => c.title)).toEqual(['Gamma']);
    expect(r.continuation).toBeNull();
  });

  it('never throws on junk', () => {
    for (const junk of [null, undefined, 42, 'x', [], { contents: { a: [null, 1, { channelRenderer: 'x' }] } }]) {
      expect(() => parseSubscriptionsPage(junk)).not.toThrow();
      expect(() => parseChannelPage(junk)).not.toThrow();
      expect(() => parseVideosTab(junk, 'UCx', 0)).not.toThrow();
      expect(parseResolveUrl(junk)).toBeNull();
    }
    expect(parseRss('<not xml')).toEqual({ channelId: null, title: '', videos: [] });
  });
});

describe('small parsers', () => {
  it('durations', () => {
    expect(parseDuration('34:32')).toBe(2072);
    expect(parseDuration('1:02:03')).toBe(3723);
    expect(parseDuration('LIVE')).toBeUndefined();
  });

  it('view counts', () => {
    expect(parseViewCount('5.8M views')).toBe(5_800_000);
    expect(parseViewCount('19M views')).toBe(19_000_000);
    expect(parseViewCount('1.2K views')).toBe(1200);
    expect(parseViewCount('5.8 million views')).toBe(5_800_000);
    expect(parseViewCount('1,234 views')).toBe(1234);
    expect(parseViewCount('1 view')).toBe(1);
    expect(parseViewCount('No views')).toBe(0);
    expect(parseViewCount('5.8M')).toBeUndefined();
    expect(parseViewCount('2d ago')).toBeUndefined();
  });

  it('relative times', () => {
    const now = 1_000_000_000_000;
    const day = 86_400_000;
    expect(parseRelativeTime('2d ago', now)).toBe(now - 2 * day);
    expect(parseRelativeTime('3 weeks ago', now)).toBe(now - 21 * day);
    expect(parseRelativeTime('1 month ago', now)).toBe(now - 30 * day);
    expect(parseRelativeTime('Streamed 5 hours ago', now)).toBe(now - 5 * 3_600_000);
    expect(parseRelativeTime('10mo ago', now)).toBe(now - 300 * day);
    expect(parseRelativeTime('5.8M', now)).toBeUndefined();
  });

  it('SAPISIDHASH header', async () => {
    const h = await sapisidAuthorization('a=1; SAPISID=abc/def; b=2', 1_700_000_000_000);
    expect(h).toMatch(/^SAPISIDHASH 1700000000_[0-9a-f]{40}$/);
    expect(await sapisidAuthorization('a=1')).toBeNull();
  });
});

describe('YouTube News hub (top stories for the region)', () => {
  // Signed-out capture for GB, 2026-10-17: story shelves, a news-posts shelf and a "Live now" shelf.
  const json = JSON.parse(fixture('news-hub-gb.json'));
  const now = Date.parse('2026-10-17T00:07:00Z');

  it('reads the stories in YouTube\'s order, with headlines', () => {
    const stories = parseNewsHub(json, now);
    expect(stories.map((s) => s.headline).slice(0, 3)).toEqual([
      'QUICK TAKE: One week in the job: Trump’s new press sec is OUT',
      'Families leave flowers at Oregon school after deadly shooting | AFP',
      "Is Zelenskyy Trump's 'scapegoat'? How EU can help Ukraine without US",
    ]);
    expect(stories.some((s) => s.headline === 'Yorkshire Wildlife Park reopens after deadly tiger attack')).toBe(true);
  });

  it('skips the posts and live shelves, and keeps only finished videos with a channel and an age', () => {
    const stories = parseNewsHub(json, now);
    expect(stories.some((s) => /Latest news posts|Live now/.test(s.headline))).toBe(false);
    for (const s of stories) {
      expect(s.videos.length).toBeGreaterThan(0);
      for (const v of s.videos) {
        expect(v.channelId).toMatch(/^UC/);
        expect(v.channelTitle).not.toBe('');
        expect(v.publishedAt).toBeLessThanOrEqual(now);
      }
    }
  });

  it('reads which outlets carry YouTube\'s verified badge', () => {
    const all = parseNewsHub(json, now, 20, 20).flatMap((s) => s.videos);
    expect(all.find((v) => v.channelTitle === 'Sky News')?.verified).toBe(true);
    expect(all.find((v) => v.channelTitle === 'BBC News')?.verified).toBe(true);
    expect(all.every((v) => typeof v.verified === 'boolean')).toBe(true);
  });

  it('caps stories and videos per story', () => {
    const stories = parseNewsHub(json, now, 2, 1);
    expect(stories).toHaveLength(2);
    expect(stories.every((s) => s.videos.length === 1)).toBe(true);
  });
});

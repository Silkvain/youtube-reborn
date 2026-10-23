import type { FeedItem } from '../src/shared/types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  historyCounts,
  isChannelHomePath,
  parseHistoryPage,
  parseSubscriptionFeedPage,
  parseVideoItems,
  parseWatchPage,
  summarisePage,
} from '../src/content/innertube';
import { feedTimeline, reachesKnown } from '../src/background/subsfeed';

const json = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));
const NOW = Date.parse('2026-10-15T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const cid = (n: number) => `UCsynth${String(n).padStart(2, '0')}xxxxxxxxxxxxxxx`;

// subscriptions-feed-real-page1.json is page 1 of a real signed-in feed (Oct 2026), anonymised:
// every ID, title, channel name and handle is synthetic, but the structure is YouTube's.
describe('subscriptions feed (real page 1, anonymised)', () => {
  const page = () => parseSubscriptionFeedPage(json('subscriptions-feed-real-page1.json'), NOW);
  const vid = (n: number) => `vid${String(n).padStart(3, '0')}xxxxx`;
  const ch = (n: number) => `UCfixture${String(n).padStart(2, '0')}xxxxxxxxxxxxx`;

  it('parses every video once, with channel, duration, views and age', () => {
    const p = page();
    expect(p.loggedOut).toBe(false);
    expect(p.continuation).toBe('FIXTURE_CONTINUATION_TOKEN');
    expect(p.videos.map((v) => v.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 10, 11, 12].map(vid));
    expect(p.videos.find((v) => v.id === vid(1))).toMatchObject({
      channelId: ch(1),
      channelTitle: 'Fixture Channel 1',
      title: 'Fixture video 1',
      durationSec: 1 * 3600 + 51 * 60 + 3,
      viewCount: 151_000,
      publishedAt: NOW - DAY,
    });
    expect(p.videos.every((v) => v.durationSec && v.viewCount !== undefined)).toBe(true);
  });

  it('skips Shorts and the collaboration video with no single channel', () => {
    expect(page().skipped).toEqual({ shorts: 2, live: 0, upcoming: 0, incomplete: 1 });
  });

  it('keeps past streams ("Streamed 5 days ago") as normal videos', () => {
    expect(page().videos.find((v) => v.id === vid(4))).toMatchObject({ durationSec: 8 * 3600 + 30 * 60 + 4, publishedAt: NOW - 5 * DAY });
  });

  it('flags "Most relevant" picks, except ones that are also in the timeline', () => {
    const shelved = page().videos.filter((v) => v.inShelf).map((v) => v.id);
    expect(shelved).toEqual([1, 3, 4].map(vid));
  });

  it('the timeline used for stop-on-overlap excludes shelf-only picks', () => {
    expect(feedTimeline(page().videos).map((v) => v.id)).toEqual([2, 5, 6, 7, 10, 11, 12].map(vid));
    // If everything were in a shelf, fall back to all videos rather than an empty timeline.
    expect(feedTimeline([{ id: 'a', inShelf: true }])).toEqual([{ id: 'a', inShelf: true }]);
  });

  it('known shelf picks cannot end a sync early', () => {
    // Previous syncs stored the three old "Most relevant" picks; none of the timeline is known yet.
    const known = new Set([1, 3, 4].map(vid));
    const timeline = feedTimeline(page().videos);
    const outcome = { items: timeline.length, known: timeline.filter((v) => known.has(v.id)).length, continuation: 'next' };
    expect(reachesKnown(outcome)).toBe(false);
    // Counting every video on the page (the old behaviour) would have stopped here.
    const naive = { items: page().videos.length, known: page().videos.filter((v) => known.has(v.id)).length, continuation: 'next' };
    expect(reachesKnown(naive)).toBe(true);
  });
});

// subscriptions-feed.json, -continuation.json and history.json are SYNTHETIC, written before a
// signed-in capture existed. They mirror the real lockupViewModel shape.
describe('subscriptions feed (synthetic fixture, real lockup shape)', () => {
  it('keeps plain videos in feed order with channel, duration, views and age', () => {
    const p = parseSubscriptionFeedPage(json('subscriptions-feed.json'), NOW);
    expect(p.loggedOut).toBe(false);
    expect(p.continuation).toBe('SYNTH_TOKEN_PAGE_2');
    expect(p.videos.map((v) => v.id)).toEqual(['synthVid001', 'synthVid002', 'synthVid003', 'synthVid004']);
    expect(p.videos[0]).toEqual({
      id: 'synthVid001',
      channelId: cid(1),
      channelTitle: 'Synthetic Channel 1',
      title: 'Synthetic video 1',
      publishedAt: NOW - 2 * HOUR,
      thumbnailUrl: 'https://i.ytimg.com/vi/synthVid001/mqdefault.jpg',
      durationSec: 754,
      viewCount: 1500,
    });
    expect(p.videos[1]!.durationSec).toBe(3723);
    expect(p.videos[3]!.viewCount).toBe(2_100_000);
  });

  it('filters Shorts (shelf and in-grid), live streams and scheduled premieres', () => {
    const p = parseSubscriptionFeedPage(json('subscriptions-feed.json'), NOW);
    const ids = p.videos.map((v) => v.id);
    for (const gone of ['synthVid090', 'synthVid091', 'synthVid080', 'synthVid083']) expect(ids).not.toContain(gone);
    expect(p.skipped).toEqual({ shorts: 4, live: 1, upcoming: 1, incomplete: 0 });
  });

  it('parses continuation pages and the end of the chain', () => {
    const p = parseSubscriptionFeedPage(json('subscriptions-feed-continuation.json'), NOW);
    expect(p.continuation).toBeNull();
    expect(p.videos.map((v) => [v.id, v.channelId])).toEqual([
      ['synthVid005', cid(2)],
      ['synthVid006', cid(3)],
      ['synthVid007', cid(1)],
      ['synthVid008', cid(2)],
    ]);
    expect(p.videos.at(-1)!.publishedAt).toBe(NOW - 35 * DAY);
  });

  it('detects a logged-out answer and never throws on junk', () => {
    expect(parseSubscriptionFeedPage(json('subscriptions-logged-out.json'), NOW)).toMatchObject({ loggedOut: true, videos: [] });
    for (const junk of [null, undefined, 42, 'x', [], { lockupViewModel: 'x' }, { lockupViewModel: { contentId: 'a' } }]) {
      expect(() => parseSubscriptionFeedPage(junk, NOW)).not.toThrow();
      expect(() => parseHistoryPage(junk, NOW)).not.toThrow();
      expect(parseWatchPage(junk, NOW)).toBeNull();
    }
  });

  it('also reads the older videoRenderer shape', () => {
    const r = {
      videoRenderer: {
        videoId: 'vr1',
        title: { runs: [{ text: 'Old shape' }] },
        ownerText: { runs: [{ text: 'Chan', navigationEndpoint: { browseEndpoint: { browseId: cid(7) } } }] },
        viewCountText: { simpleText: '1,234 views' },
        publishedTimeText: { simpleText: '3 days ago' },
        lengthText: { simpleText: '4:05' },
      },
    };
    const live = { videoRenderer: { ...r.videoRenderer, videoId: 'vr2', badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW' } }] } };
    const upcoming = { videoRenderer: { ...r.videoRenderer, videoId: 'vr3', upcomingEventData: { startTime: '1' } } };
    const p = parseSubscriptionFeedPage({ contents: [r, live, upcoming] }, NOW);
    expect(p.videos).toEqual([expect.objectContaining({ id: 'vr1', channelId: cid(7), durationSec: 245, viewCount: 1234, publishedAt: NOW - 3 * DAY })]);
    expect(p.skipped).toMatchObject({ live: 1, upcoming: 1 });
  });
});

describe('watch history (synthetic fixture)', () => {
  it('counts long-form videos per channel, ignoring Shorts and re-watches', () => {
    const p = parseHistoryPage(json('history.json'), NOW);
    expect(p.continuation).toBe('SYNTH_HISTORY_TOKEN_2');
    expect(p.entries.map((e) => e.videoId)).not.toContain('synthVid203');
    expect(historyCounts(p.entries)).toEqual({ [cid(1)]: 3, [cid(2)]: 1 });
  });
});

describe('watch page (real public data, Oct 2026)', () => {
  it('gives the video, its channel and description mentions already resolved to channel IDs', () => {
    const w = parseWatchPage(json('watch-page.json'), NOW)!;
    expect(w.videoId).toBe('NiCgcUTL9_Q');
    expect(w.channelId).toBe('UCHnyfMqiRRG1u-2MsSQLbXA');
    expect(w.mentions).toEqual(['UCune493q6fu9nLH_JkwOUhw', 'UCiDdDfxWjYUym8kZxc806MA']);
    expect(w.publishedAt).toBe(NOW - 3 * DAY);
  });

  it('related-video lockups give compact views via their accessibility label', () => {
    const related = parseVideoItems(json('watch-page.json').contents.twoColumnWatchNextResults.secondaryResults, NOW);
    expect(related).toHaveLength(3);
    expect(related[0]).toMatchObject({
      kind: 'video',
      id: 'ujkD4SxPKOI',
      channelId: 'UCsXVk37bltHxD1rDPwtNM8Q',
      channelTitle: 'Kurzgesagt – In a Nutshell',
      viewCount: 19_000_000, // shown as "19M"; "19 million views" is only in the label
      durationSec: 21 * 60 + 44,
    });
    expect(related.every((v) => v.publishedAt !== undefined && v.viewCount !== undefined)).toBe(true);
  });

  it('summarisePage routes watch pages and channel Home tabs, and nothing else', () => {
    expect(summarisePage('/watch', json('watch-page.json'), NOW)).toMatchObject({ kind: 'watch', watch: { videoId: 'NiCgcUTL9_Q' } });
    const ch = summarisePage('/@veritasium', json('channel-home.json'), NOW);
    expect(ch.kind).toBe('channel');
    if (ch.kind === 'channel') {
      expect(ch.channel.channel?.id).toBe('UCHnyfMqiRRG1u-2MsSQLbXA');
      expect(ch.channel.featured.length).toBeGreaterThanOrEqual(5);
    }
    expect(summarisePage('/@veritasium/videos', json('channel-home.json'), NOW)).toEqual({ kind: 'other' });
    expect(summarisePage('/results', json('watch-page.json'), NOW)).toEqual({ kind: 'other' });
  });

  it('knows channel Home tab paths', () => {
    for (const p of ['/@veritasium', '/@veritasium/', '/@veritasium/featured', '/channel/UCHnyfMqiRRG1u-2MsSQLbXA', '/c/name', '/user/name']) {
      expect(isChannelHomePath(p)).toBe(true);
    }
    for (const p of ['/', '/watch', '/@veritasium/videos', '/feed/subscriptions', '/channel/UCshort']) expect(isChannelHomePath(p)).toBe(false);
  });
});

describe('channel avatars on cards', () => {
  it('come from stored channels, and only from YouTube’s own image hosts', async () => {
    const { withAvatars } = await import('../src/background/feed');
    const card = (channelId: string): FeedItem => ({ videoId: 'v' + channelId, title: '', channelId, channelTitle: '', thumbnailUrl: '', publishedAt: 0, discover: false });
    const out = withAvatars(
      [card('A'), card('B'), card('C')],
      [
        { id: 'A', title: 'A', isSubscribed: true, thumbnailUrl: 'https://yt3.ggpht.com/a=s88' },
        { id: 'B', title: 'B', isSubscribed: false, thumbnailUrl: 'https://evil.example/b.png' },
      ],
    );
    expect(out.map((i) => i.channelAvatarUrl)).toEqual(['https://yt3.ggpht.com/a=s88', undefined, undefined]);
  });
});

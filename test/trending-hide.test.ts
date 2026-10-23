import 'fake-indexeddb/auto';

// computeFeed reads settings from chrome.storage; defaults are all we need here.
vi.stubGlobal('chrome', {
  storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
});

const db = await import('../src/core/db');
const { computeFeed } = await import('../src/background/feed');

const NOW = Date.now();
const HOUR = 3_600_000;
const ch = (n: number) => `UCcreator${String(n).padStart(2, '0')}xxxxxxxxxxxxx`;
const video = (rank: number, creator = rank, id = `rank${rank}`) => ({
  id,
  channelId: ch(creator),
  channelTitle: `Creator ${creator}`,
  title: `Video ranked #${rank}`,
  publishedAt: NOW - rank * HOUR,
  thumbnailUrl: '',
  viewCount: 100_000_000 - rank * 1_000_000,
});
const topRow = async () => (await computeFeed(NOW)).trending.map((t) => t.videoId);

beforeEach(async () => {
  await db.clearAll();
  // This week's most viewed, as cached by the crawler's searches: #1..#6 from six creators.
  await db.setMeta('trendingQueries', { the: { fetchedAt: NOW - HOUR, videos: [1, 2, 3, 4, 5, 6].map((r) => video(r)) } });
});

describe('hiding creators and videos in "Most viewed today"', () => {
  it('shows the 4 biggest by default', async () => {
    expect(await topRow()).toEqual(['rank1', 'rank2', 'rank3', 'rank4']);
  });

  it('a hidden creator is skipped and the next video moves up: #1, #2, #4, #5', async () => {
    await db.putFeedback({ channelId: ch(3), kind: 'notInterested', at: NOW });
    expect(await topRow()).toEqual(['rank1', 'rank2', 'rank4', 'rank5']);
  });

  it('stays hidden when new searches come in later (e.g. tomorrow), until undone', async () => {
    await db.putFeedback({ channelId: ch(3), kind: 'notInterested', at: NOW });
    // A newer upload from the same creator tops tomorrow's searches.
    await db.setMeta('trendingQueries', {
      the: { fetchedAt: NOW, videos: [video(0, 3, 'newHit'), ...[1, 2, 3, 4, 5].map((r) => video(r))] },
    });
    expect(await topRow()).toEqual(['rank1', 'rank2', 'rank4', 'rank5']);
    // Undo (feedback:undo deletes the record) brings the creator back.
    await db.deleteFeedback(ch(3));
    expect(await topRow()).toEqual(['newHit', 'rank1', 'rank2', 'rank4']);
  });

  it('hiding one video keeps that creator: their next video can still appear', async () => {
    await db.setMeta('trendingQueries', {
      the: { fetchedAt: NOW, videos: [video(1), video(2), video(3), video(4), video(5), video(6, 3, 'creator3Other')] },
    });
    await db.putVideoFeedback({ videoId: 'rank3', at: NOW });
    // Creator 3's other video is lower ranked, so #5 takes the slot; the creator isn't banned.
    expect(await topRow()).toEqual(['rank1', 'rank2', 'rank4', 'rank5']);
    await db.putFeedback({ channelId: ch(4), kind: 'notInterested', at: NOW });
    expect(await topRow()).toEqual(['rank1', 'rank2', 'rank5', 'creator3Other']);
  });
});

describe('a different few of today\'s biggest on each visit', () => {
  beforeEach(async () => {
    const ranks = Array.from({ length: 15 }, (_, i) => i + 1);
    await db.setMeta('trendingQueries', { the: { fetchedAt: NOW - HOUR, videos: ranks.map((r) => video(r)) } });
  });

  it('draws 4 of the top 12, differently per visit, biggest most often', async () => {
    const rows = await Promise.all(
      Array.from({ length: 40 }, (_, seed) => computeFeed(NOW, { seed, startedAt: NOW }).then((f) => f.trending.map((t) => t.videoId))),
    );
    const all = rows.flat();
    expect(new Set(rows.map((r) => r.join())).size).toBeGreaterThan(10);
    expect(all.every((id) => Number(id.slice(4)) <= 12)).toBe(true);
    const count = (id: string) => all.filter((x) => x === id).length;
    expect(count('rank1')).toBeGreaterThan(count('rank12'));
  });

  it('without a visit draw it is simply the 4 biggest', async () => {
    expect(await topRow()).toEqual(['rank1', 'rank2', 'rank3', 'rank4']);
  });

  it("tops up with the last few days' biggest when today runs short, never older than a week", async () => {
    // rank40 is 40 hours old (yesterday): it fills in after today's, despite more views.
    const yesterday = { ...video(40), viewCount: 500_000_000 };
    const lastMonth = { ...video(9), id: 'old', channelId: ch(50), publishedAt: NOW - 30 * 24 * HOUR };
    await db.setMeta('trendingQueries', { the: { fetchedAt: NOW - HOUR, filter: 'today', videos: [yesterday, video(2), video(3), lastMonth] } });
    expect(await topRow()).toEqual(['rank2', 'rank3', 'rank40']);
  });

  it('hiding everything from today still leaves a full row from the backup pool', async () => {
    const pool = [2, 3].map((r) => video(r)).concat([50, 60, 70, 80].map((r) => video(r)));
    await db.setMeta('trendingQueries', { the: { fetchedAt: NOW - HOUR, filter: 'today', videos: pool } });
    await db.putFeedback({ channelId: ch(2), kind: 'notInterested', at: NOW });
    await db.putFeedback({ channelId: ch(3), kind: 'notInterested', at: NOW });
    expect(await topRow()).toEqual(['rank50', 'rank60', 'rank70', 'rank80']);
  });
});

describe('Discover', () => {
  it('leaves out leftover RSS uploads with no duration (Shorts, streams the Videos tab never lists)', async () => {
    await db.upsertChannel({ id: ch(1), title: 'Creator 1', isSubscribed: true });
    await db.upsertChannel({ id: ch(2), title: 'Creator 2' });
    await db.putEdge({ fromChannelId: ch(1), toChannelId: ch(2), type: 'featured', firstSeenAt: NOW, lastSeenAt: NOW, count: 1 });
    await db.putVideos([
      { id: 'tabVideo', channelId: ch(2), title: 'From the Videos tab', publishedAt: NOW - HOUR, thumbnailUrl: '', durationSec: 600 },
      { id: 'rssShort', channelId: ch(2), title: 'Old RSS entry', publishedAt: NOW - 2 * HOUR, thumbnailUrl: '' },
    ]);
    const discover = (await computeFeed(NOW)).items.filter((i) => i.discover).map((i) => i.videoId);
    expect(discover).toEqual(['tabVideo']);
  });
});

describe('community picks in the top row', () => {
  const details = (rank: number, creator: number, viewCount: number) => ({
    fetchedAt: NOW,
    video: { ...video(rank, creator, `community${rank}`), viewCount },
  });

  beforeEach(async () => {
    await db.setMeta('community', {
      optedInAt: NOW - 10 * HOUR,
      trending: {
        fetchedAt: NOW,
        region: 'GB',
        file: {
          generatedAt: NOW,
          region: 'GB',
          videos: [
            { v: 'community1', c: ch(11), n: 300 }, // only 500 views on YouTube: below the floor
            { v: 'community2', c: ch(12), n: 200 }, // 50,000 views: shown
            { v: 'community3', c: ch(99), n: 100 }, // YouTube says a different channel: never shown
          ],
        },
      },
    });
    await db.setMeta('communityVideos', {
      community1: details(1, 11, 500),
      community2: details(2, 12, 50_000),
      community3: details(3, 13, 90_000),
    });
  });

  it('alternate with search picks, need 10,000+ YouTube views and a matching channel', async () => {
    const feed = await computeFeed(NOW);
    expect(feed.trending.map((t) => t.videoId)).toEqual(['rank1', 'community2', 'rank2', 'rank3']);
    expect(feed.trending[1]).toMatchObject({ reason: 'Popular with Reborn users', viewCount: 50_000 });
  });

  it('hidden creators are skipped for community picks too', async () => {
    await db.putFeedback({ channelId: ch(12), kind: 'notInterested', at: NOW });
    expect((await computeFeed(NOW)).trending.map((t) => t.videoId)).toEqual(['rank1', 'rank2', 'rank3', 'rank4']);
  });

  it('a dormant server publishes nothing to show', async () => {
    await db.setMeta('community', { trending: { fetchedAt: NOW, region: 'GB', file: { generatedAt: NOW, region: 'GB', videos: [], dormant: true } } });
    expect((await computeFeed(NOW)).trending.map((t) => t.videoId)).toEqual(['rank1', 'rank2', 'rank3', 'rank4']);
  });
});

describe('the top row is tailored: news first, readable languages, near what you watch', () => {
  const story = (headline: string, ...videos: ReturnType<typeof video>[]) => ({ headline, videos });
  // Today's most viewed (rank1–6) gather 16–99M views an hour, so the push bar is ~8M/hour.
  // fast() is an election-night outlet video (perHour views/hour); quiet() an ordinary day's.
  const fast = (id: string, creator: number, perHour: number, title = `${id}: live coverage of the main story`) =>
    ({ ...video(1, creator, id), title, viewCount: perHour * 2, publishedAt: NOW - 2 * HOUR, verified: true });
  const quiet = (id: string, creator: number) => ({ ...fast(id, creator, 4_000), viewCount: 20_000, publishedAt: NOW - 5 * HOUR });
  const bigStory = (h: string, a: number, b: number, speed = 50_000_000) => story(h, fast(`s${a}`, a, speed), fast(`s${b}`, b, speed - 1_000_000));

  beforeEach(async () => {
    await db.setMeta('region', 'GB');
    await db.setMeta('language', 'en-GB');
    await db.setMeta('trendingQueries', { the: { fetchedAt: NOW - HOUR, filter: 'today', videos: [1, 2, 3, 4, 5, 6].map((r) => video(r)) } });
  });
  const row = async () => (await computeFeed(NOW)).trending;
  const setNews = (...stories: ReturnType<typeof story>[]) => db.setMeta('news', { fetchedAt: NOW - HOUR, region: 'GB', stories });

  it('on a normal news day, no news: the row is just today\'s most viewed', async () => {
    await setNews(story('Council approves new bus lanes', quiet('a', 31), quiet('b', 32)));
    expect((await row()).map((t) => t.videoId)).toEqual(['rank1', 'rank2', 'rank3', 'rank4']);
  });

  it('one channel alone is never a push, however fast', async () => {
    await setNews(story('Minor political row', fast('viral', 31, 90_000_000), quiet('b', 32)));
    expect((await row())[0]!.videoId).toBe('rank1');
  });

  it('unverified channels never count, even several at once', async () => {
    const unverified = (id: string, c: number) => ({ ...fast(id, c, 60_000_000), verified: false });
    await setNews(story('Rumour', unverified('x', 31), unverified('y', 32), unverified('z', 33)));
    expect((await row())[0]!.videoId).toBe('rank1');
  });

  it('when 2+ established outlets push stories hard, up to 2 go first, labelled with their headlines', async () => {
    await setNews(
      bigStory('Election night: results as they come in', 31, 32, 60_000_000),
      bigStory('Leaders react', 33, 34, 55_000_000),
      bigStory('Third story', 35, 36, 50_000_000),
    );
    const r = await row();
    expect(r.map((t) => t.videoId)).toEqual(['s31', 's33', 'rank1', 'rank2']);
    expect(r[0]!.reason).toBe('Election night: results as they come in');
  });

  it('several established outlets among today\'s most viewed at once also lead as news', async () => {
    await setNews(story('Election results', quiet('a', 31), quiet('b', 32)));
    const pool = [1, 2, 3, 4].map((r) => video(r));
    // One outlet in today's most viewed: not enough.
    await db.setMeta('trendingQueries', { the: { fetchedAt: NOW - HOUR, filter: 'today', videos: [...pool, video(5, 31, 'outlet1'), video(6)] } });
    expect((await row())[0]!.videoId).toBe('rank1');
    // Two: YouTube is clearly pushing news.
    await db.setMeta('trendingQueries', { the: { fetchedAt: NOW - HOUR, filter: 'today', videos: [...pool, video(5, 31, 'outlet1'), video(6, 32, 'outlet2')] } });
    const r = await row();
    expect(r.slice(0, 2).map((t) => t.videoId).sort()).toEqual(['outlet1', 'outlet2']);
    expect(r[0]!.reason).toBe('In the news today');
  });

  it('skips news from another region (the user moved) or older than 12 hours', async () => {
    await db.setMeta('news', { fetchedAt: NOW - HOUR, region: 'NL', stories: [bigStory('Nieuws', 31, 32)] });
    expect((await row())[0]!.videoId).toBe('rank1');
    await db.setMeta('news', { fetchedAt: NOW - 13 * HOUR, region: 'GB', stories: [bigStory('Old', 31, 32)] });
    expect((await row())[0]!.videoId).toBe('rank1');
  });

  it('a Dutch user gets Dutch news even with YouTube set to English', async () => {
    await db.setMeta('region', 'NL');
    await db.setMeta('language', 'en');
    const dutch = (id: string, c: number) => fast(id, c, 50_000_000, 'Een week vol onrust in Floradorp na de brand');
    await db.setMeta('news', { fetchedAt: NOW - HOUR, region: 'NL', stories: [story('Nieuws over Floradorp', dutch('nos', 31), dutch('rtl', 32))] });
    expect((await row())[0]!.videoId).toBe('nos');
  });

  it('never shows most-viewed videos in a language the user does not read', async () => {
    const hindi = { ...video(1, 11, 'hindi'), title: 'Raja The Great (2026) New Released Hindi Dubbed Full Movie' };
    const arabic = { ...video(2, 12, 'arabic'), title: 'صلاة الجمعة من المسجد الحرام بث مباشر' };
    await db.setMeta('trendingQueries', { the: { fetchedAt: NOW - HOUR, filter: 'today', videos: [hindi, arabic, video(3), video(4), video(5), video(6)] } });
    expect((await computeFeed(NOW)).trending.map((t) => t.videoId)).toEqual(['rank3', 'rank4', 'rank5', 'rank6']);
  });

  it('favours channels near your subscriptions, and away from creators you hid', async () => {
    const SUB = 'UCsubscribedxxxxxxxxxxxx';
    await db.upsertChannel({ id: SUB, title: 'Mine', isSubscribed: true });
    // Creator 3 is featured by a subscription; creator 4 is featured by a channel the user hid.
    await db.putEdge({ fromChannelId: SUB, toChannelId: ch(3), type: 'featured', firstSeenAt: NOW, lastSeenAt: NOW, count: 1 });
    await db.putEdge({ fromChannelId: ch(9), toChannelId: ch(4), type: 'featured', firstSeenAt: NOW, lastSeenAt: NOW, count: 1 });
    await db.putFeedback({ channelId: ch(9), kind: 'notInterested', at: NOW });
    let near = 0;
    let hiddenNear = 0;
    for (let seed = 0; seed < 60; seed++) {
      const row = (await computeFeed(NOW, { seed, startedAt: NOW })).trending.map((t) => t.videoId);
      if (row.includes('rank3')) near++;
      if (row.includes('rank4')) hiddenNear++;
    }
    expect(near).toBeGreaterThan(hiddenNear * 1.5);
  });
});

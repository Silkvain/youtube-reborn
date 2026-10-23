/**
 * Made-up channels and videos for the store screenshots. Nothing here is a real channel, video
 * or person, so no one's subscriptions, history or creative work appears in the listing.
 */
import type { FeedItem, FeedResponse } from '../../src/shared/types';
import type { Stats } from '../../src/shared/messages';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.now();

let n = 0;
const vid = () => `demo${String(++n).padStart(7, '0')}`;
const chan = (name: string) => `UCdemo${name.replace(/\W/g, '').slice(0, 18).padEnd(18, 'x')}`;

function item(
  channelTitle: string,
  title: string,
  ageHours: number,
  durationSec: number,
  viewCount: number,
  reason?: string,
): FeedItem {
  const videoId = vid();
  return {
    videoId,
    title,
    channelId: chan(channelTitle),
    channelTitle,
    thumbnailUrl: '',
    publishedAt: now - ageHours * HOUR,
    durationSec,
    viewCount,
    discover: !!reason,
    reason,
    reasonChannelId: reason ? chan(reason.replace(/^.* (by|of) /, '').replace(/ \(via.*$/, '')) : undefined,
  };
}

export const feed: FeedResponse = {
  status: 'ok',
  coldStart: false,
  trending: [
    item('Orbit Lab', 'We launched a weather balloon to 33 km and got this', 14, 1284, 2_400_000),
    item('Pan & Pantry', 'The 10-minute bread that broke the internet', 9, 612, 1_850_000),
    item('Tidewater Films', 'Sailing alone across the North Sea in winter', 20, 2650, 1_210_000),
    item('Byte Sized', 'I rebuilt a 1998 laptop with modern parts', 6, 1033, 980_000),
  ],
  items: [
    item('Quarter Inch Workshop', 'Building a walnut desk with only hand tools', 5, 1940, 214_000),
    item('Northbound Kitchen', 'Three sauces every home cook should know', 30, 845, 96_000),
    item('Fieldnotes', 'Why rivers meander: the physics explained', 52, 1122, 431_000, 'Featured by Orbit Lab'),
    item('Slow Lane Cycling', '400 km through the Alps on a 40-year-old bike', 26, 3010, 58_000),
    item('Moss & Stone', 'Restoring a forgotten Victorian greenhouse', 75, 1555, 322_000, 'Popular with viewers of Quarter Inch Workshop'),
    item('Pixel Archive', 'The forgotten games of 1994, ranked', 18, 2240, 145_000),
    item('Analog Hours', 'Fixing a 1970s synthesizer that hasn’t worked in decades', 96, 1802, 77_000, 'Mentioned by Byte Sized (via Pixel Archive)'),
    item('Northbound Kitchen', 'One-pan dinners for busy weeknights', 120, 734, 120_000),
    item('Little Big Maps', 'Every country’s strangest border, explained', 44, 1386, 890_000, 'Popular with viewers of Fieldnotes'),
    item('Quarter Inch Workshop', 'Sharpening, the honest guide for beginners', 170, 1210, 301_000),
    item('Cloudbreak Music', 'Writing a song in 24 hours with strangers', 60, 1470, 64_000, 'Featured by Analog Hours'),
    item('Fieldnotes', 'How glaciers carve valleys, in 3D', 200, 966, 512_000),
  ],
};

export const stats: Stats = {
  enabled: true,
  subscriptions: 84,
  candidates: 1260,
  edges: 3412,
  videos: 5230,
  watchEvents: 640,
  requestsToday: 61,
  dailyCap: 300,
  spent: { subs: 18, top: 22, discovery: 19, mentions: 2 },
  budgets: { subs: 60, top: 45, discovery: 165, mentions: 25 },
  lastFeedSync: now - 4 * 60_000,
  loggedOut: false,
  stoppedForToday: false,
  status: 'Your home feed is up to date.',
  community: { on: true, lastOkAt: now - 2 * HOUR, failing: false, trendingVideos: 86, graphChannels: 4120, dormant: false },
  discover: [
    { source: 'featured', shown: 142, watched: 31, tuning: 1.2 },
    { source: 'community', shown: 96, watched: 27, tuning: 1.4 },
  ],
} as Stats;

export { DAY };

/** The word drawn on each placeholder thumbnail, by title. */
export const thumbWords: Record<string, string> = {
  'We launched a weather balloon to 33 km and got this': '33 km up',
  'The 10-minute bread that broke the internet': 'Bread',
  'Sailing alone across the North Sea in winter': 'Solo',
  'I rebuilt a 1998 laptop with modern parts': '1998',
  'Building a walnut desk with only hand tools': 'Walnut',
  'Three sauces every home cook should know': 'Sauces',
  'Why rivers meander: the physics explained': 'Rivers',
  '400 km through the Alps on a 40-year-old bike': 'Alps',
  'Restoring a forgotten Victorian greenhouse': 'Restored',
  'The forgotten games of 1994, ranked': '1994',
  'Fixing a 1970s synthesizer that hasn’t worked in decades': 'Synth',
  'One-pan dinners for busy weeknights': 'One pan',
  'Every country’s strangest border, explained': 'Borders',
  'Sharpening, the honest guide for beginners': 'Sharp',
  'Writing a song in 24 hours with strangers': '24 hrs',
  'How glaciers carve valleys, in 3D': 'Glaciers',
};

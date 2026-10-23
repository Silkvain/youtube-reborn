import type { ChannelId } from '../shared/types';

export interface ExtractedMentions {
  /** Channel IDs linked directly via /channel/UC... URLs. */
  channelIds: Set<ChannelId>;
  /** Normalised refs that need resolving: "@handle", "/c/name", "/user/name" (lowercase). */
  refs: Set<string>;
}

const CHANNEL_URL = /youtube\.com\/channel\/(UC[\w-]{22})/gi;
const HANDLE_URL = /youtube\.com\/(@[\w.\-·]{3,30})/gi;
const LEGACY_URL = /youtube\.com\/(c|user)\/([\w.\-]{1,100})/gi;
// A bare @handle must start a word: not part of an email address or URL path.
const BARE_HANDLE = /(?:^|[\s([{,;:"'“‘|>])(@[A-Za-z0-9][\w.\-·]{2,29})/g;
// Lines like "Twitter: @foo" name handles on other platforms; don't treat those as YouTube.
const OTHER_PLATFORM = /\b(twitter|x\.com|instagram|insta|tiktok|threads|bluesky|bsky|mastodon|twitch|discord|patreon|facebook|snapchat|linkedin|email|e-mail)\b|\bIG\b|\bX:/i;

function normaliseHandle(raw: string): string | null {
  const h = raw.replace(/[.\-·]+$/, '').toLowerCase();
  return h.length >= 4 ? h : null; // "@" + at least 3 chars
}

export function extractMentions(description: string): ExtractedMentions {
  const channelIds = new Set<ChannelId>();
  const refs = new Set<string>();
  for (const m of description.matchAll(CHANNEL_URL)) channelIds.add(m[1]!);
  for (const m of description.matchAll(HANDLE_URL)) {
    const h = normaliseHandle(m[1]!);
    if (h) refs.add(h);
  }
  for (const m of description.matchAll(LEGACY_URL)) refs.add(`/${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}`);
  for (const line of description.split(/\r?\n/)) {
    if (OTHER_PLATFORM.test(line)) continue;
    // Strip URLs so "youtube.com/@x" and "medium.com/@x" aren't re-read as bare handles.
    const withoutUrls = line.replace(/\S*:\/\/\S*|\S+\.(com|org|net|io|be|co|tv|me)\/\S*/gi, ' ');
    for (const m of withoutUrls.matchAll(BARE_HANDLE)) {
      const h = normaliseHandle(m[1]!);
      if (h) refs.add(h);
    }
  }
  return { channelIds, refs };
}

/** URL path to pass to resolve_url for a normalised ref. */
export function refToUrl(ref: string): string {
  return `https://www.youtube.com/${ref.replace(/^\//, '')}`;
}

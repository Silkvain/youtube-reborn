# YouTube Discovery Extension — Build Spec (v1)

## Goal

A browser extension that sits on top of youtube.com and replaces the home feed with recommendations from our own discovery engine. The engine is seeded by what the user subscribes to and watches. Users install it and it just works: no data exports, no API keys, no accounts, no server.

The feeling we're recreating: old YouTube, where subscribing to science/engineering channels and certain comedians led to recommendations of *similar channels and styles*, not whatever is globally engaging.

## Scope

### In scope (v1)
- Chrome, Manifest V3. Keep code Firefox-compatible where it costs nothing, but don't test Firefox yet.
- Single on/off toggle in the toolbar popup.
- Reading the logged-in user's subscriptions from their existing YouTube session.
- Passive logging of watch behaviour on `/watch` pages.
- Candidate discovery from a channel graph (featured channels + mentions).
- Local scoring and ranking.
- Replacing the YouTube home feed (`/`) with our feed.
- All data stored locally (IndexedDB). Nothing leaves the browser.

### Out of scope (v1) — do not build
- Any backend, server, sync, or telemetry.
- User accounts.
- YouTube Data API usage (no API keys).
- Embedding/ML similarity (planned for v2; leave a slot for it, see "Signal sources").
- Mobile.
- Changes to any YouTube page other than the home feed and passive observation of watch pages.

## Tech stack

- TypeScript, strict mode.
- Vite with a Manifest V3 plugin (e.g. `@crxjs/vite-plugin`), or plain esbuild if that's simpler. Pick one and document it in the README.
- `idb` for IndexedDB.
- No UI framework required. Plain DOM is fine for the injected feed and popup. If a framework is used, keep it lightweight (Preact at most).
- Vitest for unit tests.

## Architecture

```
popup/            toggle UI
background/       service worker: crawl scheduler, scoring, storage owner
content/
  boot.ts         runs at document_start: hides native feed before paint when enabled
  home.ts         renders our feed on "/"
  watch.ts        observes <video> on /watch and emits watch events
  innertube.ts    thin client for YouTube's internal API using the page's session
core/
  db.ts           IndexedDB schema + access
  sources/        pluggable signal sources (see below)
  ranker.ts       combines source scores into a ranked feed
```

Message passing: content scripts send events (watch events, fetched data) to the service worker; the service worker owns the database and scoring. The home content script requests the current ranked feed from the service worker.

## Behaviour

### Toggle
- Stored in `chrome.storage.local` as `enabled: boolean`, default `true` on install.
- **Off means fully inert:** no feed replacement, no watch logging, no crawling. Existing local data is kept.
- Flipping the toggle takes effect immediately on open YouTube tabs without a reload (content scripts listen to `chrome.storage.onChanged`).

### No flash of the native feed
- `boot.ts` runs at `document_start` and, when enabled, adds a class (e.g. `ydx-enabled`) to `<html>`.
- A stylesheet hides the native home grid under that class. Removing the class (toggle off) restores it.

### SPA navigation
- YouTube doesn't do full page loads. Listen for `yt-navigate-finish` and (re)mount or unmount our feed depending on whether the current route is `/`.
- Make mounting idempotent: never render the feed twice.

### Reading subscriptions
- YouTube's web app talks to an internal API ("InnerTube", `/youtubei/v1/...`) using the logged-in session. The subscriptions page (`/feed/channels`) is backed by one of these `browse` calls.
- **Do not hardcode endpoint details from memory.** Inspect the real network requests in DevTools on `/feed/channels` and on channel pages, and build `innertube.ts` from what you observe: endpoint, request body shape, client context, API key/config read from the page's `ytcfg`, and continuation-token pagination.
- Fetch the full subscription list on first enable and refresh it at most once every 24 hours.
- If the user isn't logged in, show a friendly message in our feed area instead of failing silently.

### Watch logging
On `/watch` pages, attach listeners to the `<video>` element and record per session:
- video ID, channel ID, video duration
- seconds actually watched (sum of played intervals, not just end position)
- completion ratio
- whether the user abandoned early (< 30s or < 10%, whichever is smaller)
- timestamp

Write one `WatchEvent` per video session when the user navigates away or the tab closes.

### Candidate discovery (crawler)
Runs in the service worker on a schedule (`chrome.alarms`), gently:
- **Rate limit:** at most 1 request every 3–5 seconds with jitter, and a daily cap (start at ~300 requests/day, configurable).
- Back off exponentially on errors or non-200 responses. Stop for the day after repeated failures.
- Cache everything with timestamps. Don't refetch a channel more than once per 7 days.

Signals to collect for each subscribed channel (and, at lower priority, for top candidates):
1. **Featured channels:** the channels listed on the channel's page (the "Channels" tab / featured section).
2. **Mentions:** `@handles` and channel links in descriptions of the channel's recent uploads (last ~15 videos). Resolve handles to channel IDs.

Recent uploads for feed items: prefer the public channel RSS feed (`https://www.youtube.com/feeds/videos.xml?channel_id=<ID>`) since it's cheap. Fall back to InnerTube if RSS fails.

### Signal sources (pluggable)
Define an interface so new signals can be added later (embeddings in v2, a shared co-subscription graph if the project ever grows) without touching the ranker:

```ts
interface SignalSource {
  id: string;                       // e.g. "featured", "mentions"
  weight: number;                   // default weight in ranker
  score(ctx: RankContext): Promise<Map<ChannelId, number>>; // 0..1 per candidate
}
```

v1 sources:
- `featured`: candidate score grows with how many subscribed channels feature it, weighted by how much the user actually watches those subscribed channels.
- `mentions`: same idea, from description mentions, with recency decay.

### Ranking
- Combine source scores with weights into a channel score.
- Exclude channels the user is already subscribed to from the *discovery* portion.
- Build the feed from:
  - recent uploads from subscriptions, ordered by recency and boosted by the user's engagement with that channel (completion ratios from watch logs)
  - recent uploads from top-scored discovery candidates
- Default mix ~60% subscriptions / 40% discovery. Make it a constant that's easy to change.
- Light diversity rule: no more than 2 consecutive items from the same channel.
- Feedback buttons on discovery items: "more like this" / "not interested". Store them and apply them as a multiplier on the channel score (not interested = channel hidden).

### Feed UI
- Renders in place of the native home grid, in a grid of video cards: thumbnail, title, channel name, upload age, and a small "Discover" badge on non-subscription items.
- Match YouTube's look closely enough not to feel jarring. Use YouTube's own CSS variables where possible so light/dark themes work automatically.
- Clicking a card navigates normally to `/watch?v=...`.
- Empty/cold-start state: if the crawler hasn't produced candidates yet, show subscription uploads only, with a small "building your recommendations…" note.

## Data model (IndexedDB)

Key everything by **channel ID and video ID**, never by handle or name (those change).

- `channels`: `{ id, title, handle?, thumbnailUrl?, isSubscribed, lastCrawledAt? }`
- `edges`: `{ fromChannelId, toChannelId, type: "featured" | "mention", firstSeenAt, lastSeenAt, count }`
- `videos`: `{ id, channelId, title, publishedAt, thumbnailUrl, durationSec? }`
- `watchEvents`: `{ videoId, channelId, watchedSec, durationSec, completion, abandoned, at }`
- `feedback`: `{ channelId, kind: "more" | "notInterested", at }`
- `meta`: schema version, last subscription sync, daily request counter.

Include a schema version and a migration path from the start.

## Privacy and store compliance

- No network requests to any host except youtube.com (and `i.ytimg.com` for thumbnails).
- Request only the permissions needed: `storage`, `alarms`, host permissions for `*://www.youtube.com/*`. Justify each in the README.
- Write a short plain-English privacy statement for the store listing: what's read, that it stays on-device, that turning the extension off stops all collection.
- Add a "Clear all data" button in the popup.

## Resilience

YouTube changes its DOM and internal API without notice. Assume breakage will happen:
- Isolate all YouTube-specific parsing in `innertube.ts` and a small set of DOM selectors in one file.
- Parse defensively. A missing field should skip that item, never crash the feed.
- If our feed fails to render, fail open: remove the hide class so the user sees YouTube's normal feed, and log the error to the console.

## Milestones and acceptance criteria

1. **Skeleton + toggle**
   - Extension loads unpacked in Chrome. Popup toggle persists.
   - With toggle on, the native home feed is hidden with no visible flash; with it off, YouTube is untouched. No reload needed either way.
2. **Subscriptions**
   - On a logged-in session, the full subscription list (including paginated results) is in IndexedDB within a minute of enabling.
   - Logged-out state shows a clear message.
3. **Watch logging**
   - Watching a video for ~1 minute and navigating away produces a correct `WatchEvent`. Skipping around doesn't inflate watched seconds.
   - Nothing is logged while the toggle is off.
4. **Crawler + graph**
   - Featured-channel and mention edges populate over time while respecting rate limits and daily caps (verify via counters).
5. **Ranking + feed**
   - Home page shows a mixed feed with the Discover badge. Feedback buttons change results on the next render.
   - SPA navigation away from and back to `/` remounts the feed correctly, never duplicated.
6. **Polish**
   - Light/dark theme match, cold-start state, "Clear all data", README with build/load instructions and permission justifications.

## Testing

- Unit tests (Vitest) for: ranker math, source scoring, diversity rule, watch-interval accounting, mention parsing/handle extraction.
- Save sanitized real InnerTube responses as fixtures and test the parsers against them, so API changes show up as failing tests.
- Manual test checklist in the README covering each milestone's acceptance criteria.

## Working notes for the implementer

- Build milestone by milestone; get each working end-to-end before moving on.
- When unsure about YouTube's internals, inspect the live site rather than guessing.
- Keep the crawler conservative. Being polite to YouTube matters more than crawl speed.

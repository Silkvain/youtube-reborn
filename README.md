# Reborn for YouTube

**[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/reborn-for-youtube/confbgnfdhfkpihnlibagkdekdmbimbk)** · free and open source (MIT) · [support on Ko-fi](https://ko-fi.com/silkvain)

A browser extension (Manifest V3) that brings back what made YouTube's home page good:
recommendations built from the channels you subscribe to and actually watch, plus new channels found
the way old YouTube did, through the creators you already like. Every visit draws a fresh mix.

**Private by default.** The feed is built on your device and stored in your browser; the extension
only talks to youtube.com, gently, within daily limits.

**Optional "Enhanced discoverability".** If you agree on install, it shares anonymous signals
(videos watched, by day; pairs of channels you watch a lot) with a small server in [backend/](backend).
No account, no ID, no cookie: one-time anonymous tokens, and only noisy totals that many people
contributed to are published. Design and privacy details:
[docs/enhanced-discoverability.md](docs/enhanced-discoverability.md).

Not affiliated with, endorsed by or sponsored by YouTube or Google.

Working notes: [docs/NEXT-STEPS.md](docs/NEXT-STEPS.md) (status and to-do) and
[CLAUDE.md](CLAUDE.md) (notes for AI-assisted development). The original build spec is in
[docs-HANDOFF.md](docs-HANDOFF.md).

## Build and load

Requirements: Node 20+ (developed on Node 22).

```bash
npm install
npm run build        # bundles into dist/
npm test             # unit + fixture tests (Vitest)
npm run typecheck
```

Load it in Chrome:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `dist/` folder.
3. Open youtube.com while signed in. Your subscriptions and their uploads sync within a few
   seconds. Discovery recommendations fill in over the next minutes and days while a YouTube tab
   is open (see "Request budget" below).

Run `npm run watch` to rebuild on save. After a rebuild, click the reload icon on the
extension card.

**Toolchain choice:** plain **esbuild** ([build.mjs](build.mjs)), not Vite + crxjs. The extension
is five small IIFE bundles plus static files, so a 40-line build script is simpler than a plugin
stack, and its output is easy to read.

## How it works

```
src/
  popup/           toggle, stats, "Clear all data"
  background/
    sw.ts          service worker: message router, alarms, sync bookkeeping, popup stats
    crawler.ts     job planner, per-purpose budgets, tab lease, result storage, RSS tick
    subsfeed.ts    subscriptions-feed sync state machine (stop on overlap, gaps, backfill)
    status.ts      the popup's one-line status
    ratelimit.ts   3–5 s jittered gap, daily cap + per-purpose budgets, backoff, stop-for-the-day
    feed.ts        loads the DB, scores candidates, assembles the feed
  content/
    boot.ts        document_start: adds html.ydx-enabled so boot.css hides the native grid pre-paint
    app.ts         wires the pieces below to the toggle and SPA navigation (yt-navigate-finish)
    home.ts        renders our feed on "/" (idempotent mount, fails open)
    watch.ts       observes <video> on /watch and emits WatchEvents
    subs.ts        subscription list, subscriptions feed and history seed, with the page's session
    relay.ts       sends the crawler's InnerTube jobs from the YouTube tab, one at a time
    innertube.ts   all YouTube API calls and response parsing (shared with the service worker)
    selectors.ts   all YouTube DOM selectors
    bridge-main.ts MAIN-world helper: ytcfg, player data, and the current page's data
  core/
    db.ts          IndexedDB schema, migrations, access (idb)
    sources/       pluggable SignalSources: featured.ts, mentions.ts (+ shared graph scoring)
    ranker.ts      combines sources, mixes 60/40, diversity rule, feedback multipliers
    mentions.ts    @handle / channel-link extraction
    watch-intervals.ts  played-interval accounting
```

### Data flow

Request cost is "aggregate-first": one request covers all subscriptions wherever YouTube offers
that, and data the user's own browsing already loaded is reused for free.

- **Subscription list:** when a sync is due (first enable, then at most every 24 h), a YouTube tab
  calls InnerTube `browse` with `browseId: "FEchannels"` and follows continuation tokens. It sends
  the page's cookies and a `SAPISIDHASH` Authorization header, as YouTube's own web client does.
  If you're logged out, the feed area says so.
- **Subscription uploads (all channels at once):** when Home mounts and the last sync is over
  30 minutes old, the tab reads YouTube's own subscriptions feed (`browseId: "FEsubscriptions"`,
  same session auth) and follows continuation tokens **until it reaches videos already stored**
  (3 known videos on one page, so one out-of-order item can't end a sync early). Items carry
  channel, duration, views and age, so there is no per-channel RSS polling and no durations
  crawl. Shorts (their shelf and in-grid Shorts), live streams and scheduled premieres are left
  out. The first run fetches 3 pages for the first render, then backfills toward 30 days, 3 pages
  per Home visit. A sync that finds more new pages than it fetches leaves a "gap" token that
  later syncs fill. Everything is stored, so "Earlier from your subscriptions" covers every
  channel. The feed renders from the cache first; new uploads are patched in when the sync
  finishes, but only while you're still at the top of the page.
- **Engagement seed:** once, the tab reads 1–2 pages of your watch history (`FEhistory`, same
  auth) and keeps only "videos watched per channel", locally. It orders the discovery crawl
  (most-watched first) until real watch logs exist; it never overrides them and doesn't change
  ranking.
- **Featured channels:** InnerTube `browse` on the channel ID returns the Home tab. Its
  "Featured Channels" shelf is a list of `gridChannelRenderer` items. Each subscription is read
  once (most-watched first, the discovery budget allows ~150 a day), then every 60 days (spread
  45–75 days per channel so re-reads don't bunch up). Channel pages you open yourself are read
  for free from the page's own data. Featured channels of the top 15 candidates (second hop) are
  read every ~45 days.
- **Mentions:** channel links in the description of any video you watch, taken for free from the
  watch page's data, where YouTube has already resolved `@handles` to channel IDs. The 20
  most-watched subscriptions also get a weekly RSS read (`/feeds/videos.xml`) for mentions in
  their other uploads; handles found there are resolved with `navigation/resolve_url` (capped by
  the mentions budget). Handles on lines that name another platform ("Twitter: @x") are ignored.
  Mentions are counted per video, so the same description read twice never counts twice.
- **Discovery uploads:** the top 30 candidates' Videos tabs (one request each gives durations,
  views and age), every 48 h.
- **Most viewed today (top row):** YouTube retired its Trending page; `FEtrending` now
  returns 400. The closest public signal is search filtered to "uploaded today" (a rolling
  24 hours) and sorted by view count. The crawler runs that for a few very common words ("the",
  "a", "i", "you", "how", the current year) in your YouTube region, every 6 hours (24 requests a
  day). It merges the results, keeps the 12 biggest, and each Home visit shows a different 4,
  bigger ones more often, one per creator. Each search's results are kept for a week as a
  backup pool: if hides or a thin day leave fewer than 4 of today's, the row tops up with the
  last few days' biggest. Turn it off in the popup.
- **Big news in the top row, only when YouTube is pushing it:** the extension reads YouTube's own
  News hub for your YouTube country every 2 hours (12 requests a day; a Dutch user gets Dutch news).
  A story takes a slot (at most 2, labelled with its headline) only when at least 2 different
  verified news outlets each have a video gathering views at least a quarter as fast as a typical
  "most viewed today" video, or when 2+ verified outlets are themselves among today's most viewed.
  One channel alone never counts, and the user's own viewing plays no part (the signal is the same
  for everyone in the region). On a normal day that's nothing (2026-10-17: bar
  ~130k views/hour, biggest UK story ~22k); on an election night or the start of a war, it leads.
- **Top row tailoring (neutral signals only):** candidates must be in a language you read (your
  YouTube language, your country's languages, and any language a good share of your subscriptions
  upload in), checked from titles: script, named languages ("Hindi Dubbed"), and a stop-word test
  for Latin-script languages. Channels near your subscriptions are favoured; channels near a
  creator you hid are pushed down. It never tries to infer anything about who you are.
- **Discover, after the 2010 YouTube paper (Davidson et al.):** it starts from your subscriptions
  and from channels you watch well 3+ times in 60 days without subscribing (recent viewing counts
  more: 30-day half-life). Each pick remembers which of your channels led to it: at most 4 Discover
  items per such channel, and the card says why ("Featured by Y (via X)", linked). Within a
  channel, its standout video (views vs the channel's median) comes first. Community links are
  ranked by popularity-normalised strength, so giant channels don't top every list.
- **On-device tuning:** for each Discover source (featured, mentions, community) the extension
  counts cards you saw and how many you then watched half-way, and nudges that source's weight
  (at most 2× either way, only after 30 cards). The popup shows the numbers. Nothing leaves the device.
- **Fresh feed:** each Home visit (including a reload or the logo) draws a new mix of "For you"
  from the stored pool, better matches more often. Cards seen on screen are counted once per visit
  and sink on later visits; brand-new subscription uploads stay at the top until seen twice. No
  extra requests.
- **Where requests run:** every InnerTube call is sent from an open YouTube tab, from the page's
  own origin. Public crawl jobs are leased by the service worker to one tab at a time and sent
  without cookies; session calls (subscriptions, history) use the page's session. The service
  worker itself only fetches RSS. With no YouTube tab open, nothing but RSS runs, and there is
  no feed to show anyway.
- **Watch logging:** listens to `timeupdate`/`seeking`/`seeked` on the main `<video>`. It counts
  the union of played intervals (seeks, jumps, ads and re-watching don't inflate it), and writes
  one `WatchEvent` per video session. It checkpoints every 30 s and when the tab is hidden.

### Ranking

- Each `SignalSource` returns a 0..1 score per candidate channel. The ranker takes a weighted
  average (featured 1.0, mentions 0.8), then applies feedback: "Don't recommend this channel" hides it,
  "More like this" multiplies its score by 1.5.
- **featured:** a candidate's score grows with the number of subscriptions that feature it. Each
  subscription counts `0.3 + 0.7 × engagement`, where engagement is the mean completion ratio
  from watch logs, damped until there are a few sessions. Featured links to sister channels
  (dubs, "Channel 2") count 0.15. Candidates featured by top candidates count at 25% (second hop).
- **mentions:** the same idea, with a 90-day half-life and diminishing returns for repeated mentions.
- **Feedback:** every card has a ⋮ menu. "Not interested in this video" hides only that video,
  everywhere. "Don't recommend this channel" (on top-row and Discover cards) removes the channel
  from the top row and from Discover; it never touches your subscriptions. Both are stored in
  IndexedDB and stay in force across reloads and new search results until undone (or "Clear all
  data"), so a hidden creator at #3 leaves the top row as #1, #2, #4, #5. Hiding something in the
  top row refills it at once with an Undo note above the row; elsewhere Undo replaces the card.
  "More like this" (Discover) boosts the channel's score.
- **Feed:** subscription uploads are ranked by recency × (0.5 + engagement); discovery uploads by
  channel score × recency. The two lists are interleaved at `SUBSCRIPTION_MIX = 0.6`
  ([src/shared/constants.ts](src/shared/constants.ts)). No more than 2 consecutive items come from
  the same channel. Shorts and videos you've finished (≥ 90%) are left out.
- **Earlier from your subscriptions:** below the main feed, every stored subscription upload not
  already shown loads newest first, 24 at a time as you scroll (same diversity rule). When a
  page reaches past what the subscriptions feed has covered, or runs out, the tab first reads up
  to 3 older feed pages from the furthest point reached so far (`subsFeed.deepest`, counted
  against the `subs` budget), so older uploads come with durations and views. Pre-rebuild RSS
  rows are filled in as those pages reach them. If a saved token stops working, reading further
  back stops instead of retrying. Old uploads from subscribed channels are never pruned, but
  they are for other channels after 180 days.
- **Adding a signal (v2 embeddings, etc.):** implement `SignalSource` in `src/core/sources/` and
  add it to `defaultSources()`. The ranker doesn't change.

### Crawler politeness and request budget

- One crawl request at a time, 3–5 s apart with jitter. Subscriptions-feed pages are paced by the
  tab (1.5 s for the first render, 4 s for gap and backfill pages).
- **Budgets by purpose** ([constants.ts](src/shared/constants.ts) `PURPOSE_BUDGETS`), per day, so
  one can't starve another: subscriptions feed 60, top row 12, discovery 165, mentions 25. A
  hard ceiling over everything stays at 300 (`dailyCap` in `chrome.storage.local`).
- Exponential backoff from 30 s on errors and non-200 responses. After 5 failures in a row, the
  crawler stops until tomorrow. A 404 for an unknown handle counts as an answer, not a failure.
- The popup says in words what's happening ("Discovery covers your top 150 of 400 channels so
  far", "paused until tomorrow to stay gentle with YouTube") and shows today's requests per
  purpose.

Expected requests per day, from `test/plan-cost.test.ts`, which runs the real planner, budgets
and sync state machine over 200 simulated days (assumptions: 0.3 uploads per subscription per
day, 30 videos per feed page, Home opened 10 times a day, 300 candidates):

| | 60 subscriptions | 1,000 subscriptions |
|---|---|---|
| Subscriptions feed | 10 | 15 |
| Top row | 6 | 6 |
| Discovery (featured + candidate uploads) | 16 | 33 |
| Mentions (weekly RSS of top 20) | 3 | 3 |
| **Total, steady state** | **~35** | **~57** |
| First day / bootstrap | 158, done in 1 day | ≤ 235/day for 7 days |

## Permissions

| Permission | Why |
|---|---|
| `storage` | The on/off toggle, the top-row switch and the daily cap. |
| `alarms` | Schedules the background RSS check and daily cleanup. |
| `*://www.youtube.com/*` | Runs on YouTube pages (feed, watch logging, reading subscriptions, sending crawl requests from the page) and lets the service worker fetch RSS feeds. |
| *Optional:* the Enhanced discoverability server (e.g. `https://community.example.com/*`) | Only in builds made with `COMMUNITY_API=…`, and only granted when a user switches Enhanced discoverability on. Switching it off revokes it. |

The extension makes no network requests to any host other than `www.youtube.com`. Thumbnails
are loaded by the page from `i.ytimg.com`. The one exception is the opt-in Enhanced
discoverability server, contacted only after the user turns that feature on. The popup's
"Support development" link opens ko-fi.com in a new tab only when clicked; the extension never
contacts it itself.

This matches the spec's list exactly. (Version 0.1 also needed `declarativeNetRequestWithHostAccess`
to rewrite the `Origin` of service-worker InnerTube requests, which YouTube rejects with 403.
Since 0.2 every InnerTube call is sent from a YouTube tab, so the permission and its rule are gone.)

## Enhanced discoverability (optional backend)

An opt-in feature, off by default. Users who switch it on share anonymous signals: videos
watched (by day), and pairs of channels they watch a lot (weekly). In return they get community
picks in the top row and "Popular with viewers of X" recommendations.
- There's no user ID; anonymous one-time tokens stop spam.
- Only thresholded, noisy totals are published.
- Backend: [backend/](backend) (Cloudflare Worker).

Design, privacy mechanisms, deployment steps and the legal checklist:
**[docs/enhanced-discoverability.md](docs/enhanced-discoverability.md)**. Builds without
`COMMUNITY_API` don't contain the feature.

## Privacy statement (store listing)

> YouTube Reborn reads the channels you subscribe to, their new uploads, and which videos you
> watch on youtube.com (including, once, a summary of your recent watch history: how many videos
> per channel), and builds recommendations from them. All of this stays on your device in your browser's local
> storage. Nothing is sent to us or to anyone else. The extension only talks to youtube.com, to
> read public channel pages and feeds. Turning the extension off in its toolbar popup stops all
> collection immediately. "Clear all data" in the same popup deletes everything it has stored.
> The optional "Support development" link in the popup opens our Ko-fi page only if you click it.
>
> YouTube Reborn is free. If you find it useful, you can support it at https://ko-fi.com/silkvain.

For builds with Enhanced discoverability, extend this with the opt-in section drafted in
[docs/enhanced-discoverability.md](docs/enhanced-discoverability.md#draft-privacy-policy-section-for-the-lawyer-to-edit),
after legal review.

## Support

YouTube Reborn is free, with no ads, tracking or paid features. If it improves your YouTube,
you can support development on [Ko-fi](https://ko-fi.com/silkvain). Entirely optional.

## Resilience

- YouTube-specific parsing lives only in [innertube.ts](src/content/innertube.ts) and
  [selectors.ts](src/content/selectors.ts). Parsers skip malformed items and never throw.
- Real, sanitized InnerTube and RSS responses are in [test/fixtures/](test/fixtures/). When
  YouTube changes a shape, the fixture tests fail. Refresh a fixture by capturing the request in
  DevTools and stripping tracking fields.
- If our feed fails to render, the `ydx-enabled` class is removed so YouTube's own feed shows, and
  the error is logged to the console.

## Tests

`npm test` covers: ranker math, source scoring, the 60/40 interleave, the diversity rule, feedback
multipliers, watch-interval accounting (seeks, jumps, pauses, re-watching, 2× speed), abandonment,
mention parsing and handle extraction, the rate limiter and per-purpose budgets, IndexedDB helpers,
migrations (v1 and v3 to v4) and the crawl planner (on fake-indexeddb), the subscriptions-feed sync
(first run, stop on overlap, gaps, backfill, empty, failures), the content-side sync loop and crawl
relay, the request-cost simulation, the popup status line, the feed DOM including in-place patching
(jsdom), and parsers against the fixtures.

Fixtures: `channel-*.json`, `resolve-url.json`, `search-*.json`, `rss-*.xml` and `watch-page.json`
are real public responses, stripped of tracking and player fields. `subscriptions-logged-in.json`
is a signed-in capture, anonymised. `subscriptions-feed*.json` and `history.json` are **synthetic**:
built to the real `lockupViewModel` shape (taken from `watch-page.json`) because no signed-in
capture of `FEsubscriptions`/`FEhistory` exists yet. Replace them with anonymised captures.

## Manual test checklist

**1. Skeleton + toggle**
- [ ] `dist/` loads unpacked without errors on `chrome://extensions`.
- [ ] Popup toggle persists after closing and reopening the popup and after a browser restart.
- [ ] Toggle on, hard-reload youtube.com: the native home grid never flashes.
- [ ] Toggle off with YouTube open: the native feed comes back without a reload. Toggle on: ours returns.

**2. Subscriptions**
- [ ] Signed in, enable the extension and open youtube.com. Within a minute the popup shows your
      subscription count (compare with youtube.com/feed/channels, including channels past the
      first page).
- [ ] On the first visit the feed fills with recent uploads from all your subscriptions within
      a few seconds, with durations and view counts, and no Shorts, live streams or premieres.
- [ ] Popup "subscriptions feed" shows 3–6 requests after the first visit. Open Home again 30+
      minutes later: 1–2 more. Opening Home again sooner adds none.
- [ ] Watch a new upload appear in youtube.com/feed/subscriptions, wait 30 min, open Home at the
      top of the page: it appears without a reload being needed for the rest of the feed.
- [ ] Signed out (or in a guest profile): the feed area shows "Sign in to YouTube to get your feed".

**3. Watch logging**
- [ ] Watch a video for ~1 minute, then navigate away. In DevTools → Application → IndexedDB →
      `youtube-reborn` → `watchEvents`, there's one event with `watchedSec` ≈ 60.
- [ ] Skip around (seek forward and back) while watching: `watchedSec` counts only what played.
- [ ] Ads before the video aren't counted.
- [ ] Toggle off, watch a video: no new event.

**4. Crawler + graph**
- [ ] Popup "Requests today" rises slowly (~12–15 per minute while there's work and a YouTube
      tab is open) and each purpose stops at its budget; the status line explains it.
- [ ] Close every YouTube tab: requests stop (apart from a few RSS reads); the status line says
      discovery continues while a YouTube tab is open.
- [ ] `edges` fills with `featured` and `mention` rows over time. Opening a channel page adds its
      featured channels, and watching a video adds its description's channel links, with no new
      requests.
- [ ] Service worker console (chrome://extensions → "service worker") shows no request bursts;
      after induced failures (e.g. offline), backoff and then "paused until tomorrow" show in the popup.

**4b. Most viewed today**
- [ ] The top of Home shows "Most viewed today" with 4 big videos from the last 24 hours, from 4 different creators. Reloading shows a different few.
- [ ] ⋮ → "Not interested in this video" leaves an Undo; after reload, the next-biggest video
      fills the slot. Other videos from that creator can still appear.
- [ ] ⋮ → "Don't recommend this channel" hides the channel's cards in the top row and Discover;
      Undo brings them back.
- [ ] Popup → "Most viewed this week" off: the row disappears from open tabs without a reload.

**5. Ranking + feed**
- [ ] Home shows a mix of subscription uploads and "Discover" items, with a "Featured by …" /
      "Mentioned by …" line.
- [ ] On a Discover card, ⋮ → "Don't recommend this channel" hides it immediately and it stays gone after reload.
      ⋮ → "More like this" moves the channel up on the next load.
- [ ] Go to a video, then back to Home via the logo: the feed is there exactly once.

**6. Polish**
- [ ] Switch YouTube between light and dark (avatar menu → Appearance): cards follow the theme.
- [ ] Fresh install: the feed shows subscription uploads with "Building your recommendations…".
- [ ] "Clear all data" empties the popup stats. The next YouTube visit starts a fresh sync.

## Known gaps / not yet verified

- **Signed-in feed endpoints not yet captured.** `FEsubscriptions` and `FEhistory` parsing is
  built on the `lockupViewModel` / `videoRenderer` shapes seen on public pages (Oct 2026), and the
  fixtures for them are synthetic. Not yet verified live: that `FEsubscriptions` is strictly
  newest-first (the sync needs 3 known videos on a page to stop, which tolerates a stray item),
  how far its continuation chain reaches back, how it marks Shorts and live items, and
  `FEhistory`'s shape. If history can't be parsed, the seed is skipped and retried weekly; crawl
  order then falls back to watch logs. If the feed can't be read three times running, the popup
  says so.
- **Subscription pagination:** the SAPISIDHASH-authenticated `FEchannels` request was verified
  signed in (Oct 2026). It returned all 60 subscriptions of the test account in one response,
  matching what youtube.com/feed/channels shows after scrolling. That structure is in
  `test/fixtures/subscriptions-logged-in.json`, anonymised. The continuation-following path is
  still untested against a live account with more subscriptions than fit in one response.
- Extension loading, the tab relay (top row, featured channels, candidate uploads), RSS from the
  service worker, and free harvesting (watch-page mentions; featured channels after SPA navigation
  to a channel) were verified in headless Chrome 155, signed out. Feed mounting, patching and
  watch logging on the real YouTube DOM are covered by unit/jsdom tests only.
- Not built (optional in the redesign): related videos as a third signal source, and following
  the subscriptions-feed chain further on demand while scrolling the archive.
- Firefox: the code avoids Chrome-only APIs where it's free to, but the manifest uses
  `background.service_worker` and Firefox is untested.
- No toolbar icon yet (Chrome shows its default puzzle-piece icon).

## License

[MIT](LICENSE). Free to use, modify and share.

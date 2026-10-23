# Enhanced discoverability

An **opt-in** feature: people who switch it on share anonymous signals, and everyone who has it on
gets better discovery from what those signals add up to. It's **off by default**. A build without
a backend address doesn't contain it at all.

- Backend: [backend/](../backend) (Cloudflare Worker, Durable Objects, R2)
- Extension side:
  - [src/background/community.ts](../src/background/community.ts) (scheduler)
  - [community-client.ts](../src/background/community-client.ts) (network)
  - [src/core/community.ts](../src/core/community.ts) (what gets uploaded)
  - [src/core/sources/community.ts](../src/core/sources/community.ts) (ranking signal)
- Shared protocol: [src/shared/community/](../src/shared/community)

> **Before you collect anything:** have a privacy lawyer review this document, the privacy policy
> text below and the Chrome Web Store disclosures. See [Legal checklist](#legal-checklist).

## What it does for users

1. **"Popular with viewers of X"**: a community channel graph ("people who watch A also watch B").
   It joins the featured-channel and mention signals in Discover.
2. **Community picks in "Most viewed this week"**: the top row alternates YouTube's own "most
   viewed" with what YouTube Reborn users watched this week, marked "Popular with YouTube Reborn
   users".

3. **The shared upload pool**: the server fetches recent long-form uploads of the channels in the
   published graph from the official YouTube Data API v3 and includes them in the graph shards.
   Devices then get Discover candidates for those channels without crawling them. Only public
   video data flows this way (title, length, views, date); nothing about users goes to Google.

All three start empty and fill in as people join:
- **Dormant at first.** Nothing at all is published until **160 uploads** (about 20 people sharing) arrive over the last
  7 days (`ACTIVATION_UPLOADS`). Until then the popup says "Community picks start once enough
  people have joined", and users see the normal feed.
- **Minimum contributors.** After that, each item still needs **20 contributors**
  (`MIN_CONTRIBUTORS`).
- **View floor for community picks.** A pick must also have **10,000+ views on YouTube itself**
  (`COMMUNITY_MIN_VIEWS`, checked against YouTube's own count), so an unknown video can't be
  pushed into the top row.

## What is shared, exactly

Every upload is one of these two JSON bodies, and nothing else. The server rejects any extra field.

**Watched videos**: at most once a day, at a random time:

```json
{ "token": { "epoch": "2026-10-15", "nonce": "…", "sig": "…" },
  "events": [ { "v": "<video id>", "c": "<channel id>", "d": "2026-10-15", "q": 3 } ] }
```

- `d` is the UTC **day**, never a time.
- `q` is a rough completion bucket: under 25%, 25–50%, 50–90%, 90% or more.
- One entry per video. At most 50. Sessions under a minute aren't counted.
- No titles: the extension looks those up from YouTube, so other users can't inject text.

**Channel pairs**: at most once a **week**, at a random time:

```json
{ "token": { … }, "pairs": [ ["<channel A>", "<channel B>", 2] ] }
```

- Built from the user's 12 most-watched channels over the last 4 weeks.
- Weight 1–3 reflects watch time; the weaker channel of the pair decides it.
- No videos, no times. Under 3 channels and nothing is sent.

**Never shared:**
- any account, ID, cookie or device fingerprint;
- anything watched before the user switched the feature on;
- searches;
- anything outside YouTube.

**Downloads** (cacheable, identical for everyone):
- the region's trending list;
- the graph shards covering the user's subscriptions, including the shared upload pool's recent
  uploads for the channels in them.

## Privacy mechanisms

| Mechanism | Where | What it prevents |
|---|---|---|
| **No identifier at all** | protocol | Linking uploads to a person or to each other. |
| **Anonymous one-time tokens** (RSA blind signatures, [blindrsa.ts](../src/shared/community/blindrsa.ts)) | `/v1/tokens`, spent on each upload | Spam without IDs. The server signs a *blinded* value, so it can verify a token later but can't tell which issuance it came from. Tokens are single-use (`SpentTokens`). |
| **Daily key rotation**, same key for everyone | `KeyStore` | Tokens linking across days, or a per-user key singling someone out. Keys older than 2 days are deleted. |
| **Day, not time; week for pairs** | protocol | Timing correlation with viewing sessions. |
| **Random upload times** (30 min–6 h after opt-in, then every 18–30 h; pairs within 48 h of a new week) | scheduler | Uploads lining up with what someone just watched. |
| **Separate uploads with separate tokens** | scheduler | Joining a person's videos with their channel pairs. |
| **IP never stored or logged** | Worker | The rate limiter keys on the connecting address at Cloudflare's edge, only for its 60 s window. Request logging is off (`observability.enabled = false`). Errors log messages only, never request details. |
| **Country from Cloudflare, not the client** | `/v1/events` | Region is coarse (two letters) and used only to group trending. |
| **Aggregate on arrival** | `Aggregator` | No raw uploads are stored. Counts are buffered in memory for a few seconds, then added to per-day (trending) or per-week (pairs) totals. |
| **Minimum contributors** (`MIN_CONTRIBUTORS`, default 20) | publish | Publishing anything a few people could be identified from. |
| **Laplace noise** (`DP_EPSILON`, default 1) | publish | Exact counts. Noise is fixed per item and period (seeded with `NOISE_SECRET`), so re-publishing hourly can't be averaged away. |
| **Noised popularity** (sensitivity 11) | publish | Each channel's popularity (pair-contributions it appears in) normalises its links, so giant channels don't lead every list (Davidson et al. 2010, §2.2). It is never published by itself and is noised before use. This adds a second release per graph period, so the effective privacy budget for the graph is the pair ε plus the popularity ε. |
| **Dormant until 160 uploads/week** (about 20 people) | publish | One person (or a handful) filling the lists while there are few real users. |
| **Kill switch and blocklist** (`PUBLISHING`, `BLOCKLIST`) | serve + publish | Anything that slips through: removed when served, without an extension update. |
| **Retention** | publish | Daily trending totals are kept 7 days, weekly pair totals 4 weeks, then deleted. Token nonces are deleted after 2 days. |
| **Upload pool from the official API, server-side** | `UploadPool`, cron | Devices fetching extra shards (or YouTube pages) for neighbour channels, which would reveal more about what they watch: the uploads ride inside the shards a device already downloads. Only channels already in the published (thresholded) graph are fetched, so a dormant server makes no API calls. The API key is a Worker secret. Entries are refreshed daily and anything older than 30 days is never published (YouTube API Services policy). |
| **Asked on install, off until "Agree"** | welcome window | A fresh install opens a centred window explaining that YouTube Reborn's recommendations need this, with equal-weight **Agree** and **Deny** buttons. Nothing is shared unless the user clicks Agree and the browser grants the server permission; closing the window leaves it off. Deny keeps the local feed working. The popup switch changes it later. |
| **Optional host permission** | build + popup | The extension can't contact the server until the user agrees and Chrome grants access. Switching off revokes it and deletes all downloaded community data. |

## Known limits (be honest about these)

- **Sybil/botnet attacks.** Someone with many IP addresses and patience can get many tokens and
  push a channel pair, or a popular video, up the lists. In place:
  - the burst rate limit (3 token requests per minute per address);
  - one count per video per upload;
  - the 20-contributor threshold;
  - dormancy until 160 uploads a week (about 20 people), which blunts launch-day attacks;
  - the 10,000-view floor for community picks;
  - the kill switch and blocklist.

  Not built: a daily per-address token cap. That means keeping a keyed hash of the address for up
  to a day, which changes the "IP never stored" promise. Revisit with your lawyer if abuse
  actually happens.
- **Contributor counts approximate people.**
  - A person who watches the same video on two days counts twice in that week's trending.
  - Pairs are sent once a week per device, so they count people per week accurately.
- **Single-object hot spots.** One `Aggregator` handles trending and 16 handle pairs. That's fine
  into the hundreds of thousands of users. Beyond that, shard trending by region.
- **Buffered counts can be lost.** If a Durable Object is evicted within the 5 s buffer window,
  a few increments are lost. Acceptable for statistics.
- **Graph shard downloads.** Which of the 256 shards a device fetches reveals roughly which
  channel buckets it cares about (each shard covers about 1/256 of channels, and responses are
  CDN-cached). Fetching all shards would remove this at a bandwidth cost.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/keys` | `{ epoch, n, e }`: today's public key, cached 5 min |
| POST | `/v1/tokens` | `{ epoch, blinded: [≤3] }` → `{ signatures }`. Rate-limited. |
| POST | `/v1/events` | Watched videos (above). Spends a token. |
| POST | `/v1/pairs` | Channel pairs (above). Spends a token. |
| GET | `/v1/trending/{XX\|global}.json` | `{ generatedAt, region, videos: [{ v, c, n }] }`, cached 1 h |
| GET | `/v1/graph/{0-255}.json` | `{ generatedAt, shard, neighbours: { channel: [[neighbour, n, strength]] }, uploads?: { channel: { t, f, v: [[videoId, title, publishedSec, durationSec, views]] } } }`, strongest first by `strength = n / √((pop_a+50)(pop_b+50))`, cached 6 h. `uploads` covers the shard's channels and their 15 strongest neighbours, 4 newest long-form uploads each. |
| GET | `/v1/health` | `{ ok: true }` |

Cron: trending hourly (`17 * * * *`), graph daily (`23 3 * * *`), upload pool every 10 minutes
(`*/10 * * * *`: up to 36 channels a run, stalest first, at most 9,000 API units a UTC day).

## Deploying (≈20 minutes)

You need a Cloudflare account. The free plan works to start; Workers Paid is $5/month once you
outgrow it. Node is at `~/.local/node/bin`.

```bash
cd backend && PATH=~/.local/node/bin:$PATH npx wrangler login
```

```bash
cd backend && PATH=~/.local/node/bin:$PATH npx wrangler r2 bucket create youtube-reborn-community-public
```

```bash
cd backend && PATH=~/.local/node/bin:$PATH npx wrangler secret put NOISE_SECRET
```

(Paste a long random value, e.g. from `openssl rand -base64 32`. Never commit it.)

```bash
cd backend && PATH=~/.local/node/bin:$PATH npx wrangler secret put YOUTUBE_API_KEY
```

(A YouTube Data API v3 key from Google Cloud, restricted to that API. Without it the upload pool
stays empty and everything else works.)

```bash
cd backend && PATH=~/.local/node/bin:$PATH npx wrangler deploy
```

**Kill switch and blocklist.** In the Cloudflare dashboard, open Workers & Pages →
youtube-reborn-community → Settings → Variables:
- `PUBLISHING` = `off` stops serving community data at once.
- `BLOCKLIST` = `<videoId>,<channelId>,…` removes those items from everything served.

Both apply as soon as the setting is saved. Files a user already downloaded can stay in their
browser cache for up to an hour (graph files up to 6 h), unless you purge the cache under Caching
→ Purge Everything. Set them in `wrangler.toml` too, so the next `wrangler deploy` doesn't
undo them. `ACTIVATION_UPLOADS` and `MIN_CONTRIBUTORS` work the same way.

Then, in the Cloudflare dashboard, give the Worker a custom domain such as
`community.yourdomain.com`, and build the extension with it:

```bash
COMMUNITY_API=https://community.yourdomain.com PATH=~/.local/node/bin:$PATH npm run build
```

The build adds that one origin as an **optional** host permission. Chrome asks the user only when
they switch the feature on.

**Testing locally** (no account needed):

```bash
cd backend && PATH=~/.local/node/bin:$PATH npx wrangler dev --local --port 8787 --test-scheduled --var MIN_CONTRIBUTORS:2 --var DP_EPSILON:1000
```

```bash
LIVE_BACKEND=http://127.0.0.1:8787 PATH=~/.local/node/bin:$PATH npx vitest run test/live-backend.test.ts
```

Local dev reads `NOISE_SECRET` from `backend/.dev.vars`, which is git-ignored. A build with
`COMMUNITY_API=http://127.0.0.1:8787` points a test copy of the extension at the local server.

## Costs

See the earlier estimate:
- **Cloudflare:** about £0 a month up to ~10k installs, £10–20 at 100k, £45–65 at 1M (30% opt-in).
- **Fixed:** about £110 a year (ICO fee, domain, Workers Paid).
- **One-time:** £1.6k–4.2k, mostly the privacy lawyer.

**YouTube Data API:** free. The default quota is 10,000 units a day; requests past it are refused,
never billed. The pool uses about 1.1 units per channel (its uploads playlist, plus one
`videos.list` per ~10 channels) and stops at 9,000 a day, so up to ~8,000 channel refreshes a day.
The 10-minute cron is 144 Worker runs a day, each a couple of Durable Object requests, well within
the Free plan.

The design follows that report's cost advice:
- downloads are static and CDN-cacheable;
- uploads are aggregated in memory and written in batches, never one row per event;
- spent tokens go in Durable Objects, not KV;
- raw data is never kept.

## Legal checklist

- [ ] **Privacy lawyer review**:
  - this document;
  - the privacy policy text below;
  - the consent screens: the install welcome window ([static/welcome/welcome.html](../static/welcome/welcome.html))
    and the popup switch ([static/popup/popup.html](../static/popup/popup.html));
  - the Chrome Web Store data disclosures.
- [ ] **DPIA**: complete the ICO template. The lawyer can review it.
- [ ] **ICO data protection fee**: Tier 1, £52 a year. The server processes IP addresses
      transiently, so register.
- [ ] **Chrome Web Store, Privacy tab**:
  - declare "Web history" (watched videos, aggregated and anonymous, opt-in);
  - the single purpose;
  - the optional host permission justification ("only contacted after the user opts in to
    Enhanced discoverability").
- [ ] **Store listing**: don't promise community features are live until the user base clears the
      contributor threshold. Suggested wording: *"Optional: Enhanced discoverability shares
      anonymous signals so recommendations improve as more people use it."*
- [ ] **Decide the abuse trade-off**: whether to add the per-address daily cap described above.
- [ ] **YouTube API Services terms** (the shared upload pool uses the YouTube Data API):
  - the privacy policy must say the product uses YouTube API Services, link to the
    [YouTube Terms of Service](https://www.youtube.com/t/terms) and the
    [Google Privacy Policy](https://policies.google.com/privacy);
  - the server stores only public video data, refreshes it daily and drops anything older than
    30 days; no user data is sent to Google;
  - check the Developer Policies' rules on showing API data next to the extension's own ranking
    (the reviewer may want the listing to say recommendations are not YouTube's);
  - Google may audit API clients with large quota; the default 10,000 units needs no audit.

### Draft privacy-policy section (for the lawyer to edit)

> **Enhanced discoverability (optional, off by default).** If you switch this on in the
> extension, it sends the YouTube Reborn server, at random times:
> (1) once a day, the public YouTube videos you watched that day, with the date (not the time)
> and a rough indication of how much of each you watched; and
> (2) once a week, pairs of YouTube channels you watch a lot.
> It never sends your name, account, an identifier, cookies, your searches, or anything you
> watched before switching it on. Each upload carries a single-use anonymous token, so uploads
> cannot be linked to each other or to you. We do not log or store IP addresses. Your
> connection's address is used only momentarily by our hosting provider, Cloudflare, to limit
> abuse. Uploads are immediately added to totals. We publish only totals that at least 20 people
> contributed to, with random noise added. Daily totals are deleted after 7 days and weekly
> totals after 4 weeks. The server also fetches recent public videos of channels in the published
> totals from YouTube API Services, under the YouTube Terms of Service
> (https://www.youtube.com/t/terms) and the Google Privacy Policy (https://policies.google.com/privacy);
> no information about you is sent to Google this way. You can switch it off at any time in the extension. Sharing stops
> immediately and the extension deletes the community data it downloaded.

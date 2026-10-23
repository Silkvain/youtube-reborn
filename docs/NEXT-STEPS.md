# Status and next steps

*Last updated 2026-10-18 (third session: the shared upload pool). Update this file whenever something here
changes.*

## Start here (next session)

0. **Live on the Chrome Web Store** (approved by 2026-10-23), version 0.2.1:
   https://chromewebstore.google.com/detail/reborn-for-youtube/confbgnfdhfkpihnlibagkdekdmbimbk
   (item `confbgnfdhfkpihnlibagkdekdmbimbk`). Data declared: Web history + Location. **The GitHub
   repo went public on 2026-10-23** with a single clean "initial public release" commit (the
   earlier private history is kept only in a git bundle on the owner's Mac). ~20 opted-in people
   lift the server out of dormancy. Field-by-field answers: [store-listing.md](store-listing.md).

1. Read this file, then ask the owner what they noticed using the extension since 2026-10-17
   (new feed behaviour, the top row, Discover reasons, the popup's Discover numbers).
2. **The shared upload pool is deployed** (2026-10-18) and idle until the server leaves dormancy.
   The owner's extension was rebuilt with it; they reload it in Brave.
3. Everything below "Done" is already shipped and pushed; don't redo it.

## Where things stand

**The extension (v0.2.0)** works. The owner runs it unpacked from `dist/` in **Brave** (not
Chrome), as a **backend-enabled build** (`COMMUNITY_API` set, normal timings) and is opted in to
Enhanced discoverability with their own data, by their choice. Always rebuild with:

```bash
COMMUNITY_API=https://youtube-reborn-community.youtube-reborn-community.workers.dev PATH=~/.local/node/bin:$PATH npm run build
```

After a rebuild the owner clicks reload at `brave://extensions`, then refreshes YouTube.

**Tests:** 238 extension + 31 backend, all passing (`npm test`, `cd backend && npm test`), plus
the opt-in live tests against a local Worker (passed 2026-10-17; the upload-pool one, which
uses real API quota, passed 2026-10-18).

**GitHub:** **public** repo https://github.com/Silkvain/youtube-reborn (since 2026-10-23), MIT
licence. The owner allows pushing without asking, but **everything pushed is public**: run the
privacy scan first, and keep personal details (family, legal contacts, costs) out of commits.

**Backend:** live on the owner's Cloudflare account (Workers Free plan), dormant (nothing published
until 160 uploads a week, about 20 people), collecting only from the owner's own opted-in build. An informal legal
review said it's fine for now (2026-10-18), so public builds may point at it.

## What the feed does now

- **Top row (4 slots), refreshed every 6 hours:**
  - "Most viewed today": YouTube search, upload date "Today" (a rolling 24 h, verified live)
    sorted by views, over 6 common words. The 12 biggest are kept, and each Home visit shows a
    different 4.
  - A 7-day backup pool tops the row up when hides or a thin day leave too few.
  - **Language check** from titles (script, named language like "Hindi Dubbed", Latin stop
    words). The user's languages are their YouTube UI language, their region's languages, and any
    language ≥15% of their subscription uploads are in.
  - **Affinity:** channels near subscriptions ×2; channels near a hidden creator ×0.4.
- **Pushed news (only on big news days):**
  - The extension reads YouTube's News hub (`UCYfdidRxbB8Qhf0Nx7ioOYw`) for the user's own region
    every 2 hours. It is localised per country (GB, NL, DE, FR and US checked).
  - A story takes a slot (at most 2, labelled with its headline) only when **2+ different
    verified outlets** each gather views at ≥25% of the median speed of today's most viewed, or
    2+ verified hub outlets are among today's most viewed.
  - On 2026-10-17 the bar was ~130k views/hour and the biggest UK story ~22k, so no news showed.
    That's correct.
  - It never reads the user's own home page (empty with history off anyway).
- **"For you":**
  - **A fresh weighted draw on every Home visit** (including reload and the logo), seeded per
    visit and stable per video, so mid-visit updates don't reshuffle.
  - Cards seen on screen are counted once per visit and sink on later visits (×0.5 each).
  - Brand-new subscription uploads (<48 h) are pinned at the top until seen twice.
- **Discover, after Davidson et al., "The YouTube Video Recommendation System" (RecSys 2010):**
  - **Seeds:** subscriptions plus channels watched ≥50% at least 3 times in 60 days without
    subscribing. Engagement is recency-weighted (30-day half-life). Featured channels of the top
    20 such channels are read on the 60-day cycle.
  - **Attribution:** each pick remembers its strongest seed. At most 4 Discover items per seed.
    Reasons name that seed ("Featured by Y (via X)", "Popular with viewers of X") and link to it.
  - **Standout videos:** within a Discover channel, standout videos come first (views vs the
    channel's median).
  - **Community graph:** neighbours are ranked by popularity-normalised strength, which is on the
    server now.
  - **On-device tuning:** per source (featured, mentions, community), cards seen and watched
    half-way are counted, with a 30-day half-life. Source weights are nudged 0.5–2× after 30 cards,
    and the popup shows the numbers. Nothing leaves the device.
- **Request budget:**
  - Per purpose: subscriptions 60, top row 45 (24 searches + 12 News hub reads), discovery 165,
    mentions 25.
  - Overall cap: 300 a day.
  - Simulated: about 65 a day at 60 subscriptions, about 90 at 1,000.

## Done (2026-10-18)

- **Turn-off confirmation for Enhanced discoverability** (owner's request): switching it off in
  the popup first shows what will be deleted, with "Keep it on" (highlighted) and "Turn off".
  Nothing changes until "Turn off". Kept to one factual step so withdrawing consent stays as
  easy as giving it (UK GDPR); don't add more steps or guilt wording. Tested in
  `test/popup.test.ts`.

- **Bug fix: switching Reborn off no longer looks like (or acts as) an opt-out.** The popup
  showed Enhanced discoverability as off and greyed out whenever the extension was off, and a
  background update caught mid-switch deleted the pooled videos. Now `communityOptedIn()` (the
  user's own choice) is separate from `communityActive()` (opted in *and* Reborn on): switching
  Reborn off only pauses sharing ("Paused while Reborn is off. Your choice is kept."), and only
  the Enhanced discoverability switch itself opts out and deletes downloaded data. Both popup
  switches stay usable while Reborn is off.

- **Cards match YouTube's home page** (owner's request; measured against the native signed-in
  home at 1440×900, then our real card code rendered in the same page with the same videos):
  - a 36px channel avatar beside each title (stored channel avatars, YouTube's yt3 hosts only,
    added in `withAvatars` in feed.ts; a letter circle when unknown);
  - one detail line like YouTube's: channel, ▷ short views ("864k"), age, then our Discover badge;
  - YouTube's 40px ⋮ icon, always visible; 50px kept clear for it; a soft rounded hover panel;
  - 36px between rows; duration badge 60% black. Measured result: card positions, thumbnail,
    badge, avatar, title, detail line and ⋮ all within 1px of native.
  - Not copied: the verified tick (we don't store it for every channel).
  - `scripts/screenshots/in-page.ts` is the comparison harness (dev aid, not shipped).

- **Card ⋮ opens YouTube's own menu** (owner's request): Add to queue, Save to Watch Later,
  Save to playlist, Download, Share and Report, plus our More like this / Not interested in this
  video / Don't recommend this channel in the same sheet, before Report.
  - `src/content/yt-commands.ts` builds the same command YouTube's ⋮ buttons carry (a
    `showSheetCommand` with an inline list), from the video ID, in the shapes seen on the
    signed-in home feed; tests pin the params to strings seen live. `bridge-main.ts` hands it to
    `ytd-app.handleCommandWithCommandHandler` with our ⋮ button (`data-ydx-anchor`) as the anchor.
  - Our items carry a no-op command; `home.ts` catches clicks on them (capture phase, by title)
    before YouTube does, closes the sheet and runs our action.
  - If YouTube's app doesn't answer within 0.5 s, our own menu (just our three items) opens.
  - **Verified live, signed in (built code injected, 2026-10-18):** the sheet opens anchored to our
    button with every icon; Save to playlist shows the playlist picker inside it; Report opens the
    report form; Download shows YouTube's Premium offer (the owner isn't on Premium; Premium users
    get the real download). Add to queue and Share verified earlier. Owner confirmed Watch Later.
  - Why a sheet, not separate commands: Save to playlist opens *inside* YouTube's menu sheet, and
    Download needs YouTube's own download item; neither works as a loose command.

- **Install welcome window** (`static/welcome/`, `src/welcome/welcome.ts`,
  `src/background/welcome.ts`): on a fresh install of a backend-enabled build, a window centred
  over the browser asks to switch on Enhanced discoverability, saying it is what YouTube Reborn's
  recommendations need. Agree asks for the server permission, then switches it on; Deny leaves
  it off. Shown once (`welcomeAnswer` in storage). A test keeps its "shares / never shares" list
  identical to the popup's. Checked in headless Chrome 155: opens on install, off before an
  answer, Deny works. Agree's permission prompt can't be clicked headless; unit-tested only.
  Tell the DPIA reviewer about it.

- **Google API key:** the owner made it. It is stored as the Worker secret `YOUTUBE_API_KEY`
  (set 2026-10-18). The owner pasted
  it in chat and chose not to rotate it.
- **Shared upload pool**, deployed 2026-10-18 with the owner's go-ahead (version `2f4b6591`):
  - `backend/src/pool.ts` fetches each channel's long-form uploads playlist (`UULF…`: no
    Shorts, no live) plus one `videos.list` per 50 videos. The `UploadPool` Durable Object
    (migration v2) holds the to-fetch list, the uploads and the daily quota count.
  - New cron `*/10 * * * *`: up to 36 channels a run, stalest first, capped at 9,000 units a
    UTC day. It stops for the day on `quotaExceeded`.
  - Only channels in the published graph are fetched. The daily graph publish sets that list and
    embeds `uploads` (shard channels + their 15 strongest neighbours, 4 videos each) in each
    shard. Dormant server → no API calls. Entries older than 30 days are never published.
  - Extension: `storePoolUploads` stores them as videos and sets `videosTabFetchedAt`, so the
    crawler skips those channels. Subscriptions are skipped. Opting out deletes them (tracked in
    meta `communityPool`), keeping the privacy policy's "deletes downloaded community data"
    promise.
  - Design doc updated: API, costs, YouTube API terms in the legal checklist, a line for the
    draft privacy policy.

## Done (2026-10-16 → 17)

- **Bug fix:** Discover cards without durations (pre-rebuild RSS leftovers) are no longer shown.
- **Git and GitHub:**
  - Repo set up, with commits as "Silkvain" plus the GitHub noreply address (set in this repo's
    config only).
  - GitHub CLI at `~/.local/bin/gh`, signed in.
- **Ko-fi:** "YouTube Reborn is free and open-source. Support development ❤️" in the popup footer,
  plus README and privacy-statement lines. Link: https://ko-fi.com/silkvain.
- **MIT licence** (copyright "Silkvain").
- **Backend deployed** (then redeployed with the normalised graph).
  - Live test from the owner's Brave passed: keys, tokens and `POST /v1/events` all returned 200.
  - The weekly channel-pair upload is not yet exercised (it needs 3+ channels watched at that
    moment).
- **Test-build flag:** `COMMUNITY_TEST=1` (uploads every 2–4 minutes). Never publish such a build.
- **Draft DPIA** written for an informal legal review (kept outside the repo).
- **Feed freshness, top row today, language check, pushed news, the 2010 paper's ideas (R1–R5):**
  all described above.
- **Privacy scan now catches IPv6.** A News hub capture contained the owner's IPv6 address in
  video URLs; it was scrubbed before commit.

## To do, in order

### 1. Watch the shared upload pool once there are users
Deployed 2026-10-18. The first two live pool runs ended "ok" using 0–1 ms of CPU (the Free plan
allows 10 ms); the server is dormant, so they made no API calls. Still unverified on Cloudflare:
a run that actually calls Google (it passed against a local Worker with real API calls). When the
graph first has channels, check `wrangler tail` for "exceeded CPU" and the pool's daily units.
(The daily graph publish's CPU at real scale is an older open question.)

### 2. Legal: informal review done; proper counsel later
- **2026-10-18:** an informal legal review said it's fine for now. Proper legal counsel is worth getting **at a few thousand users**. Treat that as the
  trigger; don't re-raise the legal review before then.
- Not known: whether the review went through the DPIA's eight open questions one by one (Q2
  special-category data, Q6 "Silkvain" as controller name), or saw the later additions (the R1
  popularity release, the YouTube API terms and upload pool, the install welcome window). Hand all
  of that to the proper counsel later.
- **Still needed for launch** (paperwork, not legal review). **The owner handles all of this
  themselves right before launch** (pays the ICO fee, fills the forms with other help). Don't
  raise it before then; when they say go, offer the facts from enhanced-discoverability.md
  ("What is shared, exactly" and the draft privacy-policy section) so the forms match the code.
  - the ICO data protection fee (£52 a year): the server handles personal data;
  - a privacy policy (the draft in enhanced-discoverability.md, plus the YouTube API Services
    line), hosted somewhere public;
  - the Chrome Web Store privacy disclosures;
  - optionally a custom domain for the Worker.

### 3. Chrome Web Store preparation
The owner wants the backend live before launch; this can run alongside step 2.
- **Icons and promo images: done (2026-10-18).** GPT made them from [store-assets.md](store-assets.md);
  icons in `static/icons/` (16, 48 made from the 512 master, 128) and in the manifest; store
  images in `store/` (`promo-small-440x280.png`, `marquee-1400x560.png`, `icon-512.png`), with
  a few edge pixels trimmed off GPT's resizing seams. The owner's raw originals are in `images/`
  (git-ignored). `npm run package` now produces `release/reborn-for-youtube-0.2.0.zip`.
- **Name: done (2026-10-18).** The store name is **"Reborn for YouTube"**, and the extension
  calls itself **"Reborn"** everywhere a user sees it. Decided after research:
  - "YouTube …" names pass store review (hundreds are live);
  - YouTube's API Branding Guidelines ban "YouTube", "YT" or variants in an app's name and allow
    only "for YouTube";
  - Google has forced renames by trademark complaint after launch, which can mean a new listing
    starting from zero users.

  The repo, folder, package and code comments keep "YouTube Reborn" as the project's working name.
- **Packaging: done.** `npm run package` runs tests and the typecheck, makes the production
  build (server address built in; it refuses `COMMUNITY_TEST` builds), checks the manifest
  version, the https server permission, the icons and that there are no source maps, then writes
  `release/reborn-for-youtube-<version>.zip` (git-ignored). It fails until the icons exist.
- **Screenshots: done.** `npm run screenshots` (after a build) renders the real feed, welcome
  window and popup with made-up channels and drawn thumbnails (`scripts/screenshots/`) into
  `store/screenshot-1..4.png`, 1280×800. Re-run it when the UI changes.
- **Listing text and Privacy-tab answers: done.** See [store-listing.md](store-listing.md): every
  dashboard field in order, with permission justifications, data disclosures ("Web history",
  opt-in only) and "no remote code". Keep it in step with the code.
- **Privacy policy: live (2026-10-18)** at
  https://youtube-reborn-community.youtube-reborn-community.workers.dev/privacy
  (`backend/src/privacy-page.ts`, contact silkvain.dev@gmail.com). It promises that changes to
  what is shared will be asked about again: keep that promise. Redeploy after editing it.
- **Developer account: done (2026-10-18).** The owner made a separate publishing Google account
  (publisher name "Silkvain"). Submission is theirs: upload the zip, paste from store-listing.md,
  start Unlisted.

### 4. Before launch
- The repo is public (2026-10-23), so "free and open-source" in the popup is now true.
- `homepage_url` (the GitHub repo) was added to the manifest on 2026-10-23; it reaches users with
  the next store upload (bump the version).
- **Link the public source code everywhere data collection is mentioned** (owner's idea,
  2026-10-18), once the repo is public: anyone who doubts what's collected can read the code.
  - The install welcome window (`static/welcome/welcome.html`): e.g. "Don't take our word for it:
    read the code" next to the "What it shares" lists.
  - The popup: the consent box, and turn "free and open-source" in the footer into a link.
  - The store listing, the privacy policy and the README.
  - Link the specific files too: `src/core/community.ts` (exactly what gets uploaded) and
    `backend/` (what the server keeps).
  - Set `homepage_url` in the manifest to the repo.
- Optional: GitHub Actions running both test suites.

## Owner-side checks still open
- **Cloudflare:** set the $1 budget alert (Billing → Billable Usage). Never upgrade to Workers Paid
  without redoing the cost maths.
- **Backup folder:** `~/Projects/Youtube Reborn backup (before data-layer rebuild)` can be deleted
  whenever the owner likes.

## Reference

**Privacy scan before every push.** It should print only `0.0.0.0` and nothing else. The second
command catches IPv6 addresses:

```bash
grep -rEoh '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' test/fixtures | sort -u
grep -rlE 'ip=[0-9a-fA-F]{1,4}(%3A|:)' test/fixtures
grep -rliE 'SAPISID=|__Secure-3PAPISID=|SAPISIDHASH [0-9]' test src backend/src static docs
```

Expected hits for the third command, all fine:
- the fake cookies in `test/innertube.test.ts` and `test/subs-sync.test.ts`;
- this file.

Also check that the owner's email address and macOS username appear nowhere (don't write them
into the repo). `.gitignore` excludes `node_modules/`, `dist/`, `backend/.wrangler/` and
`backend/.dev.vars`. **Never commit any NOISE_SECRET or API key.**

**Backend facts:**
- Worker `youtube-reborn-community` at
  `https://youtube-reborn-community.youtube-reborn-community.workers.dev`.
- R2 bucket `youtube-reborn-community-public`: r2.dev public access off, no custom domain.
- `NOISE_SECRET` is set (random, stored nowhere else). Wrangler is signed in on this Mac.
- `YOUTUBE_API_KEY` is set (the shared upload pool). A local Worker gets it with
  `--var YOUTUBE_API_KEY:…` on the command line, never via `.dev.vars` in the repo folder.
- Crons: trending hourly at :17, graph daily at 03:23 UTC, upload pool every 10 minutes.
- Kill switch and blocklist: see the design doc.

**Watching the live server:** `wrangler tail --format json`, printing only method, path and
status. Raw events include the connecting IP.

**Costs:** see the backend cost notes in [enhanced-discoverability.md](enhanced-discoverability.md)
and the reasoning above. Workers and Durable Objects on the Free plan fail rather than bill. R2's
worst case stays within its free tier.

## Decisions already made (don't re-litigate)

- **Business model:** a free extension, with donations via Ko-fi. Public name: "Silkvain".
- **Data fetching:** aggregate-first. Never poll channel by channel.
- **Top row:** "Most viewed today", not this week (a week looked static). News only when YouTube
  pushes it, judged by 2+ verified outlets. Never infer anything about who the user is: language
  and closeness signals only (no religion, ethnicity or politics).
- **Feedback:** per video or per creator. Creator hides never affect the user's own subscriptions.
- **Backend:**
  - Opt-in, asked up front: a welcome window on install says plainly that YouTube Reborn's
    recommendations need it, with equal Agree and Deny (decided 2026-10-18). Not on by default:
    UK GDPR/PECR and the Chrome Web Store need an affirmative "yes", and Deny must keep the local
    feed working. No persistent ID, aggregates only, IPs never stored. Cloudflare.
  - Dormant until 160 uploads a week (about 20 people; lowered from 500 on 2026-10-18 so it
    starts as soon as the 20-person rule allows). 10k-view floor for community picks, plus a kill switch and
    a blocklist.
  - Order: backend live before the store launch.
  - Ideas that need the backend are fine, as long as they are harmless at zero users.
- **The 2010 paper:**
  - Borrowed: R1–R5.
  - Deliberately not copied: video-level 24 h co-visitation (too identifying and too sparse),
    anything needing user IDs or A/B groups, likes and comment counts.
  - Not done: R6, a second hop on the community graph. It widens what shard downloads reveal
    about the user.
- **Launch messaging:** don't claim community features are live until the backend has users.

## Known gaps / not verified

- **Pushed news:** never seen live (no big news day since it was built). It is tested with
  simulated election-night numbers.
- **On-device Discover tuning:** needs ~30 Discover cards seen per source before it does anything.
- **Subscriptions-feed continuation tokens:** whether a saved token still works days later is
  unverified.
- **Browsers:** Firefox is untested. Real-page behaviour is checked by the owner by eye, plus jsdom
  tests.
- **Backend scale:** trending uses one Durable Object; shard it by region past ~100k users.

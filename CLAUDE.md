# YouTube Reborn: notes for Claude Code

A free Chrome (MV3) extension that replaces the YouTube home feed with a local, privacy-first
discovery feed. It has an optional, opt-in backend ("Enhanced discoverability", a Cloudflare
Worker in `backend/`). The owner is a solo developer in the UK who plans to publish it free with a
Ko-fi donation link.

**Start every session by reading [docs/NEXT-STEPS.md](docs/NEXT-STEPS.md).** It has the current
status, the decisions already made, and the to-do list. Ask the owner what they found while
testing before starting new work.

## Environment quirks (this Mac)

- **Node is not on PATH.** It's installed at `~/.local/node/bin` (Node 22). Prefix commands:
  `PATH=~/.local/node/bin:$PATH npm test`. There is no Homebrew.
- **git works** (since 2026-10-16). The repo is on the owner's GitHub (`origin`, private). The
  GitHub CLI is at `~/.local/bin/gh` (not on PATH) and already signed in. Interactive prompts
  don't take input in the app's terminal panel; run `gh` non-interactively. Still use Node, not
  `python3`, for scripting.
- **The owner uses Brave**, not Chrome, running a **backend-enabled build**. Rebuild with
  `COMMUNITY_API=https://youtube-reborn-community.youtube-reborn-community.workers.dev` set, or the
  Enhanced discoverability toggle disappears from their extension. They reload it at
  `brave://extensions`.
- **Cloudflare:** `wrangler` is signed in to the owner's account. The Worker is live (Free plan);
  deploy only with the owner's explicit go-ahead. Never upgrade the plan or open R2 public access.
- **Secrets the owner pastes** (API keys etc.): start `npx wrangler secret put NAME` in a terminal
  tab and let them paste. Never ask for a key in chat; never write one to the repo.
- **Pushing to GitHub** is allowed without asking, after the privacy scan. **The repo is public**
  (since 2026-10-23): everything pushed is visible to anyone, so never commit personal details
  (family, legal contacts, costs), secrets or unscrubbed captures. The public name is "Silkvain".
- **Built-in browser pane:** a tab there is usually signed in to the owner's YouTube account. It
  has signed itself out before; ask them to sign in again if needed. Use it only for read-only
  InnerTube checks; never change the account.
- **Real-Chrome testing:** Google Chrome 155 is at `/Applications/Google Chrome.app`. Branded
  Chrome ignores `--load-extension`. Instead:
  1. launch it headless with `--remote-debugging-pipe --enable-unsafe-extension-debugging` and a
     throwaway `--user-data-dir`;
  2. call the DevTools method `Extensions.loadUnpacked` with the `dist/` path.

  Headless profiles are signed out and land on YouTube's consent page.
- **Local backend:**
  ```bash
  cd backend && PATH=~/.local/node/bin:$PATH npx wrangler dev --local --port 8787 --test-scheduled --var MIN_CONTRIBUTORS:2 --var DP_EPSILON:1000 --var ACTIVATION_UPLOADS:6
  ```
  Then run `LIVE_BACKEND=http://127.0.0.1:8787 npx vitest run test/live-backend.test.ts` from the
  repo root. The local cron ignores `time`; trigger jobs with `/__scheduled?cron=<pattern>`.

## Commands

| What | Command (repo root unless noted) |
|---|---|
| Build extension | `npm run build` → `dist/` (load unpacked in Chrome) |
| Build with backend | `COMMUNITY_API=https://… npm run build` (adds the opt-in feature and its optional host permission). This is the build the owner runs. |
| Test build (fast uploads) | `COMMUNITY_TEST=1 COMMUNITY_API=https://… npm run build`. Never publish; rebuild normally afterwards. |
| Tests / types | `npm test`, `npm run typecheck` |
| Backend tests / types | `cd backend && npm test && npm run typecheck` |

After a rebuild, the owner must click reload on the extension card at `chrome://extensions`, then
refresh YouTube.

## Layout

- `src/content/`: runs on youtube.com.
  - `home.ts`: the feed UI, with the ⋮ menus, top row and older-uploads scroll.
  - `innertube.ts`: **all** YouTube API parsing.
  - `yt-commands.ts`: YouTube's own ⋮ menu (queue, Watch Later, playlist, download, share, report),
    opened by YouTube's app via `bridge-main.ts` next to our ⋮ button.
  - `selectors.ts`: **all** DOM selectors.
  - `relay.ts`: runs crawl jobs from the tab.
  - `subs.ts`: subscriptions-feed sync.
  - `watch.ts`: watch logging.
- `src/background/`: the service worker.
  - `crawler.ts`: job planner and per-purpose budgets.
  - `subsfeed.ts`: the incremental subscriptions-feed state machine.
  - `feed.ts`: assembles the feed.
  - `community*.ts`: Enhanced discoverability client.
  - `discover-stats.ts`: on-device Discover measurement and source tuning.
- `src/core/`:
  - `db.ts`: IndexedDB, schema v4. Migrations are `if (oldVersion < N)` blocks; never break existing data.
  - `ranker.ts`, `sources/`: pluggable `SignalSource`s (seeds, per-candidate `Via` attribution).
  - `language.ts`: title-based language check for the top row.
  - `community.ts`: what gets uploaded.
- `src/shared/community/`: protocol and blind-signature crypto shared with `backend/`.
- `backend/`: Cloudflare Worker (`src/app.ts` logic, `src/index.ts` entry, `src/objects.ts`
  Durable Objects, `wrangler.toml`).
- `test/fixtures/`: real YouTube responses.
- Docs:
  - `README.md`: architecture, permissions, checklist.
  - `docs/enhanced-discoverability.md`: backend design, deploy steps, legal checklist.
  - `docs-HANDOFF.md`: the original spec.

## Rules that matter here

- **Privacy is the product.** Nothing leaves the device except requests to youtube.com, plus the
  opt-in backend when the user has switched it on. Never add analytics, telemetry or third-party
  hosts. The backend takes no user IDs and stores no IP addresses (see the design doc).
- **Fixtures must be anonymised before committing.** Signed-in captures get synthetic IDs, names
  and titles. Public captures can contain the requester's IP, IPv4 or IPv6 (`ip=` in googlevideo URLs). Scan
  before every commit; see the command in docs/NEXT-STEPS.md.
- **Verify against the live site, not memory.** YouTube changes shapes often. When unsure, inspect
  the real response, add or refresh a fixture, and test the parser against it.
- **Request budget:** the crawler is deliberately gentle (per-purpose daily budgets, 3–5 s
  spacing). Don't add per-channel polling; that was the old design's failure.
- **Ask before outward-facing actions:**
  - creating repositories or changing their visibility (pushing to this repo is pre-approved);
  - deploying the backend;
  - creating any account;
  - publishing to the Chrome Web Store.

  The owner sets up accounts and credentials themselves.
- The owner prefers plain-English explanations, and wants changes tested live where possible.

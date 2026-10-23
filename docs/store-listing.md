# Chrome Web Store submission: what goes where

Every field of the Developer Dashboard, in order, with what to paste. The answers match the code
as of 2026-10-18; if the code changes what's collected or which permissions it uses, update this
file first.

**Upload:** `release/reborn-for-youtube-<version>.zip (0.2.1 as of 2026-10-22)`, made by `npm run package`.

## Account (once)

- **Publisher name:** Silkvain
- **Contact email:** silkvain.dev@gmail.com (shown publicly on the listing).
- **Trader / non-trader:** non-trader (a free extension with optional donations), the owner's
  choice.
- **2-step verification:** on.

## Store listing tab

**Name** (from the manifest): Reborn for YouTube

**Summary** (from the manifest, 132 characters max):
> Old-YouTube-style recommendations on your home page, built from what you watch. Private by default; optional anonymous sharing.

**Category:** Entertainment. (Alternative: "Functionality & UI".)

**Language:** English

**Description** (paste as is):

```
Reborn brings back what made YouTube's home page great: recommendations built from the channels you actually subscribe to and watch, plus new channels found the way old YouTube did, through the creators you already like. No endless rabbit holes picked to keep you scrolling.

WHAT YOU GET
• A fresh home feed every visit: new uploads from your subscriptions first, mixed with picks from channels you'll probably love.
• Discover picks that say why they're there: "Featured by …", "Mentioned by …", or "Popular with viewers of …".
• "Most viewed today": a few of the biggest videos of the last 24 hours, in languages you read. You can switch it off.
• Simple controls on every card: hide a video, see less of a channel, or see more like it.
• An honest popup: what Reborn is doing, what it checked and when, and one click to clear everything.

PRIVATE BY DEFAULT
Your feed is built on your own device. Your subscriptions, viewing and settings are stored locally in your browser, and Reborn only talks to youtube.com, gently, with daily limits.

OPTIONAL: ENHANCED DISCOVERABILITY
When you install Reborn, it asks whether you'd like to switch on Enhanced discoverability, the community feature behind "Popular with viewers of …" recommendations. It's off unless you click Agree.
If you agree, Reborn shares anonymously which public videos you watched (the day, never the time) and pairs of channels you watch a lot. There's no account, no ID and no cookie: each upload uses a one-time anonymous token, so uploads can't be linked to each other or to you. Only totals that many people contributed to are ever published, with random noise added. The more people join, the better the recommendations get. You can switch it off any time in the popup, and the downloaded data is deleted.

FREE
Reborn is free. If you enjoy it, you can support development on Ko-fi: https://ko-fi.com/silkvain

OPEN SOURCE
Don't take our word for it: read the code. Everything Reborn does, including exactly what Enhanced discoverability uploads and what the server keeps, is public at https://github.com/Silkvain/youtube-reborn

Reborn is an independent project. It is not affiliated with, endorsed by or sponsored by YouTube or Google.
```

**Screenshots** (upload in this order, all 1280×800, in `store/`):
1. `screenshot-1-feed.png`
2. `screenshot-2-discover.png`
3. `screenshot-3-choice.png`
4. `screenshot-4-popup.png`

**Small promo tile:** `store/promo-small-440x280.png`
**Marquee promo tile:** `store/marquee-1400x560.png` (optional)
**Icon:** taken from the package. If asked, `store/icon-512.png` is the master.

**Official URL:** leave empty. **Homepage URL:** https://github.com/Silkvain/youtube-reborn. **Support URL:** https://github.com/Silkvain/youtube-reborn/issues.

## Privacy practices tab

**Single purpose:**
> Replaces the YouTube home page with a feed of recommendations built from the channels the user subscribes to and watches.

**Permission justifications:**

| Permission | Paste |
|---|---|
| `storage` | Stores the user's settings (on/off switches, daily request limit) in the browser. The feed's data (subscriptions, cached videos, viewing progress) is stored locally on the user's device. |
| `alarms` | Schedules the background refresh: new uploads and discovery are fetched gently over the day, within daily request limits, rather than all at once. |
| Host permission `*://www.youtube.com/*` | The extension's whole function is on youtube.com: it replaces the home page feed, reads the user's subscriptions feed and their viewing progress on watch pages, and loads video and channel details from YouTube. It runs on no other site. |
| Optional host permission (the Reborn server) | Requested only if the user agrees to the optional "Enhanced discoverability" feature (asked on install, and from the popup switch). Used to upload anonymous viewing totals and download community recommendations. Never contacted otherwise; removed when the user switches the feature off. |

**Are you using remote code?** No. All JavaScript is in the package. The server returns only JSON
data (lists of video and channel IDs and public video details).

**Data usage: what the extension collects** (the store means "sent off the device"). Tick only:
- **Web history**: only if the user opts in to Enhanced discoverability. It covers which public
  YouTube videos were watched (with the day and a rough completion level) and pairs of channels
  watched. It's sent with no identifier and aggregated.

- **Location** (ticked 2026-10-22): with Enhanced discoverability on, the server records each
  upload's two-letter country (from Cloudflare) to count trending per country. Declared because
  Google's examples for Location include "region"; the privacy policy says so.

Leave unticked: personally identifiable information, health, financial and payment,
authentication, personal communications, user activity, website content. Subscriptions,
viewing progress and the feed itself stay on the device and are never sent.

**Certify** (all three apply):
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:**
`https://youtube-reborn-community.youtube-reborn-community.workers.dev/privacy` (once deployed).

## Distribution tab

- **Visibility:** Unlisted first (only people with the link can install), then Public once a few
  friends have tried it. Switching to Public later needs no new review.
- **Regions:** all.
- **Price:** free.

## After submitting

- Review usually takes a few days. Extensions with host permissions can take up to a couple of
  weeks.
- If it's rejected, the email says which policy. Bring it back here; most fixes are a wording
  change.
- After approval: install it from the store yourself (not unpacked), check the welcome window
  appears, click Agree, and check the browser asks for the server permission.

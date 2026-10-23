# Store graphics: specifications

What the Chrome Web Store listing needs, written so an image tool (the owner uses GPT) can make
each piece. Drop the finished files where each section says, then tell Claude Code. It wires the
icons into the manifest, checks the sizes and runs `npm run package`.

**Screenshots are not on this list.** The store requires screenshots to show the real extension,
so they're taken from the real UI with made-up demo channels (Claude Code does those).

## Brand, for every image

- **Name:** "Reborn" (store name "Reborn for YouTube"). Never write "YouTube Reborn" or "YT" in a
  store graphic.
- **Style:** the owner's existing look. Near-black background with flowing red light ribbons, and
  bold white type with the word "Reborn" in red. Modern, clean, a little cinematic.
- **Colours:**
  - background `#0B0B0D`;
  - surface `#1A1A1F`;
  - text `#FFFFFF`;
  - accent: a red-to-coral gradient, `#E3122D` → `#FF5A3C`. Use the gradient, not flat
    `#FF0000`, so it doesn't read as YouTube's red.
- **Font feel:** a rounded geometric sans, heavy weight (like Poppins or Montserrat ExtraBold).

### Never in any store graphic

These are the things that get listings rejected or reported for trademark:
- YouTube's logo, its red rounded-rectangle play button, or anything shaped to look like it;
- the "YouTube" wordmark or YouTube's font;
- screenshots or mock-ups of YouTube's own interface (sidebar, logo, "Shorts" etc.);
- the words "official" or "by YouTube".

"for YouTube" in small plain text is fine (YouTube's branding rules allow it). No other
companies' logos either.

## 1. Extension icon (required)

| File | Size | Notes |
|---|---|---|
| `static/icons/icon-512.png` | 512×512 | Master copy. Claude Code makes the smaller sizes from it. |
| `static/icons/icon-128.png` | 128×128 | Store and install dialog. Artwork 96×96, centred, with 16 px of transparent padding on every side (Chrome's icon guideline). |
| `static/icons/icon-16.png` | 16×16 | Browser toolbar. Optional: if the downscale looks muddy, a simplified version drawn for 16 px. |

- PNG with a transparent background around the artwork.
- **It must still read at 16×16:** one bold shape, no text, no thin lines.
- **Concept:** a rounded-square tile with the red-to-coral gradient. Inside it, a white circular
  "rewind / renew" arrow (about 300° of a circle, arrowhead at the end) wrapped around a small
  white play triangle. The play triangle must be small and enclosed by the arrow, so the whole
  thing doesn't look like YouTube's play button.
- Optional: a subtle soft shadow under the tile. No glow that turns to mush when small.

**Prompt for GPT:**
> App icon, 512×512 PNG, transparent background. A rounded-square tile filling about 75% of the
> canvas, with a smooth diagonal gradient from deep red (#E3122D) at top-left to coral
> (#FF5A3C) at bottom-right. In the centre, a bold white circular arrow (a "renew / rewind"
> symbol, about 300 degrees of a ring with one arrowhead) wrapped around a small white play
> triangle. Flat, modern, minimal, high contrast, must stay recognisable at 16×16 pixels. No
> text, no letters, no YouTube logo, no rectangle-with-play-button shape. Subtle soft drop shadow
> under the tile.

## 2. Small promo tile (required by the store)

| File | Size |
|---|---|
| `store/promo-small-440x280.png` | 440×280, PNG or JPEG, no transparency |

- The icon on the left; "Reborn" in large bold white type on the right, with "Reborn" in the
  accent gradient (or white with the icon carrying the red). Under it, small grey text:
  "for YouTube".
- Background: near-black with one or two flowing red light ribbons, like the Ko-fi banner but
  calmer.
- Little text: it's shown small. No UI mock-ups, no screenshots.

**Prompt for GPT:**
> Promotional tile, exactly 440×280 pixels. Near-black background (#0B0B0D) with one or two
> smooth flowing red-to-coral light ribbons sweeping across the lower part. On the left, an app
> icon: a red-to-coral gradient rounded square with a white circular renew arrow around a small
> white play triangle. To its right, the word "Reborn" in a heavy rounded geometric sans-serif,
> white, large. Beneath it in small light-grey text: "for YouTube". Clean, cinematic, lots of
> breathing room. Do not include the YouTube logo, YouTube's play button, the YouTube wordmark,
> or any website interface.

## 3. Marquee promo tile (optional)

Used only if the store features the extension.

| File | Size |
|---|---|
| `store/marquee-1400x560.png` | 1400×560, PNG or JPEG, no transparency |

- Same style as the small tile, wider.
- Icon and "Reborn" on the left third. The tagline below, in spaced capitals like the Ko-fi
  banner: "THE OLD RECOMMENDATIONS, REBORN".
- The right two-thirds: red light ribbons, plus an *abstract* grid of blank rounded video-card
  shapes (grey rectangles with a circle and two bars beneath each). It must not look like
  YouTube's page: no sidebar, no logo, no search bar.

**Prompt for GPT:**
> Wide promotional banner, exactly 1400×560 pixels. Near-black background (#0B0B0D) with flowing
> red-to-coral light ribbons. Left third: an app icon (red-to-coral gradient rounded square with
> a white circular renew arrow around a small white play triangle), next to the word "Reborn" in
> a heavy rounded white sans-serif. Underneath, in small widely spaced light-grey capitals:
> "THE OLD RECOMMENDATIONS, REBORN". Right two-thirds: an abstract, slightly tilted grid of
> blank dark-grey rounded rectangles like video thumbnails, each with a small circle and two
> short grey bars beneath, softly lit by the red ribbons. No logos, no website interface, no
> sidebar, no search bar, no YouTube branding.

## Checklist before handing them over

- [ ] Exact pixel sizes as listed (the store rejects other sizes).
- [ ] No YouTube logo, play-button tile, wordmark or interface anywhere.
- [ ] The icon is still recognisable when shrunk to 16×16.
- [ ] Any text is spelled right: "Reborn", "for YouTube".
- [ ] The files are saved to the paths above.

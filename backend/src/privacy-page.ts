/**
 * The privacy policy, served at /privacy (the store needs a public URL for it). Keep it in step
 * with docs/enhanced-discoverability.md and docs/store-listing.md.
 */
export const PRIVACY_CONTACT = 'silkvain.dev@gmail.com';
export const PRIVACY_UPDATED = '18 October 2026';

export const privacyPage = (contact = PRIVACY_CONTACT) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reborn for YouTube: privacy policy</title>
<style>
  :root { color-scheme: light dark; --fg: #1a1a1a; --muted: #555; --bg: #fff; --line: #e3e3e3; }
  @media (prefers-color-scheme: dark) { :root { --fg: #eee; --muted: #aaa; --bg: #141416; --line: #333; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 28px; margin: 0 0 4px; } h2 { font-size: 19px; margin: 32px 0 8px; }
  .muted { color: var(--muted); } li { margin-bottom: 6px; } a { color: inherit; }
</style></head><body><main>
<h1>Privacy policy</h1>
<p class="muted">Reborn for YouTube (“Reborn”), a browser extension by Silkvain. Last updated ${PRIVACY_UPDATED}.</p>

<h2>In short</h2>
<ul>
  <li>Reborn builds your YouTube home feed on your own device. That data stays in your browser.</li>
  <li>An optional feature, <strong>Enhanced discoverability</strong>, shares anonymous viewing
    signals with the Reborn server. It is off unless you agree, and you can switch it off at any time.</li>
  <li>Reborn has no accounts, no tracking, no analytics and no ads, and never sells data.</li>
</ul>

<h2>Data that stays on your device</h2>
<p>To build your feed, Reborn reads from youtube.com, in your browser: the channels you subscribe
to, new uploads, video and channel details, how much of the videos you watch you actually watch,
and your feedback (hidden videos and channels). This is stored only in your browser’s extension
storage. It is never sent to the Reborn server or anyone else. You can delete it all with “Clear all
data” in the extension’s popup, or by removing the extension.</p>
<p>Reborn sends requests only to YouTube (from your browser, as YouTube itself would) and, if you
opt in, to the Reborn server described below.</p>

<h2>Enhanced discoverability (optional)</h2>
<p>When you install Reborn it asks whether to switch this on; it is off unless you click Agree. If you
agree, Reborn sends the Reborn server, at random times:</p>
<ul>
  <li>once a day, the public YouTube videos you watched that day, with the date (not the time) and
    a rough indication of how much of each you watched; and</li>
  <li>once a week, pairs of YouTube channels you watch a lot.</li>
</ul>
<p>It never sends your name, account, an identifier, cookies, your searches, your subscriptions, or
anything you watched before switching it on. Each upload carries a single-use anonymous token, so
uploads cannot be linked to each other or to you.</p>
<p><strong>On the server.</strong> We do not log or store IP addresses. Your connection’s address is
used only momentarily by our hosting provider, Cloudflare, to limit abuse. Cloudflare also tells
the server which country an upload comes from (two letters, for example GB), so watched videos can be
counted per country for country-specific lists; nothing more precise about your location is used or
kept. Uploads are immediately
added to totals, and the individual uploads are not kept. We publish only totals that at least 20
people contributed to, with random noise added. Daily totals are deleted after 7 days and weekly
totals after 4 weeks.</p>
<p><strong>Switching it off</strong> (the switch in the popup) stops sharing immediately, and the
extension deletes the community data it downloaded.</p>

<h2>YouTube API Services</h2>
<p>The Reborn server uses YouTube API Services to fetch recent public videos of channels that appear
in the published community totals. No information about you is sent to YouTube or Google this way.
By using Reborn you also agree to the <a href="https://www.youtube.com/t/terms">YouTube Terms of
Service</a>; see the <a href="https://policies.google.com/privacy">Google Privacy Policy</a>.</p>
<p>Reborn is an independent project, not affiliated with, endorsed by or sponsored by YouTube or
Google.</p>

<h2>Legal basis and your rights</h2>
<p>Enhanced discoverability relies on your consent, which you can withdraw at any time with the
switch in the popup. Because uploads carry no identifier and are added to totals at once, we
cannot find, show or delete a particular person’s contributions after they arrive. Data on your
device is under your control and can be deleted at any time as described above. If you are in the
UK or EU you may also complain to your data protection authority (in the UK, the ICO).</p>

<h2>Children</h2>
<p>Reborn is not directed at children under 13 and does not knowingly collect data about them.</p>

<h2>Changes and contact</h2>
<p>If this policy changes, the date above will change. If what is shared ever changes, Reborn will ask
for your agreement again before sharing anything new. Questions: <a href="mailto:${contact}">${contact}</a>.</p>
</main></body></html>`;

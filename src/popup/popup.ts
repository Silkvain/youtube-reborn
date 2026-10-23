import { send, type Stats } from '../shared/messages';
import { communityAvailable, communityPermission } from '../shared/community/config';
import { getSettings, setEnabled, setEnhancedDiscovery, setShowTrending } from '../shared/settings';

const toggle = document.getElementById('enabled') as HTMLInputElement;
const trendingToggle = document.getElementById('showTrending') as HTMLInputElement;
const state = document.getElementById('state') as HTMLParagraphElement;
const stats = document.getElementById('stats') as HTMLDListElement;
const clear = document.getElementById('clear') as HTMLButtonElement;
const communitySection = document.getElementById('community') as HTMLElement;
const enhanced = document.getElementById('enhanced') as HTMLInputElement;
const consent = document.getElementById('consent') as HTMLElement;
const consentYes = document.getElementById('consentYes') as HTMLButtonElement;
const consentNo = document.getElementById('consentNo') as HTMLButtonElement;
const optOut = document.getElementById('optOut') as HTMLElement;
const optOutKeep = document.getElementById('optOutKeep') as HTMLButtonElement;
const optOutConfirm = document.getElementById('optOutConfirm') as HTMLButtonElement;
const communityStatus = document.getElementById('communityStatus') as HTMLParagraphElement;
const privacyNote = document.getElementById('privacyNote') as HTMLParagraphElement;

function ago(t: number | undefined): string {
  if (!t) return 'never';
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

const SOURCE_NAMES: Record<string, string> = { featured: 'featured channels', mentions: 'mentions', community: 'community' };

function renderStats(s: Stats | undefined): void {
  if (!s) {
    stats.replaceChildren();
    return;
  }
  const rows: [string, string][] = [
    ['Subscriptions', String(s.subscriptions)],
    ['Discovery candidates', String(s.candidates)],
    ['Channel links found', String(s.edges)],
    ['Videos cached', String(s.videos)],
    ['Watch sessions logged', String(s.watchEvents)],
    ['Requests today', String(s.requestsToday)],
    ['· subscriptions feed', `${s.spent.subs} of ${s.budgets.subs}`],
    ['· most viewed row', `${s.spent.top} of ${s.budgets.top}`],
    ['· discovery', `${s.spent.discovery + s.spent.mentions} of ${s.budgets.discovery + s.budgets.mentions}`],
    ['New uploads checked', ago(s.lastFeedSync)],
    // Discover, measured on this device: of the cards you saw from each source, how many you watched.
    ...(s.discover ?? []).map(({ source, shown, watched }): [string, string] => [
      `· Discover via ${SOURCE_NAMES[source] ?? source}`,
      `watched ${watched} of ${shown} seen`,
    ]),
  ];
  stats.replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }),
  );
}

function stateText(enabled: boolean, s: Stats | undefined): string {
  if (!enabled) return 'Off. YouTube is untouched and nothing is collected.';
  // The service worker explains what it's doing and why (limits, coverage, sign-in).
  return s?.status ? `On. ${s.status}` : 'On. Your home feed is replaced with your own recommendations.';
}

function communityText(c: Stats['community']): string {
  if (!c?.on) return '';
  if (c.paused) return 'Paused while Reborn is off. Your choice is kept.';
  if (c.failing) return 'Can’t reach the server right now; it will try again later.';
  if (!c.lastOkAt) return 'Starting up…';
  if (c.dormant) return 'You’re sharing, thanks! Community recommendations appear and improve as more people join.';
  const parts = [`Updated ${ago(c.lastOkAt)}.`];
  parts.push(c.trendingVideos ? `${c.trendingVideos} community picks this week.` : 'Not enough people sharing yet for community picks.');
  if (c.graphChannels) parts.push(`Connections known for ${c.graphChannels} channels.`);
  return parts.join(' ');
}

async function refresh(): Promise<void> {
  const { enabled, showTrending } = await getSettings();
  toggle.checked = enabled;
  trendingToggle.checked = showTrending;
  trendingToggle.disabled = false; // a display preference: kept, and changeable, while Reborn is off
  const s = await send({ type: 'stats:get' }).catch(() => undefined);
  state.textContent = stateText(enabled, s);
  renderStats(s);
  if (communityAvailable()) {
    communitySection.hidden = false;
    const on = s?.community?.on === true;
    if (consent.hidden && optOut.hidden) enhanced.checked = on;
    // Your choice stays yours even while Reborn is off: you can still opt out (or in) here.
    enhanced.disabled = false;
    communityStatus.textContent = communityText(s?.community);
    privacyNote.textContent = on && enabled
      ? 'Everything is stored on this device. Besides youtube.com, only the anonymous signals described above are sent, to the Reborn server.'
      : 'Everything is stored on this device. Nothing is sent anywhere except youtube.com.';
  }
}

// Enhanced discoverability: explain first, then ask Chrome for the server permission, then switch on.
enhanced.addEventListener('change', async () => {
  const permission = communityPermission();
  if (!permission) return;
  if (enhanced.checked) {
    enhanced.checked = false;
    consent.hidden = false;
    consentYes.focus();
    return;
  }
  // Turning it off deletes the community data, so say so and ask once before doing it.
  enhanced.checked = true;
  optOut.hidden = false;
  optOutKeep.focus();
});

optOutKeep.addEventListener('click', () => {
  optOut.hidden = true;
  enhanced.checked = true;
  enhanced.focus();
});

optOutConfirm.addEventListener('click', async () => {
  const permission = communityPermission();
  optOut.hidden = true;
  if (!permission) return;
  await setEnhancedDiscovery(false);
  await chrome.permissions.remove({ origins: [permission] }).catch(() => false);
  await refresh();
});

consentYes.addEventListener('click', async () => {
  const permission = communityPermission();
  if (!permission) return;
  // Must run directly in the click handler: Chrome only shows the prompt for a user gesture.
  const granted = await chrome.permissions.request({ origins: [permission] });
  consent.hidden = true;
  if (granted) await setEnhancedDiscovery(true);
  await refresh();
});

consentNo.addEventListener('click', () => {
  consent.hidden = true;
  enhanced.checked = false;
});

toggle.addEventListener('change', async () => {
  await setEnabled(toggle.checked);
  await refresh();
});

trendingToggle.addEventListener('change', () => void setShowTrending(trendingToggle.checked));

clear.addEventListener('click', async () => {
  if (!confirm('Delete all subscriptions, watch history, and recommendations stored by Reborn?')) return;
  clear.disabled = true;
  await send({ type: 'data:clear' });
  clear.disabled = false;
  await refresh();
});

void refresh();

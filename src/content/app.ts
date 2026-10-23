/**
 * Content-script entry (document_end on www.youtube.com). Wires the home feed, watch logging,
 * subscription syncs, the crawl relay and free page harvesting to the on/off toggle and to
 * YouTube's SPA navigation.
 */
import { send, type Broadcast } from '../shared/messages';
import { getSettings, onEnabledChange, onSettingsChange } from '../shared/settings';
import type { YtClientConfig } from '../shared/types';
import { getClientConfig, getPageSummary } from './bridge';
import { HomeFeed, isHomeRoute } from './home';
import { CrawlRelay } from './relay';
import { YT_EVENTS } from './selectors';
import { syncSubscriptionFeedIfDue, syncSubscriptionsIfDue, readDeeperFeedPage } from './subs';
import { WatchLogger } from './watch';

const feed = new HomeFeed({
  // Older uploads: read further back in the subscriptions feed as the user scrolls.
  deepen: () => (cfg ? readDeeperFeedPage(cfg) : Promise.resolve(false)),
});
const watch = new WatchLogger();
const relay = new CrawlRelay();
let enabled = false;
let cfg: YtClientConfig | null = null;
/** Last page harvested, so one navigation is only read once. */
let harvested = '';

function onRoute(): void {
  if (!enabled) return;
  if (isHomeRoute()) {
    void feed.mount();
    // Render from cache first; the sync patches new uploads in when they arrive.
    if (cfg) void syncSubscriptionFeedIfDue(cfg);
  } else {
    feed.unmount();
  }
  void harvestPage();
}

/**
 * Take what the page already loaded: description mentions on watch pages and featured channels
 * on channel Home tabs. Costs no requests.
 */
async function harvestPage(): Promise<void> {
  const key = location.pathname + location.search;
  if (key === harvested) return;
  harvested = key;
  const page = await getPageSummary();
  if (!enabled || !page || page.path !== location.pathname) return;
  if (page.kind === 'watch' && page.watch.videoId === new URLSearchParams(location.search).get('v')) {
    void send({ type: 'page:watch', watch: page.watch }).catch(() => undefined);
  } else if (page.kind === 'channel') {
    void send({ type: 'page:channel', page: page.channel }).catch(() => undefined);
  }
}

async function enable(): Promise<void> {
  enabled = true;
  watch.start();
  onRoute();
  cfg = await getClientConfig();
  if (cfg?.gl) void send({ type: 'region', gl: cfg.gl.toUpperCase(), hl: cfg.hl }).catch(() => undefined);
  if (!enabled) return;
  relay.start(() => cfg);
  await syncSubscriptionsIfDue(cfg);
  if (enabled && isHomeRoute()) await syncSubscriptionFeedIfDue(cfg);
}

function disable(): void {
  enabled = false;
  harvested = '';
  relay.stop();
  watch.stop();
  feed.unmount();
}

document.addEventListener(YT_EVENTS.navigateFinish, onRoute);

chrome.runtime.onMessage.addListener((msg: Broadcast) => {
  if (msg?.type === 'feed:updated' && enabled) feed.onDataUpdated();
  return false;
});

onEnabledChange((on) => void (on ? enable() : disable()));
onSettingsChange(() => {
  if (enabled && isHomeRoute()) void feed.refresh();
});

void getSettings().then((s) => (s.enabled ? enable() : disable()));

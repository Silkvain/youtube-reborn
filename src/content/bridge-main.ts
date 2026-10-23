/**
 * Runs in the page's MAIN world (not the isolated content-script world) so it can read
 * `ytcfg` and the player's data. It only answers requests from our content scripts. The one
 * thing it does to the page is open YouTube's own ⋮ menu next to our feed's ⋮ button when the
 * user clicks it (and close it again). Requests and responses travel as JSON strings on window events.
 */
import {
  BRIDGE_REQUEST,
  BRIDGE_RESPONSE,
  type BridgeCommandResult,
  type BridgeConfig,
  type BridgePage,
  type BridgeRequest,
  type BridgeVideoInfo,
} from './bridge-protocol';
import { summarisePage } from './innertube';
import { YT_EVENTS } from './selectors';
import { ytMenuCommand, type OwnMenuItem } from './yt-commands';

interface YtWindow {
  ytcfg?: { get?: (k: string) => unknown; data_?: Record<string, unknown> };
  ytInitialData?: unknown;
}

/**
 * The page data YouTube already loaded for the current page. On a full load that's
 * window.ytInitialData; after SPA navigation ytInitialData is stale and the fresh response is in
 * the yt-navigate-finish event (detail.response.response), which only this world can read.
 */
let navData: { path: string; search: string; data: unknown } | null = null;

document.addEventListener(YT_EVENTS.navigateFinish, (e) => {
  const data = (e as CustomEvent<{ response?: { response?: unknown } }>).detail?.response?.response;
  if (data) navData = { path: location.pathname, search: location.search, data };
});

function readPage(): BridgePage | null {
  const path = location.pathname;
  let data: unknown;
  if (navData) {
    if (navData.path !== path || navData.search !== location.search) return null;
    data = navData.data;
  } else {
    data = (window as unknown as YtWindow).ytInitialData;
  }
  if (!data) return null;
  return { ...summarisePage(path, data, Date.now()), path };
}

interface Player extends HTMLElement {
  getPlayerResponse?: () => { videoDetails?: { videoId?: string; channelId?: string; lengthSeconds?: string } };
}

function cfgValue(key: string): unknown {
  const ytcfg = (window as unknown as YtWindow).ytcfg;
  return ytcfg?.get?.(key) ?? ytcfg?.data_?.[key];
}

function readConfig(): BridgeConfig | null {
  const version = cfgValue('INNERTUBE_CLIENT_VERSION');
  if (typeof version !== 'string') return null;
  const ctx = cfgValue('INNERTUBE_CONTEXT') as { client?: { hl?: string; gl?: string } } | undefined;
  return {
    INNERTUBE_API_KEY: cfgValue('INNERTUBE_API_KEY') as string | undefined,
    INNERTUBE_CLIENT_NAME: cfgValue('INNERTUBE_CLIENT_NAME') as string | undefined,
    INNERTUBE_CONTEXT_CLIENT_NAME: cfgValue('INNERTUBE_CONTEXT_CLIENT_NAME') as number | undefined,
    INNERTUBE_CLIENT_VERSION: version,
    LOGGED_IN: cfgValue('LOGGED_IN') === true,
    SESSION_INDEX: cfgValue('SESSION_INDEX') as string | number | undefined,
    DELEGATED_SESSION_ID: cfgValue('DELEGATED_SESSION_ID') as string | undefined,
    VISITOR_DATA: cfgValue('VISITOR_DATA') as string | undefined,
    HL: ctx?.client?.hl,
    GL: ctx?.client?.gl,
  };
}

function readVideo(): BridgeVideoInfo | null {
  const player = document.querySelector<Player>('#movie_player');
  const details = player?.getPlayerResponse?.()?.videoDetails;
  if (!details?.videoId) return null;
  const length = Number(details.lengthSeconds);
  return {
    videoId: details.videoId,
    channelId: details.channelId,
    lengthSeconds: Number.isFinite(length) ? length : undefined,
  };
}

interface YtApp extends HTMLElement {
  handleCommandWithCommandHandler?: (command: unknown, source: HTMLElement) => void;
}

/** Opens YouTube's own menu sheet, anchored to our ⋮ button, via YouTube's app. */
function openMenu(videoId: string, anchor: string, own: OwnMenuItem[]): BridgeCommandResult {
  if (!/^[\w-]{11}$/.test(videoId) || !/^[\w-]{1,40}$/.test(anchor)) return { ok: false };
  const app = document.querySelector<YtApp>('ytd-app');
  const source = document.querySelector<HTMLElement>(`[data-ydx-anchor="${anchor}"]`);
  if (!source || typeof app?.handleCommandWithCommandHandler !== 'function') return { ok: false };
  const items = own.filter((o) => typeof o?.title === 'string' && /^[A-Z_]{1,40}$/.test(o.icon)).map((o) => ({ title: o.title.slice(0, 80), icon: o.icon }));
  app.handleCommandWithCommandHandler(ytMenuCommand(videoId, items), source);
  return { ok: true };
}

function closeMenus(): BridgeCommandResult {
  const app = document.querySelector('ytd-app');
  if (!app) return { ok: false };
  app.dispatchEvent(
    new CustomEvent('yt-action', { bubbles: true, composed: true, detail: { actionName: 'yt-close-all-popups-action', args: [], optionalAction: false, returnValue: [] } }),
  );
  return { ok: true };
}

window.addEventListener(BRIDGE_REQUEST, (e) => {
  let req: BridgeRequest;
  try {
    req = JSON.parse(String((e as CustomEvent).detail));
  } catch {
    return;
  }
  let payload: BridgeConfig | BridgeVideoInfo | BridgePage | BridgeCommandResult | null = null;
  try {
    payload =
      req.kind === 'config'
        ? readConfig()
        : req.kind === 'page'
          ? readPage()
          : req.kind === 'menu'
            ? openMenu(req.videoId, req.anchor, req.own)
            : req.kind === 'closeMenu'
              ? closeMenus()
              : readVideo();
  } catch {
    payload = null;
  }
  window.dispatchEvent(new CustomEvent(BRIDGE_RESPONSE, { detail: JSON.stringify({ id: req.id, payload }) }));
});

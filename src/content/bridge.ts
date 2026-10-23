/** Isolated-world side of the bridge: ask bridge-main.ts for page data. */
import { DEFAULT_CLIENT } from './innertube';
import {
  BRIDGE_REQUEST,
  BRIDGE_RESPONSE,
  type BridgeCommandResult,
  type BridgeConfig,
  type BridgePage,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeVideoInfo,
} from './bridge-protocol';
import type { YtClientConfig } from '../shared/types';
import type { OwnMenuItem } from './yt-commands';

let nextId = 1;

type Ask =
  | { kind: 'config' | 'video' | 'page' | 'closeMenu' }
  | { kind: 'menu'; videoId: string; anchor: string; own: OwnMenuItem[] };

function ask<T>(request: Ask, timeoutMs = 1000): Promise<T | null> {
  const id = nextId++;
  return new Promise((resolve) => {
    const onResponse = (e: Event) => {
      let res: BridgeResponse;
      try {
        res = JSON.parse(String((e as CustomEvent).detail));
      } catch {
        return;
      }
      if (res.id !== id) return;
      cleanup();
      resolve(res.payload as T | null);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener(BRIDGE_RESPONSE, onResponse);
    };
    window.addEventListener(BRIDGE_RESPONSE, onResponse);
    window.dispatchEvent(new CustomEvent(BRIDGE_REQUEST, { detail: JSON.stringify({ id, ...request } satisfies BridgeRequest) }));
  });
}

/** Page's InnerTube client config, retrying briefly while ytcfg initialises. */
export async function getClientConfig(attempts = 10): Promise<YtClientConfig | null> {
  for (let i = 0; i < attempts; i++) {
    const c = await ask<BridgeConfig>({ kind: 'config' });
    if (c?.INNERTUBE_CLIENT_VERSION) {
      return {
        apiKey: c.INNERTUBE_API_KEY,
        clientName: c.INNERTUBE_CLIENT_NAME ?? DEFAULT_CLIENT.clientName,
        clientNameId: c.INNERTUBE_CONTEXT_CLIENT_NAME ?? DEFAULT_CLIENT.clientNameId,
        clientVersion: c.INNERTUBE_CLIENT_VERSION,
        hl: c.HL ?? DEFAULT_CLIENT.hl,
        gl: c.GL ?? DEFAULT_CLIENT.gl,
        loggedIn: c.LOGGED_IN === true,
        sessionIndex: c.SESSION_INDEX === undefined ? undefined : String(c.SESSION_INDEX),
        delegatedSessionId: c.DELEGATED_SESSION_ID,
        visitorData: c.VISITOR_DATA,
      };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

export function getVideoInfo(): Promise<BridgeVideoInfo | null> {
  return ask<BridgeVideoInfo>({ kind: 'video' });
}

/** Free data from the page the user is on (see bridge-main.ts readPage). */
export function getPageSummary(): Promise<BridgePage | null> {
  return ask<BridgePage>({ kind: 'page' });
}

/**
 * Opens YouTube's own ⋮ menu for a video next to the element marked data-ydx-anchor=anchor,
 * with our own items added. False if YouTube's app didn't take it (then show our own menu).
 */
export async function openYtMenu(videoId: string, anchor: string, own: OwnMenuItem[]): Promise<boolean> {
  return (await ask<BridgeCommandResult>({ kind: 'menu', videoId, anchor, own }, 500))?.ok === true;
}

export async function closeYtMenu(): Promise<void> {
  await ask<BridgeCommandResult>({ kind: 'closeMenu' }, 500);
}

/** Event names for talking to bridge-main.ts, which runs in the page's own JS world. */
import type { PageSummary } from './innertube';
import type { OwnMenuItem } from './yt-commands';

export const BRIDGE_REQUEST = 'ydx:bridge-request';
export const BRIDGE_RESPONSE = 'ydx:bridge-response';

export interface BridgeConfig {
  INNERTUBE_API_KEY?: string;
  INNERTUBE_CLIENT_NAME?: string;
  INNERTUBE_CONTEXT_CLIENT_NAME?: number;
  INNERTUBE_CLIENT_VERSION?: string;
  LOGGED_IN?: boolean;
  SESSION_INDEX?: string | number;
  DELEGATED_SESSION_ID?: string;
  VISITOR_DATA?: string;
  HL?: string;
  GL?: string;
}

export interface BridgeVideoInfo {
  videoId?: string;
  channelId?: string;
  lengthSeconds?: number;
}

/** What the current page offers for free (watch-page mentions, channel featured list). */
export type BridgePage = PageSummary & { path: string };

/** Whether YouTube's app took the request. */
export interface BridgeCommandResult {
  ok: boolean;
}

export type BridgeRequest =
  | { id: number; kind: 'config' }
  | { id: number; kind: 'video' }
  | { id: number; kind: 'page' }
  /** Open YouTube's own ⋮ menu for a video next to the element with data-ydx-anchor=anchor. */
  | { id: number; kind: 'menu'; videoId: string; anchor: string; own: OwnMenuItem[] }
  /** Close YouTube's open menus and popups. */
  | { id: number; kind: 'closeMenu' };
export type BridgeResponse = { id: number; payload: BridgeConfig | BridgeVideoInfo | BridgePage | BridgeCommandResult | null };

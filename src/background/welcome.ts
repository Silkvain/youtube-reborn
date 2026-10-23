/**
 * On install, backend-enabled builds open the welcome window (welcome/welcome.html) centred over
 * the user's browser window, asking whether to switch on Enhanced discoverability.
 */
import { communityAvailable } from '../shared/community/config';

const WIDTH = 640;
const HEIGHT = 680;

/** Centre of the focused browser window, or null when there's none to measure. */
export function centredBounds(
  win: { left?: number; top?: number; width?: number; height?: number } | undefined,
  width = WIDTH,
  height = HEIGHT,
): { left: number; top: number; width: number; height: number } | null {
  if (!win || win.left === undefined || win.top === undefined || !win.width || !win.height) return null;
  return {
    left: Math.max(0, Math.round(win.left + (win.width - width) / 2)),
    top: Math.max(0, Math.round(win.top + (win.height - height) / 2)),
    width,
    height,
  };
}

/** Opens the welcome window on a fresh install (not on updates), once. */
export async function maybeShowWelcome(reason: string): Promise<boolean> {
  if (reason !== 'install' || !communityAvailable()) return false;
  const { welcomeAnswer } = await chrome.storage.local.get('welcomeAnswer');
  if (welcomeAnswer) return false;
  const url = chrome.runtime.getURL('welcome/welcome.html');
  const focused = await chrome.windows.getLastFocused().catch(() => undefined);
  const bounds = centredBounds(focused);
  try {
    await chrome.windows.create({ url, type: 'popup', focused: true, ...(bounds ?? { width: WIDTH, height: HEIGHT }) });
  } catch {
    await chrome.tabs.create({ url }); // e.g. no normal window open yet
  }
  return true;
}

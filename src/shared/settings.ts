import { DEFAULT_DAILY_CAP } from './constants';

export interface Settings {
  enabled: boolean;
  dailyCap: number;
  /** Show the "Most viewed today" row at the top of the feed. */
  showTrending: boolean;
  /** Opt-in "Enhanced discoverability" (anonymous sharing). Off unless the user turns it on. */
  enhancedDiscovery: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  dailyCap: DEFAULT_DAILY_CAP,
  showTrending: true,
  enhancedDiscovery: false,
};

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored } as Settings;
}

export async function isEnabled(): Promise<boolean> {
  return (await getSettings()).enabled;
}

export async function setEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ enabled });
}

export async function setEnhancedDiscovery(enhancedDiscovery: boolean): Promise<void> {
  await chrome.storage.local.set({ enhancedDiscovery });
}

export async function setShowTrending(showTrending: boolean): Promise<void> {
  await chrome.storage.local.set({ showTrending });
}

/** Calls `cb` whenever any setting other than the on/off toggle changes. */
export function onSettingsChange(cb: () => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some((k) => k in DEFAULT_SETTINGS && k !== 'enabled')) cb();
  });
}

/** Calls `cb` with the new value whenever the toggle changes, in any context. */
export function onEnabledChange(cb: (enabled: boolean) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'enabled' in changes) cb(changes.enabled?.newValue !== false);
  });
}

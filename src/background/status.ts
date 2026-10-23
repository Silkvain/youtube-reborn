/**
 * The popup's one-line explanation of what the extension is doing, so limits read as a plan
 * ("Discovery covers your top 150 channels so far") rather than a bare "306 / 300".
 */
import type { Purpose } from '../shared/constants';

export interface StatusInput {
  enabled: boolean;
  loggedOut: boolean;
  stoppedForToday: boolean;
  subscriptions: number;
  /** Subscriptions whose featured channels have been read at least once. */
  covered: number;
  /** The subscriptions feed has been read at least once. */
  feedSynced: boolean;
  /** Recent subscriptions-feed syncs failed. */
  feedFailing: boolean;
  spent: Record<Purpose, number>;
  budgets: Record<Purpose, number>;
  /** A YouTube tab is currently working through crawl jobs. */
  tabActive: boolean;
}

export function statusLine(s: StatusInput): string {
  if (!s.enabled) return 'Off. YouTube is untouched and nothing is collected.';
  if (s.loggedOut) return 'Sign in to YouTube so your subscriptions can be read.';
  if (s.stoppedForToday) return 'Paused until tomorrow: YouTube returned several errors in a row.';
  if (s.feedFailing) return 'Couldn’t read your subscriptions feed lately; showing what was saved. Retrying every 30 minutes.';
  if (!s.feedSynced) return 'Open YouTube’s Home page to load your subscriptions.';
  const discoveryDone = s.spent.discovery >= s.budgets.discovery;
  if (s.covered < s.subscriptions) {
    const so = `Discovery covers your top ${s.covered} of ${s.subscriptions} channels so far`;
    if (discoveryDone) return `${so}; paused until tomorrow to stay gentle with YouTube.`;
    if (!s.tabActive) return `${so}; it continues while a YouTube tab is open.`;
    return `${so}.`;
  }
  if (discoveryDone) return 'Discovery paused until tomorrow to stay gentle with YouTube.';
  return s.subscriptions
    ? `Up to date. Discovery covers all ${s.subscriptions} of your channels.`
    : 'Up to date.';
}

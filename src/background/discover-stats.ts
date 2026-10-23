/**
 * On-device measurement of Discover (after Davidson et al. 2010, §3: CTR and "long CTR"): per
 * signal source, how many Discover cards were seen and how many of those were then watched at
 * least half-way. Used to tune each source's weight for this user, and shown in the popup.
 * Nothing here ever leaves the device.
 */
import * as db from '../core/db';
import { DAY_MS } from '../shared/constants';

/** Counts halve every 30 days, so the tuning follows current taste. */
export const STATS_HALF_LIFE_MS = 30 * DAY_MS;
/** A Discover card counts as a success when the video is then watched at least this far. */
export const LONG_CLICK_COMPLETION = 0.5;
/** A watch counts for the card only within this long after it was shown. */
export const SHOWN_TTL_MS = 21 * DAY_MS;
/** A source is tuned only once it has been seen this many (decayed) times. */
export const TUNING_MIN_IMPRESSIONS = 30;
/** Tuning never moves a source's weight further than this factor either way. */
export const TUNING_MAX = 2;
const MAX_SHOWN = 3000;

export interface SourceCount {
  impressions: number;
  longClicks: number;
  at: number;
}

export interface DiscoverStats {
  sources: Record<string, SourceCount>;
  /** Discover videos shown recently, with the source that found them. */
  shown: Record<string, { source: string; at: number; clicked?: true }>;
}

function decayed(c: SourceCount | undefined, now: number): SourceCount {
  if (!c) return { impressions: 0, longClicks: 0, at: now };
  const f = Math.pow(0.5, Math.max(0, now - c.at) / STATS_HALF_LIFE_MS);
  return { impressions: c.impressions * f, longClicks: c.longClicks * f, at: now };
}

async function load(): Promise<DiscoverStats> {
  return (await db.getMeta('discoverStats')) ?? { sources: {}, shown: {} };
}

/** Discover cards that came on screen (once per visit each), with their sources. */
export async function recordDiscoverShown(entries: [videoId: string, source: string][], now = Date.now()): Promise<void> {
  if (!entries.length) return;
  const s = await load();
  for (const [id, source] of entries) {
    const c = decayed(s.sources[source], now);
    c.impressions += 1;
    s.sources[source] = c;
    const prev = s.shown[id];
    s.shown[id] = { source, at: now, ...(prev?.clicked ? { clicked: true as const } : {}) };
  }
  const kept = Object.entries(s.shown)
    .filter(([, v]) => now - v.at <= SHOWN_TTL_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_SHOWN);
  s.shown = Object.fromEntries(kept);
  await db.setMeta('discoverStats', s);
}

/** A watch session: if it's a recently shown Discover video watched half-way, credit its source once. */
export async function recordDiscoverWatch(videoId: string, completion: number, now = Date.now()): Promise<void> {
  if (completion < LONG_CLICK_COMPLETION) return;
  const s = await load();
  const shown = s.shown[videoId];
  if (!shown || shown.clicked || now - shown.at > SHOWN_TTL_MS) return;
  const c = decayed(s.sources[shown.source], now);
  c.longClicks += 1;
  s.sources[shown.source] = c;
  shown.clicked = true;
  await db.setMeta('discoverStats', s);
}

/**
 * Per-source weight multipliers: each source's success rate against the average, smoothed
 * (+2 successes' worth of prior) and capped to [1/TUNING_MAX, TUNING_MAX]. Sources not yet seen
 * TUNING_MIN_IMPRESSIONS times keep their default weight.
 */
export function tuningFrom(stats: DiscoverStats, now = Date.now()): Map<string, number> | undefined {
  const counts = Object.entries(stats.sources).map(([id, c]) => [id, decayed(c, now)] as const);
  const totalI = counts.reduce((n, [, c]) => n + c.impressions, 0);
  const totalL = counts.reduce((n, [, c]) => n + c.longClicks, 0);
  if (totalI < TUNING_MIN_IMPRESSIONS) return undefined;
  const average = (totalL + 1) / (totalI + 10);
  const out = new Map<string, number>();
  for (const [id, c] of counts) {
    if (c.impressions < TUNING_MIN_IMPRESSIONS) continue;
    const m = (c.longClicks + 2) / (c.impressions * average + 2);
    out.set(id, Math.min(TUNING_MAX, Math.max(1 / TUNING_MAX, m)));
  }
  return out.size ? out : undefined;
}

export async function sourceTuning(now = Date.now()): Promise<Map<string, number> | undefined> {
  return tuningFrom(await load(), now);
}

/** For the popup: per source, cards seen and watched (decayed, rounded), and the current tuning. */
export async function discoverSummary(now = Date.now()): Promise<{ source: string; shown: number; watched: number; tuning: number }[]> {
  const s = await load();
  const tuning = tuningFrom(s, now);
  return Object.entries(s.sources)
    .map(([source, c]) => {
      const d = decayed(c, now);
      return { source, shown: Math.round(d.impressions), watched: Math.round(d.longClicks), tuning: tuning?.get(source) ?? 1 };
    })
    .filter((x) => x.shown > 0)
    .sort((a, b) => b.shown - a.shown);
}

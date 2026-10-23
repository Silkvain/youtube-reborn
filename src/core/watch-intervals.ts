/** Union of played [start, end) intervals in media seconds, so re-watching or seeking never double-counts. */
export class IntervalSet {
  private intervals: [number, number][] = [];

  add(start: number, end: number): void {
    if (!(end > start)) return;
    const next: [number, number][] = [];
    let [s, e] = [start, end];
    for (const [a, b] of this.intervals) {
      if (b < s || a > e) next.push([a, b]);
      else [s, e] = [Math.min(a, s), Math.max(b, e)];
    }
    next.push([s, e]);
    next.sort((x, y) => x[0] - y[0]);
    this.intervals = next;
  }

  total(): number {
    return this.intervals.reduce((sum, [a, b]) => sum + (b - a), 0);
  }
}

/** Largest gap between two timeupdate samples still treated as continuous playback. */
export const MAX_PLAYBACK_STEP_SEC = 2.5;

/**
 * Accumulates the seconds of a video that actually played. Feed it every `timeupdate`;
 * call `seek()` when the user seeks or an ad interrupts, so the jump isn't counted.
 */
export class WatchTracker {
  private played = new IntervalSet();
  private last: number | null = null;

  constructor(private readonly maxStep = MAX_PLAYBACK_STEP_SEC) {}

  /** `rate` is playbackRate; faster playback produces bigger steps between samples. */
  sample(currentTime: number, playing: boolean, rate = 1): void {
    if (!playing) {
      this.last = currentTime;
      return;
    }
    if (this.last !== null) {
      const step = currentTime - this.last;
      if (step > 0 && step <= this.maxStep * Math.max(1, rate)) this.played.add(this.last, currentTime);
    }
    this.last = currentTime;
  }

  seek(to: number | null = null): void {
    this.last = to;
  }

  watchedSec(): number {
    return this.played.total();
  }
}

/** Abandoned = watched less than 30s or less than 10% of the video, whichever threshold is smaller. */
export function isAbandoned(watchedSec: number, durationSec: number): boolean {
  const threshold = durationSec > 0 ? Math.min(30, durationSec * 0.1) : 30;
  return watchedSec < threshold;
}

export function completionRatio(watchedSec: number, durationSec: number): number {
  if (!(durationSec > 0)) return 0;
  return Math.min(1, watchedSec / durationSec);
}

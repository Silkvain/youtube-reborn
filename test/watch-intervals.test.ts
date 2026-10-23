import { completionRatio, IntervalSet, isAbandoned, WatchTracker } from '../src/core/watch-intervals';

/** Simulates timeupdate events every 0.25 s of playback from `from` to `to`. */
function play(t: WatchTracker, from: number, to: number, rate = 1) {
  for (let x = from; x <= to + 1e-9; x += 0.25 * rate) t.sample(x, true, rate);
}

describe('IntervalSet', () => {
  it('merges overlapping and adjacent intervals', () => {
    const s = new IntervalSet();
    s.add(0, 10);
    s.add(5, 15);
    s.add(15, 20);
    s.add(30, 40);
    expect(s.total()).toBe(30);
  });

  it('ignores empty or inverted intervals', () => {
    const s = new IntervalSet();
    s.add(5, 5);
    s.add(10, 2);
    expect(s.total()).toBe(0);
  });
});

describe('WatchTracker', () => {
  it('counts continuous playback', () => {
    const t = new WatchTracker();
    play(t, 0, 60);
    expect(t.watchedSec()).toBeCloseTo(60);
  });

  it('does not count a seek forward', () => {
    const t = new WatchTracker();
    play(t, 0, 10);
    t.seek(null);
    t.seek(300);
    play(t, 300, 310);
    expect(t.watchedSec()).toBeCloseTo(20);
  });

  it('does not count a jump even without seek events', () => {
    const t = new WatchTracker();
    play(t, 0, 10);
    t.sample(500, true); // big jump: not playback
    play(t, 500, 505);
    expect(t.watchedSec()).toBeCloseTo(15);
  });

  it('does not double count rewatching', () => {
    const t = new WatchTracker();
    play(t, 0, 30);
    t.seek(0);
    play(t, 0, 30);
    expect(t.watchedSec()).toBeCloseTo(30);
  });

  it('does not count paused time', () => {
    const t = new WatchTracker();
    play(t, 0, 10);
    t.sample(10, false);
    t.sample(10, false);
    play(t, 10, 20);
    expect(t.watchedSec()).toBeCloseTo(20);
  });

  it('handles faster playback rates', () => {
    const t = new WatchTracker();
    play(t, 0, 60, 2);
    expect(t.watchedSec()).toBeCloseTo(60);
  });
});

describe('abandonment and completion', () => {
  it('uses the smaller of 30 s and 10%', () => {
    expect(isAbandoned(20, 600)).toBe(true); // threshold 30
    expect(isAbandoned(40, 600)).toBe(false);
    expect(isAbandoned(5, 100)).toBe(true); // threshold 10
    expect(isAbandoned(12, 100)).toBe(false);
  });

  it('completion is clamped to 0..1', () => {
    expect(completionRatio(30, 60)).toBe(0.5);
    expect(completionRatio(90, 60)).toBe(1);
    expect(completionRatio(10, 0)).toBe(0);
  });
});

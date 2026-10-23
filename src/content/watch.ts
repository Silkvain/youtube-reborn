/**
 * Passive watch logging on /watch pages. Tracks the seconds of each video that actually played
 * (union of played intervals; seeks and ads don't count) and writes one WatchEvent per video
 * session, with periodic checkpoints so a crash or closed tab still records something.
 */
import { completionRatio, isAbandoned, WatchTracker } from '../core/watch-intervals';
import { send } from '../shared/messages';
import type { WatchEvent } from '../shared/types';
import { getVideoInfo } from './bridge';
import { SEL, YT_EVENTS } from './selectors';

const CHECKPOINT_MS = 30_000;
const MIN_LOGGED_SEC = 1;

interface Session {
  videoId: string;
  startedAt: number;
  channelId: string;
  durationSec: number;
  tracker: WatchTracker;
}

function currentVideoId(): string | null {
  if (location.pathname !== '/watch') return null;
  return new URLSearchParams(location.search).get('v');
}

function adShowing(): boolean {
  return document.querySelector(SEL.player)?.classList.contains(SEL.adShowingClass) ?? false;
}

export class WatchLogger {
  private session: Session | null = null;
  private video: HTMLVideoElement | null = null;
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  private active = false;

  start(): void {
    if (this.active) return;
    this.active = true;
    document.addEventListener(YT_EVENTS.navigateFinish, this.onRoute);
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.checkpointTimer = setInterval(() => this.flush(false), CHECKPOINT_MS);
    this.onRoute();
  }

  /** Turning the extension off: drop the in-progress session without logging it. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    document.removeEventListener(YT_EVENTS.navigateFinish, this.onRoute);
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    this.detachVideo();
    this.session = null;
  }

  private onRoute = (): void => {
    const id = currentVideoId();
    if (this.session && this.session.videoId !== id) {
      this.flush(true);
      this.session = null;
    }
    if (id && !this.session) this.begin(id);
  };

  private onPageHide = (): void => this.flush(true);

  private onVisibility = (): void => {
    if (document.visibilityState === 'hidden') this.flush(false);
  };

  private begin(videoId: string): void {
    const session: Session = {
      videoId,
      startedAt: Date.now(),
      channelId: '',
      durationSec: 0,
      tracker: new WatchTracker(),
    };
    this.session = session;
    this.attachVideo();
    void this.fillVideoInfo(session);
  }

  /** The player may still report the previous video for a moment; retry until it matches. */
  private async fillVideoInfo(session: Session): Promise<void> {
    for (let i = 0; i < 20 && this.session === session; i++) {
      const info = await getVideoInfo();
      if (info?.videoId === session.videoId && info.channelId) {
        session.channelId = info.channelId;
        if (info.lengthSeconds) session.durationSec = info.lengthSeconds;
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private attachVideo(): void {
    const video = document.querySelector<HTMLVideoElement>(SEL.mainVideo);
    if (video === this.video) return;
    this.detachVideo();
    if (!video) {
      // Player not built yet; try again shortly while we're still on this video.
      setTimeout(() => this.session && this.active && this.attachVideo(), 1000);
      return;
    }
    this.video = video;
    video.addEventListener('timeupdate', this.onTimeUpdate);
    video.addEventListener('seeking', this.onSeeking);
    video.addEventListener('seeked', this.onSeeked);
  }

  private detachVideo(): void {
    const v = this.video;
    if (!v) return;
    v.removeEventListener('timeupdate', this.onTimeUpdate);
    v.removeEventListener('seeking', this.onSeeking);
    v.removeEventListener('seeked', this.onSeeked);
    this.video = null;
  }

  private onTimeUpdate = (): void => {
    const v = this.video;
    const s = this.session;
    if (!v || !s) return;
    if (currentVideoId() !== s.videoId) {
      this.onRoute();
      return;
    }
    if (adShowing()) {
      s.tracker.seek(null); // ads share the <video> element; never count them
      return;
    }
    if (!s.durationSec && Number.isFinite(v.duration)) s.durationSec = Math.round(v.duration);
    s.tracker.sample(v.currentTime, !v.paused, v.playbackRate);
  };

  private onSeeking = (): void => this.session?.tracker.seek(null);

  private onSeeked = (): void => {
    if (this.video && !adShowing()) this.session?.tracker.seek(this.video.currentTime);
  };

  /** Writes the session (upsert by id). `final` marks the end of the session. */
  private flush(final: boolean): void {
    const s = this.session;
    if (!s || !this.active) return;
    const watchedSec = Math.round(s.tracker.watchedSec());
    if (watchedSec < MIN_LOGGED_SEC || !s.channelId) return;
    const durationSec = s.durationSec || 0;
    const event: WatchEvent = {
      id: `${s.videoId}:${s.startedAt}`,
      videoId: s.videoId,
      channelId: s.channelId,
      watchedSec,
      durationSec,
      completion: completionRatio(watchedSec, durationSec),
      abandoned: isAbandoned(watchedSec, durationSec),
      at: s.startedAt,
    };
    void send({ type: 'watch:event', event }).catch(() => undefined);
    if (final) this.session = null;
  }
}

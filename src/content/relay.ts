/**
 * Sends the crawler's InnerTube jobs from a YouTube tab. The service worker plans the work and
 * paces it (one request every 3–5 s, daily budgets, backoff); this loop asks for one job at a
 * time, sends it from the page's own origin without cookies (public data only), and reports the
 * parsed result. Only one tab holds the lease; the others just poll occasionally.
 */
import { refToUrl } from '../core/mentions';
import type { Job, JobResult } from '../shared/jobs';
import { send } from '../shared/messages';
import type { YtClientConfig } from '../shared/types';
import {
  DEFAULT_CLIENT,
  InnertubeError,
  fetchChannelPage,
  fetchMostViewedThisWeek,
  fetchNewsHub,
  fetchVideosTab,
  parsingClient,
  resolveChannelUrl,
  fetchVideoDetails,
} from './innertube';

/** Public client context: the page's version and region, none of its session. */
export function publicClient(cfg: YtClientConfig | null): YtClientConfig {
  return parsingClient({
    ...DEFAULT_CLIENT,
    clientVersion: cfg?.clientVersion ?? DEFAULT_CLIENT.clientVersion,
    gl: cfg?.gl ?? DEFAULT_CLIENT.gl,
  });
}

export async function executeJob(job: Job, cfg: YtClientConfig): Promise<JobResult> {
  switch (job.kind) {
    case 'trending':
      return { kind: 'trending', videos: await fetchMostViewedThisWeek(job.query, cfg) };
    case 'news':
      return { kind: 'news', stories: await fetchNewsHub(cfg) };
    case 'channel':
      return { kind: 'channel', page: await fetchChannelPage(job.id, cfg) };
    case 'videos':
      return { kind: 'videos', videos: await fetchVideosTab(job.id, cfg) };
    case 'resolve':
      return { kind: 'resolve', channelId: await resolveChannelUrl(refToUrl(job.ref), cfg) };
    case 'video':
      return { kind: 'video', video: await fetchVideoDetails(job.id, cfg) };
    case 'rss':
      throw new Error('RSS jobs run in the service worker');
  }
}

/** Longest single wait, so a tab notices new work (or the toggle) reasonably soon. */
const MAX_WAIT_MS = 5 * 60_000;

export class CrawlRelay {
  private active = false;
  private wake: (() => void) | null = null;

  start(getCfg: () => YtClientConfig | null): void {
    if (this.active) return;
    this.active = true;
    void this.loop(getCfg);
  }

  stop(): void {
    this.active = false;
    this.wake?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, Math.min(Math.max(0, ms), MAX_WAIT_MS));
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wake = done;
    });
  }

  private async loop(getCfg: () => YtClientConfig | null): Promise<void> {
    while (this.active) {
      const res = await send({ type: 'crawl:lease' }).catch(() => undefined);
      if (!this.active) break;
      if (!res) {
        await this.sleep(60_000); // service worker restarting
        continue;
      }
      if ('job' in res) {
        await this.run(res.job, publicClient(getCfg()));
        continue;
      }
      await this.sleep(res.waitMs);
    }
  }

  private async run(job: Job, cfg: YtClientConfig): Promise<void> {
    try {
      const result = await executeJob(job, cfg);
      await send({ type: 'crawl:result', job, result });
    } catch (err) {
      const status = err instanceof InnertubeError ? err.status : 0;
      await send({ type: 'crawl:result', job, error: { status, message: String(err) } }).catch(() => undefined);
    }
  }
}

/**
 * YouTube Reborn "Enhanced discoverability" backend (Cloudflare Worker) entry point.
 * The Workers runtime only allows handlers and Durable Object classes as exports here; the
 * logic lives in app.ts.
 */
import { handle, scheduled, type Env } from './app';

export { Aggregator, KeyStore, SpentTokens, UploadPool } from './objects';

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
  scheduled: (controller: { cron: string; scheduledTime: number }, env: Env) =>
    scheduled(controller.cron, controller.scheduledTime, env),
};

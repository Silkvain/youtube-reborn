import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { YtClientConfig } from '../src/shared/types';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

// The service worker's answers, scripted: claim -> page 1 -> page 2 -> done; history not due.
const sent: { type: string; [k: string]: unknown }[] = [];
const answers: Record<string, unknown[]> = {};
vi.stubGlobal('chrome', {
  runtime: {
    sendMessage: vi.fn(async (msg: { type: string }) => {
      sent.push(msg);
      return answers[msg.type]?.shift();
    }),
  },
});
const fetches: { body: Record<string, unknown>; headers: Record<string, string>; credentials?: string }[] = [];
const responses: string[] = [];
vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
  fetches.push({ body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string>, credentials: init.credentials });
  return new Response(responses.shift() ?? '{}', { status: 200 });
}));

const { syncSubscriptionFeedIfDue } = await import('../src/content/subs');

const cfg: YtClientConfig = { clientName: 'WEB', clientNameId: 1, clientVersion: '2.x', hl: 'de', gl: 'DE', loggedIn: true };
const noSleep = async () => {};

beforeEach(() => {
  sent.length = 0;
  fetches.length = 0;
});

describe('subscriptions feed sync (content script)', () => {
  it('fetches exactly the pages the service worker asks for, signed in and in English', async () => {
    answers['subsfeed:claim'] = [{ request: { browseId: 'FEsubscriptions' }, waitMs: 0 }];
    answers['subsfeed:page'] = [{ request: { continuation: 'SYNTH_TOKEN_PAGE_2' }, waitMs: 1500 }, { request: null }];
    answers['history:claim'] = [{ due: false }];
    responses.push(fixture('subscriptions-feed.json'), fixture('subscriptions-feed-continuation.json'));

    await syncSubscriptionFeedIfDue(cfg, 'SAPISID=abc', noSleep);

    expect(fetches.map((f) => f.body.browseId ?? f.body.continuation)).toEqual(['FEsubscriptions', 'SYNTH_TOKEN_PAGE_2']);
    expect(fetches[0]!.headers.authorization).toMatch(/^SAPISIDHASH /);
    expect(fetches[0]!.credentials).toBe('include');
    expect((fetches[0]!.body.context as { client: { hl: string; gl: string } }).client).toMatchObject({ hl: 'en', gl: 'DE' });
    const pages = sent.filter((m) => m.type === 'subsfeed:page') as unknown as { page: { videos: { id: string }[]; continuation: string | null } }[];
    expect(pages.map((p) => p.page.videos.length)).toEqual([4, 4]);
    expect(pages[1]!.page.continuation).toBeNull();
  });

  it('does nothing when no sync is due or the user is signed out', async () => {
    answers['subsfeed:claim'] = [{ request: null }];
    answers['history:claim'] = [{ due: false }];
    await syncSubscriptionFeedIfDue(cfg, 'SAPISID=abc', noSleep);
    expect(fetches).toHaveLength(0);
    await syncSubscriptionFeedIfDue({ ...cfg, loggedIn: false }, '', noSleep);
    expect(sent.filter((m) => m.type === 'subsfeed:claim')).toHaveLength(1);
  });

  it('reports a failed page so the sync can end cleanly', async () => {
    answers['subsfeed:claim'] = [{ request: { browseId: 'FEsubscriptions' }, waitMs: 0 }];
    answers['history:claim'] = [{ due: false }];
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 503 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await syncSubscriptionFeedIfDue(cfg, 'SAPISID=abc', noSleep);
    warn.mockRestore();
    expect(sent.map((m) => m.type)).toEqual(['subsfeed:claim', 'subsfeed:error', 'history:claim']);
  });

  it('reads one or two history pages once and sends only per-channel counts', async () => {
    answers['subsfeed:claim'] = [{ request: null }];
    answers['history:claim'] = [{ due: true }];
    responses.push(fixture('history.json'), '{}');
    await syncSubscriptionFeedIfDue(cfg, 'SAPISID=abc', noSleep);
    expect(fetches.map((f) => f.body.browseId ?? f.body.continuation)).toEqual(['FEhistory', 'SYNTH_HISTORY_TOKEN_2']);
    const result = sent.find((m) => m.type === 'history:result');
    expect(result).toEqual({
      type: 'history:result',
      ok: true,
      requests: 2,
      counts: { UCsynth01xxxxxxxxxxxxxxx: 3, UCsynth02xxxxxxxxxxxxxxx: 1 },
    });
  });
});

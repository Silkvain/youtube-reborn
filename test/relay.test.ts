import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const sent: { type: string; [k: string]: unknown }[] = [];
const leases: unknown[] = [];
vi.stubGlobal('chrome', {
  runtime: {
    sendMessage: vi.fn(async (msg: { type: string }) => {
      sent.push(msg);
      if (msg.type === 'crawl:lease') return leases.shift() ?? { waitMs: 60_000, stop: true };
      return undefined;
    }),
  },
});
const inits: RequestInit[] = [];
vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
  inits.push(init);
  return new Response(fixture('search-this-week-by-views.json'), { status: 200 });
}));

const { CrawlRelay, publicClient } = await import('../src/content/relay');

describe('crawl relay (YouTube tab)', () => {
  it('runs leased jobs without the session and reports parsed results', async () => {
    leases.push({ job: { kind: 'trending', query: 'the' } }, { job: { kind: 'rss', id: 'UCx' } });
    const relay = new CrawlRelay();
    relay.start(() => ({ clientName: 'WEB', clientNameId: 1, clientVersion: '2.y', hl: 'fr', gl: 'FR', loggedIn: true, visitorData: 'secret' }));
    await vi.waitFor(() => expect(sent.filter((m) => m.type === 'crawl:result')).toHaveLength(2));
    relay.stop();
    const [ok, rss] = sent.filter((m) => m.type === 'crawl:result') as unknown as { result?: { kind: string; videos: unknown[] }; error?: { status: number } }[];
    expect(ok!.result?.kind).toBe('trending');
    expect(ok!.result?.videos).toHaveLength(6);
    expect(rss!.error).toMatchObject({ status: 0 }); // RSS belongs to the service worker
    expect(inits).toHaveLength(1);
    expect(inits[0]!.credentials).toBe('omit');
    expect((inits[0]!.headers as Record<string, string>).authorization).toBeUndefined();
    expect(JSON.parse(String(inits[0]!.body)).context.client).toEqual({ clientName: 'WEB', clientVersion: '2.y', hl: 'en', gl: 'FR' });
  });

  it('public client keeps only version and region', () => {
    expect(publicClient(null)).toMatchObject({ loggedIn: false, hl: 'en' });
  });
});

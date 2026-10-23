// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A backend-enabled build (the define esbuild sets).
(globalThis as Record<string, unknown>).__COMMUNITY_API__ = 'https://community.test';

const store: Record<string, unknown> = { enabled: true, showTrending: true, enhancedDiscovery: true };
const removed: unknown[] = [];

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (keys?: string | string[]) =>
        Object.fromEntries((Array.isArray(keys) ? keys : keys ? [keys] : Object.keys(store)).filter((k) => k in store).map((k) => [k, store[k]])),
      set: async (v: Record<string, unknown>) => void Object.assign(store, v),
    },
    onChanged: { addListener() {} },
  },
  runtime: {
    sendMessage: async (msg: { type: string }) =>
      msg.type === 'stats:get'
        ? { status: '', spent: { subs: 0, top: 0, discovery: 0, mentions: 0 }, budgets: { subs: 0, top: 0, discovery: 0, mentions: 0 }, community: { on: store.enhancedDiscovery === true } }
        : undefined,
  },
  permissions: {
    contains: async () => true,
    request: async () => true,
    remove: async (p: unknown) => {
      removed.push(p);
      return true;
    },
  },
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

beforeAll(async () => {
  const html = readFileSync(join(__dirname, '..', 'static', 'popup', 'popup.html'), 'utf8');
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  await import('../src/popup/popup');
  await flush();
  await flush();
});

describe('popup: turning Enhanced discoverability off', () => {
  const switchOff = async () => {
    const enhanced = $<HTMLInputElement>('enhanced');
    enhanced.checked = false;
    enhanced.dispatchEvent(new Event('change'));
    await flush();
  };

  it('asks first, and "Keep it on" changes nothing', async () => {
    expect($<HTMLInputElement>('enhanced').checked).toBe(true);
    await switchOff();
    expect($('optOut').hidden).toBe(false);
    expect($<HTMLInputElement>('enhanced').checked).toBe(true); // still on while asking
    expect(store.enhancedDiscovery).toBe(true);
    $('optOutKeep').click();
    await flush();
    expect($('optOut').hidden).toBe(true);
    expect(store.enhancedDiscovery).toBe(true);
    expect(removed).toEqual([]);
  });

  it('"Turn off" opts out and gives back the server permission', async () => {
    await switchOff();
    $('optOutConfirm').click();
    await flush();
    await flush();
    expect($('optOut').hidden).toBe(true);
    expect(store.enhancedDiscovery).toBe(false);
    expect(removed).toEqual([{ origins: ['https://community.test/*'] }]);
    expect($<HTMLInputElement>('enhanced').checked).toBe(false);
  });
});

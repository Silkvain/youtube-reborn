// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A backend-enabled build (the define esbuild sets).
(globalThis as Record<string, unknown>).__COMMUNITY_API__ = 'https://community.test';

const html = (path: string) => readFileSync(join(__dirname, '..', 'static', path), 'utf8');
const store: Record<string, unknown> = {};
const permissionRequests: unknown[] = [];
let grant = true;
const windowsCreated: unknown[] = [];
const tabsCreated: unknown[] = [];

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (keys: string | string[]) =>
        Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]])),
      set: async (v: Record<string, unknown>) => void Object.assign(store, v),
    },
    onChanged: { addListener() {} },
  },
  permissions: {
    request: async (p: unknown) => {
      permissionRequests.push(p);
      return grant;
    },
  },
  runtime: { getURL: (p: string) => `chrome-extension://id/${p}` },
  windows: {
    getLastFocused: async () => ({ left: 100, top: 50, width: 1440, height: 900 }),
    create: async (o: unknown) => void windowsCreated.push(o),
  },
  tabs: { create: async (o: unknown) => void tabsCreated.push(o) },
});

const { centredBounds, maybeShowWelcome } = await import('../src/background/welcome');

const flush = () => new Promise((r) => setTimeout(r, 0));

async function loadPage() {
  document.body.innerHTML = new DOMParser().parseFromString(html('welcome/welcome.html'), 'text/html').body.innerHTML;
  vi.resetModules();
  (globalThis as Record<string, unknown>).__COMMUNITY_API__ = 'https://community.test';
  window.close = vi.fn();
  await import('../src/welcome/welcome');
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  permissionRequests.length = windowsCreated.length = tabsCreated.length = 0;
  grant = true;
});

describe('install welcome window', () => {
  it('opens once, centred, on a fresh install only', async () => {
    expect(await maybeShowWelcome('update')).toBe(false);
    expect(await maybeShowWelcome('install')).toBe(true);
    expect(windowsCreated).toEqual([
      { url: 'chrome-extension://id/welcome/welcome.html', type: 'popup', focused: true, left: 500, top: 160, width: 640, height: 680 },
    ]);
    store.welcomeAnswer = 'denied';
    expect(await maybeShowWelcome('install')).toBe(false);
    expect(centredBounds(undefined)).toBeNull();
  });

  it('nothing is on until the user agrees', async () => {
    await loadPage();
    expect(store.enhancedDiscovery).toBeUndefined();
    expect(permissionRequests).toEqual([]);
  });

  it('Agree: asks the browser for the server permission, then switches it on', async () => {
    await loadPage();
    (document.getElementById('agree') as HTMLButtonElement).click();
    await flush();
    expect(permissionRequests).toEqual([{ origins: ['https://community.test/*'] }]);
    expect(store.enhancedDiscovery).toBe(true);
    expect(store.welcomeAnswer).toBe('agreed');
    expect(document.getElementById('done')!.hidden).toBe(false);
  });

  it('Agree, but the browser refuses the permission: stays off and says so', async () => {
    grant = false;
    await loadPage();
    (document.getElementById('agree') as HTMLButtonElement).click();
    await flush();
    expect(store.enhancedDiscovery).toBeUndefined();
    expect(store.welcomeAnswer).toBeUndefined();
    expect(document.getElementById('error')!.hidden).toBe(false);
  });

  it('Deny: stays off, never asks for the permission', async () => {
    await loadPage();
    (document.getElementById('deny') as HTMLButtonElement).click();
    await flush();
    expect(store.enhancedDiscovery).toBe(false);
    expect(store.welcomeAnswer).toBe('denied');
    expect(permissionRequests).toEqual([]);
  });

  it('says exactly what the popup consent says about what is and isn’t shared', () => {
    const items = (path: string) =>
      [...new DOMParser().parseFromString(html(path), 'text/html').querySelectorAll('li')].map((li) => li.textContent!.trim());
    const popup = items('popup/popup.html');
    expect(popup.length).toBeGreaterThan(0);
    expect(items('welcome/welcome.html')).toEqual(popup);
  });
});

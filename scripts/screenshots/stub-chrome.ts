/** Loaded before the real popup or welcome script: a stand-in browser API with demo stats. */
import { stats } from './demo-data';

const store: Record<string, unknown> = { enabled: true, showTrending: true, enhancedDiscovery: true, dailyCap: 300 };

(globalThis as Record<string, unknown>).chrome = {
  runtime: {
    id: 'demo',
    sendMessage: async (msg: { type: string }) => (msg.type === 'stats:get' ? stats : undefined),
    onMessage: { addListener() {} },
    getURL: (p: string) => `/${p}`,
  },
  storage: {
    local: {
      get: async (keys?: string | string[]) =>
        keys ? Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]])) : { ...store },
      set: async (v: Record<string, unknown>) => void Object.assign(store, v),
    },
    onChanged: { addListener() {} },
  },
  permissions: { contains: async () => true, request: async () => true, remove: async () => true },
};

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// jsdom doesn't apply stylesheets, so the DOM tests can't catch CSS mistakes. These guard the two
// that once made the card menu unusable on the real page.
const css = readFileSync(join(__dirname, '..', 'static', 'content', 'feed.css'), 'utf8');
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1]!.split(',').map((s) => s.trim()),
  body: m[2]!,
}));

describe('feed.css', () => {
  it('never hides the ⋮ menu button (YouTube shows it on every card)', () => {
    for (const r of rules.filter((r) => r.selectors.some((s) => s.includes('.ydx-menu-btn')))) {
      expect(r.body).not.toMatch(/opacity:\s*0\b|display:\s*none|visibility:\s*hidden/);
    }
  });

  it('scopes every menu-button rule under #ydx-feed, so hover and open states outrank the base rule', () => {
    const btnSelectors = rules.flatMap((r) => r.selectors).filter((s) => s.includes('.ydx-menu-btn'));
    expect(btnSelectors.length).toBeGreaterThan(1);
    for (const s of btnSelectors) expect(s.startsWith('#ydx-feed')).toBe(true);
  });

  it('lets the hidden attribute win over our display rules (Undo hides cards with it)', () => {
    const rule = rules.find((r) => r.selectors.includes('#ydx-feed [hidden]'));
    expect(rule?.body).toMatch(/display:\s*none\s*!important/);
  });
});

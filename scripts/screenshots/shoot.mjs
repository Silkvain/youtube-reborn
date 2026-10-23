// Store screenshots (1280×800) from the real UI with made-up data:
//   npm run build (with COMMUNITY_API set), then: node scripts/screenshots/shoot.mjs
// Needs Google Chrome at the usual macOS path. Writes store/screenshot-*.png.
import * as esbuild from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 1280;
const H = 800;
if (!existsSync('dist/manifest.json')) throw new Error('Run npm run build first.');

const work = mkdtempSync(join(tmpdir(), 'reborn-shots-'));
await esbuild.build({
  entryPoints: { 'demo-feed': 'scripts/screenshots/demo-feed.ts', 'stub-chrome': 'scripts/screenshots/stub-chrome.ts' },
  bundle: true,
  format: 'iife',
  outdir: work,
  logLevel: 'warning',
});

const FONTS = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;800&family=Roboto:wght@400;500&display=swap">';
const frameCss = `
  html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: #0b0b0d; color: #fff; font-family: Roboto, Arial, sans-serif; }
  .cap { position: absolute; left: 56px; top: 44px; right: 56px; z-index: 5; }
  .cap h1 { font: 800 40px/1.15 Poppins, "Arial Black", sans-serif; margin: 0; letter-spacing: -0.5px; }
  .cap h1 em { font-style: normal; background: linear-gradient(90deg, #e3122d, #ff5a3c); -webkit-background-clip: text; color: transparent; }
  .cap p { margin: 10px 0 0; color: #b5b5b8; font-size: 19px; max-width: 1100px; }
  .glow { position: absolute; inset: auto -10% -40% -10%; height: 70%; background: radial-gradient(ellipse at 30% 100%, rgba(227,18,45,.35), transparent 60%), radial-gradient(ellipse at 80% 100%, rgba(255,90,60,.22), transparent 55%); }
`;
const caption = (title, sub) => `<div class="cap"><h1>${title}</h1><p>${sub}</p></div>`;

const pages = {
  '/': () => `<!doctype html><html><head><meta charset="utf-8">${FONTS}
    <link rel="stylesheet" href="/content/feed.css">
    <style>${frameCss}
      .stage { position: absolute; left: 40px; right: 40px; top: 170px; bottom: 0; overflow: hidden;
        border-radius: 16px 16px 0 0; background: #0f0f0f; padding: 20px 24px; box-shadow: 0 0 0 1px #26262b, 0 30px 80px rgba(227,18,45,.25); }
      .stage #ydx-feed { zoom: 0.8; }
    </style></head>
    <body><div class="glow"></div>${caption('Your YouTube home page, <em>reborn</em>', 'A fresh feed from the channels you subscribe to and watch, plus new channels found the way old YouTube did.')}
    <div class="stage"><ytd-browse page-subtype="home"><ytd-two-column-browse-results-renderer><div id="primary"></div></ytd-two-column-browse-results-renderer></ytd-browse></div>
    <script src="/_demo/demo-feed.js"></script></body></html>`,
  '/frame/popup': () => `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>${frameCss}
      .win { position: absolute; left: 760px; top: 60px; width: 300px; height: 660px; transform: scale(1.12); transform-origin: top left;
        border-radius: 12px; overflow: hidden; box-shadow: 0 0 0 1px #33333a, 0 30px 80px rgba(0,0,0,.6); }
      .win iframe { border: 0; width: 300px; height: 660px; }
      .cap { right: 600px; top: 250px; }</style></head>
    <body><div class="glow"></div>${caption('See exactly what it’s <em>doing</em>', 'Everything is stored on your device. Turn features on or off, see what was checked and when, or clear it all with one click.')}
    <div class="win"><iframe src="/popup/popup.html"></iframe></div></body></html>`,
  '/frame/welcome': () => `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>${frameCss}
      .win { position: absolute; left: 580px; top: 52px; width: 640px; height: 668px; transform: scale(1.04); transform-origin: top left;
        border-radius: 12px; overflow: hidden; box-shadow: 0 0 0 1px #33333a, 0 30px 80px rgba(0,0,0,.6); }
      .win iframe { border: 0; width: 640px; height: 668px; }
      .cap { right: 720px; top: 250px; }</style></head>
    <body><div class="glow"></div>${caption('You choose what’s <em>shared</em>', 'Community recommendations only switch on if you agree. Anonymous, no account or ID, and you can turn it off any time.')}
    <div class="win"><iframe src="/welcome/welcome.html"></iframe></div></body></html>`,
};

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.json': 'application/json' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pages[path]) return res.writeHead(200, { 'content-type': 'text/html' }).end(pages[path]());
  const file = path.startsWith('/_demo/') ? join(work, path.slice(7)) : join('dist', normalize(path).replace(/^(\.\.[/\\])+/, ''));
  if (!existsSync(file)) return res.writeHead(404).end();
  let body = readFileSync(file);
  // The real popup and welcome pages, with the stand-in browser API loaded first.
  if (/\/(popup|welcome)\.html$/.test(path)) {
    body = body.toString().replace('<script src=', '<script src="/_demo/stub-chrome.js"></script><script src=');
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), 'reborn-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], {
  stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
});
let id = 0;
const pending = new Map();
let buf = '';
chrome.stdio[4].on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});
const call = (method, params = {}, sessionId) =>
  new Promise((res) => {
    const m = { id: ++id, method, params, ...(sessionId ? { sessionId } : {}) };
    pending.set(m.id, res);
    chrome.stdio[3].write(JSON.stringify(m) + '\0');
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(path, out, prepare) {
  const { result: t } = await call('Target.createTarget', { url: 'about:blank' });
  const { result: a } = await call('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const s = a.sessionId;
  await call('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, s);
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, s);
  await call('Page.enable', {}, s);
  await call('Page.navigate', { url: base + path }, s);
  await wait(2500);
  if (prepare) {
    await call('Runtime.evaluate', { expression: prepare }, s);
    await wait(700);
  }
  const shot = await call('Page.captureScreenshot', { format: 'png' }, s);
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  await call('Target.closeTarget', { targetId: t.targetId });
  console.log('wrote', out);
}

mkdirSync('store', { recursive: true });
try {
  await shoot('/', 'store/screenshot-1-feed.png');
  await shoot('/', 'store/screenshot-2-discover.png', `
    document.querySelector('.cap h1').innerHTML = 'Find new channels the way <em>old YouTube</em> did';
    document.querySelector('.cap p').textContent = 'Every Discover pick says why it’s there: featured by a channel you watch, mentioned in a video, or popular with viewers of your favourites.';
    const first = [...document.querySelectorAll('#ydx-feed .ydx-badge')][0]?.closest('[class*="card"], article, li, div');
    const stage = document.querySelector('.stage');
    const title = [...document.querySelectorAll('#ydx-feed .ydx-section-title')].find((h) => h.textContent === 'For you');
    if (title) stage.scrollTop += title.getBoundingClientRect().top - stage.getBoundingClientRect().top - 16;`);
  await shoot('/frame/welcome', 'store/screenshot-3-choice.png');
  await shoot('/frame/popup', 'store/screenshot-4-popup.png');
} finally {
  chrome.kill();
  server.close();
  rmSync(work, { recursive: true, force: true });
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}

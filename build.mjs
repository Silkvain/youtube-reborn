// Build script: bundles each extension entry point with esbuild and copies static files into dist/.
// Plain esbuild (no Vite plugin) keeps the toolchain small and the output easy to inspect.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync('static', outdir, { recursive: true });

// Enhanced discoverability is only built in when a backend address is given:
//   COMMUNITY_API=https://community.example.com npm run build
// Its host is added as an *optional* permission, granted only when a user switches it on.
const communityApi = (process.env.COMMUNITY_API ?? '').replace(/\/+$/, '');
if (communityApi) {
  const url = new URL(communityApi);
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error('COMMUNITY_API must be https (or a local address for testing)');
  }
  const manifest = JSON.parse(readFileSync(`${outdir}/manifest.json`, 'utf8'));
  manifest.optional_host_permissions = [`${url.origin}/*`];
  writeFileSync(`${outdir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Enhanced discoverability: built in, server ${url.origin}`);
}
// COMMUNITY_TEST=1 shortens upload timings to minutes for hand testing. Never publish such a build.
const communityTest = process.env.COMMUNITY_TEST === '1';
if (communityTest) {
  if (!communityApi) throw new Error('COMMUNITY_TEST needs COMMUNITY_API');
  console.warn('!! TEST BUILD: uploads every few minutes. Do not publish this build. !!');
}

const options = {
  entryPoints: {
    'background/sw': 'src/background/sw.ts',
    'content/boot': 'src/content/boot.ts',
    'content/app': 'src/content/app.ts',
    'content/bridge-main': 'src/content/bridge-main.ts',
    'popup/popup': 'src/popup/popup.ts',
    'welcome/welcome': 'src/welcome/welcome.ts',
  },
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  outdir,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
  define: { __COMMUNITY_API__: JSON.stringify(communityApi), __COMMUNITY_TEST__: JSON.stringify(communityTest) },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}

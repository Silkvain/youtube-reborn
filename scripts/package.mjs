// Makes the Chrome Web Store upload: tests, a production build with Enhanced discoverability,
// sanity checks, then release/<name>-<version>.zip.
//   npm run package
// COMMUNITY_API overrides the server address; test builds (COMMUNITY_TEST=1) are refused.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PRODUCTION_API = 'https://youtube-reborn-community.youtube-reborn-community.workers.dev';

if (process.env.COMMUNITY_TEST === '1') throw new Error('Refusing to package a COMMUNITY_TEST build.');
const env = { ...process.env, COMMUNITY_API: process.env.COMMUNITY_API || PRODUCTION_API };
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', env });

run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run']);
run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
run(process.execPath, ['build.mjs']);

// Checks on what's about to be uploaded.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));
const problems = [];
if (manifest.version !== pkg.version) problems.push(`manifest version ${manifest.version} ≠ package.json ${pkg.version}`);
const optional = manifest.optional_host_permissions ?? [];
if (optional.length !== 1 || !optional[0].startsWith('https://')) problems.push('expected one https optional host permission (the server)');
for (const size of ['16', '48', '128']) {
  const icon = manifest.icons?.[size];
  if (!icon || !existsSync(join('dist', icon))) problems.push(`missing ${size}px icon`);
}
const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const all = files('dist');
if (all.some((f) => f.endsWith('.map'))) problems.push('source maps in dist/');
if (all.some((f) => /\.(ts|DS_Store)$/.test(f))) problems.push('stray files in dist/');
if (problems.length) {
  console.error('Not packaged:\n- ' + problems.join('\n- '));
  process.exit(1);
}

mkdirSync('release', { recursive: true });
const slug = manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const zip = join('release', `${slug}-${manifest.version}.zip`);
rmSync(zip, { force: true });
execFileSync('zip', ['-r', '-X', '-q', join('..', zip), '.'], { cwd: 'dist', stdio: 'inherit' });
console.log(`\nPackaged ${zip} (${Math.round(statSync(zip).size / 1024)} KB), server ${env.COMMUNITY_API}`);

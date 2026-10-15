import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve('dist');
if (path.dirname(output) !== path.resolve('.') || path.basename(output) !== 'dist') throw new Error('Unexpected build output path');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp('extension', 'dist', { recursive: true });
if (!process.argv.includes('--assets-only')) {
  await build({ entryPoints: ['src/content.ts'], bundle: true, outdir: 'dist', format: 'iife', target: 'chrome116', legalComments: 'eof', minify: true });
}
await cp('assets/fonts', 'dist/fonts', { recursive: true });
await cp('LICENSE', 'dist/LICENSE');
await cp('THIRD_PARTY_NOTICES.md', 'dist/THIRD_PARTY_NOTICES.md');
await cp('licenses', 'dist/licenses', { recursive: true });
// Preserve the dependency's sources and notices without duplicating application code.
const vendor = path.resolve('third_party/mediabunny');
if (vendor !== path.join(path.resolve('.'), 'third_party', 'mediabunny')) throw new Error('Unexpected dependency source path');
await rm(vendor, { recursive: true, force: true });
await cp('node_modules/mediabunny/src', path.join(vendor, 'src'), { recursive: true });
for (const file of ['LICENSE', 'package.json', 'README.md']) await cp(path.join('node_modules/mediabunny', file), path.join(vendor, file));
console.log('dist/ を Chrome / Opera に読み込めます。');

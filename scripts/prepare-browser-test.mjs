import { build } from 'esbuild';
import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
await build({ entryPoints: ['tests/browser-harness.ts'], bundle: true, format: 'esm', outfile: 'dist/__test.js', target: 'chrome116' });
await writeFile('dist/__test.html', '<!doctype html><meta charset="utf-8"><script type="module" src="__test.js"></script>');
await mkdir('test-results', { recursive: true });
// Test fixtures only. The installed extension does not require native FFmpeg.
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', 'test-results/fixture.mp4']);
await mkdir('test-results/fixtures', { recursive: true });
for (const [name, track] of [['video', 'v'], ['audio', 'a']]) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'test-results/fixture.mp4', '-map', `0:${track}:0`, '-c', 'copy', '-f', 'hls', '-hls_time', '10', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', `${name}-init.mp4`, '-hls_segment_filename', `test-results/fixtures/${name}%d.m4s`, `test-results/fixtures/${name}.m3u8`]);
}

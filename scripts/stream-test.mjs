import { chromium } from 'playwright';
import { mkdir, readdir, open, stat, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const endpoint = process.env.NICO_TEST_CDP || 'http://127.0.0.1:9222';
const id = process.argv[2] || 'sm9', comments = process.argv[3] === 'on';
const browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
const context = browser.contexts()[0];
const versionPage = await context.newPage(); await versionPage.goto('chrome://version');
const profile = await versionPage.locator('#profile_path').textContent(); await versionPage.close();
assert.ok(path.resolve(profile).startsWith(path.resolve('.test-profile')), 'Use a dedicated workspace test profile');
const page = await context.newPage();
page.on('requestfailed', request => console.log('Failed request', new URL(request.url()).hostname, request.failure()?.errorText));
page.on('console', message => { if(message.type()==='error')console.log('Browser error',message.text().replace(/https?:\/\/[^\s]+/g, '[URL]')); });
const cdp = await context.newCDPSession(page); const worlds = [];
cdp.on('Runtime.executionContextCreated', event => worlds.push(event.context));
await cdp.send('Runtime.enable'); await cdp.send('Performance.enable');
await page.route('https://www.nicovideo.jp/watch/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>テスト動画</title><h1>テスト動画</h1>' }));
await page.goto(`https://www.nicovideo.jp/watch/${id}`);
const host = page.locator('#nico-drop'); await host.locator('#open').click();
await page.waitForFunction(() => !document.querySelector('#nico-drop')?.shadowRoot?.getElementById('download')?.disabled, undefined, { timeout: 60000 });
const world = worlds.find(w => w.name === 'NicoDrop'); assert.ok(world);
const evaluate = async expression => {
  const r = await cdp.send('Runtime.evaluate', { contextId: world.id, expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const nativePicker = await evaluate('typeof window.showSaveFilePicker'); assert.equal(nativePicker, 'function');
// Only the headless picker is substituted. The production pipeline writes through
// a real FileSystemWritableFileStream to the browser's disk-backed OPFS.
await evaluate(`window.showSaveFilePicker = async options => {
  const root = await navigator.storage.getDirectory();
  window.__picked = await root.getFileHandle(options.suggestedName, {create:true});
  return window.__picked;
}`);
const qualities = await host.locator('#quality option').evaluateAll(options => options.map(o => ({ id:o.value,label:o.textContent })));
if (comments) await host.locator('#comments').check();
await host.locator('#download').click();
const heaps = [], progress = [];
for (let n = 0; n < 1200; n++) {
  const message = await host.locator('#status').textContent();
  progress.push(message);
  const metrics = await cdp.send('Performance.getMetrics');
  heaps.push(metrics.metrics.find(x => x.name === 'JSHeapUsedSize')?.value || 0);
  if (await host.locator('#choices').isVisible()) break;
  await page.waitForTimeout(250);
}
assert.equal(await host.locator('#status').textContent(), '保存しました。');
assert.equal(await host.locator('#open').textContent(), 'ダウンロード');
const file = await evaluate(`window.__picked.getFile().then(f => ({name:f.name,size:f.size}))`);
assert.ok(file.size > 32);
async function diskMP4(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes:true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await diskMP4(filename));
    else {
      const metadata = await stat(filename);
      if (metadata.size !== file.size) continue;
      const handle = await open(filename, 'r'); const head = Buffer.alloc(12);
      await handle.read(head, 0, 12, 0); await handle.close();
      if (head.toString('ascii',4,8) === 'ftyp') found.push({filename,mtime:metadata.mtimeMs});
    }
  }
  return found;
}
const candidates = (await diskMP4(profile)).sort((a,b)=>b.mtime-a.mtime); assert.ok(candidates.length);
await mkdir('test-results', {recursive:true});
const stem = `stream-${await browser.version()}-${id}-${comments?'on':'off'}`;
await copyFile(candidates[0].filename, `test-results/${stem}.mp4`);
await writeFile(`test-results/${stem}.json`, JSON.stringify({testedAt:new Date().toISOString(),browser:await browser.version(),id,comments,qualities,file,peakJSHeapBytes:Math.max(...heaps),progress:[...new Set(progress)],nativePickerAvailable:true,pickerSubstitutedForHeadless:true},null,2));
await page.close(); await browser.close(); console.log('Streaming save passed',stem,file);

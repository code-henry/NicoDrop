import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.connectOverCDP(process.env.NICO_TEST_CDP||'http://127.0.0.1:9222',{noDefaults:true});
const context=browser.contexts()[0],page=await context.newPage();
const cdp=await context.newCDPSession(page),worlds=[];
cdp.on('Runtime.executionContextCreated',e=>worlds.push(e.context));await cdp.send('Runtime.enable');
await page.route('https://www.nicovideo.jp/watch/*',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><title>テスト</title><main><h1>テスト</h1></main>'}));
await page.goto('https://www.nicovideo.jp/watch/sm9');
const host=page.locator('#nico-drop');await host.locator('#open').click();
await page.waitForFunction(()=>!document.querySelector('#nico-drop')?.shadowRoot?.getElementById('download')?.disabled,undefined,{timeout:60000});
const world=worlds.find(w=>w.name==='NicoDrop');assert.ok(world);
const evaluate=async expression=>{
  const r=await cdp.send('Runtime.evaluate',{contextId:world.id,expression,awaitPromise:true,returnByValue:true});
  if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;
};
await evaluate(`(async()=>{
  const root=await navigator.storage.getDirectory();window.__picked=await root.getFileHandle('cancel-sentinel.mp4',{create:true});
  const w=await window.__picked.createWritable();await w.write('original-file');await w.close();
  window.showSaveFilePicker=async()=>window.__picked;
})()`);
for (const mode of ['light', 'dark']) {
  await page.emulateMedia({colorScheme:mode});
  await host.locator('#comments').check();
  assert.equal(await host.locator('.track').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(22, 131, 58)');
  await host.locator('#comments').uncheck();
  assert.equal(await host.locator('.track').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(153, 153, 153)');
}
await host.locator('#comments').check();await host.locator('#download').click();
await page.waitForFunction(()=>document.querySelector('#nico-drop')?.shadowRoot?.querySelector('progress')?.value>=5,undefined,{timeout:120000});
await page.mouse.click(2,2);
assert.equal(await host.locator('dialog').isVisible(),false);
assert.match(await host.locator('#open').textContent(),/^ダウンロード中 \d+%$/);
await host.locator('#open').click();
assert.equal(await host.locator('#working').isVisible(),true);
await host.locator('#cancel').click();await host.locator('#status').filter({hasText:'キャンセルしました'}).waitFor({timeout:60000});
assert.equal(await host.locator('#open').textContent(),'ダウンロード');
assert.equal(await evaluate('window.__picked.getFile().then(f=>f.text())'),'original-file');
// The next job must start, and cancellation during acquisition must also preserve the old file.
await host.locator('#download').click();await host.locator('#status').filter({hasText:'取得'}).waitFor();
await host.locator('#cancel').click();await host.locator('#status').filter({hasText:'キャンセルしました'}).waitFor({timeout:60000});
assert.equal(await evaluate('window.__picked.getFile().then(f=>f.text())'),'original-file');
await host.locator('#download').click();await host.locator('#status').filter({hasText:'取得'}).waitFor();
await page.evaluate(()=>history.pushState({},'','/watch/so38016254'));
await page.waitForFunction(()=>{const s=document.querySelector('#nico-drop')?.shadowRoot;return s&&!s.querySelector('dialog').open&&s.getElementById('quality').options.length===0;});
await host.locator('#open').click();await page.waitForFunction(()=>!document.querySelector('#nico-drop')?.shadowRoot?.getElementById('download')?.disabled,undefined,{timeout:60000});
const ids=await host.locator('#quality option').evaluateAll(o=>o.map(x=>x.value));assert.ok(ids.includes('video-h264-720p'));
assert.equal(await evaluate('window.__picked.getFile().then(f=>f.text())'),'original-file');
await page.evaluate(()=>document.querySelector('main').remove());await page.waitForTimeout(600);assert.equal(await page.locator('#nico-drop').count(),1);
await writeFile(`test-results/stream-cancel-${await browser.version()}.json`,JSON.stringify({testedAt:new Date().toISOString(),browser:await browser.version(),conversionCancel:true,fetchCancel:true,spaWhileFetching:true,newQualities:ids,remount:true,existingFilePreserved:true,retryAfterCancel:true,greenSwitchLightAndDark:true,progressButtonWhileDialogClosed:true,reopenProgress:true,buttonResetAfterCancel:true,pickerSubstitutedForHeadless:true},null,2));
await page.close();await browser.close();console.log('Disk abort, existing-file preservation, retry and SPA passed');

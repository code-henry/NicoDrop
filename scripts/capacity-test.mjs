import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const comments = process.argv[2] === 'on';
const browser = await chromium.connectOverCDP(process.env.NICO_TEST_CDP || 'http://127.0.0.1:9222', { noDefaults:true });
const page = await browser.contexts()[0].newPage();
page.on('crash',()=>console.log('Capacity test renderer crashed'));
page.on('pageerror',error=>console.log('Capacity page error',error.message));
page.on('console',message=>{if(message.text().startsWith('Capacity progress'))console.log(message.text());});
await page.goto('chrome://extensions');
const id = await page.locator('extensions-item').evaluateAll(items=>items.find(i=>i.data?.name==='NicoDrop').id);
const url='https://delivery.domand.nicovideo.jp/nico-drop-test/';
const vi=await readFile('test-results/fixtures/video-init.mp4'), ai=await readFile('test-results/fixtures/audio-init.mp4');
const vb=await readFile('test-results/fixtures/video0.m4s'), ab=await readFile('test-results/fixtures/audio0.m4s');
const count=640, period=8.021333333333334;
const inputBytes=(vb.length+ab.length)*count+vi.length+ai.length;
assert.ok(inputBytes>450*1024*1024);
function shifted(original,index,timescale){
  const bytes=Buffer.from(original);
  // Shift the fragment's decode base on the shared synthetic clock, preserving
  // all media payloads. The 21ms tail of AAC is included in the segment period.
  let offset=0;
  while((offset=bytes.indexOf('tfdt',offset,'ascii'))>=0){
    const amount=BigInt(Math.round(index*period*timescale));
    if(bytes[offset+4]===1)bytes.writeBigUInt64BE(bytes.readBigUInt64BE(offset+8)+amount,offset+8);
    else bytes.writeUInt32BE(Number(BigInt(bytes.readUInt32BE(offset+8))+amount),offset+8);
    offset+=16;
  }
  return bytes;
}
await page.route(url+'**',async route=>{
  const p=new URL(route.request().url()).pathname.split('/').at(-1);
  const data=p==='vi'?vi:p==='ai'?ai:p.startsWith('v')?shifted(vb,Number(p.slice(1)),15360):shifted(ab,Number(p.slice(1)),48000);
  await route.fulfill({contentType:'application/octet-stream',body:data});
});
await page.goto(`chrome-extension://${id}/__test.html`);
await page.waitForFunction(()=>!!window.runPipeline);
const cdp=await browser.contexts()[0].newCDPSession(page);await cdp.send('Performance.enable');
const measurements=[];
const sampling=setInterval(()=>{void cdp.send('Performance.getMetrics').then(r=>measurements.push(r.metrics.find(m=>m.name==='JSHeapUsedSize')?.value||0)).catch(()=>{});},250);
const result=await page.evaluate(async({url,count,period,comments})=>{
  const root=await navigator.storage.getDirectory();
  const handle=await root.getFileHandle(comments?'capacity-on.mp4':'capacity.mp4',{create:true});
  const lists=['v','a'].map(prefix=>({duration:count*period,parts:Array.from({length:count},(_,i)=>({url:url+prefix+i,duration:period,sequence:i,init:{url:url+(prefix==='v'?'vi':'ai'),duration:0,sequence:0}}))}));
  // Reuse each track's init object exactly as a parsed playlist does.
  for(const list of lists)for(const part of list.parts)part.init=list.parts[0].init;
  const start=performance.now();let progress=0,lastLog=-1;
  await window.runPipeline({lists,quality:{id:'fixture',label:'fixture',width:320,height:240,bitRate:900000,qualityLevel:0},duration:count*period,comments:comments?[{body:'流れるコメント',vposMs:500,commands:['red','big']},{body:'上固定',vposMs:1000,commands:['ue','cyan']},{body:'下固定',vposMs:1000,commands:['shita','yellow']}]:undefined,file:await handle.createWritable(),signal:new AbortController().signal,progress:p=>{progress=p;const step=Math.floor(p/10);if(step!==lastLog){lastLog=step;console.log('Capacity progress',p);}}});
  const file=await handle.getFile();
  return {outputBytes:file.size,duration:count*period,elapsedSeconds:(performance.now()-start)/1000,progress};
},{url,count,period,comments});
clearInterval(sampling);
assert.equal(result.progress,100);if(!comments)assert.ok(result.outputBytes>450*1024*1024);
const evidence={testedAt:new Date().toISOString(),browser:await browser.version(),synthetic:true,comments,inputBytes,...result,peakJSHeapBytes:Math.max(...measurements),samples:measurements.length,pickerSubstitutedForHeadless:true};
await writeFile(`test-results/capacity-${comments?'on-':''}${await browser.version()}.json`,JSON.stringify(evidence,null,2));
await page.close();await browser.close();console.log('Capacity test passed',evidence);

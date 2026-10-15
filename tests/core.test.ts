import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributes, master, parsePlaylist, sequenceIV, SegmentLoader } from '../src/hls';
import { style, layoutComments, CommentRenderer } from '../src/comments';
import { info, allowedURL } from '../src/api';
import { filename, type Watch } from '../src/types';
test('画質候補は権限のある実在形式だけ・高画質順', () => {
  const w = { video: { id: 'sm9', title: 'test', duration: 10 }, media: { domand: { videos: [
    { id: 'low', label: '360p', isAvailable: true, width: 640, height: 360, qualityLevel: 1, bitRate: 100 },
    { id: 'locked', isAvailable: false, width: 1920, height: 1080, qualityLevel: 3 },
    { id: 'high', label: '720p', isAvailable: true, width: 1280, height: 720, qualityLevel: 2, bitRate: 200 }
  ], audios: [{ isAvailable: true }] } } } as Watch;
  assert.deepEqual(info(w).qualities.map(q => q.id), ['high', 'low']);
});
test('HLSの映像と音声を別々に選択し相対URLを解決', () => {
  assert.deepEqual(master('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="AAC,128",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO="a"\nvideo.m3u8', 'https://delivery.domand.nicovideo.jp/x/master.m3u8'), {
    video: 'https://delivery.domand.nicovideo.jp/x/video.m3u8', audio: 'https://delivery.domand.nicovideo.jp/x/audio.m3u8'
  });
  assert.equal(attributes('NAME="AAC,128",TYPE=AUDIO').NAME, 'AAC,128');
});
const url = 'https://delivery.domand.nicovideo.jp/x/a.m3u8';
test('AES-128・初期化MP4・メディアシーケンス・範囲', () => {
  const p = parsePlaylist('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:257\n#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x1\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\n#EXT-X-BYTERANGE:16@0\nseg\n#EXTINF:2,\n#EXT-X-BYTERANGE:16\nseg\n#EXT-X-ENDLIST', url);
  assert.equal(p.duration, 8); assert.equal(p.parts[1].sequence, 258);
  assert.equal(p.parts[0].key?.iv?.[15], 1); assert.equal(p.parts[1].range?.offset, 16);
  assert.equal(p.parts[0].init?.url, 'https://delivery.domand.nicovideo.jp/x/init.mp4');
  assert.deepEqual(Array.from(sequenceIV(257)).slice(-2), [1, 1]);
});
test('DRM・ライブ・不連続・外部URLは明確に拒否', () => {
  assert.throws(() => parsePlaylist('#EXTM3U\n#EXTINF:1,\na', url), /ライブ/);
  assert.throws(() => parsePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF:1,\na\n#EXT-X-ENDLIST', url), /DRM/);
  assert.throws(() => parsePlaylist('#EXTM3U\n#EXT-X-DISCONTINUITY\n#EXTINF:1,\na\n#EXT-X-ENDLIST', url), /不連続/);
  assert.throws(() => allowedURL('https://nicovideo.jp.evil.example/key'));
  assert.throws(() => allowedURL('http://delivery.domand.nicovideo.jp/key'));
});
test('実際の暗号化セグメントを逐次復号・キャンセル', async () => {
  const original = globalThis.fetch;
  const key = new Uint8Array(16).fill(7);
  const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
  const plain = new TextEncoder().encode('fixture segment');
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: sequenceIV(3) }, cryptoKey, plain);
  const controller = new AbortController();
  globalThis.fetch = async input => new Response(String(input).endsWith('/key') ? key : encrypted);
  try {
    const p = parsePlaylist('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:3\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:2,\nseg\n#EXT-X-ENDLIST', url);
    const loader = new SegmentLoader(controller.signal);
    assert.deepEqual(await loader.read(p.parts[0]), plain);
    controller.abort();
    await assert.rejects(loader.read(p.parts[0]), { name: 'AbortError' });
  } finally { globalThis.fetch = original; }
});
test('主要コメントコマンド・色・サイズ', () => {
  assert.deepEqual(style(['shita', 'big', 'red']), { position: 'bottom', size: 39, color: 'FF0000', font: 'Noto Sans CJK JP' });
  assert.equal(style(['ue', 'small', '#123ABC']).color, '123ABC');
});
test('コメントの流れ・上下固定・色・重なり回避・尺外省略', () => {
  const placed = layoutComments([
    { body: '流れる', vposMs: 1230, commands: ['red'] },
    { body: '流れる2', vposMs: 1230, commands: [] },
    { body: '上', vposMs: 2000, commands: ['ue'] },
    { body: '下', vposMs: 2000, commands: ['shita', 'big'] },
    { body: '範囲外', vposMs: 100000, commands: [] }
  ], 1920, 1080, 10, (text, size) => text.length * size);
  assert.equal(placed[0].start, 1.23); assert.equal(placed[0].y, 4);
  assert.equal(placed[0].color, 'FF0000'); assert.equal(placed[1].y, 32.8);
  assert.equal(placed[2].position, 'top'); assert.equal(placed[3].position, 'bottom');
  assert.equal(placed.length, 4);
});
test('Canvas描画は時間とともに左へ流れ、表示期限を過ぎると解放する', () => {
  const draws: {text:string;x:number;y:number}[] = [];
  const ctx = { save(){},restore(){},scale(){},measureText(text:string){return {width:text.length*24};},strokeText(){},fillText(text:string,x:number,y:number){draws.push({text,x,y});} } as unknown as OffscreenCanvasRenderingContext2D;
  const renderer = new CommentRenderer(ctx, [{body:'流れる',vposMs:1000,commands:[]}], 640,360,10);
  renderer.draw(0,640,360); assert.equal(draws.length,0);
  renderer.draw(1,640,360); const start=draws.at(-1)!.x;
  renderer.draw(2,640,360); assert.ok(draws.at(-1)!.x<start);
  const count=draws.length; renderer.draw(6,640,360); assert.equal(draws.length,count);
  renderer.draw(1,640,360); assert.equal(draws.at(-1)!.x,start);
});
test('動画タイトルを安全なWindowsファイル名へ', () => {
  assert.equal(filename('CON'), '_CON.mp4');
  assert.equal(filename('テスト / 動画?'), 'テスト _ 動画_.mp4');
});

import { allowedURL, request } from './api';

export interface Key { url: string; iv?: Uint8Array<ArrayBuffer> }
export interface Part { url: string; duration: number; sequence: number; key?: Key; range?: { offset: number; length: number }; init?: Part }
export interface Playlist { parts: Part[]; duration: number }
export function attributes(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const m of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) result[m[1]] = m[2].replace(/^"|"$/g, '');
  return result;
}
const resolve = (s: string, base: string) => allowedURL(new URL(s, base).href).href;
export function master(text: string, base: string): { video: string; audio?: string } {
  const lines = text.trim().split(/\r?\n/).map(s => s.trim());
  if (lines[0] !== '#EXTM3U') throw new Error('HLSプレイリストではありません。');
  const index = lines.findIndex(l => l.startsWith('#EXT-X-STREAM-INF:'));
  if (index < 0) return { video: base };
  const attrs = attributes(lines[index]);
  const path = lines.slice(index + 1).find(l => l && !l.startsWith('#'));
  if (!path) throw new Error('映像プレイリストがありません。');
  const audios = lines.filter(l => l.startsWith('#EXT-X-MEDIA:')).map(attributes)
    .filter(a => a.TYPE === 'AUDIO' && a['GROUP-ID'] === attrs.AUDIO && a.URI);
  const audio = audios.find(a => a.DEFAULT === 'YES') || audios[0];
  if (attrs.AUDIO && !audio) throw new Error('音声プレイリストがありません。');
  return { video: resolve(path, base), audio: audio ? resolve(audio.URI, base) : undefined };
}
export function parsePlaylist(text: string, base: string): Playlist {
  const lines = text.trim().split(/\r?\n/).map(s => s.trim());
  if (lines[0] !== '#EXTM3U' || !lines.includes('#EXT-X-ENDLIST')) throw new Error('ライブ配信／未完了のHLSは未対応です。');
  let key: Key | undefined, init: Part | undefined, duration = 0, sequence = 0, range: Part['range'];
  let previousRange: { url: string; end: number } | undefined;
  const parts: Part[] = [];
  for (const line of lines) {
    if (line.startsWith('#EXT-X-DISCONTINUITY')) throw new Error('時刻が不連続なHLSは未対応です。');
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = Number(line.split(':')[1]);
    if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0]);
    if (line.startsWith('#EXT-X-KEY:')) {
      const a = attributes(line);
      if (a.METHOD === 'NONE') key = undefined;
      else {
        if (a.METHOD !== 'AES-128' || (a.KEYFORMAT && a.KEYFORMAT !== 'identity')) throw new Error('DRM／SAMPLE-AESには対応しません。');
        if (!a.URI) throw new Error('HLSの鍵URLがありません。');
        let iv;
        if (a.IV) {
          if (!/^0x[\da-f]{1,32}$/i.test(a.IV)) throw new Error('HLSのIVが不正です。');
          const hex = a.IV.slice(2).padStart(32, '0');
          iv = Uint8Array.from(hex.match(/../g)!, b => parseInt(b, 16));
        }
        key = { url: resolve(a.URI, base), iv };
      }
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const a = attributes(line);
      if (!a.URI || (key && !key.iv)) throw new Error('HLS初期化データが不正です。');
      init = { url: resolve(a.URI, base), duration: 0, sequence, key };
      if (a.BYTERANGE) {
        const [length, offset] = a.BYTERANGE.split('@').map(Number);
        if (offset === undefined) throw new Error('省略された初期化範囲には対応しません。');
        init.range = { length, offset };
      }
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const [length, offset] = line.slice(17).split('@').map(Number);
      range = { length, offset: offset ?? -1 };
    }
    if (line && !line.startsWith('#')) {
      const url = resolve(line, base);
      if (range?.offset === -1) {
        if (previousRange?.url !== url) throw new Error('HLSのバイト範囲が不正です。');
        range.offset = previousRange.end;
      }
      if (range) {
        if (range.length <= 0 || range.offset < 0) throw new Error('HLSのバイト範囲が不正です。');
        previousRange = { url, end: range.offset + range.length };
      } else previousRange = undefined;
      if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(sequence)) throw new Error('HLSの時間情報が不正です。');
      parts.push({ url, duration, sequence: sequence++, key, range, init });
      duration = 0; range = undefined;
    }
  }
  if (!parts.length) throw new Error('HLSに映像データがありません。');
  return { parts, duration: parts.reduce((sum, p) => sum + p.duration, 0) };
}
export function sequenceIV(sequence: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(16);
  let n = BigInt(sequence);
  for (let i = 15; i >= 0; i--) { iv[i] = Number(n & 255n); n >>= 8n; }
  return iv;
}
export async function playlists(url: string, signal: AbortSignal): Promise<Playlist[]> {
  const streams = master(await (await request(url, signal)).text(), url);
  return Promise.all([streams.video, ...(streams.audio ? [streams.audio] : [])].map(async u =>
    parsePlaylist(await (await request(u, signal)).text(), u)));
}
/** A small, per-job loader; encrypted bytes are released after each segment is consumed. */
export class SegmentLoader {
  private keys = new Map<string, CryptoKey>();
  constructor(private signal: AbortSignal) {}
  async read(part: Part): Promise<Uint8Array<ArrayBuffer>> {
    this.signal.throwIfAborted();
    const response = await request(part.url, this.signal, part.range ? { headers: { Range: `bytes=${part.range.offset}-${part.range.offset + part.range.length - 1}` } } : {});
    if (part.range && response.status !== 206) throw new Error('配信サーバーがバイト範囲要求に対応していません。');
    let data = await response.arrayBuffer();
    if (part.range && data.byteLength !== part.range.length) throw new Error('取得したバイト範囲の長さが不正です。');
    if (part.key) {
      let key = this.keys.get(part.key.url);
      if (!key) {
        const raw = await (await request(part.key.url, this.signal)).arrayBuffer();
        if (raw.byteLength !== 16) throw new Error('HLSの鍵形式に対応していません。');
        key = await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']); this.keys.set(part.key.url, key);
        if (this.keys.size > 4) this.keys.delete(this.keys.keys().next().value!);
      }
      data = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: part.key.iv || sequenceIV(part.sequence) }, key, data);
    }
    this.signal.throwIfAborted();
    return new Uint8Array(data);
  }
}

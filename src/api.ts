import { isWatchId, type Watch, type VideoInfo, type Comment } from './types';

const headers = { 'X-Frontend-Id': '6', 'X-Frontend-Version': '0', 'X-Request-With': 'https://www.nicovideo.jp' };
// Restrict requests to NicoNico delivery and API hosts.
export function allowedURL(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['nicovideo.jp', 'nimg.jp'].some(d => url.hostname === d || url.hostname.endsWith('.' + d))) {
    throw new Error('配信先URLに対応していません。');
  }
  return url;
}
export async function request(url: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
  allowedURL(url);
  const response = await fetch(url, { ...init, credentials: init.credentials ?? 'include', redirect: 'error', signal });
  if (response.url) allowedURL(response.url);
  if (!response.ok) throw new Error(`取得できませんでした（${new URL(url).hostname} / HTTP ${response.status}）。視聴権限とログイン状態を確認してください。`);
  return response;
}
async function json(url: string, signal: AbortSignal, init: RequestInit = {}): Promise<any> {
  const value = await (await request(url, signal, init)).json();
  if (value.meta?.status >= 400) throw new Error(`APIエラー：${value.meta.errorCode || value.meta.status}`);
  return value.data;
}
export async function getWatch(id: string, signal: AbortSignal): Promise<Watch> {
  if (!isWatchId(id)) throw new Error('動画IDが不正です。');
  const track = crypto.randomUUID().replaceAll('-', '').slice(0, 10) + '_' + Date.now();
  const url = `https://www.nicovideo.jp/api/watch/v3/${id}?actionTrackId=${track}`;
  const response = await fetch(url, { credentials: 'include', redirect: 'error', headers, signal });
  let value = await response.json();
  // Use the guest API when no session is available.
  if (response.status === 401 || value.meta?.errorCode === 'UNAUTHORIZED') {
    value = { data: await json(url.replace('/v3/', '/v3_guest/'), signal, { headers }) };
  } else if (!response.ok || value.meta?.status !== 200) {
    throw new Error(`この動画を取得できません（${value.meta?.errorCode || response.status}）。ブラウザで視聴できることを確認してください。`);
  }
  const watch: Watch = value.data;
  if (!watch?.media?.domand) throw new Error('この配信方式は未対応です（旧DMC／DRM等）。');
  if (!watch.video?.title || !watch.client?.watchTrackId) throw new Error('動画情報の形式が変更されています。');
  return watch;
}
export function info(watch: Watch): VideoInfo {
  const qualities = (watch.media.domand?.videos || []).filter(q => q.isAvailable && q.id && q.width > 0 && q.height > 0)
    .map(({ id, label, width, height, bitRate, qualityLevel }) => ({ id, label, width, height, bitRate, qualityLevel }))
    .sort((a, b) => b.qualityLevel - a.qualityLevel || b.bitRate - a.bitRate);
  if (!qualities.length || !watch.media.domand?.audios.some(a => a.isAvailable)) throw new Error('利用可能な映像・音声がありません。');
  return { ...watch.video, qualities };
}
export interface Authorization { watchId: string; trackId: string; accessKey: string; videoId: string; audioId: string }
export async function getStream(watch: Watch, qualityId: string, signal: AbortSignal,
  authorize?: (parameters: Authorization) => Promise<{ contentUrl: string }>): Promise<string> {
  const domand = watch.media.domand!;
  if (!domand.videos.some(v => v.id === qualityId && v.isAvailable)) throw new Error('選択した画質は利用できません。');
  const audio = domand.audios.filter(a => a.isAvailable).sort((a, b) => b.bitRate - a.bitRate)[0];
  if (!audio) throw new Error('音声を取得できません。');
  const parameters: Authorization = { watchId: watch.video.id, trackId: watch.client.watchTrackId, accessKey: domand.accessRightKey, videoId: qualityId, audioId: audio.id };
  // The live endpoint validates Origin. Authorize in the isolated content script,
  // where Fetch uses the watch page's normal origin and SameSite cookie context.
  const data = authorize ? await authorize(parameters) : await authorizeHLS(parameters, signal);
  if (typeof data?.contentUrl !== 'string') throw new Error('配信URLがありません。');
  return allowedURL(data.contentUrl).href;
}
export async function authorizeHLS(p: Authorization, signal: AbortSignal): Promise<{ contentUrl: string }> {
  if (!isWatchId(p.watchId)) throw new Error('動画IDが不正です。');
  return json(`https://nvapi.nicovideo.jp/v1/watch/${p.watchId}/access-rights/hls?actionTrackId=${encodeURIComponent(p.trackId)}`,
    signal, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-Access-Right-Key': p.accessKey }, body: JSON.stringify({ outputs: [[p.videoId, p.audioId]] }) });
}
export async function getComments(watch: Watch, signal: AbortSignal): Promise<Comment[]> {
  const nv = watch.comment?.nvComment;
  if (!nv?.server || !nv.params || !nv.threadKey) throw new Error('コメントAPI情報がありません。');
  const send = (threadKey: string) => json(`${allowedURL(nv.server).origin}/v1/threads`, signal, {
    // Comments are authorized by threadKey. This endpoint uses wildcard CORS and
    // intentionally does not accept credentialed cross-origin browser requests.
    credentials: 'omit',
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-Client-Os-Type': 'others' },
    body: JSON.stringify({ params: nv.params, threadKey, additionals: {} })
  });
  let data;
  try { data = await send(nv.threadKey); }
  catch (error) {
    signal.throwIfAborted();
    // Refresh an expired key once, using the same logged-in session.
    const fresh = await json(`https://nvapi.nicovideo.jp/v1/comment/keys/thread?videoId=${watch.video.id}`, signal, { headers });
    if (!fresh?.threadKey) throw error;
    data = await send(fresh.threadKey);
  }
  if (!Array.isArray(data?.threads)) throw new Error('コメントの形式が変更されています。');
  const seen = new Set<string>();
  return data.threads.flatMap((t: any) => (t.comments || []).map((c: Comment) => ({ ...c, fork: t.fork })))
    .filter((c: Comment) => {
      const key = c.id || `${c.fork}:${c.no}:${c.vposMs}:${c.body}`;
      if (seen.has(key) || c.isDeleted || typeof c.body !== 'string' || !Number.isFinite(c.vposMs)) return false;
      seen.add(key); return true;
    }).sort((a: Comment, b: Comment) => a.vposMs - b.vposMs);
}

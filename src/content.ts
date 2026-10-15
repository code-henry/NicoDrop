import { filename, type VideoInfo, type Status } from './types';
import { getWatch, info, getStream, getComments } from './api';
import { playlists } from './hls';
import { runPipeline } from './pipeline';

const host = document.createElement('div');
host.id = 'nico-drop';
const shadow = host.attachShadow({ mode: 'open' });
shadow.innerHTML = `<style>
:host{display:inline-block!important;font:14px system-ui,sans-serif!important;color-scheme:light dark;line-height:1.5!important}
*{box-sizing:border-box}button,select,input{font:inherit}button{cursor:pointer;border:1px solid var(--line);border-radius:3px;padding:7px 14px;background:var(--bg);color:var(--fg)}button:disabled{opacity:.5;cursor:default}
:host{--bg:#fff;--fg:#222;--line:#ccc;--muted:#666} @media(prefers-color-scheme:dark){:host{--bg:#222;--fg:#eee;--line:#555;--muted:#aaa}}
:host([data-dark]){--bg:#222;--fg:#eee;--line:#555;--muted:#aaa}
dialog{padding:18px;width:280px;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--fg);font:14px system-ui,sans-serif}dialog::backdrop{background:#0005}
label{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:16px}select{min-width:130px;max-width:175px;background:var(--bg);color:var(--fg);border:1px solid var(--line);padding:5px}
.switch{position:relative;display:inline-block;width:34px;height:20px}.switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}.track{display:block;width:34px;height:20px;border-radius:10px;background:#999;pointer-events:none}.track:after{content:'';display:block;position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:white}input:checked+.track{background:#16833a}input:checked+.track:after{left:17px}input:focus-visible+.track{outline:2px solid var(--fg);outline-offset:3px}
#download,#cancel{width:100%}#download{background:var(--fg);color:var(--bg)}[hidden]{display:none!important}progress{width:100%;height:5px;accent-color:var(--fg)}#status{display:block;margin:8px 0 12px;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
</style><button id="open" type="button" aria-haspopup="dialog">ダウンロード</button>
<dialog aria-label="NicoDrop"><div id="choices"><label>画質<select id="quality" aria-label="画質" disabled></select></label><label>コメント<span class="switch"><input id="comments" type="checkbox" role="switch" aria-label="コメント"><span class="track"></span></span></label><button id="download" type="button" disabled>ダウンロード</button></div><div id="working" hidden><progress max="100" value="0" aria-label="ダウンロード進捗"></progress><button id="cancel" type="button">キャンセル</button></div><output id="status" role="status" aria-live="polite" hidden></output></dialog>`;
const find = <T extends HTMLElement>(id: string) => shadow.getElementById(id) as T;
const dialog = shadow.querySelector('dialog')!;
const quality = find<HTMLSelectElement>('quality');
const download = find<HTMLButtonElement>('download');
const status = find<HTMLOutputElement>('status');
const choices = find<HTMLDivElement>('choices');
const working = find<HTMLDivElement>('working');
const open = find<HTMLButtonElement>('open');
let watchId = '', loaded: VideoInfo | undefined, loading = false, generation = 0;
let job: { id: string; controller: AbortController } | undefined;
let infoController: AbortController | undefined;
function text(message: string) { status.hidden = !message; status.textContent = message; }
function reset() {
  infoController?.abort(); loaded = undefined; loading = false; generation++;
  quality.replaceChildren(); quality.disabled = true; download.disabled = true;
  choices.hidden = false; working.hidden = true; text(''); if (dialog.open) dialog.close();
  open.textContent = 'ダウンロード';
}
async function load() {
  if (loaded || loading) return;
  const current = generation; loading = true; text('画質を取得中…');
  const controller = new AbortController(); infoController = controller;
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const value = info(await getWatch(watchId, controller.signal));
    if (generation !== current) return;
    loaded = value;
    quality.replaceChildren(...loaded!.qualities.map(q => new Option(q.label || `${q.height}p`, q.id)));
    quality.disabled = false; download.disabled = !!job; text('');
  } catch (error) { if (generation === current) text(error instanceof Error ? error.message : String(error)); }
  finally { clearTimeout(timeout); if (generation === current) loading = false; }
}
function progress(s: Status) {
  if (s.watchId !== watchId || s.jobId !== job?.id) return;
  const terminal = ['done', 'error', 'cancelled'].includes(s.phase);
  open.textContent = terminal ? 'ダウンロード' : `ダウンロード中 ${Math.floor(s.percent)}%`;
  choices.hidden = !terminal; working.hidden = terminal;
  shadow.querySelector('progress')!.value = s.percent;
  text(s.phase === 'error' ? s.error || '処理に失敗しました。' : s.phase === 'cancelled' ? 'キャンセルしました。' : s.phase === 'done' ? '保存しました。' : `${s.phase === 'convert' ? 'MP4変換' : s.phase === 'save' ? '保存' : '取得'} ${Math.floor(s.percent)}%`);
  if (terminal) { download.disabled = !loaded; }
}
open.onclick = () => { dialog.showModal(); void load(); };
dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } });
download.onclick = async () => {
  if (!loaded || job) return;
  const current = generation;
  const currentWatch = watchId;
  const selectedId = quality.value;
  const withComments = find<HTMLInputElement>('comments').checked;
  const task = { id: crypto.randomUUID(), controller: new AbortController() }; job = task;
  const signal = task.controller.signal;
  open.textContent = 'ダウンロード中 0%';
  shadow.querySelector('progress')!.value = 0;
  download.disabled = true; choices.hidden = true; working.hidden = false; text('保存先を選択…');
  let file: FileSystemWritableFileStream | undefined;
  const update = (phase: Status['phase'], percent: number, error?: string) => {
    if (generation === current) progress({ jobId: task.id, watchId: currentWatch, phase, percent, error });
  };
  try {
    const picker = (window as unknown as { showSaveFilePicker?: (options: object) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
    if (!picker) throw new Error('このブラウザはディスクへ逐次保存する機能に未対応です。最新版のChrome／Operaを使用してください。');
    // Must be invoked synchronously inside the click's user activation.
    const handle = await picker.call(window, { suggestedName: filename(loaded.title), types: [{ description: 'MP4', accept: { 'video/mp4': ['.mp4'] } }] });
    signal.throwIfAborted();
    update('fetch', 0);
    const watch = await getWatch(currentWatch, signal);
    const selected = info(watch).qualities.find(q => q.id === selectedId);
    if (!selected) throw new Error('選択した画質は現在利用できません。');
    const stream = await getStream(watch, selected.id, signal);
    const lists = await playlists(stream, signal);
    const comments = withComments ? await getComments(watch, signal) : undefined;
    signal.throwIfAborted();
    file = await handle.createWritable(); signal.throwIfAborted();
    await runPipeline({ lists, quality: selected, duration: watch.video.duration, comments, file, signal,
      progress: percent => update(comments !== undefined ? 'convert' : 'fetch', percent) });
    update('done', 100);
  } catch (error) {
    await file?.abort().catch(() => {});
    const cancelled = signal.aborted || error instanceof DOMException && error.name === 'AbortError';
    update(cancelled ? 'cancelled' : 'error', 0, cancelled ? undefined : error instanceof Error ? error.message : String(error));
  } finally {
    if (job === task) { job = undefined; open.textContent = 'ダウンロード'; }
    download.disabled = !loaded;
  }
};
find<HTMLButtonElement>('cancel').onclick = () => { job?.controller.abort(); text('キャンセル中…'); };
window.addEventListener('pagehide', () => job?.controller.abort());

function refresh() {
  const id = location.pathname.match(/^\/watch\/((?:sm|so|nm)?\d+)(?:\/|$)/)?.[1] || '';
  if (id !== watchId) {
    job?.controller.abort();
    watchId = id; reset();
  }
  if (!id) { host.remove(); return; }
  const expectedTitle = loaded?.title || document.title.replace(/\s*[-－]\s*ニコニコ動画.*$/, '').trim();
  const title = [...document.querySelectorAll('h1')].find(h => h.textContent?.trim() === expectedTitle);
  if (title && !host.isConnected) { title.insertAdjacentElement('afterend', host); host.style.cssText = 'margin:8px 0;'; }
  else if (!host.isConnected && document.body) { document.body.append(host); host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483646;'; }
  // Move the fallback button once a lazily mounted title arrives.
  if (title && host.previousElementSibling !== title) { title.insertAdjacentElement('afterend', host); host.style.cssText = 'margin:8px 0;'; }
  const dark = /dark/i.test(document.documentElement.dataset.theme || '') || /dark/i.test(document.body?.dataset.theme || '');
  host.toggleAttribute('data-dark', dark);
}
let timer: ReturnType<typeof setTimeout> | undefined;
new MutationObserver(() => { if (timer) return; timer = setTimeout(() => { timer = undefined; refresh(); }, 150); }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-theme'] });
setInterval(refresh, 500);
refresh();

import {
  Input, MP4, MPEG_TS, BufferSource, Output, Mp4OutputFormat, StreamTarget,
  EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource,
  VideoSample, CanvasSource, Quality as EncodingQuality,
  type EncodedPacket,
} from 'mediabunny';
import { SegmentLoader, type Playlist, type Part } from './hls';
import { CommentRenderer } from './comments';
import type { Comment, Quality } from './types';

export interface PipelineOptions {
  lists: Playlist[]; quality: Quality; duration: number; comments?: Comment[];
  file: FileSystemWritableFileStream; signal: AbortSignal;
  progress: (percent: number) => void;
  trace?: (event: string, value: number) => void;
}
/** One media segment per track stays live. All iterators and decoders are explicitly disposed. */
class SegmentReader {
  private init?: { part: Part; input: Input };
  private first?: Input;
  private current?: Input;
  config!: VideoDecoderConfig | AudioDecoderConfig;
  firstTimestamp = 0;
  frameRate = 30;
  codec!: 'avc' | 'aac';
  constructor(private list: Playlist, private kind: 'video' | 'audio', private loader: SegmentLoader, private signal: AbortSignal, private trace?: PipelineOptions['trace']) {}
  private async open(index: number) {
    this.trace?.(this.kind + '-open', index);
    this.signal.throwIfAborted();
    const part = this.list.parts[index];
    if (part.init && this.init?.part !== part.init) {
      this.init?.input.dispose();
      this.init = { part: part.init, input: new Input({ formats: [MP4], source: new BufferSource(await this.loader.read(part.init)) }) };
    }
    const input = new Input({ formats: [MP4, MPEG_TS], source: new BufferSource(await this.loader.read(part)), initInput: this.init?.input });
    this.trace?.(this.kind + '-loaded', index);
    this.current = input;
    try {
      const track = this.kind === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
      this.trace?.(this.kind + '-track', index);
      if (!track || track.codec !== (this.kind === 'video' ? 'avc' : 'aac')) throw new Error('H.264映像とAAC音声以外の配信は未対応です。');
      const config = await track.getDecoderConfig();
      this.trace?.(this.kind + '-config', index);
      if (!config) throw new Error('映像・音声の初期化情報がありません。');
      if (index === 0) {
        this.config = config; this.codec = track.codec;
        this.firstTimestamp = await track.getFirstTimestamp();
        if (this.kind === 'video') {
          // Open-GOP streams may contain leading pictures before the first key
          // picture. Match the first presentable packet of the copied MP4.
          const firstPacket = await new EncodedPacketSink(track).getFirstPacket({ metadataOnly: true });
          if (firstPacket) this.firstTimestamp = Math.max(this.firstTimestamp, firstPacket.timestamp);
          const stats = await track.computePacketStats(120);
          if (Number.isFinite(stats.averagePacketRate) && stats.averagePacketRate > 0) this.frameRate = stats.averagePacketRate;
        }
      } else if (config.codec !== this.config.codec) throw new Error('途中でコーデックが変わる配信は未対応です。');
      return { input, track };
    } catch (e) { input.dispose(); throw e; }
  }
  async prepare() {
    const { input } = await this.open(0); this.first = input;
  }
  private async nextInput(index: number) {
    if (index === 0 && this.first) {
      const input = this.first; this.first = undefined;
      const track = this.kind === 'video' ? (await input.getPrimaryVideoTrack())! : (await input.getPrimaryAudioTrack())!;
      return { input, track };
    }
    return this.open(index);
  }
  async *packets(): AsyncGenerator<EncodedPacket> {
    for (let i = 0; i < this.list.parts.length; i++) {
      const { input, track } = await this.nextInput(i);
      try {
        for await (const packet of new EncodedPacketSink(track).packets()) {
          this.signal.throwIfAborted(); yield packet;
        }
      } finally { input.dispose(); if (this.current === input) this.current = undefined; }
    }
  }
  async *samples(): AsyncGenerator<VideoSample> {
    // Keep one decoder across HLS boundaries, preserving reference pictures and
    // avoiding repeated browser codec initialization. Both queues are bounded.
    const config = { ...this.config as VideoDecoderConfig, hardwareAcceleration: 'prefer-software' as const };
    if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error('このブラウザでは配信映像をデコードできません。');
    const frames: VideoFrame[] = [];
    const waiters = new Set<() => void>();
    const wake = () => { for (const resolve of waiters) resolve(); waiters.clear(); };
    const wait = () => new Promise<void>(resolve => waiters.add(resolve));
    let stopped = false, done = false, failure: unknown;
    const decoder = new VideoDecoder({
      output(frame) { if (stopped) frame.close(); else frames.push(frame); wake(); },
      error(error) { failure = error; wake(); },
    });
    decoder.addEventListener('dequeue', wake);
    const abort = () => { failure = this.signal.reason; stopped = true; if (decoder.state !== 'closed') decoder.close(); wake(); };
    this.signal.addEventListener('abort', abort, { once: true });
    try { decoder.configure(config); }
    catch (error) {
      this.signal.removeEventListener('abort', abort);
      if (decoder.state !== 'closed') decoder.close();
      throw error;
    }
    const produce = (async () => {
      try {
        for await (const packet of this.packets()) {
          while (!stopped && !failure && (frames.length >= 8 || decoder.decodeQueueSize >= 8)) await wait();
          if (stopped || failure) break;
          decoder.decode(packet.toEncodedVideoChunk());
        }
        if (!stopped && !failure) await decoder.flush();
      } catch (error) { if (!stopped) failure = error; }
      finally { done = true; wake(); }
    })();
    try {
      while (true) {
        this.signal.throwIfAborted();
        if (failure) throw failure;
        if (!frames.length) { if (done) break; await wait(); continue; }
        const frame = frames.shift()!; wake();
        const sample = new VideoSample(frame);
        try {
          if (sample.timestamp + 1e-6 >= this.firstTimestamp) yield sample;
        } finally { sample.close(); }
      }
    } finally {
      stopped = true; wake();
      this.signal.removeEventListener('abort', abort);
      if (decoder.state !== 'closed') decoder.close();
      for (const frame of frames) frame.close();
      await produce;
    }
  }
  dispose() { this.current?.dispose(); this.first?.dispose(); this.init?.input.dispose(); this.current = this.first = undefined; this.init = undefined; }
}

/** MP4 output never uses a BufferTarget or a Blob: only ~1MiB disk-write chunks. */
export async function runPipeline(options: PipelineOptions): Promise<void> {
  const { lists, file, signal, quality, duration, progress } = options;
  if (lists.length !== 2) throw new Error('映像・音声が分離されたDOMAND配信のみ対応しています。');
  const loader = new SegmentLoader(signal);
  const video = new SegmentReader(lists[0], 'video', loader, signal, options.trace);
  const audio = new SegmentReader(lists[1], 'audio', loader, signal, options.trace);
  let output: Output | undefined;
  let face: FontFace | undefined;
  let vi: AsyncGenerator<EncodedPacket | VideoSample> | undefined, ai: AsyncGenerator<EncodedPacket> | undefined;
  let committed = false;
  let cancelling: Promise<void> | undefined;
  const cancelOutput = () => cancelling ??= output?.cancel().catch(() => {}) || Promise.resolve();
  const abort = () => { video.dispose(); audio.dispose(); void cancelOutput(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const prepared = await Promise.allSettled([video.prepare(), audio.prepare()]);
    signal.throwIfAborted();
    for (const result of prepared) if (result.status === 'rejected') throw result.reason;
    const origin = Math.min(video.firstTimestamp, audio.firstTimestamp);
    const writable = new WritableStream({
      async write(chunk: { position: number; data: Uint8Array }) {
        signal.throwIfAborted();
        options.trace?.('write-start', chunk.data.length);
        await file.write({ type: 'write', position: chunk.position, data: chunk.data as Uint8Array<ArrayBuffer> });
        options.trace?.('write-end', chunk.data.length);
      },
      // The real file is committed only after successful finalize, never on cancel.
      close() {},
    }, { highWaterMark: 1 });
    // Write media immediately, then the sample index at the end. This avoids
    // in-memory fast-start and fragmented-MP4 B-frame timestamp differences.
    // Only sample-index metadata grows with duration, never the media payload.
    output = new Output({ format: new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(writable, { chunked: true, chunkSize: 1024 * 1024 }) });
    const audioSource = new EncodedAudioPacketSource('aac');
    output.addAudioTrack(audioSource);
    let videoSource: CanvasSource | EncodedVideoPacketSource;
    let ctx: OffscreenCanvasRenderingContext2D | undefined, renderer: CommentRenderer | undefined;
    if (options.comments !== undefined) {
      if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') throw new Error('このブラウザはコメント付き保存に必要なWebCodecsに対応していません。');
      const canvas = new OffscreenCanvas(quality.width, quality.height);
      ctx = canvas.getContext('2d', { alpha: false })!;
      if (!ctx) throw new Error('コメント合成用Canvasを作成できません。');
      const font = await (await fetch(chrome.runtime.getURL('fonts/NotoSansCJKjp-Bold.otf'), { signal })).arrayBuffer();
      face = new FontFace('NicoDrop', font, { weight: '700' }); await face.load(); document.fonts.add(face);
      renderer = new CommentRenderer(ctx, options.comments, quality.width, quality.height, duration);
      videoSource = new CanvasSource(canvas, { codec: 'avc', quality: new EncodingQuality({ bitrate: Math.round(Math.max(quality.bitRate * 1.5, quality.width * quality.height * video.frameRate * 0.25)) }), alpha: 'discard', hardwareAcceleration: 'prefer-software' });
      vi = video.samples();
    } else { videoSource = new EncodedVideoPacketSource('avc'); vi = video.packets(); }
    output.addVideoTrack(videoSource);
    ai = audio.packets();
    await output.start();
    let [v, a] = await Promise.all([vi.next(), ai.next()]);
    let maxTime = 0, lastPercent = -1;
    while (!v.done || !a.done) {
      signal.throwIfAborted();
      // Each track remains in decode order. Interleaving limits fragment buffering.
      if (!v.done && (a.done || v.value.timestamp <= a.value.timestamp)) {
        const value = v.value;
        const timestamp = value.timestamp - origin;
        if (videoSource instanceof CanvasSource) {
          const sample = value as VideoSample;
          sample.draw(ctx!, 0, 0, quality.width, quality.height);
          renderer!.draw(timestamp, quality.width, quality.height);
          options.trace?.('encode-start', timestamp);
          await videoSource.add(timestamp, sample.duration);
          options.trace?.('encode-end', timestamp);
        } else {
          const packet = value as EncodedPacket;
          await videoSource.add(packet.clone({ timestamp }), { decoderConfig: video.config as VideoDecoderConfig });
        }
        maxTime = Math.max(maxTime, timestamp + value.duration);
        v = await vi.next();
        if (v.done) videoSource.close();
      } else if (!a.done) {
        const packet = a.value;
        await audioSource.add(packet.clone({ timestamp: packet.timestamp - origin }), { decoderConfig: audio.config as AudioDecoderConfig });
        a = await ai.next();
        if (a.done) audioSource.close();
      }
      const percent = Math.min(98, Math.floor(maxTime / duration * 98));
      if (percent !== lastPercent) { progress(percent); lastPercent = percent; }
    }
    signal.throwIfAborted(); await output.finalize(); signal.throwIfAborted();
    await file.close(); committed = true; progress(100);
  } finally {
    signal.removeEventListener('abort', abort);
    if (!committed) { await cancelOutput(); await file.abort().catch(() => {}); }
    await Promise.allSettled([vi?.return(undefined), ai?.return(undefined)]);
    video.dispose(); audio.dispose(); if (face) document.fonts.delete(face);
  }
}

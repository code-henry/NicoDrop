export interface Quality {
  id: string; label: string; width: number; height: number; bitRate: number; qualityLevel: number;
}
export interface Comment {
  id?: string; no?: number; body: string; vposMs: number; commands: string[];
  isDeleted?: boolean; score?: number; fork?: string;
}
export interface Watch {
  video: { id: string; title: string; duration: number };
  client: { watchTrackId: string };
  media: { domand?: {
    accessRightKey: string;
    videos: (Quality & { isAvailable: boolean })[];
    audios: { id: string; isAvailable: boolean; bitRate: number; qualityLevel: number }[];
  }; delivery?: unknown };
  comment: { nvComment?: { server: string; threadKey: string; params: { targets: { id: string; fork: string }[]; language: string } } };
}
export interface VideoInfo { id: string; title: string; duration: number; qualities: Quality[] }
export type Phase = 'fetch' | 'convert' | 'save' | 'done' | 'cancelled' | 'error';
export interface Status { jobId: string; watchId: string; phase: Phase; percent: number; error?: string }
export const isWatchId = (id: unknown): id is string => typeof id === 'string' && /^(?:sm|so|nm)?\d+$/.test(id);
export function filename(title: string): string {
  const base = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 150) || '動画';
  return (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) ? `_${base}` : base) + '.mp4';
}

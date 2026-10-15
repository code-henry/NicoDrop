import type { Comment } from './types';

const colors: Record<string, string> = {
  white: 'FFFFFF', red: 'FF0000', pink: 'FF8080', orange: 'FFC000', yellow: 'FFFF00', green: '00FF00', cyan: '00FFFF', blue: '0000FF', purple: 'C000FF', black: '000000',
  white2: 'CCCC99', red2: 'CC0033', pink2: 'FF33CC', orange2: 'FF6600', yellow2: '999900', green2: '00CC66', cyan2: '00CCCC', blue2: '3399FF', purple2: '6633CC', black2: '666666',
  niconicowhite: 'CCCC99', truered: 'CC0033', passionorange: 'FF6600', madyellow: '999900', elementalgreen: '00CC66', marineblue: '3399FF', nobleviolet: '6633CC'
};
export interface Style { position: 'flow' | 'top' | 'bottom'; size: number; color: string; font: string }
export function style(commands: string[]): Style {
  const value: Style = { position: 'flow', size: 24, color: 'FFFFFF', font: 'Noto Sans CJK JP' };
  for (const raw of commands || []) {
    const command = raw.toLowerCase();
    if (command === 'ue') value.position = 'top';
    if (command === 'shita') value.position = 'bottom';
    if (command === 'naka') value.position = 'flow';
    if (command === 'big') value.size = 39;
    if (command === 'small') value.size = 15;
    if (command === 'medium') value.size = 24;
    if (colors[command]) value.color = colors[command];
    if (/^#[\da-f]{6}$/i.test(command)) value.color = command.slice(1).toUpperCase();
  }
  return value;
}
export interface Placed { start: number; end: number; y: number; height: number; width: number; speed: number; position: Style['position']; size: number; color: string; lines: string[] }
// Virtual player coordinates: 16:9 640x360, 4:3 480x360. Scale to source resolution.
export function layoutComments(comments: Comment[], width: number, height: number, duration: number,
  measure: (text: string, size: number) => number): Placed[] {
  const playY = 360, playX = Math.round(360 * width / height);
  let active: Placed[] = [];
  const result: Placed[] = [];
  for (const c of [...comments].sort((a, b) => a.vposMs - b.vposMs)) {
    if (c.isDeleted || !c.body.trim() || (c.fork === 'owner' && /^[@＠]/.test(c.body))) continue;
    const start = Math.max(0, c.vposMs / 1000);
    if (!Number.isFinite(start) || start >= duration) continue;
    const s = style(c.commands);
    const lines = c.body.split(/\r?\n/);
    let size = s.size;
    let textWidth = Math.max(...lines.map(line => measure(line, size)));
    // Fixed comments shrink to fit; multiline comments shrink vertically.
    const shrink = Math.min(1, (playY - 8) / (size * 1.2 * lines.length), s.position !== 'flow' ? (playX - 8) / Math.max(textWidth, 1) : 1);
    size *= shrink; textWidth *= shrink;
    const textHeight = size * 1.2 * lines.length;
    const life = s.position === 'flow' ? 4 : 3;
    const speed = (playX + textWidth) / life;
    active = active.filter(a => a.end > start);
    const candidates: number[] = [];
    for (let y = 4; y + textHeight <= playY - 4; y += Math.max(2, size * 1.2)) candidates.push(y);
    if (s.position === 'bottom') candidates.reverse();
    const collides = (y: number, a: Placed) => {
      if (a.position !== s.position || y >= a.y + a.height || y + textHeight <= a.y) return false;
      if (s.position !== 'flow') return true;
      const priorRight = playX - a.speed * (start - a.start) + a.width;
      if (priorRight >= playX - 4) return true;
      // Faster followers must not catch the previous comment before it leaves the screen.
      return speed > a.speed && (playX - priorRight) / (speed - a.speed) < a.end - start;
    };
    const y = candidates.find(y => !active.some(a => collides(y, a)));
    // Like a player with a finite number of lanes, omit overflow rather than stack unreadable text.
    if (y === undefined) continue;
    const placed: Placed = { start, end: start + life, y, height: textHeight, width: textWidth, speed, position: s.position, size, color: s.color, lines };
    active.push(placed); result.push(placed);
  }
  return result;
}
/** Precompute layout and draw the comments active at the current frame. */
export class CommentRenderer {
  private readonly placed: Placed[];
  private next = 0;
  private active: Placed[] = [];
  private lastTime = -Infinity;
  private readonly playX: number;
  constructor(private readonly ctx: OffscreenCanvasRenderingContext2D, comments: Comment[], width: number, height: number, duration: number) {
    this.playX = Math.round(360 * width / height);
    this.placed = layoutComments(comments, width, height, duration, (text, size) => {
      ctx.font = `700 ${size}px NicoDrop`; return ctx.measureText(text).width;
    });
  }
  draw(time: number, width: number, height: number) {
    if (time < this.lastTime) { this.next = 0; this.active = []; }
    this.lastTime = time;
    this.active = this.active.filter(c => c.end > time);
    while (this.next < this.placed.length && this.placed[this.next].start <= time) {
      const c = this.placed[this.next++]; if (c.end > time) this.active.push(c);
    }
    const ctx = this.ctx;
    ctx.save(); ctx.scale(width / this.playX, height / 360);
    ctx.textBaseline = 'top'; ctx.lineJoin = 'round'; ctx.lineWidth = 2;
    ctx.strokeStyle = '#000a';
    for (const c of this.active) {
      ctx.font = `700 ${c.size}px NicoDrop`; ctx.fillStyle = '#' + c.color;
      ctx.textAlign = c.position === 'flow' ? 'left' : 'center';
      const x = c.position === 'flow' ? this.playX - c.speed * (time - c.start) : this.playX / 2;
      c.lines.forEach((line, i) => {
        const y = c.y + i * c.size * 1.2;
        ctx.strokeText(line, x, y); ctx.fillText(line, x, y);
      });
    }
    ctx.restore();
  }
}

// Outline editor: shows a photo with a four-cornered outline whose corners can be dragged onto the
// book's real corners (mouse or touch). The result is used to straighten the book (see detect.js).

import { isConvexQuad } from './detect.js';

const MARGIN = 20; // css px of room around the picture so edge handles stay reachable
const HANDLE_RADIUS = 11;
const GRAB_RADIUS = 34; // how close a press must be to a corner to pick it up

export const defaultOutline = (width, height) => {
  const h = height * 0.72;
  const w = Math.min(width * 0.9, h * (2 / 3));
  const x = (width - w) / 2;
  const y = (height - h) / 2;
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
};

export class OutlineEditor {
  /** @param {HTMLCanvasElement} canvas  @param {{onChange?: () => void}} [handlers] */
  constructor(canvas, { onChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange;
    this.src = null;
    this.points = [];
    this.active = -1;
    this.cssW = 0;
    this.cssH = 0;
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;

    canvas.addEventListener('pointerdown', (e) => this.#down(e));
    canvas.addEventListener('pointermove', (e) => this.#move(e));
    for (const type of ['pointerup', 'pointercancel']) canvas.addEventListener(type, () => (this.active = -1));
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.resize()).observe(canvas);
  }

  /** Corners as [tl, tr, br, bl] in the source picture's pixels. */
  get corners() {
    return this.points.map((p) => ({ ...p }));
  }

  get valid() {
    return this.src ? isConvexQuad(this.points, this.src.width * this.src.height) : false;
  }

  setSource(src, corners) {
    this.src = src;
    this.points = (corners || defaultOutline(src.width, src.height)).map((p) => ({ ...p }));
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || !this.src) return;
    const dpr = window.devicePixelRatio || 1;
    this.cssW = rect.width;
    this.cssH = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.scale = Math.min((this.cssW - 2 * MARGIN) / this.src.width, (this.cssH - 2 * MARGIN) / this.src.height);
    this.ox = (this.cssW - this.src.width * this.scale) / 2;
    this.oy = (this.cssH - this.src.height * this.scale) / 2;
    this.draw();
  }

  #toScreen(p) {
    return { x: this.ox + p.x * this.scale, y: this.oy + p.y * this.scale };
  }

  #fromScreen(x, y) {
    return { x: (x - this.ox) / this.scale, y: (y - this.oy) / this.scale };
  }

  draw() {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.fillStyle = '#0d0c0a';
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    if (!this.src) return;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.src, this.ox, this.oy, this.src.width * this.scale, this.src.height * this.scale);

    const pts = this.points.map((p) => this.#toScreen(p));
    // dim everything outside the outline
    ctx.fillStyle = 'rgb(0 0 0 / 0.45)';
    ctx.beginPath();
    ctx.rect(0, 0, this.cssW, this.cssH);
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill('evenodd');

    const ok = this.valid;
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = ok ? '#3ddc84' : '#ff6b5e';
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();

    for (const [i, p] of pts.entries()) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = i === this.active ? '#ffffff' : 'rgb(255 255 255 / 0.85)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = ok ? '#3ddc84' : '#ff6b5e';
      ctx.stroke();
    }
  }

  #pointer(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  #down(e) {
    if (!this.src) return;
    const { x, y } = this.#pointer(e);
    let best = -1;
    let bestDist = GRAB_RADIUS;
    this.points.forEach((p, i) => {
      const s = this.#toScreen(p);
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestDist) {
        best = i;
        bestDist = d;
      }
    });
    this.active = best;
    if (best >= 0) {
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        /* capture is optional */
      }
      this.#move(e);
    }
  }

  #move(e) {
    if (this.active < 0 || !this.src) return;
    const { x, y } = this.#pointer(e);
    const p = this.#fromScreen(x, y);
    this.points[this.active] = {
      x: Math.min(this.src.width, Math.max(0, p.x)),
      y: Math.min(this.src.height, Math.max(0, p.y)),
    };
    this.draw();
    this.onChange?.();
  }
}

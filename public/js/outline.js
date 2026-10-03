// Outline editor: shows a photo with a four-cornered outline whose corners can be dragged onto the
// book's real corners (mouse or touch). The result is used to straighten the book (see detect.js).

import { isConvexQuad } from './detect.js';

const MARGIN = 20; // css px of room around the picture so edge handles stay reachable
const HANDLE_RADIUS = 11;
const GRAB_RADIUS = 34; // how close a press must be to a corner to pick it up

export const defaultOutline = (width, height) => {
  const rectHeight = height * 0.72;
  const rectWidth = Math.min(width * 0.9, rectHeight * (2 / 3));
  const x = (width - rectWidth) / 2;
  const y = (height - rectHeight) / 2;
  return [
    { x, y },
    { x: x + rectWidth, y },
    { x: x + rectWidth, y: y + rectHeight },
    { x, y: y + rectHeight },
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

    canvas.addEventListener('pointerdown', (event) => this.#down(event));
    canvas.addEventListener('pointermove', (event) => this.#move(event));
    for (const type of ['pointerup', 'pointercancel']) canvas.addEventListener(type, () => (this.active = -1));
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.resize()).observe(canvas);
  }

  /** Corners as [tl, tr, br, bl] in the source picture's pixels. */
  get corners() {
    return this.points.map((point) => ({ ...point }));
  }

  get valid() {
    return this.src ? isConvexQuad(this.points, this.src.width * this.src.height) : false;
  }

  setSource(source, corners) {
    this.src = source;
    this.points = (corners || defaultOutline(source.width, source.height)).map((point) => ({ ...point }));
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || !this.src) return;
    const pixelRatio = window.devicePixelRatio || 1;
    this.cssW = rect.width;
    this.cssH = rect.height;
    this.canvas.width = Math.round(rect.width * pixelRatio);
    this.canvas.height = Math.round(rect.height * pixelRatio);
    this.ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    this.scale = Math.min((this.cssW - 2 * MARGIN) / this.src.width, (this.cssH - 2 * MARGIN) / this.src.height);
    this.ox = (this.cssW - this.src.width * this.scale) / 2;
    this.oy = (this.cssH - this.src.height * this.scale) / 2;
    this.draw();
  }

  #toScreen(point) {
    return { x: this.ox + point.x * this.scale, y: this.oy + point.y * this.scale };
  }

  #fromScreen(x, y) {
    return { x: (x - this.ox) / this.scale, y: (y - this.oy) / this.scale };
  }

  draw() {
    const { ctx: context } = this;
    context.clearRect(0, 0, this.cssW, this.cssH);
    context.fillStyle = '#0d0c0a';
    context.fillRect(0, 0, this.cssW, this.cssH);
    if (!this.src) return;
    context.imageSmoothingQuality = 'high';
    context.drawImage(this.src, this.ox, this.oy, this.src.width * this.scale, this.src.height * this.scale);

    const points = this.points.map((point) => this.#toScreen(point));
    // dim everything outside the outline
    context.fillStyle = 'rgb(0 0 0 / 0.45)';
    context.beginPath();
    context.rect(0, 0, this.cssW, this.cssH);
    points.forEach((point, pointIndex) => (pointIndex ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)));
    context.closePath();
    context.fill('evenodd');

    const isValid = this.valid;
    context.lineWidth = 2.5;
    context.strokeStyle = isValid ? '#3ddc84' : '#ff6b5e';
    context.beginPath();
    points.forEach((point, pointIndex) => (pointIndex ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)));
    context.closePath();
    context.stroke();

    for (const [pointIndex, point] of points.entries()) {
      context.beginPath();
      context.arc(point.x, point.y, HANDLE_RADIUS, 0, Math.PI * 2);
      context.fillStyle = pointIndex === this.active ? '#ffffff' : 'rgb(255 255 255 / 0.85)';
      context.fill();
      context.lineWidth = 3;
      context.strokeStyle = isValid ? '#3ddc84' : '#ff6b5e';
      context.stroke();
    }
  }

  #pointer(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  #down(event) {
    if (!this.src) return;
    const { x, y } = this.#pointer(event);
    let best = -1;
    let bestDist = GRAB_RADIUS;
    this.points.forEach((point, pointIndex) => {
      const screenPoint = this.#toScreen(point);
      const distance = Math.hypot(screenPoint.x - x, screenPoint.y - y);
      if (distance < bestDist) {
        best = pointIndex;
        bestDist = distance;
      }
    });
    this.active = best;
    if (best >= 0) {
      try {
        this.canvas.setPointerCapture(event.pointerId);
      } catch {
        /* capture is optional */
      }
      this.#move(event);
    }
  }

  #move(event) {
    if (this.active < 0 || !this.src) return;
    const { x, y } = this.#pointer(event);
    const point = this.#fromScreen(x, y);
    this.points[this.active] = {
      x: Math.min(this.src.width, Math.max(0, point.x)),
      y: Math.min(this.src.height, Math.max(0, point.y)),
    };
    this.draw();
    this.onChange?.();
  }
}

// A small cover cropper. A fixed book-shaped (2:3) frame sits over the image; the user
// drags the image and zooms until the frame lines up with the cover's edges.
// Works with mouse, touch (drag + pinch), wheel, keyboard and a zoom slider.

export const COVER_RATIO = 2 / 3; // width / height
export const MAX_ZOOM = 6;
const OUTPUT_WIDTH = 400; // saved covers are at most 400 x 600
const MAX_SOURCE_DIM = 2400; // big phone photos are shrunk on load to stay fast
const MAX_DATA_URL_CHARS = 330_000; // stay well inside the server's limit
const FRAME_MARGIN = 14;

/** Turn a File/Blob into a canvas (EXIF rotation applied, shrunk to MAX_SOURCE_DIM). */
export async function loadImageSource(blob) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('That file could not be read as an image.'));
      };
      img.src = url;
    });
  }
  const w = bitmap.width || bitmap.naturalWidth;
  const h = bitmap.height || bitmap.naturalHeight;
  if (!w || !h) throw new Error('That file could not be read as an image.');
  return drawToCanvas(bitmap, w, h);
}

/** Copy any drawable (video, bitmap, image, canvas) into a new canvas, shrinking if huge. */
export function drawToCanvas(source, w, h) {
  const scale = Math.min(1, MAX_SOURCE_DIM / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export class Cropper {
  /**
   * @param {HTMLCanvasElement} canvas  the visible stage
   * @param {{onZoom?: (zoom: number) => void}} [handlers]
   */
  constructor(canvas, { onZoom } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onZoom = onZoom;
    this.src = null;
    this.zoom = 1;
    this.cx = 0; // image point (in source pixels) shown at the centre of the frame
    this.cy = 0;
    this.pointers = new Map();
    this.pinchDistance = 0;
    this.frame = { x: 0, y: 0, w: 0, h: 0 };
    this.cssW = 0;
    this.cssH = 0;

    canvas.addEventListener('pointerdown', (e) => this.#down(e));
    canvas.addEventListener('pointermove', (e) => this.#move(e));
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      canvas.addEventListener(type, (e) => this.#up(e));
    }
    canvas.addEventListener('wheel', (e) => this.#wheel(e), { passive: false });
    canvas.addEventListener('keydown', (e) => this.#key(e));
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.resize()).observe(canvas);
  }

  get hasImage() {
    return Boolean(this.src);
  }

  get #minScale() {
    return Math.max(this.frame.w / this.src.width, this.frame.h / this.src.height);
  }

  /** Pixels on screen per source pixel. */
  get scale() {
    return this.#minScale * this.zoom;
  }

  /** Match the canvas bitmap to its on-screen size and lay out the frame. */
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    this.cssW = rect.width;
    this.cssH = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let h = this.cssH - FRAME_MARGIN * 2;
    let w = h * COVER_RATIO;
    if (w > this.cssW - FRAME_MARGIN * 2) {
      w = this.cssW - FRAME_MARGIN * 2;
      h = w / COVER_RATIO;
    }
    this.frame = { x: (this.cssW - w) / 2, y: (this.cssH - h) / 2, w, h };
    if (this.src) {
      this.#clamp();
      this.draw();
    }
  }

  /** @param {CanvasImageSource & {width: number, height: number}} source */
  setSource(source) {
    this.src = source;
    this.zoom = 1;
    this.cx = source.width / 2;
    this.cy = source.height / 2;
    this.resize();
    this.onZoom?.(this.zoom);
    this.draw();
  }

  /** Rotate the picture a quarter turn clockwise (for photos taken sideways). */
  rotate() {
    if (!this.src) return;
    const { width: w, height: h } = this.src;
    const out = document.createElement('canvas');
    out.width = h;
    out.height = w;
    const ctx = out.getContext('2d');
    ctx.translate(h, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(this.src, 0, 0);
    this.setSource(out);
  }

  setZoom(zoom) {
    if (!this.src) return;
    this.zoom = Math.min(MAX_ZOOM, Math.max(1, zoom));
    this.#clamp();
    this.draw();
    this.onZoom?.(this.zoom);
  }

  panBy(dxCss, dyCss) {
    if (!this.src) return;
    this.cx -= dxCss / this.scale;
    this.cy -= dyCss / this.scale;
    this.#clamp();
    this.draw();
  }

  /** Keep the frame inside the picture. */
  #clamp() {
    const s = this.scale;
    const halfW = this.frame.w / (2 * s);
    const halfH = this.frame.h / (2 * s);
    this.cx = Math.min(this.src.width - halfW, Math.max(halfW, this.cx));
    this.cy = Math.min(this.src.height - halfH, Math.max(halfH, this.cy));
  }

  draw() {
    const { ctx, frame: f } = this;
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.fillStyle = '#0d0c0a';
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    if (!this.src) return;

    const s = this.scale;
    const dx = f.x + f.w / 2 - this.cx * s;
    const dy = f.y + f.h / 2 - this.cy * s;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.src, dx, dy, this.src.width * s, this.src.height * s);

    // Dim everything outside the frame.
    ctx.fillStyle = 'rgb(0 0 0 / 0.58)';
    ctx.beginPath();
    ctx.rect(0, 0, this.cssW, this.cssH);
    ctx.rect(f.x, f.y, f.w, f.h);
    ctx.fill('evenodd');

    // Frame and thirds guide.
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(f.x, f.y, f.w, f.h);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgb(255 255 255 / 0.28)';
    ctx.beginPath();
    for (const t of [1 / 3, 2 / 3]) {
      ctx.moveTo(f.x + f.w * t, f.y);
      ctx.lineTo(f.x + f.w * t, f.y + f.h);
      ctx.moveTo(f.x, f.y + f.h * t);
      ctx.lineTo(f.x + f.w, f.y + f.h * t);
    }
    ctx.stroke();
  }

  /** Render what is inside the frame as a JPEG data URL (at most 400 x 600). */
  toDataUrl() {
    if (!this.src) throw new Error('No image to crop.');
    const s = this.scale;
    const sw = this.frame.w / s;
    const sh = this.frame.h / s;
    const sx = this.cx - sw / 2;
    const sy = this.cy - sh / 2;
    const outW = Math.max(1, Math.min(OUTPUT_WIDTH, Math.floor(sw)));
    const outH = Math.round(outW / COVER_RATIO);
    const out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outW, outH);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.src, sx, sy, sw, sh, 0, 0, outW, outH);
    let url = '';
    for (const quality of [0.86, 0.75, 0.62, 0.5]) {
      url = out.toDataURL('image/jpeg', quality);
      if (url.length <= MAX_DATA_URL_CHARS) break;
    }
    return url;
  }

  // -- input ---------------------------------------------------------------
  #down(e) {
    if (!this.src) return;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* capture is only a nicety (keeps dragging when the pointer leaves the canvas) */
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.pinchDistance = this.#pinchDistance();
  }

  #move(e) {
    const prev = this.pointers.get(e.pointerId);
    if (!prev || !this.src) return;
    const now = { x: e.clientX, y: e.clientY };
    this.pointers.set(e.pointerId, now);
    if (this.pointers.size === 1) {
      this.panBy(now.x - prev.x, now.y - prev.y);
    } else if (this.pointers.size === 2) {
      const distance = this.#pinchDistance();
      if (this.pinchDistance > 0 && distance > 0) this.setZoom(this.zoom * (distance / this.pinchDistance));
      this.pinchDistance = distance;
    }
  }

  #up(e) {
    this.pointers.delete(e.pointerId);
    this.pinchDistance = this.#pinchDistance();
  }

  #pinchDistance() {
    if (this.pointers.size < 2) return 0;
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  #wheel(e) {
    if (!this.src) return;
    e.preventDefault();
    this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.0015));
  }

  #key(e) {
    const step = e.shiftKey ? 40 : 12;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      e.preventDefault();
      this.panBy(...moves[e.key]);
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      this.setZoom(this.zoom * 1.1);
    } else if (e.key === '-') {
      e.preventDefault();
      this.setZoom(this.zoom / 1.1);
    }
  }
}

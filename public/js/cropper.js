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
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('That file could not be read as an image.'));
      };
      image.src = url;
    });
  }
  const width = bitmap.width || bitmap.naturalWidth;
  const height = bitmap.height || bitmap.naturalHeight;
  if (!width || !height) throw new Error('That file could not be read as an image.');
  return drawToCanvas(bitmap, width, height);
}

/** Copy any drawable (video, bitmap, image, canvas) into a new canvas, shrinking if huge. */
export function drawToCanvas(source, width, height) {
  const scale = Math.min(1, MAX_SOURCE_DIM / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
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

    canvas.addEventListener('pointerdown', (event) => this.#down(event));
    canvas.addEventListener('pointermove', (event) => this.#move(event));
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      canvas.addEventListener(type, (event) => this.#up(event));
    }
    canvas.addEventListener('wheel', (event) => this.#wheel(event), { passive: false });
    canvas.addEventListener('keydown', (event) => this.#key(event));
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
    const pixelRatio = window.devicePixelRatio || 1;
    this.cssW = rect.width;
    this.cssH = rect.height;
    this.canvas.width = Math.round(rect.width * pixelRatio);
    this.canvas.height = Math.round(rect.height * pixelRatio);
    this.ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    let frameHeight = this.cssH - FRAME_MARGIN * 2;
    let frameWidth = frameHeight * COVER_RATIO;
    if (frameWidth > this.cssW - FRAME_MARGIN * 2) {
      frameWidth = this.cssW - FRAME_MARGIN * 2;
      frameHeight = frameWidth / COVER_RATIO;
    }
    this.frame = { x: (this.cssW - frameWidth) / 2, y: (this.cssH - frameHeight) / 2, w: frameWidth, h: frameHeight };
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
    const { width: imageWidth, height: imageHeight } = this.src;
    const out = document.createElement('canvas');
    out.width = imageHeight;
    out.height = imageWidth;
    const context = out.getContext('2d');
    context.translate(imageHeight, 0);
    context.rotate(Math.PI / 2);
    context.drawImage(this.src, 0, 0);
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
    const scale = this.scale;
    const halfW = this.frame.w / (2 * scale);
    const halfH = this.frame.h / (2 * scale);
    this.cx = Math.min(this.src.width - halfW, Math.max(halfW, this.cx));
    this.cy = Math.min(this.src.height - halfH, Math.max(halfH, this.cy));
  }

  draw() {
    const { ctx: context, frame: frameRect } = this;
    context.clearRect(0, 0, this.cssW, this.cssH);
    context.fillStyle = '#0d0c0a';
    context.fillRect(0, 0, this.cssW, this.cssH);
    if (!this.src) return;

    const scale = this.scale;
    const destX = frameRect.x + frameRect.w / 2 - this.cx * scale;
    const destY = frameRect.y + frameRect.h / 2 - this.cy * scale;
    context.imageSmoothingQuality = 'high';
    context.drawImage(this.src, destX, destY, this.src.width * scale, this.src.height * scale);

    // Dim everything outside the frame.
    context.fillStyle = 'rgb(0 0 0 / 0.58)';
    context.beginPath();
    context.rect(0, 0, this.cssW, this.cssH);
    context.rect(frameRect.x, frameRect.y, frameRect.w, frameRect.h);
    context.fill('evenodd');

    // Frame and thirds guide.
    context.lineWidth = 2;
    context.strokeStyle = '#ffffff';
    context.strokeRect(frameRect.x, frameRect.y, frameRect.w, frameRect.h);
    context.lineWidth = 1;
    context.strokeStyle = 'rgb(255 255 255 / 0.28)';
    context.beginPath();
    for (const fraction of [1 / 3, 2 / 3]) {
      context.moveTo(frameRect.x + frameRect.w * fraction, frameRect.y);
      context.lineTo(frameRect.x + frameRect.w * fraction, frameRect.y + frameRect.h);
      context.moveTo(frameRect.x, frameRect.y + frameRect.h * fraction);
      context.lineTo(frameRect.x + frameRect.w, frameRect.y + frameRect.h * fraction);
    }
    context.stroke();
  }

  /** Render what is inside the frame as a JPEG data URL (at most 400 x 600). */
  toDataUrl() {
    if (!this.src) throw new Error('No image to crop.');
    const scale = this.scale;
    const sourceWidth = this.frame.w / scale;
    const sourceHeight = this.frame.h / scale;
    const sourceLeft = this.cx - sourceWidth / 2;
    const sourceTop = this.cy - sourceHeight / 2;
    const outputWidth = Math.max(1, Math.min(OUTPUT_WIDTH, Math.floor(sourceWidth)));
    const outputHeight = Math.round(outputWidth / COVER_RATIO);
    const out = document.createElement('canvas');
    out.width = outputWidth;
    out.height = outputHeight;
    const context = out.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, outputWidth, outputHeight);
    context.imageSmoothingQuality = 'high';
    context.drawImage(this.src, sourceLeft, sourceTop, sourceWidth, sourceHeight, 0, 0, outputWidth, outputHeight);
    let url = '';
    for (const quality of [0.86, 0.75, 0.62, 0.5]) {
      url = out.toDataURL('image/jpeg', quality);
      if (url.length <= MAX_DATA_URL_CHARS) break;
    }
    return url;
  }

  // -- input ---------------------------------------------------------------
  #down(event) {
    if (!this.src) return;
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      /* capture is only a nicety (keeps dragging when the pointer leaves the canvas) */
    }
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.pinchDistance = this.#pinchDistance();
  }

  #move(event) {
    const prev = this.pointers.get(event.pointerId);
    if (!prev || !this.src) return;
    const now = { x: event.clientX, y: event.clientY };
    this.pointers.set(event.pointerId, now);
    if (this.pointers.size === 1) {
      this.panBy(now.x - prev.x, now.y - prev.y);
    } else if (this.pointers.size === 2) {
      const distance = this.#pinchDistance();
      if (this.pinchDistance > 0 && distance > 0) this.setZoom(this.zoom * (distance / this.pinchDistance));
      this.pinchDistance = distance;
    }
  }

  #up(event) {
    this.pointers.delete(event.pointerId);
    this.pinchDistance = this.#pinchDistance();
  }

  #pinchDistance() {
    if (this.pointers.size < 2) return 0;
    const [firstPointer, secondPointer] = [...this.pointers.values()];
    return Math.hypot(firstPointer.x - secondPointer.x, firstPointer.y - secondPointer.y);
  }

  #wheel(event) {
    if (!this.src) return;
    event.preventDefault();
    this.setZoom(this.zoom * Math.exp(-event.deltaY * 0.0015));
  }

  #key(event) {
    const step = event.shiftKey ? 40 : 12;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[event.key]) {
      event.preventDefault();
      this.panBy(...moves[event.key]);
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      this.setZoom(this.zoom * 1.1);
    } else if (event.key === '-') {
      event.preventDefault();
      this.setZoom(this.zoom / 1.1);
    }
  }
}

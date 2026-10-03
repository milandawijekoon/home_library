// Camera barcode scanner for ISBN (EAN-13) barcodes.
//
// Uses the browser's built-in BarcodeDetector when it supports EAN-13 (Chrome/Edge on
// Android, macOS, ...) and falls back to ZXing (served locally from /vendor/zxing.min.js)
// everywhere else (Safari, Firefox, ...).
import { isValidIsbn13, normalizeIsbn } from './isbn.js';

const SCAN_INTERVAL_MS = 140;
const MAX_DECODE_WIDTH = 1024;

export class ScannerError extends Error {
  /** code: "unsupported" | "insecure" | "permission" | "no-camera" | "in-use" | "failed" | "cancelled" */
  constructor(message, code) {
    super(message);
    this.name = 'ScannerError';
    this.code = code;
  }
}

export function describeCameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new ScannerError(
        'Camera access was blocked. Allow camera permission for this site in your browser settings, then press "Start camera". You can still type the ISBN below.',
        'permission',
      );
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new ScannerError('No camera was found on this device. You can type the ISBN below instead.', 'no-camera');
    case 'NotReadableError':
    case 'AbortError':
      return new ScannerError(
        'The camera is busy or unavailable. Close other apps or tabs that might be using it and try again.',
        'in-use',
      );
    default:
      return new ScannerError(`Could not start the camera${err?.message ? `: ${err.message}` : '.'}`, 'failed');
  }
}

let zxingPromise = null;
function loadZXing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  zxingPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/zxing.min.js';
    script.onload = () => (window.ZXing ? resolve(window.ZXing) : reject(new Error('ZXing did not load')));
    script.onerror = () => {
      zxingPromise = null;
      reject(new Error('Could not load the barcode scanning library'));
    };
    document.head.append(script);
  });
  return zxingPromise;
}

/** Decode an EAN-13 barcode from a canvas with ZXing. Resolves to the digits, or "" if none found. */
let zxingReader = null;
export async function decodeCanvasWithZXing(canvas) {
  const ZXing = await loadZXing();
  if (!zxingReader) {
    zxingReader = new ZXing.MultiFormatReader();
    zxingReader.setHints(
      new Map([
        [ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13]],
        [ZXing.DecodeHintType.TRY_HARDER, true],
      ]),
    );
  }
  const reader = zxingReader;
  try {
    const source = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
    return reader.decode(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source))).getText();
  } catch {
    return ''; // NotFound / Checksum / Format: just means "no barcode in this frame"
  }
}

export class BarcodeScanner {
  /**
   * @param {HTMLVideoElement} video
   * @param {{onDetect: (isbn: string) => void, onNotIsbn?: (text: string) => void}} handlers
   */
  constructor(video, { onDetect, onNotIsbn }) {
    this.video = video;
    this.onDetect = onDetect;
    this.onNotIsbn = onNotIsbn;
    this.stream = null;
    this.timer = null;
    this.session = 0;
    this.paused = false;
    this.engine = '';
    this.canvas = null;
  }

  get active() {
    return Boolean(this.stream);
  }

  /** Start the camera and begin scanning. Resolves to the engine name. Throws ScannerError. */
  async start() {
    this.stop();
    const session = ++this.session;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw window.isSecureContext
        ? new ScannerError('This browser cannot access a camera. You can type the ISBN below instead.', 'unsupported')
        : new ScannerError(
            'Camera access needs a secure connection. Open the app at http://localhost:3000 or over HTTPS, or type the ISBN below.',
            'insecure',
          );
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
    } catch (err) {
      throw describeCameraError(err);
    }
    if (session !== this.session) {
      stream.getTracks().forEach((track) => track.stop()); // stopped/closed while the permission prompt was open
      throw new ScannerError('Scanner closed.', 'cancelled');
    }

    this.stream = stream;
    this.video.srcObject = stream;
    this.video.muted = true;
    this.video.setAttribute('playsinline', '');
    try {
      await this.video.play();
    } catch (err) {
      this.stop();
      throw describeCameraError(err);
    }
    if (session !== this.session) throw new ScannerError('Scanner closed.', 'cancelled');

    let detect;
    try {
      detect = await this.#createDetector();
    } catch (err) {
      this.stop();
      throw new ScannerError(`${err.message}. You can type the ISBN below instead.`, 'failed');
    }
    if (session !== this.session) throw new ScannerError('Scanner closed.', 'cancelled');

    this.paused = false;
    const tick = async () => {
      if (session !== this.session) return;
      if (!this.paused && this.video.readyState >= 2 && this.video.videoWidth > 0) {
        try {
          const text = await detect();
          if (text && session === this.session && !this.paused) this.#handleText(text);
        } catch {
          /* a failed frame is not fatal */
        }
      }
      if (session === this.session) this.timer = setTimeout(tick, SCAN_INTERVAL_MS);
    };
    this.timer = setTimeout(tick, SCAN_INTERVAL_MS);
    return this.engine;
  }

  /** Stop scanning and release the camera. Safe to call repeatedly. */
  stop() {
    this.session++;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    this.video.pause();
    this.video.srcObject = null;
  }

  /** Ignore detections (e.g. while a lookup is running) without releasing the camera. */
  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  #handleText(text) {
    const digits = normalizeIsbn(text);
    if (isValidIsbn13(digits)) {
      this.paused = true; // exactly one detection per scan; the app resumes when ready
      this.onDetect(digits);
    } else if (/^\d{13}$/.test(digits)) {
      this.onNotIsbn?.(digits); // an EAN-13 that is not a Bookland (978/979) barcode, e.g. a price tag
    }
  }

  async #createDetector() {
    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('ean_13')) {
          const detector = new window.BarcodeDetector({ formats: ['ean_13'] });
          this.engine = 'BarcodeDetector';
          return async () => (await detector.detect(this.video))[0]?.rawValue || '';
        }
      } catch {
        /* fall through to ZXing */
      }
    }
    await loadZXing();
    this.engine = 'ZXing';
    this.canvas ??= document.createElement('canvas');
    const context = this.canvas.getContext('2d', { willReadFrequently: true });
    return () => {
      const scale = Math.min(1, MAX_DECODE_WIDTH / this.video.videoWidth);
      this.canvas.width = Math.round(this.video.videoWidth * scale);
      this.canvas.height = Math.round(this.video.videoHeight * scale);
      context.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
      return decodeCanvasWithZXing(this.canvas);
    };
  }
}

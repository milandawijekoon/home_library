// Camera and image modules in jsdom: the barcode scanner, the cover cropper, the outline editor and the
// cover-photo dialog. Camera, barcode and image-decoding APIs are replaced by small fakes.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, waitFor, sleep } from './support/dom.js';
import { makeScene, point } from './detect-scenes.js';

const window = installDom({ baseUrl: 'http://127.0.0.1:1' });
const $ = (selector) => window.document.querySelector(selector);
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const pointer = (node, type, init) => node.dispatchEvent(new window.PointerEvent(type, { bubbles: true, pointerId: 1, ...init }));
const VALID_ISBN = '9780140328721';
const PRICE_TAG_EAN = '4006381333931';

// Every canvas reports a phone-sized layout box.
window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ width: 300, height: 450, left: 0, top: 0, right: 300, bottom: 450 });
globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };

const { BarcodeScanner, ScannerError, describeCameraError } = await import('../public/js/scanner.js');
const { Cropper, drawToCanvas, loadImageSource, MAX_ZOOM } = await import('../public/js/cropper.js');
const { OutlineEditor } = await import('../public/js/outline.js');
const { captureCover, initCoverCapture } = await import('../public/js/cover.js');

const canvasOf = (width, height) => Object.assign(window.document.createElement('canvas'), { width, height });

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------
function fakeCamera({ rejectWith, deferred } = {}) {
  const camera = { stopped: 0, requests: 0 };
  const stream = { getTracks: () => [{ stop: () => { camera.stopped += 1; } }] };
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => {
        camera.requests += 1;
        if (rejectWith) throw Object.assign(new Error('nope'), { name: rejectWith });
        if (deferred) await deferred;
        return stream;
      },
    },
  });
  return camera;
}

function fakeVideo() {
  const video = window.document.createElement('video');
  Object.defineProperty(video, 'readyState', { value: 4 });
  Object.defineProperty(video, 'videoWidth', { value: 640 });
  Object.defineProperty(video, 'videoHeight', { value: 480 });
  return video;
}

beforeEach(() => {
  delete window.navigator.mediaDevices;
  delete window.BarcodeDetector;
  delete window.ZXing;
});

test('describeCameraError maps browser errors to helpful messages', () => {
  const cases = { NotAllowedError: 'permission', SecurityError: 'permission', NotFoundError: 'no-camera', OverconstrainedError: 'no-camera', NotReadableError: 'in-use', AbortError: 'in-use', WeirdError: 'failed' };
  for (const [name, code] of Object.entries(cases)) {
    const error = describeCameraError({ name, message: 'boom' });
    assert.ok(error instanceof ScannerError);
    assert.equal(error.code, code, name);
  }
  assert.match(describeCameraError({ name: 'WeirdError', message: 'boom' }).message, /boom/);
  assert.match(describeCameraError(undefined).message, /Could not start the camera/);
});

test('scanner: no camera API explains why, depending on a secure context', async () => {
  const scanner = new BarcodeScanner(fakeVideo(), { onDetect() {} });
  await assert.rejects(scanner.start(), (error) => error.code === 'insecure');
  window.isSecureContext = true;
  await assert.rejects(scanner.start(), (error) => error.code === 'unsupported');
  delete window.isSecureContext;
});

test('scanner: a refused camera permission is reported and nothing is left running', async () => {
  const camera = fakeCamera({ rejectWith: 'NotAllowedError' });
  const scanner = new BarcodeScanner(fakeVideo(), { onDetect() {} });
  await assert.rejects(scanner.start(), (error) => error.code === 'permission');
  assert.equal(scanner.active, false);
  assert.equal(camera.requests, 1);
});

test('scanner: BarcodeDetector engine reports each ISBN once, flags non-ISBN barcodes, and releases the camera', async () => {
  const camera = fakeCamera();
  let next = '';
  window.BarcodeDetector = class {
    static async getSupportedFormats() { return ['ean_13']; }
    async detect() { return next ? [{ rawValue: next }] : []; }
  };
  const found = [];
  const rejected = [];
  const scanner = new BarcodeScanner(fakeVideo(), { onDetect: (isbn) => found.push(isbn), onNotIsbn: (text) => rejected.push(text) });
  assert.equal(await scanner.start(), 'BarcodeDetector');
  assert.equal(scanner.active, true);

  next = PRICE_TAG_EAN;
  await waitFor(() => rejected.length > 0, 'a non-ISBN barcode');
  assert.equal(found.length, 0);

  next = VALID_ISBN;
  await waitFor(() => found.length === 1, 'an ISBN');
  await sleep(400); // paused after the first detection: it must not fire again
  assert.deepEqual(found, [VALID_ISBN]);

  scanner.resume();
  await waitFor(() => found.length === 2, 'a second detection after resume');
  scanner.pause();
  scanner.stop();
  assert.equal(scanner.active, false);
  assert.equal(camera.stopped, 1);
  scanner.stop(); // safe to repeat
  assert.equal(camera.stopped, 1);
});

test('scanner: falls back to ZXing when the browser cannot read EAN-13', async () => {
  fakeCamera();
  const next = VALID_ISBN;
  window.ZXing = {
    DecodeHintType: { POSSIBLE_FORMATS: 'formats', TRY_HARDER: 'harder' },
    BarcodeFormat: { EAN_13: 'ean13' },
    MultiFormatReader: class {
      setHints() {}
      decode() { return { getText: () => next }; }
    },
    HTMLCanvasElementLuminanceSource: class {},
    BinaryBitmap: class {},
    HybridBinarizer: class {},
  };
  const found = [];
  const scanner = new BarcodeScanner(fakeVideo(), { onDetect: (isbn) => found.push(isbn) });
  assert.equal(await scanner.start(), 'ZXing');
  await waitFor(() => found.length === 1, 'ZXing detection');
  assert.deepEqual(found, [VALID_ISBN]);
  scanner.stop();
});

test('scanner: closing while the permission prompt is open releases the camera that arrives late', async () => {
  let release;
  const camera = fakeCamera({ deferred: new Promise((resolve) => { release = resolve; }) });
  const scanner = new BarcodeScanner(fakeVideo(), { onDetect() {} });
  const starting = scanner.start();
  await sleep(10);
  scanner.stop();
  release();
  await assert.rejects(starting, (error) => error.code === 'cancelled');
  assert.equal(camera.stopped, 1);
  assert.equal(scanner.active, false);
});

// ---------------------------------------------------------------------------
// Cropper
// ---------------------------------------------------------------------------
test('Cropper: 2:3 frame, zoom limits, panning stays inside the picture, output is a bounded JPEG', () => {
  const zooms = [];
  const cropper = new Cropper(canvasOf(300, 450), { onZoom: (zoom) => zooms.push(zoom) });
  assert.equal(cropper.hasImage, false);
  cropper.setZoom(3); // no picture yet: ignored
  assert.throws(() => cropper.toDataUrl(), /No image/);

  cropper.setSource(canvasOf(1200, 800));
  cropper.resize();
  assert.ok(Math.abs(cropper.frame.w / cropper.frame.h - 2 / 3) < 1e-9);
  assert.equal(cropper.zoom, 1);

  cropper.setZoom(100);
  assert.equal(cropper.zoom, MAX_ZOOM);
  cropper.setZoom(0.01);
  assert.equal(cropper.zoom, 1);
  assert.equal(zooms.at(-1), 1);

  cropper.setZoom(2);
  cropper.panBy(-1e6, 1e6);
  const halfW = cropper.frame.w / (2 * cropper.scale);
  const halfH = cropper.frame.h / (2 * cropper.scale);
  assert.ok(cropper.cx <= 1200 - halfW + 1e-6 && cropper.cx >= halfW - 1e-6);
  assert.ok(cropper.cy <= 800 - halfH + 1e-6 && cropper.cy >= halfH - 1e-6);

  const url = cropper.toDataUrl();
  assert.match(url, /^data:image\/jpeg;base64,/);
  assert.ok(url.length <= 330_000);

  cropper.rotate();
  assert.deepEqual([cropper.src.width, cropper.src.height], [800, 1200]);
});

test('Cropper: keyboard, wheel, drag and pinch all move or zoom the picture', () => {
  const stage = canvasOf(300, 450);
  const cropper = new Cropper(stage, {});
  cropper.setSource(canvasOf(1200, 1800));
  cropper.setZoom(2);
  const zoomed = cropper.zoom;

  const key = (name, init = {}) => stage.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }));
  const startX = cropper.cx;
  key('ArrowRight');
  assert.ok(cropper.cx > startX); // the picture moves left under the frame, so the view centre moves right
  key('ArrowLeft', { shiftKey: true });
  assert.ok(cropper.cx < startX);
  key('+');
  assert.ok(cropper.zoom > zoomed);
  key('-');
  key('-');
  assert.ok(cropper.zoom < zoomed);

  stage.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -200, bubbles: true, cancelable: true }));
  const afterWheel = cropper.zoom;
  assert.ok(afterWheel > 1);

  const centerBeforeDrag = cropper.cx;
  pointer(stage, 'pointerdown', { clientX: 100, clientY: 100 });
  pointer(stage, 'pointermove', { clientX: 80, clientY: 100 });
  pointer(stage, 'pointerup', { clientX: 80, clientY: 100 });
  assert.notEqual(cropper.cx, centerBeforeDrag);

  pointer(stage, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 200 });
  pointer(stage, 'pointerdown', { pointerId: 2, clientX: 140, clientY: 200 });
  pointer(stage, 'pointermove', { pointerId: 2, clientX: 220, clientY: 200 });
  assert.ok(cropper.zoom > afterWheel); // fingers moved apart
  pointer(stage, 'pointerup', { pointerId: 1 });
  pointer(stage, 'pointerup', { pointerId: 2 });
});

test('Cropper: when the JPEG is too big it retries at lower quality', () => {
  const original = window.HTMLCanvasElement.prototype.toDataURL;
  const tried = [];
  window.HTMLCanvasElement.prototype.toDataURL = (type, quality) => {
    tried.push(quality);
    return `data:${type};base64,${'A'.repeat(quality > 0.7 ? 400_000 : 1000)}`;
  };
  try {
    const cropper = new Cropper(canvasOf(300, 450), {});
    cropper.setSource(canvasOf(800, 1200));
    assert.ok(cropper.toDataUrl().length < 330_000);
    assert.deepEqual(tried, [0.86, 0.75, 0.62]);
  } finally {
    window.HTMLCanvasElement.prototype.toDataURL = original;
  }
});

test('image loading: big photos are shrunk, unreadable ones are rejected', async (testContext) => {
  testContext.after(() => { delete globalThis.createImageBitmap; });
  const shrunk = drawToCanvas({}, 4800, 3200);
  assert.deepEqual([shrunk.width, shrunk.height], [2400, 1600]);
  const small = drawToCanvas({}, 500, 300);
  assert.deepEqual([small.width, small.height], [500, 300]);

  globalThis.createImageBitmap = async () => ({ width: 3000, height: 1500 });
  const loaded = await loadImageSource(new window.Blob(['x']));
  assert.deepEqual([loaded.width, loaded.height], [2400, 1200]);
  globalThis.createImageBitmap = async () => ({ width: 0, height: 0 });
  await assert.rejects(loadImageSource(new window.Blob(['x'])), /could not be read as an image/);
});

// ---------------------------------------------------------------------------
// Outline editor
// ---------------------------------------------------------------------------
test('OutlineEditor: corners can be dragged, stay inside the picture, and a crossed outline is invalid', () => {
  const stage = canvasOf(400, 400);
  let changes = 0;
  const editor = new OutlineEditor(stage, { onChange: () => { changes += 1; } });
  assert.equal(editor.valid, false); // no picture yet
  editor.setSource({ width: 1000, height: 1000 }, null);
  assert.equal(editor.valid, true);
  assert.equal(editor.corners.length, 4);

  const screen = (point) => ({ clientX: editor.ox + point.x * editor.scale, clientY: editor.oy + point.y * editor.scale });
  pointer(stage, 'pointerdown', screen(editor.corners[0]));
  pointer(stage, 'pointermove', { clientX: editor.ox + 5000, clientY: editor.oy - 5000 }); // far outside: clamped
  assert.ok(changes > 0);
  assert.deepEqual(editor.corners[0], { x: 1000, y: 0 });
  assert.equal(editor.valid, false); // the corner now sits on top of the top-right one
  pointer(stage, 'pointermove', screen({ x: 200, y: 100 }));
  assert.equal(editor.valid, true);
  pointer(stage, 'pointerup', {});

  const before = JSON.stringify(editor.corners);
  pointer(stage, 'pointermove', screen({ x: 500, y: 500 })); // no corner held: nothing moves
  assert.equal(JSON.stringify(editor.corners), before);
  pointer(stage, 'pointerdown', screen({ x: 500, y: 500 })); // far from every corner: nothing is picked up
  pointer(stage, 'pointermove', screen({ x: 10, y: 10 }));
  assert.equal(JSON.stringify(editor.corners), before);

  const given = [{ x: 10, y: 10 }, { x: 900, y: 10 }, { x: 900, y: 900 }, { x: 10, y: 900 }];
  editor.setSource({ width: 1000, height: 1000 }, given);
  assert.deepEqual(editor.corners, given);
  assert.notEqual(editor.corners[0], given[0]); // a copy: callers cannot mutate the editor's state
});

// ---------------------------------------------------------------------------
// Cover photo dialog
// ---------------------------------------------------------------------------
test('cover dialog: opens without a camera, can be cancelled with Close or Esc, and a new request cancels the old one', async () => {
  initCoverCapture();
  const dialog = $('#cover-dialog');

  const first = captureCover();
  assert.ok(dialog.open);
  assert.equal($('#cover-title').textContent, 'Cover photo');
  assert.match($('#cover-error').textContent, /HTTPS or localhost|cannot access a camera/);
  assert.equal($('#cover-shoot').disabled, true);
  click($('#cover-dialog [data-close]'));
  assert.equal(await first, null);
  assert.ok(!dialog.open);

  const second = captureCover();
  dialog.dispatchEvent(new window.Event('cancel')); // Esc
  dialog.close();
  assert.equal(await second, null);

  const third = captureCover();
  const fourth = captureCover();
  assert.equal(await third, null);
  click($('#cover-dialog [data-close]'));
  assert.equal(await fourth, null);
});

test('cover dialog: the auto-detect choice is remembered', () => {
  const box = $('#cover-auto');
  box.checked = false;
  box.dispatchEvent(new window.Event('change'));
  assert.equal(window.localStorage.getItem('home-library:cover-auto'), 'off');
  box.checked = true;
  box.dispatchEvent(new window.Event('change'));
  assert.equal(window.localStorage.getItem('home-library:cover-auto'), 'on');
});

test('cover dialog: choosing a non-image is refused; an image goes through outline, crop and "use"', async (testContext) => {
  testContext.after(() => { delete globalThis.createImageBitmap; });
  const choose = (file) => {
    const input = $('#cover-file');
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new window.Event('change'));
  };

  const pending = captureCover();
  choose(new window.File(['hello'], 'notes.txt', { type: 'text/plain' }));
  assert.match($('#cover-error').textContent, /choose an image file/);
  assert.ok(!$('#cover-capture').hidden);

  globalThis.createImageBitmap = async () => ({ width: 800, height: 1200 });
  choose(new window.File(['img'], 'cover.jpg', { type: 'image/jpeg' }));
  await waitFor(() => !$('#cover-crop').hidden, 'crop step');
  assert.equal($('#cover-title').textContent, 'Crop the cover');
  assert.ok(!$('#cover-use').hidden && $('#cover-shoot').hidden);

  click($('#cover-rotate'));
  click($('#cover-adjust'));
  assert.ok(!$('#cover-outline').hidden);
  assert.equal($('#cover-title').textContent, 'Adjust the outline');
  assert.equal($('#cover-outline-apply').disabled, false);
  click($('#cover-outline-back'));
  assert.ok(!$('#cover-crop').hidden);
  click($('#cover-adjust'));
  click($('#cover-outline-apply'));
  assert.ok(!$('#cover-crop').hidden);
  assert.match($('#cover-crop-note').textContent, /Straightened using your outline/);
  assert.ok(!$('#cover-original').hidden);
  click($('#cover-original'));
  assert.equal($('#cover-original').dataset.mode, 'original');

  click($('#cover-use'));
  const photo = await pending;
  assert.match(photo, /^data:image\/jpeg;base64,/);
  assert.ok(!$('#cover-dialog').open);

  const again = captureCover(); // retake goes back to the camera step
  choose(new window.File(['img'], 'cover.jpg', { type: 'image/jpeg' }));
  await waitFor(() => !$('#cover-crop').hidden, 'crop step again');
  click($('#cover-retake'));
  assert.ok(!$('#cover-capture').hidden);
  click($('#cover-dialog [data-close]'));
  assert.equal(await again, null);
});

// ---------------------------------------------------------------------------
// Cover photo dialog with a live camera
// ---------------------------------------------------------------------------
async function withLiveCoverCamera(testContext, scene) {
  const camera = fakeCamera();
  const video = $('#cover-video');
  Object.defineProperty(video, 'readyState', { configurable: true, value: 4 });
  Object.defineProperty(video, 'videoWidth', { configurable: true, value: scene.width });
  Object.defineProperty(video, 'videoHeight', { configurable: true, value: scene.height });
  // Detection and straightening read pixels back from a canvas; hand them the synthetic photo of a book.
  const original = window.HTMLCanvasElement.prototype.getContext;
  window.HTMLCanvasElement.prototype.getContext = function getContext(...args) {
    const context = original.apply(this, args);
    context.getImageData = () => scene;
    return context;
  };
  testContext.after(() => { window.HTMLCanvasElement.prototype.getContext = original; });
  return camera;
}

test('cover dialog: with the camera on, a steady book is outlined and photographed automatically', async (testContext) => {
  const scene = makeScene({ quad: [point(62, 8), point(194, 8), point(194, 184), point(62, 184)] });
  const camera = await withLiveCoverCamera(testContext, scene);
  $('#cover-auto').checked = true;
  $('#cover-auto').dispatchEvent(new window.Event('change'));

  const pending = captureCover();
  await waitFor(() => $('#cover-camera').classList.contains('is-live'), 'live camera');
  await waitFor(() => /Book found|Hold still/.test($('#cover-status').textContent), 'book outline', 4000);
  await waitFor(() => !$('#cover-crop').hidden, 'automatic capture', 6000);
  assert.match($('#cover-crop-note').textContent, /Captured automatically and straightened/);
  assert.equal(camera.stopped, 1); // the camera is released once the photo is taken
  assert.ok(!$('#cover-original').hidden);

  click($('#cover-use'));
  assert.match(await pending, /^data:image\/jpeg;base64,/);
});

test('cover dialog: with auto-detect off, Take photo captures the frame as it is', async (testContext) => {
  const scene = makeScene({ quad: [point(62, 8), point(194, 8), point(194, 184), point(62, 184)] });
  const camera = await withLiveCoverCamera(testContext, scene);
  $('#cover-auto').checked = false;
  $('#cover-auto').dispatchEvent(new window.Event('change'));

  const pending = captureCover();
  await waitFor(() => !$('#cover-shoot').disabled, 'camera ready');
  assert.match($('#cover-status').textContent, /press Take photo/);
  click($('#cover-shoot'));
  assert.ok(!$('#cover-crop').hidden);
  assert.match($('#cover-crop-note').textContent, /Drag the picture/);
  assert.ok($('#cover-original').hidden); // nothing was straightened, so there is no original to go back to
  assert.equal(camera.stopped, 1);

  click($('#cover-dialog [data-close]'));
  assert.equal(await pending, null);
  $('#cover-auto').checked = true;
  $('#cover-auto').dispatchEvent(new window.Event('change'));
});

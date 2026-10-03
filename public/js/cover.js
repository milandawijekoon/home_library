// Cover photo capture: take a photo with the camera (or pick an image), then crop it.
//   const dataUrl = await captureCover();   // resolves to a JPEG data URL, or null if cancelled
//
// With "detect book" switched on, the live camera view outlines the book it sees (upright, portrait
// books only: a wide outline is never reported, which keeps the box from stretching sideways). Once the outline
// has been steady for about a second the photo is taken automatically, and the book is straightened
// (perspective corrected) into a flat cover ready for the crop step. Photos picked from files get
// the same treatment. Detection is a first guess: the crop step always follows, and the original
// photo is one click away.
import { Cropper, drawToCanvas, loadImageSource, MAX_ZOOM } from './cropper.js';
import { OutlineEditor } from './outline.js';
import { describeCameraError, ScannerError } from './scanner.js';
import { detectBook, cornerShift, coverOutputSize, uprightCorners, warpQuad } from './detect.js';

const CHOOSE = 'Use "Choose photo" instead: on a phone it opens your camera app or photo library.';
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const CAMERA_MESSAGES = {
  permission: `Camera access was blocked. Allow it for this site in your browser settings, or ${lower(CHOOSE)}`,
  'no-camera': `No camera was found on this device. ${CHOOSE}`,
  'in-use': `The camera is busy. Close other apps or tabs using it and press Retake, or ${lower(CHOOSE)}`,
  failed: `Could not start the camera. ${CHOOSE}`,
};

const DETECT_WIDTH = 256; // frames are shrunk to this width for detection
const TICK_MS = 150;
const STEADY_TICKS = 7; // about a second of a steady outline triggers the photo
const STEADY_SHIFT = 0.018; // corners may move this fraction of the frame diagonal between ticks
const MIN_AUTO_AREA = 0.18; // the book must fill at least this much of the view to auto-capture
const MAX_MISSES = 2; // dropped detections tolerated before the hold timer restarts
const OUTPUT_MAX_SIDE = 900; // straightened covers are about this tall (the saved cover is 600 tall)
const AUTO_KEY = 'home-library:cover-auto';

const $ = (selector) => document.querySelector(selector);

let dialog, video, stage, overlay, cropper, outline, resolver, stream, session;
let outlineCorners = null; // the outline used for the current straightened picture, in `original` pixels
let original = null; // the photo as taken / chosen (canvas)
let straightened = null; // the same photo with the book flattened (canvas), when a book was found
let lastTrack = null; // { corners, at } most recent live detection, in video pixels

function readAutoPref() {
  try {
    return localStorage.getItem(AUTO_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeAutoPref(on) {
  try {
    localStorage.setItem(AUTO_KEY, on ? 'on' : 'off');
  } catch {
    /* preference just won't persist */
  }
}

const autoOn = () => $('#cover-auto').checked;

const TITLES = { capture: 'Cover photo', crop: 'Crop the cover', outline: 'Adjust the outline' };

function setStage(name) {
  $('#cover-capture').hidden = name !== 'capture';
  $('#cover-crop').hidden = name !== 'crop';
  $('#cover-outline').hidden = name !== 'outline';
  for (const id of ['cover-shoot', 'cover-choose']) $(`#${id}`).hidden = name !== 'capture';
  for (const id of ['cover-retake', 'cover-rotate', 'cover-use']) $(`#${id}`).hidden = name !== 'crop';
  for (const id of ['cover-outline-back', 'cover-outline-apply']) $(`#${id}`).hidden = name !== 'outline';
  $('#cover-title').textContent = TITLES[name];
  showError('');
  if (name === 'crop') cropper.resize(); // the canvas just became visible
  if (name === 'outline') outline.resize();
}

function showError(message) {
  const box = $('#cover-error');
  box.textContent = message || '';
  box.hidden = !message;
}

function setProgress(fraction) {
  $('#cover-progress-bar').style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

function clearOverlay() {
  if (!overlay) return;
  overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------
/** Detect a book in any canvas / video frame. Corners come back in the source's pixels. */
function detectIn(source, width, height) {
  const scale = DETECT_WIDTH / width;
  const w = DETECT_WIDTH;
  const h = Math.max(32, Math.round(height * scale));
  const small = detectIn.canvas ?? (detectIn.canvas = document.createElement('canvas'));
  small.width = w;
  small.height = h;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const found = detectBook(ctx.getImageData(0, 0, w, h));
  if (!found) return null;
  const sx = width / w;
  const sy = height / h;
  return { ...found, corners: found.corners.map((p) => ({ x: p.x * sx, y: p.y * sy })) };
}

/** Flatten the quad in `canvas` into an upright cover picture. */
function straighten(canvas, corners) {
  const upright = uprightCorners(corners);
  const { width, height } = coverOutputSize(upright, OUTPUT_MAX_SIDE);
  const src = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  const flat = warpQuad(src, upright, width, height);
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  out.getContext('2d').putImageData(new ImageData(flat.data, width, height), 0, 0);
  return out;
}

/** Show `canvas` in the crop step, straightening it first if a book outline is given. */
function enterCrop(canvas, corners, note) {
  original = canvas;
  straightened = null;
  outlineCorners = corners || null;
  if (corners) {
    try {
      straightened = straighten(canvas, corners);
    } catch {
      straightened = null;
    }
  }
  cropper.setSource(straightened || original);
  setStage('crop');
  cropper.resize();
  cropper.canvas.focus({ preventScroll: true });
  const toggle = $('#cover-original');
  toggle.hidden = !straightened;
  toggle.textContent = 'Use original photo instead';
  toggle.dataset.mode = 'straightened';
  $('#cover-crop-note').textContent =
    note || (straightened ? 'The book was found and straightened. Fine-tune below if needed.' : 'Drag the picture and zoom until the white frame lines up with the edges of the cover.');
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------
function stopCamera() {
  session++;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.pause();
  video.srcObject = null;
  lastTrack = null;
  $('#cover-camera').classList.remove('is-live');
  clearOverlay();
  setProgress(0);
}

/** Map a point in video pixels to the overlay canvas (the video is shown with object-fit: cover). */
function videoToOverlay(p) {
  const cw = overlay.clientWidth;
  const ch = overlay.clientHeight;
  const scale = Math.max(cw / video.videoWidth, ch / video.videoHeight);
  return { x: p.x * scale + (cw - video.videoWidth * scale) / 2, y: p.y * scale + (ch - video.videoHeight * scale) / 2 };
}

function drawOutline(corners, progress) {
  const dpr = window.devicePixelRatio || 1;
  const cw = overlay.clientWidth;
  const ch = overlay.clientHeight;
  if (overlay.width !== Math.round(cw * dpr) || overlay.height !== Math.round(ch * dpr)) {
    overlay.width = Math.round(cw * dpr);
    overlay.height = Math.round(ch * dpr);
  }
  const ctx = overlay.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  if (!corners) return;
  const pts = corners.map(videoToOverlay);
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = `rgb(61 220 132 / ${0.12 + 0.18 * progress})`;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = progress >= 1 ? '#ffffff' : '#3ddc84';
  ctx.stroke();
  ctx.fillStyle = '#3ddc84';
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Live detection loop: outline the book, and take the photo once it has been steady. */
function startDetection(mine) {
  let steady = 0;
  let misses = 0;
  let previous = null;

  const tick = () => {
    if (mine !== session || !stream) return;
    if (!autoOn() || !video.videoWidth || video.readyState < 2) {
      clearOverlay();
      setProgress(0);
      steady = 0;
      previous = null;
      lastTrack = null;
      setTimeout(tick, TICK_MS);
      return;
    }
    let found = null;
    try {
      found = detectIn(video, video.videoWidth, video.videoHeight);
    } catch {
      /* a failed frame is not fatal */
    }

    if (found) {
      misses = 0;
      const moved = previous ? cornerShift(previous, found.corners, video.videoWidth, video.videoHeight) : Infinity;
      steady = moved <= STEADY_SHIFT ? steady + 1 : 1;
      previous = found.corners;
      lastTrack = { corners: found.corners, at: performance.now(), area: found.area };
      const big = found.area >= MIN_AUTO_AREA;
      const progress = big ? Math.min(1, steady / STEADY_TICKS) : 0;
      drawOutline(found.corners, progress);
      setProgress(progress);
      $('#cover-status').textContent = !big
        ? 'Book found. Move closer so it fills more of the view.'
        : progress >= 1
          ? 'Captured!'
          : 'Book found. Hold still…';
      if (big && steady >= STEADY_TICKS) {
        capture(found.corners);
        return;
      }
    } else if (++misses > MAX_MISSES) {
      steady = 0;
      previous = null;
      lastTrack = null;
      clearOverlay();
      setProgress(0);
      $('#cover-status').textContent = 'Looking for a book… hold it upright (portrait), cover facing the camera, against a plain background.';
    }
    setTimeout(tick, TICK_MS);
  };
  setTimeout(tick, TICK_MS);
}

async function startCamera() {
  const mine = ++session;
  showError('');
  $('#cover-status').textContent = 'Starting camera…';
  $('#cover-shoot').disabled = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    $('#cover-status').textContent = 'Camera not available here.';
    showError(
      window.isSecureContext
        ? 'This browser cannot access a camera. Use "Choose photo" instead.'
        : 'The live camera needs HTTPS or localhost. Use "Choose photo": on a phone it opens your camera app.',
    );
    return;
  }
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    if (mine !== session) {
      s.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = s;
    video.srcObject = s;
    await video.play();
    if (mine !== session) return;
    $('#cover-camera').classList.add('is-live');
    $('#cover-camera').classList.toggle('is-auto', autoOn());
    $('#cover-status').textContent = autoOn()
      ? 'Looking for a book… hold it upright (portrait), cover facing the camera.'
      : 'Fill the frame with the front cover, then press Take photo.';
    $('#cover-shoot').disabled = false;
    startDetection(mine);
  } catch (err) {
    if (mine !== session) return;
    stopCamera();
    $('#cover-status').textContent = 'Camera is off.';
    const code = (err instanceof ScannerError ? err : describeCameraError(err)).code;
    showError(CAMERA_MESSAGES[code] || CAMERA_MESSAGES.failed);
  }
}

/** Grab the current frame at full resolution and move on to cropping. */
function capture(corners) {
  if (!stream || !video.videoWidth) return;
  const frame = drawToCanvas(video, video.videoWidth, video.videoHeight);
  // frame may have been shrunk relative to the video; scale the outline to match
  const k = frame.width / video.videoWidth;
  const scaled = corners ? corners.map((p) => ({ x: p.x * k, y: p.y * k })) : null;
  stopCamera();
  enterCrop(frame, scaled, scaled ? 'Captured automatically and straightened. Fine-tune below if needed.' : null);
}

function takePhoto() {
  // Use the outline we are currently showing, if it is fresh; otherwise take the frame as it is.
  const fresh = lastTrack && performance.now() - lastTrack.at < 800 && autoOn();
  capture(fresh ? lastTrack.corners : null);
}

async function useBlob(blob) {
  showError('');
  if (!blob.type.startsWith('image/')) {
    showError('Please choose an image file (JPEG, PNG or WebP).');
    return;
  }
  try {
    const canvas = await loadImageSource(blob);
    let found = null;
    if (autoOn()) {
      try {
        found = detectIn(canvas, canvas.width, canvas.height);
      } catch {
        found = null;
      }
    }
    stopCamera();
    enterCrop(canvas, found?.corners ?? null);
  } catch (err) {
    showError(err.message);
  }
}

function finish(value) {
  stopCamera();
  const done = resolver;
  resolver = null;
  original = null;
  straightened = null;
  outlineCorners = null;
  if (dialog.open) dialog.close();
  done?.(value);
}

/** Wire up the dialog once, at start-up. */
export function initCoverCapture() {
  dialog = $('#cover-dialog');
  video = $('#cover-video');
  stage = $('#cover-stage');
  overlay = $('#cover-overlay');
  session = 0;
  const zoom = $('#cover-zoom');
  zoom.max = String(MAX_ZOOM);
  cropper = new Cropper(stage, { onZoom: (z) => (zoom.value = String(z)) });

  $('#cover-auto').checked = readAutoPref();
  $('#cover-auto').addEventListener('change', (e) => {
    writeAutoPref(e.target.checked);
    $('#cover-camera').classList.toggle('is-auto', e.target.checked);
    if (stream) {
      $('#cover-status').textContent = e.target.checked
        ? 'Looking for a book… hold it upright (portrait), cover facing the camera.'
        : 'Fill the frame with the front cover, then press Take photo.';
    }
    if (!e.target.checked) {
      clearOverlay();
      setProgress(0);
    }
  });

  zoom.addEventListener('input', () => cropper.setZoom(Number(zoom.value)));
  $('#cover-shoot').addEventListener('click', takePhoto);
  $('#cover-choose').addEventListener('click', () => $('#cover-file').click());
  $('#cover-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) useBlob(file);
  });
  $('#cover-rotate').addEventListener('click', () => cropper.rotate());
  $('#cover-original').addEventListener('click', (e) => {
    const button = e.currentTarget;
    const showOriginal = button.dataset.mode === 'straightened';
    cropper.setSource(showOriginal ? original : straightened);
    button.dataset.mode = showOriginal ? 'original' : 'straightened';
    button.textContent = showOriginal ? 'Use the straightened cover' : 'Use original photo instead';
  });
  outline = new OutlineEditor($('#cover-outline-stage'), {
    onChange: () => ($('#cover-outline-apply').disabled = !outline.valid),
  });
  $('#cover-adjust').addEventListener('click', () => {
    if (!original) return;
    outline.setSource(original, outlineCorners);
    $('#cover-outline-apply').disabled = !outline.valid;
    setStage('outline');
  });
  $('#cover-outline-back').addEventListener('click', () => setStage('crop'));
  $('#cover-outline-apply').addEventListener('click', () => {
    if (!outline.valid) return;
    try {
      outlineCorners = outline.corners;
      straightened = straighten(original, outlineCorners);
    } catch (err) {
      showError(err.message);
      return;
    }
    cropper.setSource(straightened);
    const toggle = $('#cover-original');
    toggle.hidden = false;
    toggle.textContent = 'Use original photo instead';
    toggle.dataset.mode = 'straightened';
    $('#cover-crop-note').textContent = 'Straightened using your outline. Fine-tune below if needed.';
    setStage('crop');
  });
  $('#cover-retake').addEventListener('click', () => {
    setStage('capture');
    startCamera();
  });
  $('#cover-use').addEventListener('click', () => {
    try {
      finish(cropper.toDataUrl());
    } catch (err) {
      showError(err.message);
    }
  });
  dialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) finish(null);
  });
  dialog.addEventListener('cancel', () => finish(null)); // Esc
  dialog.addEventListener('close', () => {
    if (resolver) finish(null); // backstop for any other way the dialog closes
  });
  window.addEventListener('pagehide', stopCamera);
}

export function captureCover() {
  return new Promise((resolve) => {
    resolver?.(null);
    resolver = resolve;
    setStage('capture');
    showError('');
    if (!dialog.open) dialog.showModal();
    startCamera();
  });
}

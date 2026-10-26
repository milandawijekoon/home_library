// Test support: boots the real front end (public/index.html) inside jsdom and wires the browser
// globals the ES modules expect, so app code runs unchanged against a real server.
// jsdom has no canvas, <dialog> modal API, matchMedia or ResizeObserver; minimal stand-ins are added here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

/** A recording stand-in for a 2D canvas context: every method is a no-op, every property settable. */
function fakeContext() {
  return new Proxy({}, {
    get: (target, key) => (key in target ? target[key] : () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })),
    set: (target, key, value) => { target[key] = value; return true; },
  });
}

/**
 * @param {{ baseUrl: string, failFetch?: () => boolean }} options
 * `failFetch` lets a test simulate the server being unreachable.
 */
export function installDom({ baseUrl, failFetch = () => false }) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: `${baseUrl}/`, pretendToBeVisual: true });
  const { window } = dom;

  const dialogProto = window.HTMLDialogElement.prototype;
  dialogProto.showModal = function showModal() { this.setAttribute('open', ''); };
  dialogProto.close = function close() {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new window.Event('close'));
  };
  window.Element.prototype.scrollIntoView = () => {};
  window.HTMLMediaElement.prototype.pause = () => {};
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window.HTMLCanvasElement.prototype.getContext = function getContext() { return (this.ctx ??= fakeContext()); };
  window.HTMLCanvasElement.prototype.toDataURL = function toDataURL(type, quality = 0.92) {
    return `data:${type};base64,${'A'.repeat(Math.round(this.width * this.height * quality))}`;
  };
  window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} disconnect() {} };

  const realFetch = globalThis.fetch;
  const globals = {
    window,
    document: window.document,
    localStorage: window.localStorage,
    Node: window.Node,
    DOMParser: window.DOMParser,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    matchMedia: window.matchMedia,
    ResizeObserver: window.ResizeObserver,
    fetch: (url, init) => {
      if (failFetch()) return Promise.reject(new TypeError('fetch failed'));
      return realFetch(typeof url === 'string' && url.startsWith('/') ? baseUrl + url : url, init);
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
  return window;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `check()` is truthy; fail loudly (with `message`) when it never is. */
export async function waitFor(check, message = 'condition', timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await sleep(10);
  }
}

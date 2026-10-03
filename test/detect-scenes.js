// Synthetic photo generator for the book detector tests (no DOM, no canvas).
import { squareToQuad, mapUnit } from '../public/js/detect.js';

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * quad = [tl, tr, br, bl]. background: 'plain' | 'wood' | 'clutter'. coverTone: 0..255 base brightness
 * of the cover's main colour (to test low contrast against the 150-ish background).
 */
export function makeScene({ width = 256, height = 192, quad, background = 'plain', coverTone = 70, seed = 1, noise = 5 }) {
  const rand = rng(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  const bg = (x, y) => {
    if (background === 'plain') return 150;
    if (background === 'wood') return 150 + 14 * Math.sin(y * 0.45 + 3 * Math.sin(x * 0.03)) + 8 * Math.sin(x * 0.11 + y * 0.02);
    return 150 + 22 * Math.sin(x * 0.19) * Math.cos(y * 0.23) + 16 * Math.sin((x + y) * 0.41);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = bg(x, y);
      const o = (y * width + x) * 4;
      data[o] = v + 6;
      data[o + 1] = v;
      data[o + 2] = v - 6;
      data[o + 3] = 255;
    }
  }
  if (background === 'clutter') {
    // random bright/dark blocks (other objects on the table), kept away from the exact centre
    for (let k = 0; k < 14; k++) {
      const bx = Math.floor(rand() * width);
      const by = Math.floor(rand() * height);
      const bw = 8 + Math.floor(rand() * 26);
      const bh = 8 + Math.floor(rand() * 26);
      const tone = rand() < 0.5 ? 60 : 235;
      for (let y = by; y < Math.min(height, by + bh); y++) {
        for (let x = bx; x < Math.min(width, bx + bw); x++) {
          const o = (y * width + x) * 4;
          data[o] = data[o + 1] = data[o + 2] = tone;
        }
      }
    }
  }
  if (quad) {
    const m = squareToQuad(quad);
    const side = Math.max(...quad.map((p, i) => Math.hypot(p.x - quad[(i + 1) % 4].x, p.y - quad[(i + 1) % 4].y)));
    const n = Math.ceil(side * 5);
    for (let iv = 0; iv <= n; iv++) {
      for (let iu = 0; iu <= n; iu++) {
        const u = iu / n;
        const v = iv / n;
        const { x, y } = mapUnit(m, u, v);
        const px = Math.round(x);
        const py = Math.round(y);
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        // cover art: dark title band, picture block with a pattern, plain body
        let tone = coverTone;
        if (v < 0.22) tone = coverTone - 35;
        else if (v > 0.35 && v < 0.8 && u > 0.18 && u < 0.82) tone = coverTone + 40 * Math.sin(u * 20) * Math.cos(v * 17);
        const o = (py * width + px) * 4;
        data[o] = tone + 30;
        data[o + 1] = tone;
        data[o + 2] = tone - 30;
      }
    }
  }
  // A real lens/sensor softens edges. Blur (about 1 px), then add sensor noise.
  blurRgba(data, width, height, 2);
  for (let i = 0; i < data.length; i += 4) {
    const n = (rand() - 0.5) * 2 * noise;
    data[i] += n;
    data[i + 1] += n;
    data[i + 2] += n;
  }
  return { data, width, height };
}

function blurRgba(data, w, h, passes) {
  const tmp = new Float32Array(data.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          const i = (y * w + x) * 4 + c;
          const l = data[x > 0 ? i - 4 : i];
          const r = data[x < w - 1 ? i + 4 : i];
          tmp[i] = (l + data[i] + r) / 3;
        }
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          const i = (y * w + x) * 4 + c;
          const u = tmp[y > 0 ? i - w * 4 : i];
          const d = tmp[y < h - 1 ? i + w * 4 : i];
          data[i] = (u + tmp[i] + d) / 3;
        }
      }
    }
  }
}

export const P = (x, y) => ({ x, y });

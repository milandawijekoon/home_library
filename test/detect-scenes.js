// Synthetic photo generator for the book detector tests (no DOM, no canvas).
import { squareToQuad, mapUnit } from '../public/js/detect.js';

export function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * quad = [tl, tr, br, bl]. background: 'plain' | 'wood' | 'clutter'. coverTone: 0..255 base brightness
 * of the cover's main colour (to test low contrast against the 150-ish background).
 */
export function makeScene({ width = 256, height = 192, quad, background = 'plain', coverTone = 70, seed = 1, noise = 5 }) {
  const rand = rng(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  const backgroundAt = (x, y) => {
    if (background === 'plain') return 150;
    if (background === 'wood') return 150 + 14 * Math.sin(y * 0.45 + 3 * Math.sin(x * 0.03)) + 8 * Math.sin(x * 0.11 + y * 0.02);
    return 150 + 22 * Math.sin(x * 0.19) * Math.cos(y * 0.23) + 16 * Math.sin((x + y) * 0.41);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = backgroundAt(x, y);
      const pixelOffset = (y * width + x) * 4;
      data[pixelOffset] = color + 6;
      data[pixelOffset + 1] = color;
      data[pixelOffset + 2] = color - 6;
      data[pixelOffset + 3] = 255;
    }
  }
  if (background === 'clutter') {
    // random bright/dark blocks (other objects on the table), kept away from the exact centre
    for (let clutterIndex = 0; clutterIndex < 14; clutterIndex++) {
      const boxX = Math.floor(rand() * width);
      const boxY = Math.floor(rand() * height);
      const boxWidth = 8 + Math.floor(rand() * 26);
      const boxHeight = 8 + Math.floor(rand() * 26);
      const tone = rand() < 0.5 ? 60 : 235;
      for (let y = boxY; y < Math.min(height, boxY + boxHeight); y++) {
        for (let x = boxX; x < Math.min(width, boxX + boxWidth); x++) {
          const pixelOffset = (y * width + x) * 4;
          data[pixelOffset] = data[pixelOffset + 1] = data[pixelOffset + 2] = tone;
        }
      }
    }
  }
  if (quad) {
    const matrix = squareToQuad(quad);
    const side = Math.max(...quad.map((corner, index) => Math.hypot(corner.x - quad[(index + 1) % 4].x, corner.y - quad[(index + 1) % 4].y)));
    const noiseAmount = Math.ceil(side * 5);
    for (let rowStep = 0; rowStep <= noiseAmount; rowStep++) {
      for (let columnStep = 0; columnStep <= noiseAmount; columnStep++) {
        const unitU = columnStep / noiseAmount;
        const color = rowStep / noiseAmount;
        const { x, y } = mapUnit(matrix, unitU, color);
        const pixelX = Math.round(x);
        const pixelY = Math.round(y);
        if (pixelX < 0 || pixelY < 0 || pixelX >= width || pixelY >= height) continue;
        // cover art: dark title band, picture block with a pattern, plain body
        let tone = coverTone;
        if (color < 0.22) tone = coverTone - 35;
        else if (color > 0.35 && color < 0.8 && unitU > 0.18 && unitU < 0.82) tone = coverTone + 40 * Math.sin(unitU * 20) * Math.cos(color * 17);
        const pixelOffset = (pixelY * width + pixelX) * 4;
        data[pixelOffset] = tone + 30;
        data[pixelOffset + 1] = tone;
        data[pixelOffset + 2] = tone - 30;
      }
    }
  }
  // A real lens/sensor softens edges. Blur (about 1 px), then add sensor noise.
  blurRgba(data, width, height, 2);
  for (let index = 0; index < data.length; index += 4) {
    const noiseAmount = (rand() - 0.5) * 2 * noise;
    data[index] += noiseAmount;
    data[index + 1] += noiseAmount;
    data[index + 2] += noiseAmount;
  }
  return { data, width, height };
}

function blurRgba(data, width, height, passes) {
  const scratch = new Float32Array(data.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let channel = 0; channel < 3; channel++) {
          const index = (y * width + x) * 4 + channel;
          const left = data[x > 0 ? index - 4 : index];
          const right = data[x < width - 1 ? index + 4 : index];
          scratch[index] = (left + data[index] + right) / 3;
        }
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let channel = 0; channel < 3; channel++) {
          const index = (y * width + x) * 4 + channel;
          const unitU = scratch[y > 0 ? index - width * 4 : index];
          const below = scratch[y < height - 1 ? index + width * 4 : index];
          data[index] = (unitU + scratch[index] + below) / 3;
        }
      }
    }
  }
}

export const point = (x, y) => ({ x, y });

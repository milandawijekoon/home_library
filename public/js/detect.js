// Book edge detection and perspective correction (pure functions, no DOM: usable in tests).
//
// detectBook(image) looks for the outline of a book cover in a small RGBA image:
//   1. gradient edges (Sobel, thinned),
//   2. long straight lines (Hough transform, each edge pixel votes only near its own direction),
//   3. the best set of four lines forming a convex, book-shaped quadrilateral that surrounds the
//      centre of the picture and is well supported by edge pixels along all four sides.
// warpQuad(image, corners, w, h) then flattens that quadrilateral into an upright w x h picture.
//
// "image" is { data: Uint8ClampedArray (RGBA), width, height }. Keep it small (about 240-320 px
// wide) for detection; it is a few milliseconds per frame at that size.

const THETA_BINS = 180;
const MAX_LINES = 14;
const SHAPE_WEIGHT = 3;
const SHAPE_MIN = 0.5; // plausible width per height of a book (portrait: 0.5 to 0.9)
const SHAPE_MAX = 0.9;
const PORTRAIT_LIMIT = 1.0; // with portrait on, outlines wider than tall are rejected
const VOTE_WINDOW = 10; // degrees either side of an edge pixel's gradient direction

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function toGray(image) {
  const { data, width, height } = image;
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return gray;
}

function blur3(src, w, h) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l = src[x > 0 ? i - 1 : i];
      const r = src[x < w - 1 ? i + 1 : i];
      tmp[i] = (l + 2 * src[i] + r) / 4;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = tmp[y > 0 ? i - w : i];
      const d = tmp[y < h - 1 ? i + w : i];
      out[i] = (u + 2 * tmp[i] + d) / 4;
    }
  }
  return out;
}

/** Thin gradient edges. Returns edge pixel list (index, gradient angle) and a "near an edge" map. */
function findEdges(gray, w, h) {
  const mag = new Float32Array(w * h);
  const gxs = new Float32Array(w * h);
  const gys = new Float32Array(w * h);
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1];
      const gy = gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1];
      gxs[i] = gx;
      gys[i] = gy;
      const m = Math.abs(gx) + Math.abs(gy);
      mag[i] = m;
      sum += m;
      sumSq += m * m;
      n++;
    }
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  const threshold = Math.max(28, mean + 0.8 * std);

  const edges = []; // [index, gx, gy]
  const edgeMap = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m <= threshold) continue;
      const ax = Math.abs(gxs[i]);
      const ay = Math.abs(gys[i]);
      let a;
      let b;
      if (ay <= 0.4142 * ax) {
        a = mag[i - 1];
        b = mag[i + 1];
      } else if (ay >= 2.4142 * ax) {
        a = mag[i - w];
        b = mag[i + w];
      } else if (gxs[i] * gys[i] > 0) {
        a = mag[i - w - 1];
        b = mag[i + w + 1];
      } else {
        a = mag[i - w + 1];
        b = mag[i + w - 1];
      }
      if (m >= a && m >= b) {
        edges.push(i, gxs[i], gys[i]);
        edgeMap[i] = 1;
      }
    }
  }

  // "near" = within 2 px of an edge pixel (separable 5x5 max).
  const rowMax = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -2; k <= 2 && !v; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < w && edgeMap[y * w + xx]) v = 1;
      }
      rowMax[y * w + x] = v;
    }
  }
  const near = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -2; k <= 2 && !v; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < h && rowMax[yy * w + x]) v = 1;
      }
      near[y * w + x] = v;
    }
  }
  return { edges, near };
}

const COS = new Float64Array(THETA_BINS);
const SIN = new Float64Array(THETA_BINS);
for (let t = 0; t < THETA_BINS; t++) {
  COS[t] = Math.cos((t * Math.PI) / THETA_BINS);
  SIN[t] = Math.sin((t * Math.PI) / THETA_BINS);
}

/**
 * Strongest straight lines as {theta (bin, degrees), rho, votes}, after suppressing near-duplicates.
 * A line is (theta, rho) with x cos(theta) + y sin(theta) = rho. theta runs over [0, 180), and the
 * same line is also (theta + 180, -rho), so cells next to the 0/180 boundary are neighbours with
 * the sign of rho flipped. That wrap matters: vertical edges sit right on the boundary.
 */
function houghLines(edges, w, h) {
  const diag = Math.ceil(Math.hypot(w, h));
  const rw = 2 * diag + 1;
  const acc = new Float32Array(THETA_BINS * rw);
  const ox = w / 2; // offsets are measured from the picture centre: that keeps peaks tight
  const oy = h / 2;
  for (let k = 0; k < edges.length; k += 3) {
    const i = edges[k];
    const x = (i % w) - ox;
    const y = Math.floor(i / w) - oy;
    const deg = (Math.atan2(edges[k + 2], edges[k + 1]) * 180) / Math.PI;
    const t0 = Math.round(deg);
    // The gradient angle of a noisy edge pixel is only good to about +-8 degrees, so each pixel
    // votes over a window. A real line still piles every vote into one cell; noise spreads thin.
    for (let d = -VOTE_WINDOW; d <= VOTE_WINDOW; d++) {
      const t = (((t0 + d) % THETA_BINS) + THETA_BINS) % THETA_BINS;
      acc[t * rw + Math.round(x * COS[t] + y * SIN[t]) + diag] += 1;
    }
  }
  const at = (a, t, r) => {
    let rr = r;
    let tt = t;
    if (tt < 0) {
      tt += THETA_BINS;
      rr = -rr;
    } else if (tt >= THETA_BINS) {
      tt -= THETA_BINS;
      rr = -rr;
    }
    const col = rr + diag;
    return col < 0 || col >= rw ? 0 : a[tt * rw + col];
  };

  // smooth along rho (an edge may be a pixel or two thick)
  const sm = new Float32Array(acc.length);
  for (let t = 0; t < THETA_BINS; t++) {
    const base = t * rw;
    for (let r = 1; r < rw - 1; r++) sm[base + r] = acc[base + r - 1] + 2 * acc[base + r] + acc[base + r + 1];
  }

  const minLength = 0.28 * Math.min(w, h); // shortest edge worth considering, in pixels
  const minVotes = 1.6 * minLength; // measured: a clean edge scores roughly 1.5 x its length
  const peaks = [];
  for (let t = 0; t < THETA_BINS; t++) {
    for (let col = 3; col < rw - 3; col++) {
      const v = sm[t * rw + col];
      if (v < minVotes) continue;
      const rho = col - diag;
      let isMax = true;
      for (let dt = -3; dt <= 3 && isMax; dt++) {
        for (let dr = -3; dr <= 3; dr++) {
          if (!dt && !dr) continue;
          const o = at(sm, t + dt, rho + dr);
          if (o > v || (o === v && (dt < 0 || (dt === 0 && dr < 0)))) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) peaks.push({ theta: t, rho, votes: v });
    }
  }
  peaks.sort((a, b) => b.votes - a.votes);

  const lines = [];
  for (const p of peaks) {
    const dup = lines.some((q) => {
      let dTheta = Math.abs(p.theta - q.theta);
      let dRho = Math.abs(p.rho - q.rho);
      if (dTheta > THETA_BINS / 2) {
        dTheta = THETA_BINS - dTheta;
        dRho = Math.abs(p.rho + q.rho); // wrapping flips the normal, and so the sign of rho
      }
      return dTheta < 8 && dRho < 8;
    });
    if (!dup) lines.push(p);
    if (lines.length >= MAX_LINES) break;
  }
  return lines;
}

const angleBetween = (a, b) => {
  const d = Math.abs(a.theta - b.theta);
  return Math.min(d, THETA_BINS - d);
};

function intersect(a, b, ox, oy) {
  const det = COS[a.theta] * SIN[b.theta] - SIN[a.theta] * COS[b.theta];
  if (Math.abs(det) < 1e-3) return null;
  return {
    x: (a.rho * SIN[b.theta] - b.rho * SIN[a.theta]) / det + ox,
    y: (COS[a.theta] * b.rho - COS[b.theta] * a.rho) / det + oy,
  };
}

function polygonArea(p) {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

function isConvex(p) {
  let sign = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    const c = p[(i + 2) % p.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-6) return false;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

function containsPoint(p, x, y) {
  let sign = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    const s = Math.sign(cross);
    if (s && sign && s !== sign) return false;
    if (s) sign = s;
  }
  return true;
}

/** Fraction of points along a side that lie next to an edge pixel. */
function sideCoverage(near, w, h, a, b) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.floor(len / 1.5));
  let inside = 0;
  let hits = 0;
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(a.x + ((b.x - a.x) * s) / steps);
    const y = Math.round(a.y + ((b.y - a.y) * s) / steps);
    if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue; // part of the side is off-screen
    inside++;
    if (near[y * w + x]) hits++;
  }
  return inside < 12 ? 0 : hits / inside;
}

/** Order four points clockwise from the top-left (screen coordinates). */
export function orderCorners(points) {
  const cx = points.reduce((s, p) => s + p.x, 0) / 4;
  const cy = points.reduce((s, p) => s + p.y, 0) / 4;
  const sorted = [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // atan2 ascending = clockwise on screen; start at the corner nearest the top-left
  let start = 0;
  for (let i = 1; i < 4; i++) if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
  return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]);
}

/** Estimated width / height of the flat object seen as this quad (tl, tr, br, bl). */
export function quadAspect([tl, tr, br, bl]) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  return (d(tl, tr) + d(bl, br)) / 2 / ((d(tl, bl) + d(tr, br)) / 2);
}

/**
 * Find a book outline (by default only upright, portrait-shaped ones; pass { portrait: false } to
 * also accept books lying on their side). Returns { corners: [tl, tr, br, bl] (pixels of `image`), score, area }
 * where area is the fraction of the picture covered, or null when nothing convincing is found.
 */
export function detectBook(image, { portrait = true } = {}) {
  const { width: w, height: h } = image;
  if (w < 32 || h < 32) return null;
  const gray = blur3(toGray(image), w, h);
  const { edges, near } = findEdges(gray, w, h);
  if (edges.length < 60) return null;
  const lines = houghLines(edges, w, h);
  if (lines.length < 4) return null;

  const frameArea = w * h;
  const margin = 0.1;
  const cx = w / 2;
  const cy = h / 2;
  let best = null;

  // pairs of roughly parallel lines = opposite sides of the book
  const pairs = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (angleBetween(lines[i], lines[j]) <= 22) pairs.push([lines[i], lines[j]]);
    }
  }
  const meanTheta = (pair) => {
    // average of two angles on a 180-degree circle
    let a = pair[0].theta;
    let b = pair[1].theta;
    if (Math.abs(a - b) > 90) b += a > b ? 180 : -180;
    return (((a + b) / 2) % 180 + 180) % 180;
  };
  const thetas = pairs.map(meanTheta);

  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const [a1, a2] = pairs[i];
      const [b1, b2] = pairs[j];
      if (a1 === b1 || a1 === b2 || a2 === b1 || a2 === b2) continue;
      let dir = Math.abs(thetas[i] - thetas[j]);
      dir = Math.min(dir, 180 - dir);
      if (dir < 55) continue; // the two pairs must be roughly perpendicular

      const p = [intersect(a1, b1, cx, cy), intersect(a1, b2, cx, cy), intersect(a2, b2, cx, cy), intersect(a2, b1, cx, cy)];
      if (p.some((q) => !q)) continue;
      if (p.some((q) => q.x < -margin * w || q.x > (1 + margin) * w || q.y < -margin * h || q.y > (1 + margin) * h)) continue;
      if (!isConvex(p)) continue;
      const area = polygonArea(p) / frameArea;
      if (area < 0.1 || area > 1.2) continue;
      if (!containsPoint(p, cx, cy)) continue;

      const cov = [0, 1, 2, 3].map((k) => sideCoverage(near, w, h, p[k], p[(k + 1) % 4]));
      const minCov = Math.min(...cov);
      const meanCov = (cov[0] + cov[1] + cov[2] + cov[3]) / 4;
      if (minCov < 0.4 || meanCov < 0.6) continue;
      // Books are held upright: an outline must be taller than wide (width per height under about 1).
      // Within that, a plausible book is about 0.5 to 0.9 wide per tall; outside it is probably a
      // wrong line (a box far too tall is skinny, one far too short is squat), so penalise it.
      const ratio = quadAspect(orderCorners(p));
      if (portrait && ratio > PORTRAIT_LIMIT) continue;
      const shape = portrait ? ratio : Math.min(ratio, 1 / ratio);
      const shapePenalty = SHAPE_WEIGHT * Math.max(0, SHAPE_MIN - shape, shape - SHAPE_MAX);
      const score = 0.5 * minCov + 0.5 * meanCov + 0.35 * Math.min(area, 1) - shapePenalty;
      if (!best || score > best.score) best = { corners: p, score, area };
    }
  }
  if (!best) return null;
  const corners = orderCorners(best.corners);
  return { corners, score: best.score, area: best.area };
}

/** True when the four corners form a convex quadrilateral of at least `minArea` pixels (default 2%). */
export function isConvexQuad(corners, frameArea, minFraction = 0.02) {
  return isConvex(corners) && polygonArea(corners) >= minFraction * frameArea;
}

/** Largest movement (as a fraction of the picture diagonal) between two corner sets. */
export function cornerShift(a, b, width, height) {
  const diag = Math.hypot(width, height);
  return Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y))) / diag;
}

/** Homography mapping the unit square (0,0)=tl (1,0)=tr (1,1)=br (0,1)=bl onto the quad. */
export function squareToQuad([p0, p1, p2, p3]) {
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    return { a: p1.x - p0.x, b: p2.x - p1.x, c: p0.x, d: p1.y - p0.y, e: p2.y - p1.y, f: p0.y, g: 0, h: 0, affine: true };
  }
  const den = dx1 * dy2 - dy1 * dx2;
  const g = (dx3 * dy2 - dy3 * dx2) / den;
  const h = (dx1 * dy3 - dy1 * dx3) / den;
  return {
    a: p1.x - p0.x + g * p1.x,
    b: p3.x - p0.x + h * p3.x,
    c: p0.x,
    d: p1.y - p0.y + g * p1.y,
    e: p3.y - p0.y + h * p3.y,
    f: p0.y,
    g,
    h,
  };
}

export function mapUnit(m, u, v) {
  if (m.affine) {
    // for the affine case a,b are the u,v coefficients along edges p0->p1 and p1->p2
    return { x: m.c + m.a * u + m.b * v, y: m.f + m.d * u + m.e * v };
  }
  const k = m.g * u + m.h * v + 1;
  return { x: (m.a * u + m.b * v + m.c) / k, y: (m.d * u + m.e * v + m.f) / k };
}

/**
 * Flatten the quad (tl, tr, br, bl in `image` pixels) into an upright outW x outH picture,
 * bilinear sampled. Returns { data, width, height } (RGBA).
 */
export function warpQuad(image, corners, outW, outH) {
  const m = squareToQuad(corners);
  const { data, width, height } = image;
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let oy = 0; oy < outH; oy++) {
    const v = (oy + 0.5) / outH;
    for (let ox = 0; ox < outW; ox++) {
      const u = (ox + 0.5) / outW;
      const { x, y } = mapUnit(m, u, v);
      const fx = clamp(x - 0.5, 0, width - 1.001);
      const fy = clamp(y - 0.5, 0, height - 1.001);
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const i00 = (y0 * width + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + width * 4;
      const i11 = i01 + 4;
      const o = (oy * outW + ox) * 4;
      for (let c = 0; c < 4; c++) {
        const top = data[i00 + c] * (1 - tx) + data[i10 + c] * tx;
        const bottom = data[i01 + c] * (1 - tx) + data[i11 + c] * tx;
        out[o + c] = top * (1 - ty) + bottom * ty;
      }
    }
  }
  return { data: out, width: outW, height: outH };
}

/**
 * Output size for a flattened cover: portrait, about `maxSide` px on the long side. Aspect
 * ratios close to a standard 2:3 cover are snapped to exactly 2:3 so nothing is trimmed later.
 */
export function coverOutputSize(corners, maxSide = 1200) {
  let ratio = quadAspect(corners);
  if (ratio >= 0.6 && ratio <= 0.75) ratio = 2 / 3;
  ratio = clamp(ratio, 0.4, 1.2);
  const h = Math.round(maxSide);
  return { width: Math.round(h * ratio), height: h };
}

/** Rotate the corner order a quarter turn so a sideways (landscape) quad becomes upright. */
export function uprightCorners(corners) {
  const [tl, tr, br, bl] = corners;
  return quadAspect(corners) > 1.05 ? [bl, tl, tr, br] : corners;
}

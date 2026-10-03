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

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function toGray(image) {
  const { data, width, height } = image;
  const gray = new Float32Array(width * height);
  for (let pixelIndex = 0, rgbaOffset = 0; pixelIndex < gray.length; pixelIndex++, rgbaOffset += 4) {
    gray[pixelIndex] = 0.299 * data[rgbaOffset] + 0.587 * data[rgbaOffset + 1] + 0.114 * data[rgbaOffset + 2];
  }
  return gray;
}

function blur3(source, width, height) {
  const scratch = new Float32Array(source.length);
  const out = new Float32Array(source.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;
      const left = source[x > 0 ? pixelIndex - 1 : pixelIndex];
      const right = source[x < width - 1 ? pixelIndex + 1 : pixelIndex];
      scratch[pixelIndex] = (left + 2 * source[pixelIndex] + right) / 4;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;
      const above = scratch[y > 0 ? pixelIndex - width : pixelIndex];
      const below = scratch[y < height - 1 ? pixelIndex + width : pixelIndex];
      out[pixelIndex] = (above + 2 * scratch[pixelIndex] + below) / 4;
    }
  }
  return out;
}

/** Thin gradient edges. Returns edge pixel list (index, gradient angle) and a "near an edge" map. */
function findEdges(gray, width, height) {
  const magnitudes = new Float32Array(width * height);
  const gradientsX = new Float32Array(width * height);
  const gradientsY = new Float32Array(width * height);
  let sum = 0;
  let sumSq = 0;
  let edgeCount = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const pixelIndex = y * width + x;
      const gradientX = gray[pixelIndex - width + 1] + 2 * gray[pixelIndex + 1] + gray[pixelIndex + width + 1] - gray[pixelIndex - width - 1] - 2 * gray[pixelIndex - 1] - gray[pixelIndex + width - 1];
      const gradientY = gray[pixelIndex + width - 1] + 2 * gray[pixelIndex + width] + gray[pixelIndex + width + 1] - gray[pixelIndex - width - 1] - 2 * gray[pixelIndex - width] - gray[pixelIndex - width + 1];
      gradientsX[pixelIndex] = gradientX;
      gradientsY[pixelIndex] = gradientY;
      const magnitude = Math.abs(gradientX) + Math.abs(gradientY);
      magnitudes[pixelIndex] = magnitude;
      sum += magnitude;
      sumSq += magnitude * magnitude;
      edgeCount++;
    }
  }
  const mean = sum / edgeCount;
  const standardDeviation = Math.sqrt(Math.max(0, sumSq / edgeCount - mean * mean));
  const threshold = Math.max(28, mean + 0.8 * standardDeviation);

  const edges = []; // [index, gx, gy]
  const edgeMap = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const pixelIndex = y * width + x;
      const magnitude = magnitudes[pixelIndex];
      if (magnitude <= threshold) continue;
      const absGradientX = Math.abs(gradientsX[pixelIndex]);
      const absGradientY = Math.abs(gradientsY[pixelIndex]);
      let neighborA;
      let neighborB;
      if (absGradientY <= 0.4142 * absGradientX) {
        neighborA = magnitudes[pixelIndex - 1];
        neighborB = magnitudes[pixelIndex + 1];
      } else if (absGradientY >= 2.4142 * absGradientX) {
        neighborA = magnitudes[pixelIndex - width];
        neighborB = magnitudes[pixelIndex + width];
      } else if (gradientsX[pixelIndex] * gradientsY[pixelIndex] > 0) {
        neighborA = magnitudes[pixelIndex - width - 1];
        neighborB = magnitudes[pixelIndex + width + 1];
      } else {
        neighborA = magnitudes[pixelIndex - width + 1];
        neighborB = magnitudes[pixelIndex + width - 1];
      }
      if (magnitude >= neighborA && magnitude >= neighborB) {
        edges.push(pixelIndex, gradientsX[pixelIndex], gradientsY[pixelIndex]);
        edgeMap[pixelIndex] = 1;
      }
    }
  }

  // "near" = within 2 px of an edge pixel (separable 5x5 max).
  const near = dilate(dilate(edgeMap, width, height, 1, 0), width, height, 0, 1);
  return { edges, near };
}

/** 1-D max filter (radius 2) of a 0/1 map along the (dx, dy) axis. */
function dilate(map, width, height, stepX, stepY) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let found = 0;
      for (let offset = -2; offset <= 2 && !found; offset++) {
        const neighborX = x + offset * stepX;
        const neighborY = y + offset * stepY;
        if (neighborX >= 0 && neighborX < width && neighborY >= 0 && neighborY < height && map[neighborY * width + neighborX]) found = 1;
      }
      out[y * width + x] = found;
    }
  }
  return out;
}

const COS = new Float64Array(THETA_BINS);
const SIN = new Float64Array(THETA_BINS);
for (let thetaBin = 0; thetaBin < THETA_BINS; thetaBin++) {
  COS[thetaBin] = Math.cos((thetaBin * Math.PI) / THETA_BINS);
  SIN[thetaBin] = Math.sin((thetaBin * Math.PI) / THETA_BINS);
}

/**
 * Strongest straight lines as {theta (bin, degrees), rho, votes}, after suppressing near-duplicates.
 * A line is (theta, rho) with x cos(theta) + y sin(theta) = rho. theta runs over [0, 180), and the
 * same line is also (theta + 180, -rho), so cells next to the 0/180 boundary are neighbours with
 * the sign of rho flipped. That wrap matters: vertical edges sit right on the boundary.
 */
function houghLines(edges, width, height) {
  const diagonal = Math.ceil(Math.hypot(width, height));
  const rhoCount = 2 * diagonal + 1;
  const accumulator = new Float32Array(THETA_BINS * rhoCount);
  const centerX = width / 2; // offsets are measured from the picture centre: that keeps peaks tight
  const centerY = height / 2;
  for (let edgeOffset = 0; edgeOffset < edges.length; edgeOffset += 3) {
    const pixelIndex = edges[edgeOffset];
    const x = (pixelIndex % width) - centerX;
    const y = Math.floor(pixelIndex / width) - centerY;
    const degrees = (Math.atan2(edges[edgeOffset + 2], edges[edgeOffset + 1]) * 180) / Math.PI;
    const centerTheta = Math.round(degrees);
    // The gradient angle of a noisy edge pixel is only good to about +-8 degrees, so each pixel
    // votes over a window. A real line still piles every vote into one cell; noise spreads thin.
    for (let voteOffset = -VOTE_WINDOW; voteOffset <= VOTE_WINDOW; voteOffset++) {
      const thetaBin = (((centerTheta + voteOffset) % THETA_BINS) + THETA_BINS) % THETA_BINS;
      accumulator[thetaBin * rhoCount + Math.round(x * COS[thetaBin] + y * SIN[thetaBin]) + diagonal] += 1;
    }
  }
  const accumulatorAt = (accumulator, thetaBin, rhoBin) => {
    let wrappedRho = rhoBin;
    let wrappedTheta = thetaBin;
    if (wrappedTheta < 0) {
      wrappedTheta += THETA_BINS;
      wrappedRho = -wrappedRho;
    } else if (wrappedTheta >= THETA_BINS) {
      wrappedTheta -= THETA_BINS;
      wrappedRho = -wrappedRho;
    }
    const rhoColumn = wrappedRho + diagonal;
    return rhoColumn < 0 || rhoColumn >= rhoCount ? 0 : accumulator[wrappedTheta * rhoCount + rhoColumn];
  };

  // smooth along rho (an edge may be a pixel or two thick)
  const smoothed = new Float32Array(accumulator.length);
  for (let thetaBin = 0; thetaBin < THETA_BINS; thetaBin++) {
    const base = thetaBin * rhoCount;
    for (let rhoBin = 1; rhoBin < rhoCount - 1; rhoBin++) smoothed[base + rhoBin] = accumulator[base + rhoBin - 1] + 2 * accumulator[base + rhoBin] + accumulator[base + rhoBin + 1];
  }

  const minLength = 0.28 * Math.min(width, height); // shortest edge worth considering, in pixels
  const minVotes = 1.6 * minLength; // measured: a clean edge scores roughly 1.5 x its length
  const peaks = [];
  for (let thetaBin = 0; thetaBin < THETA_BINS; thetaBin++) {
    for (let rhoColumn = 3; rhoColumn < rhoCount - 3; rhoColumn++) {
      const votes = smoothed[thetaBin * rhoCount + rhoColumn];
      if (votes < minVotes) continue;
      const rho = rhoColumn - diagonal;
      let isMax = true;
      for (let thetaOffset = -3; thetaOffset <= 3 && isMax; thetaOffset++) {
        for (let rhoOffset = -3; rhoOffset <= 3; rhoOffset++) {
          if (!thetaOffset && !rhoOffset) continue;
          const neighbor = accumulatorAt(smoothed, thetaBin + thetaOffset, rho + rhoOffset);
          if (neighbor > votes || (neighbor === votes && (thetaOffset < 0 || (thetaOffset === 0 && rhoOffset < 0)))) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) peaks.push({ theta: thetaBin, rho, votes: votes });
    }
  }
  peaks.sort((first, second) => second.votes - first.votes);

  const lines = [];
  for (const peak of peaks) {
    const isDuplicate = lines.some((accepted) => {
      let dTheta = Math.abs(peak.theta - accepted.theta);
      let rhoDifference = Math.abs(peak.rho - accepted.rho);
      if (dTheta > THETA_BINS / 2) {
        dTheta = THETA_BINS - dTheta;
        rhoDifference = Math.abs(peak.rho + accepted.rho); // wrapping flips the normal, and so the sign of rho
      }
      return dTheta < 8 && rhoDifference < 8;
    });
    if (!isDuplicate) lines.push(peak);
    if (lines.length >= MAX_LINES) break;
  }
  return lines;
}

const angleBetween = (lineA, lineB) => {
  const difference = Math.abs(lineA.theta - lineB.theta);
  return Math.min(difference, THETA_BINS - difference);
};

function intersect(lineA, lineB, centerX, centerY) {
  const determinant = COS[lineA.theta] * SIN[lineB.theta] - SIN[lineA.theta] * COS[lineB.theta];
  if (Math.abs(determinant) < 1e-3) return null;
  return {
    x: (lineA.rho * SIN[lineB.theta] - lineB.rho * SIN[lineA.theta]) / determinant + centerX,
    y: (COS[lineA.theta] * lineB.rho - COS[lineB.theta] * lineA.rho) / determinant + centerY,
  };
}

function polygonArea(polygon) {
  let doubleArea = 0;
  for (let vertexIndex = 0; vertexIndex < polygon.length; vertexIndex++) {
    const current = polygon[vertexIndex];
    const next = polygon[(vertexIndex + 1) % polygon.length];
    doubleArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(doubleArea) / 2;
}

function isConvex(polygon) {
  let sign = 0;
  for (let vertexIndex = 0; vertexIndex < polygon.length; vertexIndex++) {
    const current = polygon[vertexIndex];
    const next = polygon[(vertexIndex + 1) % polygon.length];
    const afterNext = polygon[(vertexIndex + 2) % polygon.length];
    const cross = (next.x - current.x) * (afterNext.y - next.y) - (next.y - current.y) * (afterNext.x - next.x);
    if (Math.abs(cross) < 1e-6) return false;
    const turn = Math.sign(cross);
    if (sign && turn !== sign) return false;
    sign = turn;
  }
  return true;
}

function containsPoint(polygon, x, y) {
  let sign = 0;
  for (let vertexIndex = 0; vertexIndex < polygon.length; vertexIndex++) {
    const current = polygon[vertexIndex];
    const next = polygon[(vertexIndex + 1) % polygon.length];
    const cross = (next.x - current.x) * (y - current.y) - (next.y - current.y) * (x - current.x);
    const turn = Math.sign(cross);
    if (turn && sign && turn !== sign) return false;
    if (turn) sign = turn;
  }
  return true;
}

/** Fraction of points along a side that lie next to an edge pixel. */
function sideCoverage(near, width, height, start, end) {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  const steps = Math.max(1, Math.floor(length / 1.5));
  let inside = 0;
  let hits = 0;
  for (let step = 0; step <= steps; step++) {
    const x = Math.round(start.x + ((end.x - start.x) * step) / steps);
    const y = Math.round(start.y + ((end.y - start.y) * step) / steps);
    if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue; // part of the side is off-screen
    inside++;
    if (near[y * width + x]) hits++;
  }
  return inside < 12 ? 0 : hits / inside;
}

/** Order four points clockwise from the top-left (screen coordinates). */
export function orderCorners(points) {
  const centerX = points.reduce((sum, point) => sum + point.x, 0) / 4;
  const centerY = points.reduce((sum, point) => sum + point.y, 0) / 4;
  const sorted = [...points].sort((first, second) => Math.atan2(first.y - centerY, first.x - centerX) - Math.atan2(second.y - centerY, second.x - centerX));
  // atan2 ascending = clockwise on screen; start at the corner nearest the top-left
  let start = 0;
  for (let cornerIndex = 1; cornerIndex < 4; cornerIndex++) if (sorted[cornerIndex].x + sorted[cornerIndex].y < sorted[start].x + sorted[start].y) start = cornerIndex;
  return [0, 1, 2, 3].map((cornerIndex) => sorted[(start + cornerIndex) % 4]);
}

/** Estimated width / height of the flat object seen as this quad (tl, tr, br, bl). */
export function quadAspect([topLeft, topRight, bottomRight, bottomLeft]) {
  const distance = (pointA, pointB) => Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y);
  return (distance(topLeft, topRight) + distance(bottomLeft, bottomRight)) / 2 / ((distance(topLeft, bottomLeft) + distance(topRight, bottomRight)) / 2);
}

/**
 * Find a book outline (by default only upright, portrait-shaped ones; pass { portrait: false } to
 * also accept books lying on their side). Returns { corners: [tl, tr, br, bl] (pixels of `image`), score, area }
 * where area is the fraction of the picture covered, or null when nothing convincing is found.
 */
export function detectBook(image, { portrait = true } = {}) {
  const { width: width, height: height } = image;
  if (width < 32 || height < 32) return null;
  const gray = blur3(toGray(image), width, height);
  const { edges, near } = findEdges(gray, width, height);
  if (edges.length < 60) return null;
  const lines = houghLines(edges, width, height);
  if (lines.length < 4) return null;

  const frameArea = width * height;
  const margin = 0.1;
  const centerX = width / 2;
  const centerY = height / 2;
  let best = null;

  // pairs of roughly parallel lines = opposite sides of the book
  const pairs = [];
  for (let firstIndex = 0; firstIndex < lines.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < lines.length; secondIndex++) {
      if (angleBetween(lines[firstIndex], lines[secondIndex]) <= 22) pairs.push([lines[firstIndex], lines[secondIndex]]);
    }
  }
  const meanTheta = (pair) => {
    // average of two angles on a 180-degree circle
    let thetaA = pair[0].theta;
    let thetaB = pair[1].theta;
    if (Math.abs(thetaA - thetaB) > 90) thetaB += thetaA > thetaB ? 180 : -180;
    return (((thetaA + thetaB) / 2) % 180 + 180) % 180;
  };
  const thetas = pairs.map(meanTheta);

  for (let firstPairIndex = 0; firstPairIndex < pairs.length; firstPairIndex++) {
    for (let secondPairIndex = firstPairIndex + 1; secondPairIndex < pairs.length; secondPairIndex++) {
      const [lineA1, lineA2] = pairs[firstPairIndex];
      const [lineB1, lineB2] = pairs[secondPairIndex];
      if (lineA1 === lineB1 || lineA1 === lineB2 || lineA2 === lineB1 || lineA2 === lineB2) continue;
      let angleDifference = Math.abs(thetas[firstPairIndex] - thetas[secondPairIndex]);
      angleDifference = Math.min(angleDifference, 180 - angleDifference);
      if (angleDifference < 55) continue; // the two pairs must be roughly perpendicular

      const quadCorners = [intersect(lineA1, lineB1, centerX, centerY), intersect(lineA1, lineB2, centerX, centerY), intersect(lineA2, lineB2, centerX, centerY), intersect(lineA2, lineB1, centerX, centerY)];
      if (quadCorners.some((corner) => !corner)) continue;
      if (quadCorners.some((corner) => corner.x < -margin * width || corner.x > (1 + margin) * width || corner.y < -margin * height || corner.y > (1 + margin) * height)) continue;
      if (!isConvex(quadCorners)) continue;
      const area = polygonArea(quadCorners) / frameArea;
      if (area < 0.1 || area > 1.2) continue;
      if (!containsPoint(quadCorners, centerX, centerY)) continue;

      const sideCoverages = [0, 1, 2, 3].map((cornerIndex) => sideCoverage(near, width, height, quadCorners[cornerIndex], quadCorners[(cornerIndex + 1) % 4]));
      const minCov = Math.min(...sideCoverages);
      const meanCov = (sideCoverages[0] + sideCoverages[1] + sideCoverages[2] + sideCoverages[3]) / 4;
      if (minCov < 0.4 || meanCov < 0.6) continue;
      // Books are held upright: an outline must be taller than wide (width per height under about 1).
      // Within that, a plausible book is about 0.5 to 0.9 wide per tall; outside it is probably a
      // wrong line (a box far too tall is skinny, one far too short is squat), so penalise it.
      const ratio = quadAspect(orderCorners(quadCorners));
      if (portrait && ratio > PORTRAIT_LIMIT) continue;
      const shape = portrait ? ratio : Math.min(ratio, 1 / ratio);
      const shapePenalty = SHAPE_WEIGHT * Math.max(0, SHAPE_MIN - shape, shape - SHAPE_MAX);
      const score = 0.5 * minCov + 0.5 * meanCov + 0.35 * Math.min(area, 1) - shapePenalty;
      if (!best || score > best.score) best = { corners: quadCorners, score, area };
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
export function cornerShift(before, after, width, height) {
  const diagonal = Math.hypot(width, height);
  return Math.max(...before.map((corner, cornerIndex) => Math.hypot(corner.x - after[cornerIndex].x, corner.y - after[cornerIndex].y))) / diagonal;
}

/** Homography mapping the unit square (0,0)=tl (1,0)=tr (1,1)=br (0,1)=bl onto the quad. */
export function squareToQuad([topLeft, topRight, bottomRight, bottomLeft]) {
  const deltaX1 = topRight.x - bottomRight.x;
  const deltaX2 = bottomLeft.x - bottomRight.x;
  const deltaX3 = topLeft.x - topRight.x + bottomRight.x - bottomLeft.x;
  const deltaY1 = topRight.y - bottomRight.y;
  const deltaY2 = bottomLeft.y - bottomRight.y;
  const deltaY3 = topLeft.y - topRight.y + bottomRight.y - bottomLeft.y;
  if (Math.abs(deltaX3) < 1e-9 && Math.abs(deltaY3) < 1e-9) {
    return { a: topRight.x - topLeft.x, b: bottomRight.x - topRight.x, c: topLeft.x, d: topRight.y - topLeft.y, e: bottomRight.y - topRight.y, f: topLeft.y, g: 0, h: 0, affine: true };
  }
  const denominator = deltaX1 * deltaY2 - deltaY1 * deltaX2;
  const perspectiveX = (deltaX3 * deltaY2 - deltaY3 * deltaX2) / denominator;
  const perspectiveY = (deltaX1 * deltaY3 - deltaY1 * deltaX3) / denominator;
  return {
    a: topRight.x - topLeft.x + perspectiveX * topRight.x,
    b: bottomLeft.x - topLeft.x + perspectiveY * bottomLeft.x,
    c: topLeft.x,
    d: topRight.y - topLeft.y + perspectiveX * topRight.y,
    e: bottomLeft.y - topLeft.y + perspectiveY * bottomLeft.y,
    f: topLeft.y,
    g: perspectiveX,
    h: perspectiveY,
  };
}

export function mapUnit(matrix, unitU, unitV) {
  if (matrix.affine) {
    // for the affine case a,b are the u,v coefficients along edges p0->p1 and p1->p2
    return { x: matrix.c + matrix.a * unitU + matrix.b * unitV, y: matrix.f + matrix.d * unitU + matrix.e * unitV };
  }
  const denominator = matrix.g * unitU + matrix.h * unitV + 1;
  return { x: (matrix.a * unitU + matrix.b * unitV + matrix.c) / denominator, y: (matrix.d * unitU + matrix.e * unitV + matrix.f) / denominator };
}

/**
 * Flatten the quad (tl, tr, br, bl in `image` pixels) into an upright outW x outH picture,
 * bilinear sampled. Returns { data, width, height } (RGBA).
 */
export function warpQuad(image, corners, outputWidth, outputHeight) {
  const matrix = squareToQuad(corners);
  const { data, width, height } = image;
  const out = new Uint8ClampedArray(outputWidth * outputHeight * 4);
  for (let outputY = 0; outputY < outputHeight; outputY++) {
    const unitV = (outputY + 0.5) / outputHeight;
    for (let outputX = 0; outputX < outputWidth; outputX++) {
      const unitU = (outputX + 0.5) / outputWidth;
      const { x, y } = mapUnit(matrix, unitU, unitV);
      const sourceX = clamp(x - 0.5, 0, width - 1.001);
      const sourceY = clamp(y - 0.5, 0, height - 1.001);
      const floorX = Math.floor(sourceX);
      const floorY = Math.floor(sourceY);
      const fractionX = sourceX - floorX;
      const fractionY = sourceY - floorY;
      const topLeftIndex = (floorY * width + floorX) * 4;
      const topRightIndex = topLeftIndex + 4;
      const bottomLeftIndex = topLeftIndex + width * 4;
      const bottomRightIndex = bottomLeftIndex + 4;
      const outputOffset = (outputY * outputWidth + outputX) * 4;
      for (let channel = 0; channel < 4; channel++) {
        const top = data[topLeftIndex + channel] * (1 - fractionX) + data[topRightIndex + channel] * fractionX;
        const bottom = data[bottomLeftIndex + channel] * (1 - fractionX) + data[bottomRightIndex + channel] * fractionX;
        out[outputOffset + channel] = top * (1 - fractionY) + bottom * fractionY;
      }
    }
  }
  return { data: out, width: outputWidth, height: outputHeight };
}

/**
 * Output size for a flattened cover: portrait, about `maxSide` px on the long side. Aspect
 * ratios close to a standard 2:3 cover are snapped to exactly 2:3 so nothing is trimmed later.
 */
export function coverOutputSize(corners, maxSide = 1200) {
  let ratio = quadAspect(corners);
  if (ratio >= 0.6 && ratio <= 0.75) ratio = 2 / 3;
  ratio = clamp(ratio, 0.4, 1.2);
  const outputHeight = Math.round(maxSide);
  return { width: Math.round(outputHeight * ratio), height: outputHeight };
}

/** Rotate the corner order a quarter turn so a sideways (landscape) quad becomes upright. */
export function uprightCorners(corners) {
  const [topLeft, topRight, bottomRight, bottomLeft] = corners;
  return quadAspect(corners) > 1.05 ? [bottomLeft, topLeft, topRight, bottomRight] : corners;
}

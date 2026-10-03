import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBook, isConvexQuad, warpQuad, squareToQuad, mapUnit, orderCorners, quadAspect, coverOutputSize, uprightCorners, cornerShift } from '../public/js/detect.js';
import { makeScene, point } from './detect-scenes.js';

const WIDTH = 256;
const HEIGHT = 192;
const diagonal = Math.hypot(WIDTH, HEIGHT);

function maxError(found, truth) {
  return Math.max(...found.map((corner, index) => Math.hypot(corner.x - truth[index].x, corner.y - truth[index].y))) / diagonal;
}

const scenes = {
  'upright, plain table': { quad: [point(88, 24), point(172, 24), point(172, 168), point(88, 168)] },
  'rotated 12 degrees': { quad: [point(100, 22), point(176, 37), point(150, 173), point(74, 158)] },
  'perspective tilt': { quad: [point(84, 30), point(176, 20), point(184, 172), point(76, 160)] },
  'big, nearly fills view': { quad: [point(62, 8), point(194, 8), point(194, 184), point(62, 184)] },
  'wood-grain table': { quad: [point(90, 26), point(170, 26), point(170, 166), point(90, 166)], background: 'wood', seed: 3 },
  'rotated on wood': { quad: [point(98, 24), point(172, 40), point(146, 170), point(72, 154)], background: 'wood', seed: 4 },
  'cluttered table': { quad: [point(86, 22), point(174, 22), point(174, 170), point(86, 170)], background: 'clutter', seed: 5 },
  'low contrast cover': { quad: [point(88, 24), point(172, 24), point(172, 168), point(88, 168)], coverTone: 105 },
};

for (const [name, spec] of Object.entries(scenes)) {
  test(`finds the book: ${name}`, () => {
    const image = makeScene(spec);
    const startTime = performance.now();
    const found = detectBook(image);
    const elapsedMs = performance.now() - startTime;
    assert.ok(found, 'no book detected');
    const err = maxError(found.corners, spec.quad);
    assert.ok(err < 0.035, `corner error ${(err * 100).toFixed(1)}% of the diagonal (limit 3.5%)`);
    assert.ok(elapsedMs < 250, `too slow: ${elapsedMs.toFixed(0)} ms`);
  });
}

test('no book in view: empty table, noise and clutter report nothing', () => {
  for (const background of ['plain', 'wood', 'clutter']) {
    for (const seed of [1, 2, 3]) {
      const found = detectBook(makeScene({ background, seed, quad: null }));
      if (found) assert.fail(`false detection on "${background}" seed ${seed}: area ${found.area.toFixed(2)}`);
    }
  }
});

test('stable: the same scene gives (almost) the same corners every time', () => {
  const spec = scenes['rotated 12 degrees'];
  const firstResult = detectBook(makeScene({ ...spec, seed: 11 }));
  const secondResult = detectBook(makeScene({ ...spec, seed: 12 })); // different noise
  assert.ok(firstResult && secondResult);
  assert.ok(cornerShift(firstResult.corners, secondResult.corners, WIDTH, HEIGHT) < 0.01);
});

test('corner ordering is tl, tr, br, bl regardless of input order', () => {
  const quad = [point(100, 20), point(180, 30), point(170, 170), point(90, 160)];
  for (const shuffled of [[2, 0, 3, 1], [3, 2, 1, 0], [1, 3, 0, 2]]) {
    const ordered = orderCorners(shuffled.map((index) => quad[index]));
    assert.deepEqual(ordered, quad);
  }
});

test('homography maps the unit square corners onto the quad', () => {
  const quad = [point(10, 12), point(210, 30), point(190, 260), point(25, 230)];
  const matrix = squareToQuad(quad);
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([unitU, unitV], index) => {
    const corner = mapUnit(matrix, unitU, unitV);
    assert.ok(Math.hypot(corner.x - quad[index].x, corner.y - quad[index].y) < 1e-6, `corner ${index}`);
  });
  const affine = squareToQuad([point(0, 0), point(10, 0), point(10, 20), point(0, 20)]);
  assert.deepEqual(mapUnit(affine, 0.5, 0.5), { x: 5, y: 10 });
});

test('warpQuad flattens a tilted cover back to its pattern', () => {
  const spec = scenes['perspective tilt'];
  const image = makeScene({ ...spec, noise: 0 });
  const found = detectBook(image);
  const { width, height } = coverOutputSize(found.corners, 300);
  assert.equal(width, 200); // ratio snapped to 2:3
  const flat = warpQuad(image, found.corners, width, height);
  const lum = (x, y) => flat.data[(y * width + x) * 4 + 1];
  // the cover has a dark title band in the top 22% and a plain, lighter body at the bottom
  assert.ok(lum(100, 20) < lum(100, 280) - 20, 'title band should be at the top');
  // after flattening the cover fills the picture edge to edge: no table (150) at any border
  for (const y of [30, 150, 280]) {
    assert.ok(lum(3, y) < 120, `left border at y=${y}`);
    assert.ok(lum(width - 4, y) < 120, `right border at y=${y}`);
  }
  for (const x of [20, 100, 180]) {
    assert.ok(lum(x, 3) < 120, `top border at x=${x}`);
    assert.ok(lum(x, height - 4) < 120, `bottom border at x=${x}`);
  }
});

test('sideways quads are rotated upright; aspect helper', () => {
  const tall = [point(0, 0), point(100, 0), point(100, 150), point(0, 150)];
  const wide = [point(0, 0), point(150, 0), point(150, 100), point(0, 100)];
  assert.ok(Math.abs(quadAspect(tall) - 2 / 3) < 1e-9);
  assert.equal(uprightCorners(tall), tall);
  assert.ok(quadAspect(uprightCorners(wide)) < 1);
});

test('outline validity: convex and big enough; crossed or tiny outlines are rejected', () => {
  const area = 256 * 192;
  assert.ok(isConvexQuad([point(80, 20), point(170, 25), point(165, 170), point(85, 165)], area));
  assert.ok(!isConvexQuad([point(80, 20), point(170, 170), point(170, 20), point(80, 170)], area), 'bow-tie (corners crossed)');
  assert.ok(!isConvexQuad([point(100, 100), point(105, 100), point(105, 106), point(100, 106)], area), 'tiny');
  assert.ok(!isConvexQuad([point(10, 10), point(200, 10), point(100, 80), point(10, 170)], area), 'dented (concave)');
});

test('portrait mode: upright books are found, books lying on their side are ignored unless allowed', () => {
  const upright = makeScene({ quad: [point(88, 24), point(172, 24), point(172, 168), point(88, 168)] });
  assert.ok(detectBook(upright), 'upright book');
  // the same book turned a quarter turn: wider than tall
  const sideways = makeScene({ quad: [point(40, 50), point(216, 50), point(216, 142), point(40, 142)] });
  assert.equal(detectBook(sideways), null, 'sideways book must not be reported in portrait mode');
  const found = detectBook(sideways, { portrait: false });
  assert.ok(found, 'sideways book is still found when portrait is off');
  assert.ok(quadAspect(found.corners) > 1);
  // empty table: still nothing either way
  assert.equal(detectBook(makeScene({ quad: null }), { portrait: false }), null);
});

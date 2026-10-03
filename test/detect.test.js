import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBook, isConvexQuad, warpQuad, squareToQuad, mapUnit, orderCorners, quadAspect, coverOutputSize, uprightCorners, cornerShift } from '../public/js/detect.js';
import { makeScene, P } from './detect-scenes.js';

const W = 256;
const H = 192;
const diag = Math.hypot(W, H);

function maxError(found, truth) {
  return Math.max(...found.map((p, i) => Math.hypot(p.x - truth[i].x, p.y - truth[i].y))) / diag;
}

const scenes = {
  'upright, plain table': { quad: [P(88, 24), P(172, 24), P(172, 168), P(88, 168)] },
  'rotated 12 degrees': { quad: [P(100, 22), P(176, 37), P(150, 173), P(74, 158)] },
  'perspective tilt': { quad: [P(84, 30), P(176, 20), P(184, 172), P(76, 160)] },
  'big, nearly fills view': { quad: [P(62, 8), P(194, 8), P(194, 184), P(62, 184)] },
  'wood-grain table': { quad: [P(90, 26), P(170, 26), P(170, 166), P(90, 166)], background: 'wood', seed: 3 },
  'rotated on wood': { quad: [P(98, 24), P(172, 40), P(146, 170), P(72, 154)], background: 'wood', seed: 4 },
  'cluttered table': { quad: [P(86, 22), P(174, 22), P(174, 170), P(86, 170)], background: 'clutter', seed: 5 },
  'low contrast cover': { quad: [P(88, 24), P(172, 24), P(172, 168), P(88, 168)], coverTone: 105 },
};

for (const [name, spec] of Object.entries(scenes)) {
  test(`finds the book: ${name}`, () => {
    const img = makeScene(spec);
    const t0 = performance.now();
    const found = detectBook(img);
    const ms = performance.now() - t0;
    assert.ok(found, 'no book detected');
    const err = maxError(found.corners, spec.quad);
    assert.ok(err < 0.035, `corner error ${(err * 100).toFixed(1)}% of the diagonal (limit 3.5%)`);
    assert.ok(ms < 250, `too slow: ${ms.toFixed(0)} ms`);
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
  const a = detectBook(makeScene({ ...spec, seed: 11 }));
  const b = detectBook(makeScene({ ...spec, seed: 12 })); // different noise
  assert.ok(a && b);
  assert.ok(cornerShift(a.corners, b.corners, W, H) < 0.01);
});

test('corner ordering is tl, tr, br, bl regardless of input order', () => {
  const quad = [P(100, 20), P(180, 30), P(170, 170), P(90, 160)];
  for (const shuffled of [[2, 0, 3, 1], [3, 2, 1, 0], [1, 3, 0, 2]]) {
    const ordered = orderCorners(shuffled.map((i) => quad[i]));
    assert.deepEqual(ordered, quad);
  }
});

test('homography maps the unit square corners onto the quad', () => {
  const quad = [P(10, 12), P(210, 30), P(190, 260), P(25, 230)];
  const m = squareToQuad(quad);
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => {
    const p = mapUnit(m, u, v);
    assert.ok(Math.hypot(p.x - quad[i].x, p.y - quad[i].y) < 1e-6, `corner ${i}`);
  });
  const affine = squareToQuad([P(0, 0), P(10, 0), P(10, 20), P(0, 20)]);
  assert.deepEqual(mapUnit(affine, 0.5, 0.5), { x: 5, y: 10 });
});

test('warpQuad flattens a tilted cover back to its pattern', () => {
  const spec = scenes['perspective tilt'];
  const img = makeScene({ ...spec, noise: 0 });
  const found = detectBook(img);
  const { width, height } = coverOutputSize(found.corners, 300);
  assert.equal(width, 200); // ratio snapped to 2:3
  const flat = warpQuad(img, found.corners, width, height);
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
  const tall = [P(0, 0), P(100, 0), P(100, 150), P(0, 150)];
  const wide = [P(0, 0), P(150, 0), P(150, 100), P(0, 100)];
  assert.ok(Math.abs(quadAspect(tall) - 2 / 3) < 1e-9);
  assert.equal(uprightCorners(tall), tall);
  assert.ok(quadAspect(uprightCorners(wide)) < 1);
});

test('outline validity: convex and big enough; crossed or tiny outlines are rejected', () => {
  const area = 256 * 192;
  assert.ok(isConvexQuad([P(80, 20), P(170, 25), P(165, 170), P(85, 165)], area));
  assert.ok(!isConvexQuad([P(80, 20), P(170, 170), P(170, 20), P(80, 170)], area), 'bow-tie (corners crossed)');
  assert.ok(!isConvexQuad([P(100, 100), P(105, 100), P(105, 106), P(100, 106)], area), 'tiny');
  assert.ok(!isConvexQuad([P(10, 10), P(200, 10), P(100, 80), P(10, 170)], area), 'dented (concave)');
});

test('portrait mode: upright books are found, books lying on their side are ignored unless allowed', () => {
  const upright = makeScene({ quad: [P(88, 24), P(172, 24), P(172, 168), P(88, 168)] });
  assert.ok(detectBook(upright), 'upright book');
  // the same book turned a quarter turn: wider than tall
  const sideways = makeScene({ quad: [P(40, 50), P(216, 50), P(216, 142), P(40, 142)] });
  assert.equal(detectBook(sideways), null, 'sideways book must not be reported in portrait mode');
  const found = detectBook(sideways, { portrait: false });
  assert.ok(found, 'sideways book is still found when portrait is off');
  assert.ok(quadAspect(found.corners) > 1);
  // empty table: still nothing either way
  assert.equal(detectBook(makeScene({ quad: null }), { portrait: false }), null);
});

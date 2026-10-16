import { describe, expect, it } from 'vitest';
import { socketsFit, type Sockets } from './analysis';
import { ALL_FACES, OPPOSITE } from './profile';
import { FACE_OFFSETS, buildVariants, cellCoords, cellIndex, solveWfc, tagFilter, type WfcResult } from './wfc';

/** Every pair of placed neighbours must fit. */
function checkSolution(res: WfcResult) {
  const { size, cells, variants } = res;
  for (let i = 0; i < cells.length; i++) {
    const [x, y, z] = cellCoords(size, i);
    for (const f of ALL_FACES) {
      const d = FACE_OFFSETS[f];
      const p = [x + d[0], y + d[1], z + d[2]];
      if (!p.every((v, a) => v >= 0 && v < size[a])) continue;
      const a = variants[cells[i]];
      const b = variants[cells[cellIndex(size, p[0], p[1], p[2])]];
      expect(socketsFit(f, a.sockets[f], b.sockets[OPPOSITE[f]]), `${i} ${f}`).toBe(true);
    }
  }
}

const all = (id: string): Sockets => ({ posX: id, negZ: id, negX: id, posZ: id });

/** The wall from the format spec: outside on -X, inside on +X. */
const WALL: Sockets = { posX: 'i', negZ: 'io', negX: 'o', posZ: 'oi' };

describe('buildVariants', () => {
  it('turns tiles like the loader and infers missing faces', () => {
    const [v0, v1] = buildVariants([{ sockets: WALL, weight: 1 }]);
    expect(v0.sockets).toEqual({ ...WALL, posY: 'i|io|o|oi', negY: 'i|io|o|oi' });
    // One turn, as in the spec: posX oi, negZ i, negX io, posZ o.
    expect(v1.sockets).toEqual({ posX: 'oi', negZ: 'i', negX: 'io', posZ: 'o', posY: 'oi|i|io|o', negY: 'oi|i|io|o' });
  });

  it('turns explicit faces and keeps a middle part last', () => {
    const v = buildVariants([{ sockets: { ...all('a'), posY: 'A0|A1|A2|A3|c', negY: 'g' }, weight: 1 }]);
    expect(v.map((x) => x.sockets.posY)).toEqual(['A0|A1|A2|A3|c', 'A3|A0|A1|A2|c', 'A2|A3|A0|A1|c', 'A1|A2|A3|A0|c']);
    expect(v.every((x) => x.sockets.negY === 'g')).toBe(true);
  });

  it('merges identical rotations without changing relative weights', () => {
    const v = buildVariants([
      { sockets: all('o'), weight: 1 },
      { sockets: WALL, weight: 1 },
      { sockets: all('c'), weight: 0, tags: ['LastResort'] },
    ]);
    expect(v.map((x) => [x.proto, x.rotation, x.weight])).toEqual([
      [0, 0, 4],
      [1, 0, 1],
      [1, 1, 1],
      [1, 2, 1],
      [1, 3, 1],
      [2, 0, 0],
    ]);
    expect(v[5].lastResort).toBe(true);
  });
});

describe('solveWfc', () => {
  it('solves a flat tileset and every neighbour fits', () => {
    const protos = [
      { sockets: all('a'), weight: 1 },
      { sockets: { posX: 'p', negZ: 'a', negX: 'p', posZ: 'a' }, weight: 1 },
      { sockets: { posX: 'p', negZ: 'p', negX: 'a', posZ: 'a' }, weight: 1 },
      { sockets: { posX: 'ab', negZ: 'a', negX: 'ba', posZ: 'a' }, weight: 1 },
    ];
    const variants = buildVariants(protos);
    for (const seed of [1, 2, 3]) {
      const res = solveWfc(variants, { size: [8, 1, 8], seed });
      expect(res.ok).toBe(true);
      expect([...res.cells].every((c) => c >= 0)).toBe(true);
      checkSolution(res);
    }
  });

  it('is deterministic for a seed', () => {
    const variants = buildVariants([{ sockets: all('a'), weight: 1 }, { sockets: all('b'), weight: 1 }]);
    const a = solveWfc(variants, { size: [5, 2, 5], seed: 7 });
    const b = solveWfc(variants, { size: [5, 2, 5], seed: 7 });
    expect([...a.cells]).toEqual([...b.cells]);
  });

  it('stacks layers with inferred faces and honours the boundary sockets', () => {
    // Ground gives only its bottom; air is all outside, walls stack on walls.
    const protos = [
      { sockets: { ...all('o'), negY: 'g' }, weight: 1 },
      { sockets: all('o'), weight: 1 },
      { sockets: WALL, weight: 1 },
      { sockets: { ...WALL, negY: 'g' }, weight: 1 },
    ];
    const variants = buildVariants(protos);
    const res = solveWfc(variants, { size: [4, 3, 4], seed: 3, outer: 'o', bottom: 'g', top: 'o|o|o|o' });
    expect(res.ok).toBe(true);
    checkSolution(res);
    for (let i = 0; i < res.cells.length; i++) {
      const [x, y, z] = cellCoords(res.size, i);
      const s = variants[res.cells[i]].sockets;
      if (y === 0) expect(s.negY).toBe('g');
      if (y === 2) expect(s.posY).toBe('o|o|o|o');
      if (x === 0) expect(s.negX).toBe('o');
      if (z === 3) expect(s.posZ).toBe('o');
    }
  });

  it('picks weight 0 and LastResort tiles only when nothing else is left', () => {
    const protos = [
      { sockets: all('a'), weight: 1 },
      { sockets: all('a'), weight: 0 },
      { sockets: all('a'), weight: 5, tags: ['LastResort'] },
    ];
    const res = solveWfc(buildVariants(protos), { size: [6, 2, 6], seed: 1 });
    expect(res.ok).toBe(true);
    expect([...res.cells].every((c) => res.variants[c].proto === 0)).toBe(true);

    const onlyFallbacks = solveWfc(buildVariants(protos.slice(1)), { size: [3, 1, 3], seed: 1 });
    expect([...onlyFallbacks.cells].every((c) => onlyFallbacks.variants[c].proto === 0)).toBe(true);
  });

  it('reports a contradiction when tiles cannot be neighbours', () => {
    const protos = [{ sockets: { posX: 'ab', negZ: 'c', negX: 'ab', posZ: 'c' }, weight: 1 }];
    const res = solveWfc(buildVariants(protos), { size: [3, 1, 3], seed: 1, maxAttempts: 3 });
    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(3);
    expect(res.contradiction).not.toBeNull();
  });

  it('uses the ground outer socket on the sides of layer 0 only', () => {
    // Ground gives its sides 'b' and its bottom 'g'; air ('o') goes above.
    const protos = [
      { sockets: { ...all('b'), negY: 'g', posY: 'o|o|o|o' }, weight: 1 },
      { sockets: all('o'), weight: 1 },
    ];
    const variants = buildVariants(protos);
    const opts = { size: [3, 2, 3] as [number, number, number], seed: 1, outer: 'o', bottom: 'g', top: 'o|o|o|o' };
    expect(solveWfc(variants, opts).ok).toBe(false);
    const res = solveWfc(variants, { ...opts, outerGround: 'b' });
    expect(res.ok).toBe(true);
    checkSolution(res);
    for (let i = 0; i < res.cells.length; i++) {
      expect(variants[res.cells[i]].sockets.negX).toBe(cellCoords(res.size, i)[1] === 0 ? 'b' : 'o');
    }
  });
});

describe('tagFilter', () => {
  it('drops prototypes with a hidden tag and always keeps untagged ones', () => {
    const protos = [{ tags: ['Wall', 'Corner'] }, { tags: ['Wall'] }, { tags: ['Roof'] }, {}];
    expect(tagFilter(protos, new Set())).toEqual([true, true, true, true]);
    expect(tagFilter(protos, new Set(['Corner']))).toEqual([false, true, true, true]);
    expect(tagFilter(protos, new Set(['Wall', 'Roof']))).toEqual([false, false, false, true]);
  });
});

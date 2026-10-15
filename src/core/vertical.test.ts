import { describe, expect, it } from 'vitest';
import {
  analyze,
  computeIds,
  faceSocket,
  findUnmatchedFaces,
  meshSockets,
  rotateFace,
  rotateSockets,
  socketsFit,
  type Sockets,
} from './analysis';
import { encodeVertical, parseVertical } from './ids';
import { classifyVertical, makeProfile, rotateV, rotateVec, type Point2 } from './profile';
import { box, rawMesh, rotateMesh, unitySettings } from './testUtils';
import type { Vec3 } from './axis';

const P1: Point2[] = [[-200, -200], [-200, 200], [200, -200], [200, 200]];
const P2: Point2[] = [[-300, 0], [300, 0]];
const P4: Point2[] = [[200, 100]];

describe('vertical rotation', () => {
  it('turns clockwise viewed from above: +X -> -Z -> -X -> +Z', () => {
    expect(rotateVec([1, 0, 0], 1)).toEqual([0, 0, -1]);
    expect(rotateVec([1, 0, 0], 2)).toEqual([-1, 0, 0]);
    expect(rotateVec([1, 0, 0], 3)).toEqual([0, 0, 1]);
    expect(rotateV(makeProfile([[1000, 0]]), 1).points).toEqual([[0, -1000]]);
  });

  it('computes periods 1, 2 and 4', () => {
    expect(classifyVertical(makeProfile(P1)).period).toBe(1);
    expect(classifyVertical(makeProfile(P2)).period).toBe(2);
    expect(classifyVertical(makeProfile(P4)).period).toBe(4);
    expect(classifyVertical(makeProfile([])).period).toBe(1);
  });

  it('puts all rotations in one class with consistent r', () => {
    for (const pts of [P1, P2, P4]) {
      const base = makeProfile(pts);
      const c0 = classifyVertical(base);
      for (let k = 0; k < 4; k++) {
        const c = classifyVertical(rotateV(base, k));
        expect(c.canonical.key).toBe(c0.canonical.key);
        expect(c.period).toBe(c0.period);
        expect(c.r).toBe((c0.r + k) % c0.period);
        expect(rotateV(c.canonical, c.r).key).toBe(rotateV(base, k).key);
      }
    }
  });

  it('distinguishes profiles that differ only by rotation', () => {
    const a = classifyVertical(makeProfile(P4));
    const b = classifyVertical(rotateV(makeProfile(P4), 1));
    expect(encodeVertical('B', a.r, a.period)).not.toBe(encodeVertical('B', b.r, b.period));
  });

  it('encodes in the prototype face format and parses', () => {
    expect(encodeVertical('A', 0, 1)).toBe('A');
    expect(encodeVertical('B', 0, 4)).toBe('B0|B1|B2|B3');
    expect(encodeVertical('B', 3, 4)).toBe('B1|B2|B3|B0');
    expect(encodeVertical('C', 3, 2)).toBe('C1|C0|C1|C0');
    expect(parseVertical('B1|B2|B3|B0')).toEqual({ base: 'B' });
    expect(parseVertical('A')).toEqual({ base: 'A' });
    expect(parseVertical('B3B')).toEqual({ base: 'B' });
    expect(parseVertical('ab')).toBeNull();
    expect(parseVertical('i|io|o|oi')).toBeNull();
  });

  it("matches the loader's turn: last side part to the front", () => {
    expect(rotateFace('i|io|o|oi', 1)).toBe('oi|i|io|o');
    expect(rotateFace('a|b|c|d|m', 2)).toBe('c|d|a|b|m');
    expect(rotateFace('g', 3)).toBe('g');
    for (const period of [2, 4] as const) {
      for (let r = 0; r < period; r++) {
        expect(rotateFace(encodeVertical('B', r, period), 1)).toBe(encodeVertical('B', r + 1, period));
      }
    }
  });
});

/** Tiles with asymmetric features on every face, plus vertical period 1, 2 and 4 profiles. */
function tiles(): Record<string, Vec3[]> {
  return {
    // Floor + pillar in +X/-Z corner (touches posX, negZ, top) + low block touching negX/posZ.
    Mixed: [
      ...box([-0.5, 0, -0.5], [0.5, 0.2, 0.5]),
      ...box([0.1, 0, -0.5], [0.5, 1, -0.2]),
      ...box([-0.5, 0, 0], [-0.3, 0.6, 0.5]),
    ],
    // Two opposite posts reaching the top: period 2 on top.
    Posts: [...box([-0.5, 0, -0.1], [-0.3, 1, 0.1]), ...box([0.3, 0, -0.1], [0.5, 1, 0.1])],
    // Centred column: period 1 top and bottom.
    Column: box([-0.2, 0, -0.2], [0.2, 1, 0.2]),
    // An off-centre ledge.
    Ledge: box([0.2, 0.4, 0.1], [0.5, 0.6, 0.35]),
  };
}

describe('rotation round-trip', () => {
  const defs = tiles();
  const names = Object.keys(defs);
  const raws = names.flatMap((n) => [0, 1, 2, 3].map((k) => rawMesh(`${n}_r${k}`, rotateMesh(defs[n], k))));
  const a = analyze(raws, unitySettings({ vertical: true }));
  const { ids } = computeIds(a);
  const sockets = a.meshes.map((m) => meshSockets(a, ids, m.index, true));

  it('covers periods 1, 2 and 4', () => {
    expect(new Set([...a.vClasses.values()].map((c) => c.period))).toEqual(new Set([1, 2, 4]));
  });

  for (let t = 0; t < names.length; t++) {
    for (let k = 1; k < 4; k++) {
      it(`${names[t]} rotated ${k} quarter turn(s) matches the Unity rule`, () => {
        const original = sockets[t * 4];
        const rotated = sockets[t * 4 + k];
        expect(rotated).toEqual(rotateSockets(original, k));
      });
    }
  }

  it('flags only faces with no possible neighbour', () => {
    // Every tile is present in all rotations, and each face matches some face of the
    // same set only if its mirror exists; check against brute force.
    const unmatched = findUnmatchedFaces(sockets);
    const rotatedAll: Sockets[] = sockets.flatMap((s) => [0, 1, 2, 3].map((k) => rotateSockets(s, k)));
    const opposite = { posX: 'negX', negX: 'posX', posZ: 'negZ', negZ: 'posZ', posY: 'negY', negY: 'posY' } as const;
    sockets.forEach((s, mesh) => {
      for (const [face, id] of Object.entries(s) as [keyof typeof opposite, string][]) {
        const o = opposite[face];
        const ok = rotatedAll.some((r) => socketsFit(face, id, o === 'posY' || o === 'negY' ? faceSocket(r, o) : r[o]!));
        expect(unmatched.some((u) => u.mesh === mesh && u.face === face)).toBe(!ok);
      }
    });
    // The ledge's posX has no mirror partner in this set.
    const ledge = names.indexOf('Ledge') * 4;
    expect(unmatched.some((u) => u.mesh === ledge && u.face === 'posX')).toBe(true);
    // The column's top matches its own bottom.
    const column = names.indexOf('Column') * 4;
    expect(unmatched.some((u) => u.mesh === column && u.face === 'posY')).toBe(false);
  });
});

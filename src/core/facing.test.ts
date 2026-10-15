import { describe, expect, it } from 'vitest';
import { AXIS_PRESETS, cloneMapping, mappingDeterminant, type Vec3 } from './axis';
import { analyze, computeIds, findUnmatchedFaces, meshSockets, rotateSockets, socketsFit } from './analysis';
import { makeProfile, rotateV, rotateVec } from './profile';
import { quadMesh, rawMesh, unitySettings } from './testUtils';

type Quad = { corners: [Vec3, Vec3, Vec3, Vec3]; front: Vec3 };

/** The SimpleTiles case: a centre wall facing -X, with a roof (+X half, top) or a ground (-X half, bottom). */
const wall: Quad = { corners: [[0, 0, -0.5], [0, 1, -0.5], [0, 1, 0.5], [0, 0, 0.5]], front: [-1, 0, 0] };
const roof: Quad = { corners: [[0, 1, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5], [0, 1, 0.5]], front: [0, 1, 0] };
const ground: Quad = { corners: [[-0.5, 0, -0.5], [0, 0, -0.5], [0, 0, 0.5], [-0.5, 0, 0.5]], front: [0, 1, 0] };
/** A ceiling over the roof's half of the bottom plane, facing down (out of the cell). */
const ceiling: Quad = { corners: [[0, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [0, 0, 0.5]], front: [0, -1, 0] };

function tiles(toFile: (v: Vec3) => Vec3 = (v) => v) {
  const conv = (q: Quad): Quad => ({ corners: q.corners.map(toFile) as Quad['corners'], front: toFile(q.front) });
  return [
    quadMesh('WallRoof', [wall, roof].map(conv)),
    quadMesh('GroundWall', [wall, ground].map(conv)),
    quadMesh('CeilingWall', [wall, ceiling].map(conv)),
    rawMesh('-1', []),
  ];
}

describe('face orientation', () => {
  it('tags points by the way their in-plane triangles face', () => {
    const p = makeProfile([[0, 0, 'o'], [0, 0, 'i'], [1, 0, 'o'], [2, 0]]);
    expect(p.facing).toEqual(['b', 'o', '']);
    expect(p.key).toBe('0,0b 1,0o 2,0');
    expect(rotateV(p, 1).facing).toEqual(['', 'o', 'b']);
  });

  it('computes the mapping determinant', () => {
    expect(mappingDeterminant(AXIS_PRESETS.unity.mapping)).toBe(1);
    expect(mappingDeterminant(AXIS_PRESETS.blender.mapping)).toBe(-1);
    expect(mappingDeterminant(AXIS_PRESETS.zup.mapping)).toBe(-1);
  });

  const cases: [string, ReturnType<typeof unitySettings>, (v: Vec3) => Vec3][] = [
    ['Unity axes', unitySettings({ vertical: true }), (v) => v],
    // Blender preset: Unity = (-x, y, z), so the file has x negated (a mirror).
    ['mirroring axis mapping', unitySettings({ vertical: true, axis: cloneMapping(AXIS_PRESETS.blender.mapping) }), (v) => [-v[0], v[1], v[2]]],
  ];
  for (const [name, settings, toFile] of cases) {
    it(`keeps a roof and a ground on the same vertices apart (${name})`, () => {
      const a = analyze(tiles(toFile), settings);
      const [wallRoof, groundWall, ceilingWall, air] = a.meshes;
      // The roof and the ceiling only face out of their cells: open, so their profile is the empty one.
      expect(wallRoof.faces.posY.open).toBe(true);
      expect(wallRoof.faces.posY.profile.points).toEqual([]);
      expect(ceilingWall.faces.negY.open).toBe(true);
      expect(groundWall.faces.negY.open).toBe(false);
      expect(groundWall.faces.negY.profile.facing.every((f) => f === 'i')).toBe(true);
      // The wall's bottom crosses the face without lying in it: closed.
      expect(wallRoof.faces.negY.open).toBe(false);
      // The wall only touches the cell boundary along edges, so its vertices on the side faces are untagged.
      expect(wallRoof.faces.negZ.profile.facing).toContain('');

      const cls = (m: typeof wallRoof, f: 'posY' | 'negY') => a.vProfiles.get(m.faces[f].profile.key)!.classKey;
      // Same points (a 180° turn apart), but ground on roof would be two surfaces in one place.
      expect(cls(groundWall, 'negY')).not.toBe(cls(wallRoof, 'posY'));
      // Back to back is fine: a downward ceiling over the roof.
      expect(cls(ceilingWall, 'negY')).toBe(cls(wallRoof, 'posY'));

      const { ids } = computeIds(a);
      const sockets = a.meshes.map((m) => meshSockets(a, ids, m.index, true));
      expect(sockets[1].negY).not.toBe(sockets[0].posY);
      // Air fits on the roof (and under the ceiling).
      expect(sockets[0].posY).toBe(sockets[3].negY);
      expect(sockets[2].negY).toBe(sockets[3].posY);
      expect(air.faces.posY.open).toBe(false);
      // Ground still needs something with the same inward surface below: nothing here.
      expect(findUnmatchedFaces(sockets)).toContainEqual({ mesh: 1, face: 'negY' });
      expect(findUnmatchedFaces(sockets)).not.toContainEqual({ mesh: 0, face: 'posY' });
    });
  }
});

describe('edge-on surfaces', () => {
  // A centre wall facing -X, and the same wall facing +X (turned 180°).
  const flipped: Quad = { ...wall, front: [1, 0, 0] };
  const a = analyze([quadMesh('Wall', [wall]), quadMesh('Flipped', [flipped])], unitySettings({ vertical: true }));
  const { ids } = computeIds(a);
  const [w, f] = a.meshes.map((m) => meshSockets(a, ids, m.index, true));

  it('records which way a wall crossing a face points', () => {
    // posZ reads -X to +X, so a front facing -X points to -u.
    expect(a.meshes[0].faces.posZ.profile.dirs.every((d) => d.length === 1 && d[0][0] === -1000)).toBe(true);
    expect(a.meshes[0].faces.posY.profile.dirs.every((d) => d.length === 1 && d[0][0] === -1000)).toBe(true);
  });

  it('gives the wall asymmetric sides that only continue the same wall', () => {
    expect(a.hProfiles.get(a.meshes[0].faces.posZ.profile.key)!.symmetric).toBe(false);
    expect(socketsFit('posZ', w.posZ!, w.negZ!)).toBe(true);
    expect(socketsFit('posZ', w.posZ!, f.negZ!)).toBe(false);
  });

  it('only stacks a wall on a wall facing the same way', () => {
    expect(a.vClasses.get(a.vProfiles.get(a.meshes[0].faces.posY.profile.key)!.classKey)!.period).toBe(4);
    expect(w.posY).toBe(w.negY);
    expect(f.negY).not.toBe(w.posY);
    // The flipped wall is the wall turned twice, and its sockets say so.
    expect(rotateSockets(w, 2)).toEqual(f);
  });
});

describe('inside and outside space', () => {
  const turn = (q: Quad, k: number): Quad => ({
    corners: q.corners.map((c) => rotateVec(c, k)) as Quad['corners'],
    front: rotateVec(q.front, k),
  });
  const s = unitySettings({ vertical: true });

  it('labels space in front of a wall outside and behind it inside', () => {
    const [m] = analyze([quadMesh('Wall', [wall])], s).meshes;
    // The wall faces -X.
    expect(m.faces.negX.profile.space).toBe('o'.repeat(16));
    expect(m.faces.posX.profile.space).toBe('i'.repeat(16));
    // posZ reads -X to +X: outside then inside.
    expect(m.faces.posZ.profile.space).toBe('ooii'.repeat(4));
  });

  it('labels the space beyond a surface lying in the face', () => {
    const a = analyze(tiles(), s);
    const [wallRoof, groundWall] = a.meshes;
    expect(wallRoof.faces.posY.profile.space).toBe('o'.repeat(16)); // above the roof
    expect(groundWall.faces.negY.profile.space).toBe('i'.repeat(16)); // under the ground, and behind the wall
  });

  it('separates outside and inside air', () => {
    const a = analyze([quadMesh('Wall', [wall]), { ...rawMesh('-1', []), emptySpace: 'o' }, { ...rawMesh('-1', []), emptySpace: 'i' }], s);
    const { ids } = computeIds(a);
    const [w, out, inside] = a.meshes.map((m) => meshSockets(a, ids, m.index, true));
    expect(out.posX).not.toBe(inside.posX);
    // Outside air fits the wall's front, inside air its back.
    expect(socketsFit('negX', w.negX!, out.posX!)).toBe(true);
    expect(socketsFit('negX', w.negX!, inside.posX!)).toBe(false);
    expect(socketsFit('posX', w.posX!, inside.negX!)).toBe(true);
    expect(socketsFit('posX', w.posX!, out.negX!)).toBe(false);
  });

  it('turns with the tile like the Unity rule', () => {
    const corner = [wall, { corners: [[-0.5, 0, 0], [-0.5, 1, 0], [0, 1, 0], [0, 0, 0]], front: [0, 0, 1] } as Quad, roof];
    const raws = [0, 1, 2, 3].map((k) => quadMesh(`Corner_r${k}`, corner.map((q) => turn(q, k))));
    const a = analyze(raws, s);
    const { ids } = computeIds(a);
    const sockets = a.meshes.map((m) => meshSockets(a, ids, m.index, true));
    for (let k = 1; k < 4; k++) expect(sockets[k]).toEqual(rotateSockets(sockets[0], k));
  });
});

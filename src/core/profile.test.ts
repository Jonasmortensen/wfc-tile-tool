import { describe, expect, it } from 'vitest';
import { AXIS_PRESETS, fileToUnity, presetForMapping, validateMapping, type Vec3 } from './axis';
import { analyze } from './analysis';
import { ALL_FACES, extractFaces, faceEdges, makeProfile, mirrorH, profileToUnity, projectToFace, type Cell } from './profile';
import { box, rawMesh, unitySettings } from './testUtils';

const CELL: Cell = { size: [1, 1, 1], pivot: 'bottom' };
const EPS = 0.001;

describe('profile extraction', () => {
  it('finds boundary vertices of a centred wall', () => {
    const faces = extractFaces(box([-0.5, 0, -0.1], [0.5, 1, 0.1]), CELL, EPS);
    // posX: u runs along -Z (clockwise from above), centred; v from the cell bottom.
    expect(faces.posX.profile.points).toEqual([[-100, 0], [-100, 1000], [100, 0], [100, 1000]]);
    expect(faces.negX.profile.key).toBe(faces.posX.profile.key);
    expect(faces.posZ.profile.points).toEqual([]);
    expect(faces.negZ.profile.points).toEqual([]);
    expect(faces.posY.profile.points).toEqual([[-500, -100], [-500, 100], [500, -100], [500, 100]]);
    expect(faces.negY.profile.key).toBe(faces.posY.profile.key);
  });

  it('reads every side clockwise as seen from above', () => {
    // Block in the +X/+Z corner, touching posX and posZ.
    const faces = extractFaces(box([0.2, 0, 0.3], [0.5, 1, 0.5]), CELL, EPS);
    // posX runs from the +Z corner to the -Z corner: the block is at its start.
    expect(faces.posX.profile.points.map((p) => p[0])).toEqual([-500, -500, -300, -300]);
    // posZ runs from the -X corner to the +X corner: the block is at its end.
    expect(faces.posZ.profile.points.map((p) => p[0])).toEqual([200, 200, 500, 500]);

    // Block in the -X/-Z corner.
    const other = extractFaces(box([-0.5, 0, -0.5], [-0.2, 1, -0.3]), CELL, EPS);
    // negX runs from the -Z corner to the +Z corner.
    expect(other.negX.profile.points.map((p) => p[0])).toEqual([-500, -500, -300, -300]);
    // negZ runs from the +X corner to the -X corner.
    expect(other.negZ.profile.points.map((p) => p[0])).toEqual([200, 200, 500, 500]);
  });

  it('makes geometrically continuous neighbours mirror images', () => {
    // A ledge crossing the boundary between tile A (left) and tile B (at +X).
    const a = extractFaces(box([0.2, 0.4, 0.1], [0.5, 0.6, 0.35]), CELL, EPS);
    const b = extractFaces(box([-0.5, 0.4, 0.1], [-0.1, 0.6, 0.35]), CELL, EPS);
    expect(a.posX.profile.key).not.toBe(mirrorH(a.posX.profile).key);
    expect(b.negX.profile.key).toBe(mirrorH(a.posX.profile).key);
  });

  it('respects epsilon', () => {
    const faces = extractFaces(
      [
        [0.5009, 0.5, 0],
        [0.502, 0.2, 0],
      ],
      CELL,
      EPS,
    );
    expect(faces.posX.profile.points).toEqual([[0, 500]]);
  });

  it('respects the pivot', () => {
    const centred: Cell = { size: [1, 1, 1], pivot: 'center' };
    const faces = extractFaces(box([-0.1, -0.5, -0.1], [0.1, 0.5, 0.1]), centred, EPS);
    expect(faces.posY.profile.points.length).toBe(4);
    expect(faces.negY.profile.points.length).toBe(4);
    const bottom = extractFaces(box([-0.1, -0.5, -0.1], [0.1, 0.5, 0.1]), CELL, EPS);
    expect(bottom.posY.profile.points.length).toBe(0);
  });

  it('gives an empty face its own profile', () => {
    const faces = extractFaces(box([-0.1, 0.1, -0.1], [0.1, 0.2, 0.1]), CELL, EPS);
    expect(faces.posX.profile.key).toBe('');
    expect(faces.posX.profile.key).toBe(mirrorH(faces.posX.profile).key);
  });

  it('dedupes and sorts', () => {
    expect(makeProfile([[2, 1], [1, 5], [2, 1], [1, 2]]).points).toEqual([[1, 2], [1, 5], [2, 1]]);
  });
});

describe('axis mapping', () => {
  it('maps the presets', () => {
    const p: Vec3 = [1, 2, 3];
    expect(fileToUnity(p, AXIS_PRESETS.unity.mapping)).toEqual([1, 2, 3]);
    expect(fileToUnity(p, AXIS_PRESETS.blender.mapping)).toEqual([-1, 2, 3]);
    // Blender Z-up: (x, y, z) -> (-x, z, -y)
    expect(fileToUnity(p, AXIS_PRESETS.zup.mapping)).toEqual([-1, 3, -2]);
    expect(presetForMapping(AXIS_PRESETS.zup.mapping)).toBe('zup');
  });

  it('rejects non-permutations', () => {
    expect(validateMapping({ x: { axis: 0, sign: 1 }, y: { axis: 0, sign: 1 }, z: { axis: 2, sign: 1 } })).toMatch(/exactly once/);
  });

  it('extracts profiles in Unity axes after mapping', () => {
    // In Z-up file space: a block touching the top (file +Z) and file -Y.
    // file -Y is Unity +Z, file +X is Unity -X.
    const fileVerts = box([0.1, -0.5, 0.5], [0.4, -0.3, 1]);
    const a = analyze([rawMesh('m', fileVerts)], unitySettings({ axis: AXIS_PRESETS.zup.mapping }));
    const f = a.meshes[0].faces;
    expect(f.posY.profile.points.length).toBe(4);
    expect(f.posZ.profile.points.length).toBe(4);
    expect(f.negZ.profile.points.length).toBe(0);
    // Unity x = -file x, so the block spans Unity x in [-0.4, -0.1].
    expect(f.posY.profile.points.map((p) => p[0])).toEqual([-400, -400, -100, -100]);
    // On posZ, u = x, so u in [-400, -100].
    expect(f.posZ.profile.points.map((p) => p[0])).toEqual([-400, -400, -100, -100]);
  });

  it('applies scale and ignoreTranslation', () => {
    const raw = { ...rawMesh('m', box([450, 0, -50], [550, 100, 50])), origin: [500, 0, 0] as Vec3 };
    const a = analyze([raw], unitySettings({ scale: 0.01, ignoreTranslation: true }));
    expect(a.meshes[0].outsideCount).toBe(0);
    expect(a.meshes[0].faces.posY.profile.points).toEqual([[-500, -500], [-500, 500], [500, -500], [500, 500]]);
  });
});

describe('face edges', () => {
  /** A triangulated box: corners from box() (index = 4x + 2y + z bits), two triangles per side. */
  const BOX_TRIS = [
    [0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], // -X, +X
    [0, 4, 5], [0, 5, 1], [2, 3, 7], [2, 7, 6], // -Y, +Y
    [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3], // -Z, +Z
  ].flat();

  it('outlines a cap lying on the face, without its diagonal', () => {
    const verts = box([-0.5, 0, -0.1], [0.5, 1, 0.1]);
    const edges = faceEdges(verts.flat(), BOX_TRIS, CELL, EPS);
    // posX is the wall's end cap: a 0.2 x 1 rectangle.
    expect(edges.posX).toHaveLength(4);
    expect(edges.posX).toContainEqual([[-100, 0], [100, 0]]);
    expect(edges.posX).toContainEqual([[-100, 0], [-100, 1000]]);
    expect(edges.posX).not.toContainEqual([[-100, 0], [100, 1000]]);
    expect(edges.posZ).toEqual([]);
    // The top is a cap too.
    expect(edges.posY).toHaveLength(4);
  });

  it('keeps edges of perpendicular walls that touch the face', () => {
    // A box open on the posX side: drop the +X triangles.
    const verts = box([-0.5, 0, -0.1], [0.5, 1, 0.1]);
    const open = BOX_TRIS.slice(6);
    const edges = faceEdges(verts.flat(), open, CELL, EPS);
    expect(edges.posX).toHaveLength(4);
  });

  it('works on non-indexed geometry', () => {
    const verts = box([-0.5, 0, -0.1], [0.5, 1, 0.1]);
    const flat = BOX_TRIS.flatMap((i) => verts[i]);
    expect(faceEdges(flat, null, CELL, EPS).posX).toHaveLength(4);
  });

  it('is stored on the analysis', () => {
    const verts = box([-0.5, 0, -0.1], [0.5, 1, 0.1]);
    const a = analyze([{ ...rawMesh('w', verts), index: BOX_TRIS }], unitySettings());
    expect(a.meshes[0].faces.posX.edges).toHaveLength(4);
  });
});

describe('profileToUnity', () => {
  it('inverts the face projection on every face', () => {
    const cell: Cell = { size: [1, 1, 1], pivot: 'bottom' };
    const verts = box([-0.5, 0, -0.5], [0.5, 1, 0.5]).concat([[0.5, 0.3, 0.2], [-0.1, 1, 0.4], [0.25, 0.6, -0.5]]);
    const faces = extractFaces(verts, cell, EPS);
    for (const face of ALL_FACES) {
      faces[face].vertices.forEach((v) => {
        const p = projectToFace(face, v, [-0.5, 0, -0.5], [0.5, 1, 0.5], EPS)!;
        const back = profileToUnity(face, p, cell, EPS);
        back.forEach((c, i) => expect(c).toBeCloseTo(v[i], 6));
      });
    }
  });
});

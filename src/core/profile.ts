import type { Vec3 } from './axis';

export type HFace = 'posX' | 'negZ' | 'negX' | 'posZ';
export type VFace = 'posY' | 'negY';
export type Face = HFace | VFace;

/** Order matters: one clockwise quarter turn moves each face to the next one. */
export const H_FACES: readonly HFace[] = ['posX', 'negZ', 'negX', 'posZ'];
export const V_FACES: readonly VFace[] = ['posY', 'negY'];
export const ALL_FACES: readonly Face[] = [...H_FACES, ...V_FACES];

export const OPPOSITE: Record<Face, Face> = {
  posX: 'negX',
  negX: 'posX',
  posZ: 'negZ',
  negZ: 'posZ',
  posY: 'negY',
  negY: 'posY',
};

export type Pivot = 'center' | 'bottom';

export interface Cell {
  size: Vec3;
  pivot: Pivot;
}

export function cellBounds(cell: Cell): { min: Vec3; max: Vec3 } {
  const [sx, sy, sz] = cell.size;
  const minY = cell.pivot === 'bottom' ? 0 : -sy / 2;
  return { min: [-sx / 2, minY, -sz / 2], max: [sx / 2, minY + sy, sz / 2] };
}

/** A point on the epsilon grid (integer multiples of epsilon). */
export type Point2 = readonly [number, number];

/** A canonical (deduplicated, sorted) set of quantized points. */
export interface Profile {
  readonly points: readonly Point2[];
  readonly key: string;
}

/** Round to the epsilon grid, symmetric around zero so that quantize(-x) === -quantize(x). */
export function quantize(x: number, eps: number): number {
  const q = x / eps;
  const r = q < 0 ? -Math.round(-q) : Math.round(q);
  return r === 0 ? 0 : r; // normalise -0
}

export function comparePoints(a: Point2, b: Point2): number {
  return a[0] - b[0] || a[1] - b[1];
}

export function makeProfile(points: Iterable<Point2>): Profile {
  const unique = new Map<string, Point2>();
  for (const p of points) {
    const k = `${p[0]},${p[1]}`;
    if (!unique.has(k)) unique.set(k, [p[0] === 0 ? 0 : p[0], p[1] === 0 ? 0 : p[1]]);
  }
  const sorted = [...unique.values()].sort(comparePoints);
  return { points: sorted, key: sorted.map((p) => `${p[0]},${p[1]}`).join(' ') };
}

/** Lexicographic comparison of sorted point lists. */
export function compareProfiles(a: Profile, b: Profile): number {
  const n = Math.min(a.points.length, b.points.length);
  for (let i = 0; i < n; i++) {
    const c = comparePoints(a.points[i], b.points[i]);
    if (c !== 0) return c;
  }
  return a.points.length - b.points.length;
}

/**
 * Horizontal profiles store u relative to the face centre, so the spec's
 * "u -> cellWidth - u" mirror becomes "u -> -u".
 */
export function mirrorH(p: Profile): Profile {
  return makeProfile(p.points.map(([u, v]) => [0 - u, v] as const));
}

/**
 * Rotate a vertical (x, z) profile by k clockwise quarter turns viewed from
 * above in Unity axes. One turn takes +X to -Z (and +Z to +X), which is the
 * same as Unity's Quaternion.Euler(0, 90, 0): (x, z) -> (z, -x).
 */
export function rotateV(p: Profile, k: number): Profile {
  let pts: Point2[] = [...p.points];
  for (let i = 0; i < ((k % 4) + 4) % 4; i++) pts = pts.map(([x, z]) => [z, 0 - x] as const);
  return makeProfile(pts);
}

/** Same rotation as rotateV, applied to a Unity-space position. */
export function rotateVec(v: Readonly<Vec3>, k: number): Vec3 {
  let [x, y, z] = v;
  for (let i = 0; i < ((k % 4) + 4) % 4; i++) [x, z] = [z, 0 - x];
  return [x, y, z];
}

export type Period = 1 | 2 | 4;

export interface VerticalClassification {
  /** Lexicographically smallest member of the 90-degree rotation class. */
  canonical: Profile;
  period: Period;
  /** Clockwise quarter turns taking canonical to this profile, modulo period. */
  r: number;
}

export function classifyVertical(p: Profile): VerticalClassification {
  let canonical = p;
  for (let k = 1; k < 4; k++) {
    const rot = rotateV(p, k);
    if (compareProfiles(rot, canonical) < 0) canonical = rot;
  }
  const period: Period =
    rotateV(canonical, 1).key === canonical.key ? 1 : rotateV(canonical, 2).key === canonical.key ? 2 : 4;
  let r = 0;
  while (rotateV(canonical, r).key !== p.key) r++;
  return { canonical, period, r: r % period };
}

/**
 * Horizontal face frames. u runs left to right as seen from OUTSIDE the tile
 * looking at the face, with v up (Unity +Y). In Unity's left-handed axes the
 * viewer's right is cross(normal, up).
 */
export const H_FRAMES: Record<HFace, { axis: 0 | 2; side: 1 | -1; right: Vec3 }> = {
  posX: { axis: 0, side: 1, right: [0, 0, 1] },
  negX: { axis: 0, side: -1, right: [0, 0, -1] },
  posZ: { axis: 2, side: 1, right: [-1, 0, 0] },
  negZ: { axis: 2, side: -1, right: [1, 0, 0] },
};

export const FACE_NORMALS: Record<Face, Vec3> = {
  posX: [1, 0, 0],
  negX: [-1, 0, 0],
  posY: [0, 1, 0],
  negY: [0, -1, 0],
  posZ: [0, 0, 1],
  negZ: [0, 0, -1],
};

export type Edge2 = readonly [Point2, Point2];

export interface FaceSample {
  profile: Profile;
  /** Unity-space boundary vertices, for the preview. */
  vertices: Vec3[];
  /** Mesh edges lying in the face plane, in profile coordinates, for display. */
  edges: Edge2[];
}

/**
 * Project a Unity-space vertex onto a face's profile frame, or null if it is
 * not within eps of that face's plane. Horizontal faces use (u, v) as above;
 * vertical faces use world (x, z).
 */
export function projectToFace(face: Face, v: Readonly<Vec3>, min: Vec3, max: Vec3, eps: number): Point2 | null {
  if (face === 'posY' || face === 'negY') {
    const plane = face === 'posY' ? max[1] : min[1];
    return Math.abs(v[1] - plane) <= eps ? [quantize(v[0], eps), quantize(v[2], eps)] : null;
  }
  const { axis, side, right } = H_FRAMES[face];
  const plane = side > 0 ? max[axis] : min[axis];
  if (Math.abs(v[axis] - plane) > eps) return null;
  return [quantize(v[0] * right[0] + v[2] * right[2], eps), quantize(v[1] - min[1], eps)];
}

/** Inverse of projectToFace: a profile point back to a Unity-space position on the face plane. */
export function profileToUnity(face: Face, p: Point2, cell: Cell, eps: number): Vec3 {
  const { min, max } = cellBounds(cell);
  if (face === 'posY' || face === 'negY') return [p[0] * eps, face === 'posY' ? max[1] : min[1], p[1] * eps];
  const { axis, side, right } = H_FRAMES[face];
  const u = p[0] * eps;
  const out: Vec3 = [right[0] * u, min[1] + p[1] * eps, right[2] * u];
  out[axis] = side > 0 ? max[axis] : min[axis];
  return out;
}

/**
 * Collect the vertices lying within eps of each cell boundary plane and turn
 * them into canonical profiles. Vertices are Unity-space positions.
 */
export function extractFaces(vertices: Iterable<Readonly<Vec3>>, cell: Cell, eps: number): Record<Face, FaceSample> {
  const { min, max } = cellBounds(cell);
  const pts: Record<Face, Point2[]> = { posX: [], negZ: [], negX: [], posZ: [], posY: [], negY: [] };
  const verts: Record<Face, Vec3[]> = { posX: [], negZ: [], negX: [], posZ: [], posY: [], negY: [] };

  for (const v of vertices) {
    for (const face of ALL_FACES) {
      const p = projectToFace(face, v, min, max, eps);
      if (p) {
        pts[face].push(p);
        verts[face].push([v[0], v[1], v[2]]);
      }
    }
  }

  const out = {} as Record<Face, FaceSample>;
  for (const face of ALL_FACES) out[face] = { profile: makeProfile(pts[face]), vertices: verts[face], edges: [] };
  return out;
}

/**
 * Triangle edges lying in each face plane, in profile coordinates. An edge
 * shared by exactly two in-plane triangles and nothing else is interior to a
 * flat cap (e.g. a quad's diagonal) and is left out.
 * `positions` are flat Unity-space positions; without an index, every three
 * vertices form a triangle.
 */
export function faceEdges(
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null | undefined,
  cell: Cell,
  eps: number,
): Record<Face, Edge2[]> {
  const { min, max } = cellBounds(cell);
  const vertexCount = Math.floor(positions.length / 3);
  const triCount = Math.floor((index ? index.length : vertexCount) / 3);
  const corner = (t: number, c: number) => (index ? index[t * 3 + c] : t * 3 + c);

  const out = {} as Record<Face, Edge2[]>;
  for (const face of ALL_FACES) {
    const proj: (Point2 | null)[] = [];
    for (let i = 0; i < vertexCount; i++) {
      proj.push(projectToFace(face, [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]], min, max, eps));
    }
    const stats = new Map<string, { edge: Edge2; inPlane: number; outOfPlane: number }>();
    for (let t = 0; t < triCount; t++) {
      const p = [proj[corner(t, 0)], proj[corner(t, 1)], proj[corner(t, 2)]];
      const inPlane = p.every((q) => q);
      for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
        const a = p[i];
        const b = p[j];
        if (!a || !b) continue;
        const order = comparePoints(a, b);
        if (order === 0) continue;
        const edge: Edge2 = order < 0 ? [a, b] : [b, a];
        const key = `${edge[0][0]},${edge[0][1]} ${edge[1][0]},${edge[1][1]}`;
        let st = stats.get(key);
        if (!st) stats.set(key, (st = { edge, inPlane: 0, outOfPlane: 0 }));
        if (inPlane) st.inPlane++;
        else st.outOfPlane++;
      }
    }
    out[face] = [...stats.values()].filter((st) => st.inPlane !== 2 || st.outOfPlane > 0).map((st) => st.edge);
  }
  return out;
}

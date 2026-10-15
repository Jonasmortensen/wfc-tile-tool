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

/**
 * Which way the in-plane triangles touching a boundary vertex face, relative
 * to the cell: 'o' out of the cell, 'i' into it, 'b' both, '' no in-plane
 * triangle. A roof on the top plane faces out, a ground on the bottom plane
 * faces in: same vertices, different surfaces.
 */
export type Facing = '' | 'o' | 'i' | 'b';

/**
 * Where a surface meets the face edge-on (a wall crossing the top face, or
 * ending at a side), the direction its front faces, projected into the face's
 * profile coordinates and scaled to 1000. It tells a wall from the same wall
 * turned 180 degrees: same vertices, front on the other side.
 */
export type Dir = readonly [number, number];

/** A point, optionally with its facing and edge-on front directions. */
export type TaggedPoint = readonly [number, number, Facing?, (readonly Dir[])?];

/** A canonical (deduplicated, sorted) set of quantized points. */
export interface Profile {
  readonly points: readonly Point2[];
  /** Facing of each point, parallel to `points`. */
  readonly facing: readonly Facing[];
  /** Edge-on front directions of each point (sorted, distinct), parallel to `points`. */
  readonly dirs: readonly (readonly Dir[])[];
  /**
   * Inside/outside label ('i' / 'o') of the space at each sample of a
   * SPACE_GRID x SPACE_GRID grid over the face, row-major from the (-u, v = 0)
   * or (-x, -z) corner. Empty when not computed.
   */
  readonly space: string;
  readonly key: string;
}

/** Samples per side of a face's space grid. */
export const SPACE_GRID = 4;

/** The space grid of a mirrored horizontal profile (u -> -u). */
export function mirrorSpace(space: string): string {
  if (!space) return space;
  const n = SPACE_GRID;
  return Array.from({ length: n * n }, (_, k) => space[Math.floor(k / n) * n + (n - 1 - (k % n))]).join('');
}

/** The space grid of a vertical profile turned k clockwise quarter turns, like rotatePoint. */
export function rotateSpace(space: string, k: number): string {
  if (!space) return space;
  const n = SPACE_GRID;
  for (let r = 0; r < ((k % 4) + 4) % 4; r++) {
    // (x, z) -> (z, -x): sample (i, j) moves to (j, n - 1 - i).
    const next: string[] = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) next[(n - 1 - i) * n + j] = space[j * n + i];
    space = next.join('');
  }
  return space;
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

export function mergeFacing(a: Facing, b: Facing): Facing {
  return !a ? b : !b || a === b ? a : 'b';
}

/** Normalise -0 to 0. */
const z = (x: number) => (x === 0 ? 0 : x);

export function makeProfile(points: Iterable<TaggedPoint>, space = ''): Profile {
  const unique = new Map<string, { p: Point2; f: Facing; d: Map<string, Dir> }>();
  for (const p of points) {
    const k = `${p[0]},${p[1]}`;
    let e = unique.get(k);
    if (!e) unique.set(k, (e = { p: [z(p[0]), z(p[1])], f: '', d: new Map() }));
    e.f = mergeFacing(e.f, p[2] ?? '');
    for (const d of p[3] ?? []) e.d.set(`${z(d[0])}:${z(d[1])}`, [z(d[0]), z(d[1])]);
  }
  const sorted = [...unique.values()].sort((a, b) => comparePoints(a.p, b.p));
  const dirs = sorted.map((e) => [...e.d.values()].sort(comparePoints));
  const dirKey = (ds: readonly Dir[]) => (ds.length ? '>' + ds.map((d) => `${d[0]}:${d[1]}`).join(';') : '');
  return {
    points: sorted.map((e) => e.p),
    facing: sorted.map((e) => e.f),
    dirs,
    space,
    key: sorted.map((e, i) => `${e.p[0]},${e.p[1]}${e.f}${dirKey(dirs[i])}`).join(' ') + (space ? ` |${space}` : ''),
  };
}

/** Points with their tags, transformed by a linear map (which turns the directions too). */
function tagged(p: Profile, map: (q: Point2) => Point2): TaggedPoint[] {
  return p.points.map((q, i) => [...map(q), p.facing[i], p.dirs[i].map(map)] as const);
}

/** Lexicographic comparison of sorted point lists, then of their tags. */
export function compareProfiles(a: Profile, b: Profile): number {
  const n = Math.min(a.points.length, b.points.length);
  for (let i = 0; i < n; i++) {
    const c = comparePoints(a.points[i], b.points[i]);
    if (c !== 0) return c;
  }
  if (a.points.length !== b.points.length) return a.points.length - b.points.length;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Horizontal profiles store u relative to the face centre, so the spec's
 * "u -> cellWidth - u" mirror becomes "u -> -u".
 */
export function mirrorH(p: Profile): Profile {
  return makeProfile(tagged(p, ([u, v]) => [0 - u, v]), mirrorSpace(p.space));
}

/**
 * Rotate a vertical (x, z) profile by k clockwise quarter turns viewed from
 * above in Unity axes. One turn takes +X to -Z (and +Z to +X), which is the
 * same as Unity's Quaternion.Euler(0, 90, 0): (x, z) -> (z, -x).
 */
export function rotateV(p: Profile, k: number): Profile {
  return makeProfile(tagged(p, (q) => rotatePoint(q, k)), rotateSpace(p.space, k));
}

/** One vertical-profile point rotated like rotateV. */
export function rotatePoint(p: Point2, k: number): Point2 {
  let [x, z] = p;
  for (let i = 0; i < ((k % 4) + 4) % 4; i++) [x, z] = [z, 0 - x];
  return [x, z];
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
 * Horizontal face frames. u runs clockwise around the tile as seen from above,
 * the order sockets are read in (posX from +Z to -Z, negZ from +X to -X, negX
 * from -Z to +Z, posZ from -X to +X). That is left to right as seen from
 * INSIDE the tile looking at the face, with v up (Unity +Y).
 */
export const H_FRAMES: Record<HFace, { axis: 0 | 2; side: 1 | -1; right: Vec3 }> = {
  posX: { axis: 0, side: 1, right: [0, 0, -1] },
  negX: { axis: 0, side: -1, right: [0, 0, 1] },
  posZ: { axis: 2, side: 1, right: [1, 0, 0] },
  negZ: { axis: 2, side: -1, right: [-1, 0, 0] },
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
  /**
   * The face's only surface faces out of the cell, so it already closes the
   * tile and the neighbour needs nothing there: its profile is the empty one.
   */
  open: boolean;
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
 * A face is open when every point on it belongs to a surface facing out of the
 * cell (a roof on the top face): nothing beyond needs to continue it, so it
 * matches an empty face. Untagged points (geometry crossing the face, like a
 * wall carrying on upward) or inward surfaces keep it closed.
 */
export function isOpen(p: Profile): boolean {
  return p.points.length > 0 && p.facing.every((f) => f === 'o');
}

/**
 * Collect the vertices lying within eps of each cell boundary plane and turn
 * them into canonical profiles. Vertices are Unity-space positions; `facing`
 * (from faceFacing) tags them by the way the surfaces touching them face.
 */
export function extractFaces(
  vertices: Iterable<Readonly<Vec3>>,
  cell: Cell,
  eps: number,
  facing?: Record<Face, ReadonlyMap<string, PointTag>>,
  space?: Record<Face, string>,
): Record<Face, FaceSample> {
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
  for (const face of ALL_FACES) {
    const tags = facing?.[face];
    const profile = makeProfile(
      pts[face].map((p) => {
        const t = tags?.get(`${p[0]},${p[1]}`);
        return [p[0], p[1], t?.facing ?? '', t?.dirs ?? []] as const;
      }),
      space?.[face] ?? '',
    );
    const open = isOpen(profile);
    out[face] = { profile: open ? makeProfile([], profile.space) : profile, open, vertices: verts[face], edges: [] };
  }
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

/** How the surfaces at a profile point face: in the plane (facing) and edge-on (dirs). */
export interface PointTag {
  facing: Facing;
  dirs: Dir[];
}

/**
 * For each face plane, tags for the profile points touched by surfaces,
 * keyed "u,v": triangles lying in the plane give a facing (out of or into the
 * cell), triangles meeting it along an edge give the direction their front
 * faces within the plane. Normals follow the triangle winding of the file
 * (counter-clockwise front faces); `flip` must be set when the axis mapping
 * mirrors (negative determinant), since mirrored positions reverse the
 * winding while Unity's import keeps faces pointing the same way.
 */
export function faceFacing(
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null | undefined,
  cell: Cell,
  eps: number,
  flip: boolean,
): Record<Face, Map<string, PointTag>> {
  const { min, max } = cellBounds(cell);
  const vertexCount = Math.floor(positions.length / 3);
  const triCount = Math.floor((index ? index.length : vertexCount) / 3);
  const corner = (t: number, c: number) => (index ? index[t * 3 + c] : t * 3 + c);
  const pos = (i: number): Vec3 => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  const sign = flip ? -1 : 1;

  const out = {} as Record<Face, Map<string, PointTag>>;
  for (const face of ALL_FACES) {
    const tags = new Map<string, PointTag>();
    const tag = (q: Point2) => {
      const k = `${q[0]},${q[1]}`;
      let t = tags.get(k);
      if (!t) tags.set(k, (t = { facing: '', dirs: [] }));
      return t;
    };
    const n = FACE_NORMALS[face];
    for (let t = 0; t < triCount; t++) {
      const v = [pos(corner(t, 0)), pos(corner(t, 1)), pos(corner(t, 2))];
      const onPlane = v.map((q) => projectToFace(face, q, min, max, eps)).filter((q): q is Point2 => !!q);
      if (onPlane.length < 2) continue;
      const e1 = [0, 1, 2].map((a) => v[1][a] - v[0][a]);
      const e2 = [0, 1, 2].map((a) => v[2][a] - v[0][a]);
      // Positions went through the axis mapping M, so cross(M e1, M e2) = det(M) * M * (file normal).
      const normal: Vec3 = [
        sign * (e1[1] * e2[2] - e1[2] * e2[1]),
        sign * (e1[2] * e2[0] - e1[0] * e2[2]),
        sign * (e1[0] * e2[1] - e1[1] * e2[0]),
      ];
      const len = Math.hypot(...normal);
      if (len < eps * eps) continue;
      if (onPlane.length === 3) {
        // In the plane: the normal is along the face axis.
        const f: Facing = normal[0] * n[0] + normal[1] * n[1] + normal[2] * n[2] > 0 ? 'o' : 'i';
        for (const q of onPlane) tag(q).facing = mergeFacing(tag(q).facing, f);
      } else {
        // Edge-on: the normal's direction within the plane, in profile coordinates.
        const [du, dv] = profileDirection(face, normal);
        const l = Math.hypot(du, dv);
        if (l < len * 1e-3) continue;
        const dir: Dir = [Math.round((du / l) * 1000), Math.round((dv / l) * 1000)];
        for (const q of onPlane) tag(q).dirs.push(dir);
      }
    }
    out[face] = tags;
  }
  return out;
}

/** A Unity-space direction in a face's profile coordinates, (u, v) or (x, z), dropping the face-normal part. */
export function profileDirection(face: Face, d: Readonly<Vec3>): [number, number] {
  if (face === 'posY' || face === 'negY') return [d[0], d[2]];
  const { right } = H_FRAMES[face];
  return [d[0] * right[0] + d[2] * right[2], d[1]];
}

import type { Vec3 } from './axis';
import { ALL_FACES, FACE_NORMALS, H_FRAMES, SPACE_GRID, cellBounds, type Cell, type Face, type HFace } from './profile';

/** What fills the space at a point: 'o' outside (in front of surfaces), 'i' inside (behind them). */
export type Space = 'o' | 'i';

const AXES: Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** The other 20 of the 26 grid directions, unit length: edge and corner diagonals. */
const DIAGONALS: Vec3[] = [];
for (const x of [-1, 0, 1]) {
  for (const y of [-1, 0, 1]) {
    for (const z of [-1, 0, 1]) {
      const n = Math.abs(x) + Math.abs(y) + Math.abs(z);
      if (n >= 2) DIAGONALS.push([x / Math.sqrt(n), y / Math.sqrt(n), z / Math.sqrt(n)]);
    }
  }
}

/**
 * Sample points of a face's space grid, in grid order (row-major from the
 * profile's (0, 0) corner: u or x across, v or z up), in Unity space and
 * moved `inset` into the cell.
 */
export function spaceSamples(face: Face, cell: Cell, inset: number): Vec3[] {
  const { min, max } = cellBounds(cell);
  const [sx, sy, sz] = cell.size;
  const f = (i: number) => (i + 0.5) / SPACE_GRID;
  const out: Vec3[] = [];
  for (let j = 0; j < SPACE_GRID; j++) {
    for (let i = 0; i < SPACE_GRID; i++) {
      if (face === 'posY' || face === 'negY') {
        const y = face === 'posY' ? max[1] - inset : min[1] + inset;
        out.push([(f(i) - 0.5) * sx, y, (f(j) - 0.5) * sz]);
      } else {
        const { axis, side, right } = H_FRAMES[face as HFace];
        const width = axis === 0 ? sz : sx;
        const u = (f(i) - 0.5) * width;
        const p: Vec3 = [right[0] * u, min[1] + f(j) * sy, right[2] * u];
        p[axis] = side > 0 ? max[axis] - inset : min[axis] + inset;
        out.push(p);
      }
    }
  }
  return out;
}

/** Möller–Trumbore: distance along `dir` to the triangle, or null. */
function hitTriangle(o: Vec3, dir: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = [dir[1] * e2[2] - dir[2] * e2[1], dir[2] * e2[0] - dir[0] * e2[2], dir[0] * e2[1] - dir[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
  return t > 0 ? t : null;
}

/**
 * Inside/outside labels for every face's sample grid, as one character per
 * sample in grid order. A sample is labelled by the nearest surface an
 * axis-aligned ray from it meets inside the cell: its front means outside,
 * its back inside (inside wins a tie). Where no axis-aligned ray meets a
 * surface (the quadrant across from an L-shaped corner wall), diagonal rays
 * decide the same way; with no surface in reach at all it gets `empty`. Where a surface
 * lies in the face itself (a roof on the top face), the label is the space
 * beyond that surface, since that is what the neighbour across the face sees.
 * Normals follow the file's winding; `flip` as in faceFacing.
 */
export function faceSpace(
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null | undefined,
  cell: Cell,
  flip: boolean,
  empty: Space,
): Record<Face, string> {
  const { min, max } = cellBounds(cell);
  const inset = Math.min(...cell.size) * 0.01;
  const vertexCount = Math.floor(positions.length / 3);
  const triCount = Math.floor((index ? index.length : vertexCount) / 3);
  const corner = (t: number, c: number) => (index ? index[t * 3 + c] : t * 3 + c);
  const pos = (i: number): Vec3 => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  const sign = flip ? -1 : 1;
  const tris = Array.from({ length: triCount }, (_, t) => {
    const [a, b, c] = [pos(corner(t, 0)), pos(corner(t, 1)), pos(corner(t, 2))];
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n: Vec3 = [
      sign * (e1[1] * e2[2] - e1[2] * e2[1]),
      sign * (e1[2] * e2[0] - e1[0] * e2[2]),
      sign * (e1[0] * e2[1] - e1[1] * e2[0]),
    ];
    return { a, b, c, n };
  });

  /** Nearest surface along `dir` within the cell: its distance and whether the ray meets its front. */
  const cast = (o: Vec3, dir: Vec3) => {
    let best: { t: number; front: boolean } | null = null;
    // Distance along `dir` to where the ray leaves the cell.
    let reach = Infinity;
    for (let a = 0; a < 3; a++) {
      if (dir[a]) reach = Math.min(reach, (dir[a] > 0 ? max[a] - o[a] : o[a] - min[a]) / Math.abs(dir[a]));
    }
    reach += inset;
    for (const { a, b, c, n } of tris) {
      const d = dir[0] * n[0] + dir[1] * n[1] + dir[2] * n[2];
      if (d === 0) continue;
      const t = hitTriangle(o, dir, a, b, c);
      if (t !== null && t <= reach && (!best || t < best.t)) best = { t, front: d < 0 };
    }
    return best;
  };

  const out = {} as Record<Face, string>;
  for (const face of ALL_FACES) {
    const outward = FACE_NORMALS[face];
    out[face] = spaceSamples(face, { ...cell }, inset)
      .map((o): Space => {
        // A surface in the face plane: label the space beyond it.
        const own = cast(o, outward);
        if (own && own.t <= inset * 2) return own.front ? 'i' : 'o';
        let hits = AXES.map((dir) => cast(o, dir)).filter((h) => h !== null);
        if (!hits.length) hits = DIAGONALS.map((dir) => cast(o, dir)).filter((h) => h !== null);
        if (!hits.length) return empty;
        // Equally near surfaces that disagree (a sample in a corner): inside wins, the same in every rotation.
        const nearest = Math.min(...hits.map((h) => h.t));
        return hits.some((h) => h.t <= nearest + inset * 0.1 && !h.front) ? 'i' : 'o';
      })
      .join('');
  }
  return out;
}

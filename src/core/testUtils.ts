import { AXIS_PRESETS, cloneMapping, type Vec3 } from './axis';
import { defaultSettings, type RawMesh, type Settings } from './analysis';
import { rotateVec } from './profile';

/** The 8 corners of an axis-aligned box. */
export function box(min: Vec3, max: Vec3): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push([x, y, z]);
  return out;
}

/**
 * Fixtures sit this high in the file, with their origin moved up as far, so
 * they read as stacked tiles rather than ground tiles (origin at height 0).
 */
const LIFT = 10;

function lifted(name: string, vertices: Vec3[], index: RawMesh['index']): RawMesh {
  return { name, positions: vertices.flatMap(([x, y, z]) => [x, y + LIFT, z]), index, origin: [0, LIFT, 0] };
}

/** A bare point set: an empty index, so no triangles (and no facing). */
export function rawMesh(name: string, vertices: Vec3[]): RawMesh {
  return lifted(name, vertices, []);
}

/**
 * A mesh of quads. Each quad's corners go around its outline; it is split
 * into two triangles wound counter-clockwise as seen from `front` (a normal
 * in the same coordinates).
 */
export function quadMesh(name: string, quads: { corners: [Vec3, Vec3, Vec3, Vec3]; front: Vec3 }[]): RawMesh {
  const positions: Vec3[] = [];
  for (const { corners: [a, b, c, d], front } of quads) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const ccw = n[0] * front[0] + n[1] * front[1] + n[2] * front[2] > 0;
    const tris = ccw ? [a, b, c, a, c, d] : [a, c, b, a, d, c];
    positions.push(...tris);
  }
  return lifted(name, positions, null);
}

/** Settings where file coordinates are Unity coordinates. */
export function unitySettings(overrides: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(), axis: cloneMapping(AXIS_PRESETS.unity.mapping), ...overrides };
}

export function rotateMesh(vertices: Vec3[], k: number): Vec3[] {
  return vertices.map((v) => rotateVec(v, k));
}

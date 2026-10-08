import { AXIS_PRESETS, cloneMapping, type Vec3 } from './axis';
import { defaultSettings, type RawMesh, type Settings } from './analysis';
import { rotateVec } from './profile';

/** The 8 corners of an axis-aligned box. */
export function box(min: Vec3, max: Vec3): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push([x, y, z]);
  return out;
}

export function rawMesh(name: string, vertices: Vec3[]): RawMesh {
  return { name, positions: vertices.flat(), origin: [0, 0, 0] };
}

/** Settings where file coordinates are Unity coordinates. */
export function unitySettings(overrides: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(), axis: cloneMapping(AXIS_PRESETS.unity.mapping), ...overrides };
}

export function rotateMesh(vertices: Vec3[], k: number): Vec3[] {
  return vertices.map((v) => rotateVec(v, k));
}

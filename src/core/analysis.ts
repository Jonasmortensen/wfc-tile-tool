import { AXIS_PRESETS, cloneMapping, fileToUnity, type AxisMapping, type Vec3 } from './axis';
import {
  assignHorizontalIds,
  assignVerticalBases,
  encodeVertical,
  parseVertical,
  reverseString,
  type Rejection,
} from './ids';
import {
  ALL_FACES,
  H_FACES,
  OPPOSITE,
  V_FACES,
  cellBounds,
  classifyVertical,
  extractFaces,
  faceEdges,
  mirrorH,
  type Cell,
  type Face,
  type FaceSample,
  type HFace,
  type Period,
  type Pivot,
  type Profile,
} from './profile';

export interface Settings {
  cellSize: Vec3;
  pivot: Pivot;
  epsilon: number;
  /** Multiplier applied to file positions (e.g. 0.01 for centimetre files). */
  scale: number;
  /** Subtract each object's world position, for files with tiles laid out side by side. */
  ignoreTranslation: boolean;
  axis: AxisMapping;
  vertical: boolean;
}

export function defaultSettings(): Settings {
  return {
    cellSize: [1, 1, 1],
    pivot: 'bottom',
    epsilon: 0.001,
    scale: 1,
    ignoreTranslation: true,
    axis: cloneMapping(AXIS_PRESETS.blender.mapping),
    vertical: false,
  };
}

/** A mesh as loaded from the file: world-space positions in file axes. */
export interface RawMesh {
  name: string;
  positions: ArrayLike<number>;
  index?: ArrayLike<number> | null;
  /** World position of the object, in file axes. */
  origin: Vec3;
}

export interface FaceRef {
  mesh: number;
  face: Face;
}

export interface HProfileInfo {
  key: string;
  profile: Profile;
  mirror: Profile;
  symmetric: boolean;
  usage: FaceRef[];
}

export interface VProfileInfo {
  key: string;
  profile: Profile;
  classKey: string;
  r: number;
  period: Period;
  usage: FaceRef[];
}

export interface VClassInfo {
  key: string;
  canonical: Profile;
  period: Period;
  members: string[];
}

export interface MeshAnalysis {
  name: string;
  index: number;
  /** Flat Unity-space positions. */
  positions: Float64Array;
  faces: Record<Face, FaceSample>;
  outsideCount: number;
  bounds: { min: Vec3; max: Vec3 } | null;
}

export interface Analysis {
  settings: Settings;
  meshes: MeshAnalysis[];
  /** Insertion order = order of first appearance. */
  hProfiles: Map<string, HProfileInfo>;
  vProfiles: Map<string, VProfileInfo>;
  vClasses: Map<string, VClassInfo>;
}

export function meshToUnity(raw: RawMesh, s: Settings): Float64Array {
  const p = raw.positions;
  const o = s.ignoreTranslation ? raw.origin : [0, 0, 0];
  const out = new Float64Array(p.length);
  for (let i = 0; i + 2 < p.length; i += 3) {
    const u = fileToUnity([p[i] - o[0], p[i + 1] - o[1], p[i + 2] - o[2]], s.axis);
    out[i] = u[0] * s.scale;
    out[i + 1] = u[1] * s.scale;
    out[i + 2] = u[2] * s.scale;
  }
  return out;
}

function* vec3s(flat: Float64Array): Generator<Vec3> {
  for (let i = 0; i + 2 < flat.length; i += 3) yield [flat[i], flat[i + 1], flat[i + 2]];
}

export function analyze(raws: readonly RawMesh[], s: Settings): Analysis {
  const cell: Cell = { size: s.cellSize, pivot: s.pivot };
  const { min, max } = cellBounds(cell);
  const eps = s.epsilon;

  const meshes = raws.map((raw, index): MeshAnalysis => {
    const positions = meshToUnity(raw, s);
    let outsideCount = 0;
    let bounds: MeshAnalysis['bounds'] = null;
    for (const v of vec3s(positions)) {
      if (!bounds) bounds = { min: [...v], max: [...v] };
      let outside = false;
      for (let a = 0; a < 3; a++) {
        bounds.min[a] = Math.min(bounds.min[a], v[a]);
        bounds.max[a] = Math.max(bounds.max[a], v[a]);
        if (v[a] < min[a] - eps || v[a] > max[a] + eps) outside = true;
      }
      if (outside) outsideCount++;
    }
    const faces = extractFaces(vec3s(positions), cell, eps);
    const edges = faceEdges(positions, raw.index, cell, eps);
    for (const face of ALL_FACES) faces[face].edges = edges[face];
    return { name: raw.name, index, positions, faces, outsideCount, bounds };
  });

  const hProfiles = new Map<string, HProfileInfo>();
  const vProfiles = new Map<string, VProfileInfo>();
  const vClasses = new Map<string, VClassInfo>();
  for (const m of meshes) {
    for (const face of H_FACES) {
      const profile = m.faces[face].profile;
      let info = hProfiles.get(profile.key);
      if (!info) {
        const mirror = mirrorH(profile);
        info = { key: profile.key, profile, mirror, symmetric: mirror.key === profile.key, usage: [] };
        hProfiles.set(profile.key, info);
      }
      info.usage.push({ mesh: m.index, face });
    }
    for (const face of V_FACES) {
      const profile = m.faces[face].profile;
      let info = vProfiles.get(profile.key);
      if (!info) {
        const c = classifyVertical(profile);
        info = { key: profile.key, profile, classKey: c.canonical.key, r: c.r, period: c.period, usage: [] };
        vProfiles.set(profile.key, info);
        let cls = vClasses.get(c.canonical.key);
        if (!cls) {
          cls = { key: c.canonical.key, canonical: c.canonical, period: c.period, members: [] };
          vClasses.set(cls.key, cls);
        }
        cls.members.push(profile.key);
      }
      info.usage.push({ mesh: m.index, face });
    }
  }
  return { settings: s, meshes, hProfiles, vProfiles, vClasses };
}

export interface IdState {
  /** Horizontal profile key (including unused mirrors) -> socket ID. */
  h: Map<string, string>;
  /** Vertical class key -> base character. */
  v: Map<string, string>;
}

export function computeIds(
  a: Analysis,
  hProposals: readonly ReadonlyMap<string, string>[] = [],
  vProposals: readonly ReadonlyMap<string, string>[] = [],
): { ids: IdState; rejectedH: Rejection[]; rejectedV: Rejection[] } {
  const h = assignHorizontalIds(
    [...a.hProfiles.values()].map((p) => ({ key: p.key, mirrorKey: p.mirror.key, symmetric: p.symmetric })),
    hProposals,
  );
  const v = assignVerticalBases([...a.vClasses.keys()], vProposals);
  return { ids: { h: h.ids, v: v.bases }, rejectedH: h.rejected, rejectedV: v.rejected };
}

export type Sockets = Partial<Record<Face, string>>;

export function verticalSocket(a: Analysis, ids: IdState, key: string): string {
  const info = a.vProfiles.get(key)!;
  return encodeVertical(ids.v.get(info.classKey)!, info.r, info.period);
}

/** Sockets of one mesh, keys in export order. */
export function meshSockets(a: Analysis, ids: IdState, meshIndex: number, vertical: boolean): Sockets {
  const m = a.meshes[meshIndex];
  const out: Sockets = {};
  for (const f of H_FACES) out[f] = ids.h.get(m.faces[f].profile.key)!;
  if (vertical) for (const f of V_FACES) out[f] = verticalSocket(a, ids, m.faces[f].profile.key);
  return out;
}

/** Period of every vertical base in use, sorted by base. */
export function verticalPeriods(a: Analysis, ids: IdState): Record<string, number> {
  const entries = [...a.vClasses.values()].map((c) => [ids.v.get(c.key)!, c.period] as const);
  entries.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return Object.fromEntries(entries);
}

/**
 * The Unity rotation rule: k clockwise quarter turns viewed from above move
 * posX -> negZ -> negX -> posZ -> posX, and XrX vertical sockets get
 * r = (r + k) % period[X].
 */
export function rotateSockets(s: Sockets, k: number, periods: Readonly<Record<string, number>>): Sockets {
  k = ((k % 4) + 4) % 4;
  const moved: Sockets = {};
  H_FACES.forEach((f, i) => {
    if (s[f] !== undefined) moved[H_FACES[(i + k) % 4]] = s[f];
  });
  const out: Sockets = {};
  for (const f of H_FACES) if (moved[f] !== undefined) out[f] = moved[f];
  for (const f of V_FACES) {
    const id = s[f];
    if (id === undefined) continue;
    const p = parseVertical(id);
    if (p && p.r !== null) {
      const period = periods[p.base] as Period;
      out[f] = encodeVertical(p.base, (p.r + k) % period, period);
    } else out[f] = id;
  }
  return out;
}

/** Faces for which no tile, in any of its four rotations, has a compatible opposite face. */
export function findUnmatchedFaces(all: readonly Sockets[], periods: Readonly<Record<string, number>>): FaceRef[] {
  const available = new Map<Face, Set<string>>();
  for (const s of all) {
    for (let k = 0; k < 4; k++) {
      for (const [face, id] of Object.entries(rotateSockets(s, k, periods)) as [Face, string][]) {
        if (!available.has(face)) available.set(face, new Set());
        available.get(face)!.add(id);
      }
    }
  }
  const out: FaceRef[] = [];
  all.forEach((s, mesh) => {
    for (const [face, id] of Object.entries(s) as [Face, string][]) {
      if (!available.get(OPPOSITE[face])?.has(reverseString(id))) out.push({ mesh, face });
    }
  });
  return out;
}

export interface Prototype {
  mesh_name: string;
  sockets: Sockets;
  weight: number;
}

export interface ExportJson {
  prototypes: Prototype[];
  vertical_socket_periods?: Record<string, number>;
}

export function buildExport(a: Analysis, ids: IdState, weights: readonly number[], vertical: boolean): ExportJson {
  const json: ExportJson = {
    prototypes: a.meshes.map((m) => ({
      mesh_name: m.name,
      sockets: meshSockets(a, ids, m.index, vertical),
      weight: weights[m.index] ?? 1,
    })),
  };
  if (vertical) json.vertical_socket_periods = verticalPeriods(a, ids);
  return json;
}

export function exportText(json: ExportJson): string {
  return JSON.stringify(json, null, 4);
}

export function parseImport(text: string): ExportJson {
  const data = JSON.parse(text) as unknown;
  const protos = (data as { prototypes?: unknown })?.prototypes;
  if (!Array.isArray(protos)) throw new Error('JSON has no "prototypes" array.');
  return {
    prototypes: protos.map((p, i) => {
      const proto = p as Partial<Prototype>;
      if (typeof proto?.mesh_name !== 'string') throw new Error(`Prototype ${i} has no mesh_name.`);
      const sockets: Sockets = {};
      for (const [face, id] of Object.entries(proto.sockets ?? {})) {
        if (typeof id === 'string') sockets[face as Face] = id;
      }
      return { mesh_name: proto.mesh_name, sockets, weight: typeof proto.weight === 'number' ? proto.weight : 1 };
    }),
  };
}

/**
 * ID proposals from an imported JSON: any face of a mesh whose name appears
 * in the JSON proposes that face's old socket ID for its new profile.
 * `origin` records where each proposal came from, for messages.
 */
export function importProposals(
  a: Analysis,
  imported: ExportJson,
): { h: Map<string, string>; v: Map<string, string>; origin: Map<string, string> } {
  const h = new Map<string, string>();
  const v = new Map<string, string>();
  const origin = new Map<string, string>();
  for (const proto of imported.prototypes) {
    for (const m of a.meshes.filter((m) => m.name === proto.mesh_name)) {
      for (const f of H_FACES as readonly HFace[]) {
        const id = proto.sockets[f];
        const key = m.faces[f].profile.key;
        if (id !== undefined && !h.has(key)) {
          h.set(key, id);
          origin.set(`h:${key}`, `${m.name}.${f}`);
        }
      }
      for (const f of V_FACES) {
        const parsed = proto.sockets[f] !== undefined ? parseVertical(proto.sockets[f]) : null;
        const classKey = a.vProfiles.get(m.faces[f].profile.key)!.classKey;
        if (parsed && !v.has(classKey)) {
          v.set(classKey, parsed.base);
          origin.set(`v:${classKey}`, `${m.name}.${f}`);
        }
      }
    }
  }
  return { h, v, origin };
}

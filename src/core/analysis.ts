import { AXIS_PRESETS, cloneMapping, fileToUnity, mappingDeterminant, type AxisMapping, type Vec3 } from './axis';
import { faceSpace, type Space } from './space';
import { GROUND_SOCKET, assignHorizontalIds, assignVerticalBases, encodeVertical, parseVertical, reverseString, type Rejection } from './ids';
import {
  ALL_FACES,
  H_FACES,
  OPPOSITE,
  V_FACES,
  cellBounds,
  classifyVertical,
  extractFaces,
  faceEdges,
  faceFacing,
  mirrorH,
  type Cell,
  type Face,
  type FaceSample,
  type HFace,
  type Period,
  type Pivot,
  type VFace,
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
  /** Enclosed space: inside/outside sampling of the tiles' faces. Off: every tile counts as outside everywhere. */
  enclosedSpace: boolean;
  /** Tags (from tile names) turned off for Enclosed space: tiles with any of them are not sampled. */
  openTags: readonly string[];
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
    enclosedSpace: true,
    openTags: [],
  };
}

/** Whether a mesh gets inside/outside sampling under the Enclosed space setting. */
export function samplesSpace(
  raw: Pick<RawMesh, 'name' | 'emptySpace'>,
  s: Pick<Settings, 'enclosedSpace' | 'openTags'>,
): boolean {
  // The generated empty tiles have no geometry: their label is their whole point.
  if (raw.emptySpace !== undefined) return true;
  return s.enclosedSpace && !tagsFromName(raw.name).some((t) => s.openTags.includes(t));
}

/** A mesh as loaded from the file: world-space positions in file axes. */
export interface RawMesh {
  name: string;
  positions: ArrayLike<number>;
  index?: ArrayLike<number> | null;
  /** World position of the object, in file axes. */
  origin: Vec3;
  /** Label for space no surface reaches; 'i' makes an empty mesh inside air. Default 'o'. */
  emptySpace?: Space;
  /** Stands on the ground whatever its origin: a generated empty tile with the ground socket below. */
  ground?: boolean;
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
  emptySpace: Space;
  /** The object origin sits at height 0 (Unity Y, within epsilon): the bottom face gets GROUND_SOCKET. */
  grounded: boolean;
}

export interface Analysis {
  settings: Settings;
  meshes: MeshAnalysis[];
  /** Insertion order = order of first appearance. */
  hProfiles: Map<string, HProfileInfo>;
  vProfiles: Map<string, VProfileInfo>;
  vClasses: Map<string, VClassInfo>;
}

export { GROUND_SOCKET };

/** The format's empty tile name: nothing is built for it. */
export const EMPTY_NAME = '-1';

/** A mesh's name for display; the two empty tiles share "-1", so say which air each one is. */
export function meshLabel(m: Pick<MeshAnalysis, 'name' | 'emptySpace' | 'grounded'>): string {
  if (m.name !== EMPTY_NAME) return m.name;
  return `-1 (${m.emptySpace === 'i' ? 'inside' : 'outside'} air${m.grounded ? ' on ground' : ''})`;
}

/** Whether a mesh from the file has its object origin at height 0 (Unity Y, within epsilon). */
export function originAtGround(raw: RawMesh, s: Settings): boolean {
  return Math.abs(fileToUnity(raw.origin, s.axis)[1] * s.scale) <= s.epsilon;
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
    const flip = mappingDeterminant(s.axis) < 0;
    const facing = faceFacing(positions, raw.index, cell, eps, flip);
    const emptySpace = raw.emptySpace ?? 'o';
    // Without sampling, every face is outside: like a tile with no surface in reach.
    const space = samplesSpace(raw, s) ? faceSpace(positions, raw.index, cell, flip, emptySpace) : faceSpace([], null, cell, flip, 'o');
    const faces = extractFaces(vec3s(positions), cell, eps, facing, space);
    const edges = faceEdges(positions, raw.index, cell, eps);
    for (const face of ALL_FACES) faces[face].edges = edges[face];
    // The generated empty tiles have no real position: only `ground` puts them on the ground.
    const grounded = raw.ground ?? (raw.emptySpace === undefined && originAtGround(raw, s));
    return { name: raw.name, index, positions, faces, outsideCount, bounds, emptySpace, grounded };
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

/**
 * Whether every mesh's object origin sits at the same height (Unity Y, within
 * epsilon). Tiles laid out on several levels need posY/negY sockets.
 */
export function sameOriginHeights(raws: readonly RawMesh[], s: Settings): boolean {
  const ys = raws.map((r) => fileToUnity(r.origin, s.axis)[1] * s.scale);
  return ys.every((y) => Math.abs(y - ys[0]) <= s.epsilon);
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
  if (m.grounded) out.negY = GROUND_SOCKET;
  return out;
}

/**
 * A top or bottom socket as the Unity loader sees it: the explicit one, or,
 * when left out, posX|negZ|negX|posZ built from the sides.
 */
export function faceSocket(s: Sockets, f: VFace): string {
  return s[f] || H_FACES.map((h) => s[h] ?? '').join('|');
}

/** Turn a top or bottom socket k quarter turns: the last side part moves to the front, a middle part stays last. */
export function rotateFace(id: string, k: number): string {
  const parts = id.split('|');
  if (parts.length !== 4 && parts.length !== 5) return id;
  const sides = parts.slice(0, 4);
  const n = ((k % 4) + 4) % 4;
  return [...sides.slice(4 - n), ...sides.slice(0, 4 - n), ...parts.slice(4)].join('|');
}

/**
 * The Unity rotation rule: k clockwise quarter turns viewed from above move
 * side sockets posX -> negZ -> negX -> posZ -> posX unchanged, and turn
 * top/bottom sockets with rotateFace.
 */
export function rotateSockets(s: Sockets, k: number): Sockets {
  k = ((k % 4) + 4) % 4;
  const moved: Sockets = {};
  H_FACES.forEach((f, i) => {
    if (s[f] !== undefined) moved[H_FACES[(i + k) % 4]] = s[f];
  });
  const out: Sockets = {};
  for (const f of H_FACES) if (moved[f] !== undefined) out[f] = moved[f];
  for (const f of V_FACES) if (s[f] !== undefined) out[f] = rotateFace(s[f], k);
  return out;
}

/** Whether `id` on `face` fits `other` on the neighbour's opposite face: sides reversed, top/bottom exactly. */
export function socketsFit(face: Face, id: string, other: string): boolean {
  return face === 'posY' || face === 'negY' ? id === other : id === reverseString(other);
}

/**
 * Faces for which no tile, in any of its four rotations, has a compatible
 * opposite face. Top and bottom are only checked where given explicitly, and
 * may be matched by an inferred face.
 */
export function findUnmatchedFaces(all: readonly Sockets[]): FaceRef[] {
  const available = new Map<Face, Set<string>>();
  for (const s of all) {
    for (let k = 0; k < 4; k++) {
      const r = rotateSockets(s, k);
      for (const face of [...H_FACES, ...V_FACES]) {
        const id = face === 'posY' || face === 'negY' ? faceSocket(r, face) : r[face];
        if (id === undefined) continue;
        if (!available.has(face)) available.set(face, new Set());
        available.get(face)!.add(id);
      }
    }
  }
  const out: FaceRef[] = [];
  all.forEach((s, mesh) => {
    for (const [face, id] of Object.entries(s) as [Face, string][]) {
      // The ground sits on the grid's bottom boundary, not on another tile.
      if (face === 'negY' && id === GROUND_SOCKET) continue;
      const want = face === 'posY' || face === 'negY' ? id : reverseString(id);
      if (!available.get(OPPOSITE[face])?.has(want)) out.push({ mesh, face });
    }
  });
  return out;
}

export interface Prototype {
  mesh_name: string;
  sockets: Sockets;
  weight: number;
  /** Free-form labels; "LastResort" tiles are only used where nothing else fits. */
  tags?: string[];
}

export interface ExportJson {
  prototypes: Prototype[];
  /** Partial when imported from a file that leaves some out. */
  boundary_sockets?: Partial<BoundarySockets>;
}

/**
 * Sockets required on the edge of the map, as the solve preview uses them.
 * Sides equal `outside` (unreversed), or `inside` in layer 0 when present;
 * `bottom` / `top` are required exactly under layer 0 / on top of the highest layer.
 * An empty string means any socket.
 */
export interface BoundarySockets {
  outside: string;
  inside?: string;
  bottom: string;
  top: string;
}

const BOUNDARY_KEYS: Record<WfcBoundary, keyof BoundarySockets> = {
  outer: 'outside',
  outerGround: 'inside',
  bottom: 'bottom',
  top: 'top',
};

/** The export section for the boundary sockets; `inside` only applies with top/bottom sockets. */
export function boundarySockets(b: Readonly<Record<WfcBoundary, string>>, vertical: boolean): BoundarySockets {
  return { outside: b.outer, ...(vertical ? { inside: b.outerGround } : {}), bottom: b.bottom, top: b.top };
}

/** Boundary values from an imported section, by setting; keys the section lacks are left out. */
export function importedBoundary(b: Partial<BoundarySockets>): Partial<Record<WfcBoundary, string>> {
  const out: Partial<Record<WfcBoundary, string>> = {};
  for (const [key, json] of Object.entries(BOUNDARY_KEYS) as [WfcBoundary, keyof BoundarySockets][]) {
    if (typeof b[json] === 'string') out[key] = b[json];
  }
  return out;
}

/**
 * Tags from a mesh name: its PascalCase words, with acronyms and digit runs
 * as their own words and anything else (`_`, spaces, `-`) as a separator:
 * "WallCornerInner" → Wall, Corner, Inner; "UIPanel_02" → UI, Panel, 02.
 * The empty tile ("-1") has none.
 */
export function tagsFromName(name: string): string[] {
  if (name === EMPTY_NAME) return [];
  return [...new Set(name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? [])];
}

/** A prototype's tags: the ones from its name, then any `extra` (e.g. imported) not already there. */
export function prototypeTags(name: string, extra: readonly string[] = []): string[] {
  return [...new Set([...tagsFromName(name), ...extra])];
}

/** Extra `tags` per mesh index, e.g. carried over from an imported JSON; the name's tags are always added. */
export function buildExport(
  a: Analysis,
  ids: IdState,
  weights: readonly number[],
  vertical: boolean,
  tags: readonly (string[] | undefined)[] = [],
): ExportJson {
  return {
    prototypes: a.meshes.map((m) => {
      const p: Prototype = { mesh_name: m.name, sockets: meshSockets(a, ids, m.index, vertical), weight: weights[m.index] ?? 1 };
      const t = prototypeTags(m.name, tags[m.index]);
      if (t.length) p.tags = t;
      return p;
    }),
  };
}

export function exportText(json: ExportJson): string {
  return JSON.stringify(json, null, 4);
}

export function parseImport(text: string): ExportJson {
  const data = JSON.parse(text) as unknown;
  const protos = (data as { prototypes?: unknown })?.prototypes;
  if (!Array.isArray(protos)) throw new Error('JSON has no "prototypes" array.');
  const boundary = (data as { boundary_sockets?: unknown }).boundary_sockets;
  return {
    prototypes: protos.map((p, i) => {
      const proto = p as Partial<Prototype>;
      if (typeof proto?.mesh_name !== 'string') throw new Error(`Prototype ${i} has no mesh_name.`);
      const sockets: Sockets = {};
      for (const [face, id] of Object.entries(proto.sockets ?? {})) {
        if (typeof id === 'string') sockets[face as Face] = id;
      }
      const tags = Array.isArray(proto.tags) ? proto.tags.filter((t): t is string => typeof t === 'string') : [];
      return {
        mesh_name: proto.mesh_name,
        sockets,
        // Unity reads a missing weight as 0.
        weight: typeof proto.weight === 'number' ? proto.weight : 0,
        ...(tags.length ? { tags } : {}),
      };
    }),
    ...(boundary && typeof boundary === 'object' ? { boundary_sockets: parseBoundary(boundary as Record<string, unknown>) } : {}),
  };
}

/** The string-valued boundary keys; missing ones stay missing, so they keep following the defaults. */
function parseBoundary(b: Record<string, unknown>): Partial<BoundarySockets> {
  const out: Partial<BoundarySockets> = {};
  for (const key of Object.values(BOUNDARY_KEYS)) if (typeof b[key] === 'string') out[key] = b[key] as string;
  return out;
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
        if (f === 'negY' && proto.sockets[f] === GROUND_SOCKET) continue;
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

export type WfcBoundary = 'outer' | 'outerGround' | 'bottom' | 'top';

/**
 * Boundary defaults: the ground socket under layer 0 when some tile has it,
 * outside air around the sides and on top when the empty tile is on, and
 * outside ground around layer 0: of the symmetric sides of ground tiles, the
 * one with the most outside samples.
 */
export function wfcBoundaryDefaults(a: Analysis, protos: readonly Prototype[]): Record<WfcBoundary, string> {
  const air = a.meshes.findIndex((m) => m.name === EMPTY_NAME && m.emptySpace === 'o');
  const airSockets = air >= 0 ? protos[air].sockets : null;
  let outerGround = '';
  let most = 0;
  for (const m of a.meshes) {
    if (!m.grounded) continue;
    for (const f of H_FACES) {
      const profile = m.faces[f].profile;
      if (!a.hProfiles.get(profile.key)!.symmetric) continue;
      const outside = [...profile.space].filter((c) => c === 'o').length;
      if (outside > most) [outerGround, most] = [protos[m.index].sockets[f]!, outside];
    }
  }
  return {
    // A side next to air must be the reverse of air's side; a top under air equals air's bottom.
    outer: airSockets ? reverseString(airSockets.negX!) : '',
    outerGround,
    bottom: a.meshes.some((m) => m.grounded) ? GROUND_SOCKET : '',
    top: airSockets ? faceSocket(airSockets, 'negY') : '',
  };
}

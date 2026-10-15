import type { Vec3 } from './axis';
import { ALL_FACES, OPPOSITE, type Face } from './profile';
import { faceSocket, rotateSockets, socketsFit, type Prototype, type Sockets } from './analysis';

/** One prototype in one rotation, as the Unity loader generates it. */
export interface Variant {
  /** Index of the source prototype. */
  proto: number;
  /** Clockwise quarter turns viewed from above. */
  rotation: number;
  /** All six sockets, top and bottom inferred from the sides where not given. */
  sockets: Required<Sockets>;
  /** Prototype weight times the number of its rotations with these sockets. */
  weight: number;
  lastResort: boolean;
}

/** Grid step per face, in Unity axes. */
export const FACE_OFFSETS: Record<Face, Vec3> = {
  posX: [1, 0, 0],
  negX: [-1, 0, 0],
  posY: [0, 1, 0],
  negY: [0, -1, 0],
  posZ: [0, 0, 1],
  negZ: [0, 0, -1],
};

/**
 * All four rotations of every prototype, like the loader with rotations on.
 * Rotations of one prototype that give identical sockets are merged into one
 * variant carrying their combined weight, so relative weights are unchanged.
 */
export function buildVariants(protos: readonly Pick<Prototype, 'sockets' | 'weight' | 'tags'>[]): Variant[] {
  const out: Variant[] = [];
  protos.forEach((p, proto) => {
    const byKey = new Map<string, Variant>();
    for (let rotation = 0; rotation < 4; rotation++) {
      const r = rotateSockets(p.sockets, rotation);
      const sockets = { ...r, posY: faceSocket(r, 'posY'), negY: faceSocket(r, 'negY') } as Required<Sockets>;
      const key = JSON.stringify(ALL_FACES.map((f) => sockets[f]));
      const seen = byKey.get(key);
      if (seen) seen.weight += Math.max(0, p.weight);
      else {
        const v = { proto, rotation, sockets, weight: Math.max(0, p.weight), lastResort: !!p.tags?.includes('LastResort') };
        byKey.set(key, v);
        out.push(v);
      }
    }
  });
  return out;
}

/** compat[face][a] = variants that may sit next to variant a on its `face` side. */
export function compatibility(variants: readonly Variant[]): Record<Face, number[][]> {
  const out = {} as Record<Face, number[][]>;
  for (const f of ALL_FACES) {
    out[f] = variants.map((a) => {
      const list: number[] = [];
      variants.forEach((b, j) => {
        if (socketsFit(f, a.sockets[f], b.sockets[OPPOSITE[f]])) list.push(j);
      });
      return list;
    });
  }
  return out;
}

/** Small seeded PRNG (mulberry32), so a seed always gives the same result. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WfcOptions {
  size: Vec3;
  seed: number;
  /** Socket every side on the edge of the map must equal (unreversed). Empty: unconstrained. */
  outer?: string;
  /** Socket required under layer 0 (exact). Empty: unconstrained. */
  bottom?: string;
  /** Socket required on top of the highest layer (exact). Empty: unconstrained. */
  top?: string;
  /** Restarts allowed after a contradiction. */
  maxAttempts?: number;
}

export interface WfcResult {
  size: Vec3;
  variants: Variant[];
  /** Variant index per cell (x + X * (y + Y * z)); -1 where nothing was placed. */
  cells: Int32Array;
  ok: boolean;
  attempts: number;
  /** Cell whose options ran out, on failure. */
  contradiction: number | null;
}

export function cellIndex(size: Readonly<Vec3>, x: number, y: number, z: number): number {
  return x + size[0] * (y + size[1] * z);
}

export function cellCoords(size: Readonly<Vec3>, i: number): Vec3 {
  return [i % size[0], Math.floor(i / size[0]) % size[1], Math.floor(i / (size[0] * size[1]))];
}

/**
 * Observe/propagate WFC with restarts, following the prototype format: weight
 * 0 tiles are only picked when every remaining option has weight 0, and
 * LastResort tiles only when nothing else is left.
 */
export function solveWfc(variants: Variant[], opts: WfcOptions): WfcResult {
  const { size } = opts;
  const compat = compatibility(variants);
  const random = rng(opts.seed);
  const n = size[0] * size[1] * size[2];
  const nv = variants.length;
  const maxAttempts = opts.maxAttempts ?? 20;

  // Neighbour cell per face, or -1 at the grid edge.
  const neighbours = ALL_FACES.map((f) => {
    const d = FACE_OFFSETS[f];
    const out = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const [x, y, z] = cellCoords(size, i);
      const p = [x + d[0], y + d[1], z + d[2]];
      out[i] = p.every((v, a) => v >= 0 && v < size[a]) ? cellIndex(size, p[0], p[1], p[2]) : -1;
    }
    return out;
  });
  // Boundary sockets a variant must have on a face that lies on the grid edge.
  const boundary = (f: Face) => (f === 'posY' ? opts.top : f === 'negY' ? opts.bottom : opts.outer) || '';
  const xlogx = (w: number) => (w > 0 ? w * Math.log(w) : 0);

  let attempts = 0;
  let last: { cells: Int32Array; contradiction: number | null } = { cells: new Int32Array(n).fill(-1), contradiction: null };
  while (attempts < maxAttempts) {
    attempts++;
    const domain = new Uint8Array(n * nv).fill(1);
    const count = new Int32Array(n).fill(nv);
    const sumW = new Float64Array(n).fill(variants.reduce((s, v) => s + v.weight, 0));
    const sumWlogW = new Float64Array(n).fill(variants.reduce((s, v) => s + xlogx(v.weight), 0));
    const mark = new Uint8Array(nv);
    let contradiction: number | null = nv === 0 && n > 0 ? 0 : null;

    const ban = (c: number, v: number) => {
      domain[c * nv + v] = 0;
      count[c]--;
      sumW[c] -= variants[v].weight;
      sumWlogW[c] -= xlogx(variants[v].weight);
      if (count[c] === 0 && contradiction === null) contradiction = c;
    };

    const propagate = (starts: number[]) => {
      const stack = [...starts];
      const queued = new Uint8Array(n);
      for (const c of starts) queued[c] = 1;
      while (stack.length && contradiction === null) {
        const c = stack.pop()!;
        queued[c] = 0;
        ALL_FACES.forEach((f, fi) => {
          const nb = neighbours[fi][c];
          if (nb < 0 || contradiction !== null) return;
          mark.fill(0);
          for (let a = 0; a < nv; a++) if (domain[c * nv + a]) for (const b of compat[f][a]) mark[b] = 1;
          let changed = false;
          for (let b = 0; b < nv; b++) {
            if (domain[nb * nv + b] && !mark[b]) {
              ban(nb, b);
              changed = true;
            }
          }
          if (changed && !queued[nb]) {
            queued[nb] = 1;
            stack.push(nb);
          }
        });
      }
    };

    // Boundary sockets on the grid edges.
    ALL_FACES.forEach((f, fi) => {
      const want = boundary(f);
      if (!want) return;
      for (let c = 0; c < n && contradiction === null; c++) {
        if (neighbours[fi][c] >= 0) continue;
        for (let v = 0; v < nv; v++) if (domain[c * nv + v] && variants[v].sockets[f] !== want) ban(c, v);
      }
    });
    // Drop variants that have no possible neighbour on some side before the first choice.
    if (contradiction === null) propagate(Array.from({ length: n }, (_, c) => c));
    while (contradiction === null) {
      // Lowest weighted entropy among undecided cells, with a little noise to break ties.
      let best = -1;
      let bestH = Infinity;
      for (let c = 0; c < n; c++) {
        if (count[c] <= 1) continue;
        const h = (sumW[c] > 0 ? Math.log(sumW[c]) - sumWlogW[c] / sumW[c] : Math.log(count[c])) + random() * 1e-6;
        if (h < bestH) {
          bestH = h;
          best = c;
        }
      }
      if (best < 0) break;
      // LastResort only when nothing else is left; weight 0 only when every candidate has weight 0.
      let options: number[] = [];
      for (let v = 0; v < nv; v++) if (domain[best * nv + v]) options.push(v);
      const preferred = options.filter((v) => !variants[v].lastResort);
      if (preferred.length) options = preferred;
      const total = options.reduce((s, v) => s + variants[v].weight, 0);
      let pick = options[Math.floor(random() * options.length)];
      if (total > 0) {
        let r = random() * total;
        for (const v of options) {
          if (variants[v].weight <= 0) continue;
          pick = v;
          r -= variants[v].weight;
          if (r <= 0) break;
        }
      }
      for (let v = 0; v < nv; v++) if (v !== pick && domain[best * nv + v]) ban(best, v);
      propagate([best]);
    }

    const cells = new Int32Array(n).fill(-1);
    for (let c = 0; c < n; c++) {
      if (count[c] !== 1) continue;
      for (let v = 0; v < nv; v++) if (domain[c * nv + v]) cells[c] = v;
    }
    last = { cells, contradiction };
    if (contradiction === null) return { size, variants, cells, ok: true, attempts, contradiction: null };
  }
  return { size, variants, cells: last.cells, ok: false, attempts, contradiction: last.contradiction };
}

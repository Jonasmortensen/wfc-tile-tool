import { SPACE_GRID, type Edge2, type Facing, type Point2, type Profile } from '../core/profile';

const SIZE = 84;
const PAD = 8;

function svg(body: string, title: string): string {
  return `<svg class="plot" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}"><title>${title}</title>${body}</svg>`;
}

function frame(w: number, h: number): { scale: number; ox: number; oy: number; rect: string } {
  const scale = (SIZE - 2 * PAD) / Math.max(w, h);
  const ox = (SIZE - w * scale) / 2;
  const oy = (SIZE - h * scale) / 2;
  const rect = `<rect x="${ox}" y="${oy}" width="${w * scale}" height="${h * scale}" class="plot-frame"/>`;
  return { scale, ox, oy, rect };
}

function dots(coords: [number, number][], color: string): string {
  if (!coords.length) return `<text x="${SIZE / 2}" y="${SIZE / 2 + 3}" class="plot-empty">empty</text>`;
  return coords.map(([x, y]) => `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2.4" fill="${color}"/>`).join('');
}

const FACING_TITLE: Record<Exclude<Facing, ''>, string> = {
  o: 'surface facing out of the cell',
  i: 'surface facing into the cell',
  b: 'surfaces facing both ways',
};

/** Ticks showing which way an edge-on surface's front faces, from each point that has one. */
function dirMarks(profile: Profile, map: (p: Point2) => [number, number], color: string): string {
  return profile.points
    .flatMap((p, i) =>
      profile.dirs[i].map((d) => {
        const [x, y] = map(p);
        // map is affine, so the screen direction is map(p + d) - map(p).
        const [x2, y2] = map([p[0] + d[0], p[1] + d[1]]);
        const l = Math.hypot(x2 - x, y2 - y) || 1;
        const ex = x + ((x2 - x) / l) * 7;
        const ey = y + ((y2 - y) / l) * 7;
        return `<g><title>front of an edge-on surface points this way</title><line x1="${x.toFixed(2)}" y1="${y.toFixed(2)}" x2="${ex.toFixed(2)}" y2="${ey.toFixed(2)}" stroke="${color}" stroke-width="1.2" stroke-dasharray="1.5 1"/><circle cx="${ex.toFixed(2)}" cy="${ey.toFixed(2)}" r="1.3" fill="${color}"/></g>`;
      }),
    )
    .join('');
}

/** Square markers for points with in-plane surfaces: filled = out of the cell, hollow = into it, both = dotted. */
function facingMarks(profile: Profile, map: (p: Point2) => [number, number], color: string): string {
  return profile.points
    .map((p, i) => {
      const f = profile.facing[i];
      if (!f) return '';
      const [x, y] = map(p);
      const fill = f === 'o' ? color : 'none';
      const dot = f === 'b' ? `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="1" fill="${color}"/>` : '';
      return `<g><title>${FACING_TITLE[f]}</title><rect x="${(x - 3).toFixed(2)}" y="${(y - 3).toFixed(2)}" width="6" height="6" fill="${fill}" stroke="${color}" stroke-width="1.2"/>${dot}</g>`;
    })
    .join('');
}

/**
 * Shade the inside ('i') cells of the space grid. `cell(i, j)` gives two
 * opposite corners of grid cell (i, j) in profile units.
 */
function spaceShade(profile: Profile, map: (p: Point2) => [number, number], cell: (i: number, j: number) => [Point2, Point2]): string {
  let out = '';
  for (let k = 0; k < profile.space.length; k++) {
    if (profile.space[k] !== 'i') continue;
    const [a, b] = cell(k % SPACE_GRID, Math.floor(k / SPACE_GRID)).map(map);
    const x = Math.min(a[0], b[0]);
    const y = Math.min(a[1], b[1]);
    out += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${Math.abs(a[0] - b[0]).toFixed(2)}" height="${Math.abs(a[1] - b[1]).toFixed(2)}" class="plot-inside"/>`;
  }
  return out ? `<g><title>shaded: inside (behind a surface)</title>${out}</g>` : '';
}

/** In-plane edges as lines, dots for any profile point no edge touches, and facing markers. */
function marks(profile: Profile, edges: readonly Edge2[], map: (p: Point2) => [number, number], color: string): string {
  const points = profile.points;
  if (!points.length) return dots([], color);
  const lines = edges
    .map((e) => {
      const [[x1, y1], [x2, y2]] = e.map(map);
      return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>`;
    })
    .join('');
  const covered = new Set(edges.flatMap((e) => e.map((p) => `${p[0]},${p[1]}`)));
  const loose = points.filter((p) => !covered.has(`${p[0]},${p[1]}`)).map(map);
  return lines + (loose.length ? dots(loose, color) : '') + facingMarks(profile, map, color) + dirMarks(profile, map, color);
}

/** Horizontal profile: u (reading order, left to right seen from inside the tile) and v (up). */
export function plotH(
  profile: Profile,
  edges: readonly Edge2[],
  eps: number,
  width: number,
  height: number,
  color: string,
): string {
  const { scale, ox, oy, rect } = frame(width, height);
  const map = ([u, v]: Point2): [number, number] => [ox + (u * eps + width / 2) * scale, oy + (height - v * eps) * scale];
  const n = SPACE_GRID;
  const shade = spaceShade(profile, map, (i, j) => [
    [((i / n - 0.5) * width) / eps, ((j / n) * height) / eps],
    [(((i + 1) / n - 0.5) * width) / eps, (((j + 1) / n) * height) / eps],
  ]);
  return svg(rect + shade + `<text x="2" y="${SIZE - 2}" class="plot-axis">u→</text>` + marks(profile, edges, map, color), 'Seen from inside: u is the socket reading order (clockwise from above), v up');
}

/** Vertical profile in Unity world (x, z), viewed from above: +X right, +Z up. */
export function plotV(
  profile: Profile,
  edges: readonly Edge2[],
  eps: number,
  sx: number,
  sz: number,
  color: string,
): string {
  const { scale, ox, oy, rect } = frame(sx, sz);
  const map = ([x, z]: Point2): [number, number] => [ox + (x * eps + sx / 2) * scale, oy + (sz / 2 - z * eps) * scale];
  const axes = `<text x="${SIZE - 14}" y="${SIZE - 2}" class="plot-axis">+X</text><text x="2" y="9" class="plot-axis">+Z</text>`;
  const n = SPACE_GRID;
  const shade = spaceShade(profile, map, (i, j) => [
    [((i / n - 0.5) * sx) / eps, ((j / n - 0.5) * sz) / eps],
    [(((i + 1) / n - 0.5) * sx) / eps, (((j + 1) / n - 0.5) * sz) / eps],
  ]);
  return svg(rect + shade + axes + marks(profile, edges, map, color), 'Viewed from above: +X right, +Z up');
}

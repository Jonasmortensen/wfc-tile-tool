import type { Edge2, Point2 } from '../core/profile';

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

/**
 * Horizontal profile: u (left to right, seen from outside) and v (up).
 * Draws the in-plane edges, plus dots for any boundary vertex no edge touches.
 */
export function plotH(
  points: readonly Point2[],
  edges: readonly Edge2[],
  eps: number,
  width: number,
  height: number,
  color: string,
): string {
  const { scale, ox, oy, rect } = frame(width, height);
  const map = ([u, v]: Point2): [number, number] => [ox + (u * eps + width / 2) * scale, oy + (height - v * eps) * scale];
  const lines = edges
    .map((e) => {
      const [[x1, y1], [x2, y2]] = e.map(map);
      return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>`;
    })
    .join('');
  const covered = new Set(edges.flatMap((e) => e.map((p) => `${p[0]},${p[1]}`)));
  const loose = points.filter((p) => !covered.has(`${p[0]},${p[1]}`)).map(map);
  const marks = !points.length ? dots([], color) : lines + (loose.length ? dots(loose, color) : '');
  return svg(rect + `<text x="2" y="${SIZE - 2}" class="plot-axis">u→</text>` + marks, 'Seen from outside: u right, v up');
}

/** Vertical profile in Unity world (x, z), viewed from above: +X right, +Z up. */
export function plotV(points: readonly Point2[], eps: number, sx: number, sz: number, color: string): string {
  const { scale, ox, oy, rect } = frame(sx, sz);
  const coords = points.map(([x, z]): [number, number] => [ox + (x * eps + sx / 2) * scale, oy + (sz / 2 - z * eps) * scale]);
  const axes = `<text x="${SIZE - 14}" y="${SIZE - 2}" class="plot-axis">+X</text><text x="2" y="9" class="plot-axis">+Z</text>`;
  return svg(rect + axes + dots(coords, color), 'Viewed from above: +X right, +Z up');
}

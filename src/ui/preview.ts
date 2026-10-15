import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { mappingDeterminant, type Vec3 } from '../core/axis';
import type { MeshAnalysis, Settings } from '../core/analysis';
import { ALL_FACES, FACE_NORMALS, cellBounds, profileToUnity, projectToFace, type Face } from '../core/profile';

export const BACK_FACE_COLOR = 0xc0392b;

export const FACE_COLORS: Record<Face, string> = {
  posX: '#ff5a4f',
  negX: '#ff9f40',
  posZ: '#4aa3ff',
  negZ: '#b07cff',
  posY: '#3ddc84',
  negY: '#f5d142',
};

/** Unity is left-handed (Z forward), three.js right-handed (Z toward viewer): flip Z to display. */
export function u2t(v: Readonly<Vec3>): THREE.Vector3 {
  return new THREE.Vector3(v[0], v[1], -v[2]);
}

function label(text: string, color: string, height: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = 'bold 48px system-ui, sans-serif';
  ctx.font = font;
  canvas.width = Math.ceil(ctx.measureText(text).width) + 16;
  canvas.height = 64;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 8, 34);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set((height * canvas.width) / canvas.height, height, 1);
  sprite.renderOrder = 10;
  return sprite;
}

export function disposeTree(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      (mat as THREE.SpriteMaterial).map?.dispose();
      mat.dispose();
    }
  });
}

export class Preview {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  private controls: OrbitControls;
  private content = new THREE.Group();

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x15181d);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404858, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(3, 5, 4);
    this.scene.add(sun, this.content);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.content.traverse((o) => {
      if (o instanceof LineSegments2) o.material.resolution.set(w, h);
    });
  }

  show(mesh: MeshAnalysis | null, index: ArrayLike<number> | null | undefined, s: Settings, resetView: boolean) {
    disposeTree(this.content);
    this.content.clear();

    const { min, max } = cellBounds({ size: s.cellSize, pivot: s.pivot });
    const [sx, sy, sz] = s.cellSize;
    const m = Math.max(sx, sy, sz);
    const center: Vec3 = [0, (min[1] + max[1]) / 2, 0];

    // Cell box.
    const cell = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(sx, sy, sz)),
      new THREE.LineBasicMaterial({ color: 0x9aa4b2 }),
    );
    cell.position.copy(u2t(center));
    this.content.add(cell);

    const grid = new THREE.GridHelper(m * 3, 12, 0x3a414c, 0x262b33);
    grid.position.y = min[1];
    // The grid shares the plane (and some lines) with the cell's bottom edges: draw it
    // first without writing depth so those edges always win instead of z-fighting.
    grid.material.depthWrite = false;
    grid.renderOrder = -1;
    this.content.add(grid);

    // Unity axes at the pivot.
    const axes: [string, Vec3, number][] = [
      ['+X', [1, 0, 0], 0xff4d4d],
      ['+Y', [0, 1, 0], 0x4ddc6a],
      ['+Z', [0, 0, 1], 0x4d8dff],
    ];
    for (const [name, dir, color] of axes) {
      const len = m * 0.8;
      this.content.add(new THREE.ArrowHelper(u2t(dir).normalize(), new THREE.Vector3(), len, color, len * 0.12, len * 0.06));
      const l = label(`${name} (Unity)`, `#${color.toString(16).padStart(6, '0')}`, m * 0.08);
      l.position.copy(u2t(dir).multiplyScalar(len * 1.12));
      this.content.add(l);
    }

    // Face labels.
    for (const face of ALL_FACES) {
      const n = FACE_NORMALS[face];
      const half: Vec3 = [sx / 2, sy / 2, sz / 2];
      const p: Vec3 = [0, 1, 2].map((a) => center[a] + n[a] * (half[a] + m * 0.12)) as Vec3;
      const l = label(face, FACE_COLORS[face], m * 0.07);
      l.position.copy(u2t(p));
      this.content.add(l);
    }

    if (mesh && mesh.positions.length) {
      const pos = new Float32Array(mesh.positions.length);
      for (let i = 0; i < pos.length; i += 3) {
        pos[i] = mesh.positions[i];
        pos[i + 1] = mesh.positions[i + 1];
        pos[i + 2] = -mesh.positions[i + 2];
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      if (index) geom.setIndex(Array.from(index));
      geom.computeVertexNormals();
      // Front faces follow the file's winding. The axis mapping and the Z flip
      // to three.js space each mirror (det -1); when only the Z flip does, the
      // displayed winding is reversed, so swap which side counts as front.
      const reversed = mappingDeterminant(s.axis) > 0;
      const material = (color: number, front: boolean) =>
        new THREE.MeshStandardMaterial({
          color,
          side: front !== reversed ? THREE.FrontSide : THREE.BackSide,
          flatShading: true,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        });
      // Back faces are tinted red.
      this.content.add(new THREE.Mesh(geom, material(0x7d8da3, true)), new THREE.Mesh(geom, material(BACK_FACE_COLOR, false)));
      this.content.add(
        new THREE.LineSegments(new THREE.EdgesGeometry(geom, 25), new THREE.LineBasicMaterial({ color: 0x2b3340 })),
      );

      // Socket edges, coloured per face and nudged outward so edges shared by two faces show both colours.
      // Boundary vertices that no in-plane edge touches are still drawn as points.
      const cell = { size: s.cellSize, pivot: s.pivot };
      for (const face of ALL_FACES) {
        const sample = mesh.faces[face];
        const n = FACE_NORMALS[face];
        const nudge = m * 0.012;
        const place = (v: Readonly<Vec3>) => u2t([v[0] + n[0] * nudge, v[1] + n[1] * nudge, v[2] + n[2] * nudge]);

        if (sample.edges.length) {
          const arr: number[] = [];
          for (const edge of sample.edges) {
            for (const p of edge) {
              const t = place(profileToUnity(face, p, cell, s.epsilon));
              arr.push(t.x, t.y, t.z);
            }
          }
          const g = new LineSegmentsGeometry();
          g.setPositions(arr);
          const mat = new LineMaterial({ color: FACE_COLORS[face], linewidth: 3 });
          mat.resolution.set(this.container.clientWidth, this.container.clientHeight);
          const lines = new LineSegments2(g, mat);
          this.content.add(lines);
        }

        const covered = new Set(sample.edges.flatMap((e) => e.map((p) => `${p[0]},${p[1]}`)));
        const loose = sample.vertices.filter((v) => {
          const p = projectToFace(face, v, min, max, s.epsilon);
          return !p || !covered.has(`${p[0]},${p[1]}`);
        });
        if (!loose.length) continue;
        const arr = new Float32Array(loose.length * 3);
        loose.forEach((v, i) => {
          const t = place(v);
          arr.set([t.x, t.y, t.z], i * 3);
        });
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        const pts = new THREE.Points(
          g,
          new THREE.PointsMaterial({ color: FACE_COLORS[face], size: 8, sizeAttenuation: false }),
        );
        this.content.add(pts);
      }
    }

    if (resetView) {
      // Like Unity's scene view: from behind (-Z) and above, +X to the right.
      const target = u2t(center);
      this.controls.target.copy(target);
      this.camera.position.copy(target).add(u2t([m * 1.5, m * 1.3, -m * 2.2]));
      this.camera.near = m * 0.01;
      this.camera.far = m * 100;
      this.camera.updateProjectionMatrix();
      this.controls.update();
    }
  }
}

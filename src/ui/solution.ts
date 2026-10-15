import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mappingDeterminant, type Vec3 } from '../core/axis';
import { meshLabel, type MeshAnalysis, type Settings } from '../core/analysis';
import { cellBounds, rotateVec } from '../core/profile';
import { cellCoords, type WfcResult } from '../core/wfc';
import { disposeTree, u2t } from './preview';

/** Distinct, muted colour per prototype. */
export function protoColor(i: number): THREE.Color {
  return new THREE.Color().setHSL((i * 0.618034) % 1, 0.45, 0.58);
}

/** Tile geometry in three.js space, turned k clockwise quarter turns (Unity rule) about the pivot. */
function tileGeometry(mesh: MeshAnalysis, index: ArrayLike<number> | null | undefined, k: number): THREE.BufferGeometry {
  const src = mesh.positions;
  const pos = new Float32Array(src.length);
  for (let i = 0; i + 2 < src.length; i += 3) {
    const t = u2t(rotateVec([src[i], src[i + 1], src[i + 2]], k));
    pos[i] = t.x;
    pos[i + 1] = t.y;
    pos[i + 2] = t.z;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (index) geom.setIndex(Array.from(index));
  geom.computeVertexNormals();
  return geom;
}

/** 3D view of a WFC result: one tile instance per solved cell. */
export class SolutionView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  private controls: OrbitControls;
  private content = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pickables: THREE.Mesh[] = [];
  private tileMaterials: THREE.Material[] = [];
  /** The side that is the file's front face once displayed (see Preview). */
  private frontSide: THREE.Side = THREE.FrontSide;
  private cull = false;

  /** `onPick` gets the prototype (mesh) index of a tile clicked without dragging. */
  constructor(
    private container: HTMLElement,
    private tooltip: HTMLElement,
    private onPick: (mesh: number) => void,
  ) {
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
    this.renderer.domElement.addEventListener('pointermove', (e) => this.hover(e));
    this.renderer.domElement.addEventListener('pointerleave', () => (this.tooltip.style.display = 'none'));
    // A click picks a tile; a drag (orbiting) does not.
    let down: { x: number; y: number } | null = null;
    this.renderer.domElement.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    this.renderer.domElement.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      const proto = this.pick(e)?.userData.proto;
      if (typeof proto === 'number') this.onPick(proto);
    });
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
  }

  private pick(e: PointerEvent): THREE.Object3D | undefined {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.intersectObjects(this.pickables, false)[0]?.object;
  }

  private hover(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const hit = this.pick(e);
    this.renderer.domElement.style.cursor = typeof hit?.userData.proto === 'number' ? 'pointer' : '';
    if (!hit) {
      this.tooltip.style.display = 'none';
      return;
    }
    this.tooltip.textContent = hit.userData.label as string;
    this.tooltip.style.display = 'block';
    this.tooltip.style.left = `${e.clientX - rect.left + 12}px`;
    this.tooltip.style.top = `${e.clientY - rect.top + 12}px`;
  }

  /** Hide the back faces of tiles (by the file's winding) instead of drawing both sides. */
  setCullBackFaces(cull: boolean) {
    this.cull = cull;
    for (const mat of this.tileMaterials) {
      mat.side = cull ? this.frontSide : THREE.DoubleSide;
      mat.needsUpdate = true;
    }
  }

  show(
    result: WfcResult | null,
    meshes: readonly MeshAnalysis[],
    indices: readonly (ArrayLike<number> | null | undefined)[],
    s: Settings,
    resetView: boolean,
  ) {
    disposeTree(this.content);
    this.content.clear();
    this.pickables = [];
    this.tileMaterials = [];
    this.tooltip.style.display = 'none';
    if (!result) return;

    const [sx, sy, sz] = s.cellSize;
    const [nx, ny, nz] = result.size;
    const { min } = cellBounds({ size: s.cellSize, pivot: s.pivot });
    // Unity position of a cell's pivot, with the grid centred on the origin in x and z.
    const cellPos = (c: Vec3): Vec3 => [(c[0] - (nx - 1) / 2) * sx, c[1] * sy, (c[2] - (nz - 1) / 2) * sz];

    const ext = Math.max(nx * sx, ny * sy, nz * sz);
    const grid = new THREE.GridHelper(Math.max(nx * sx, nz * sz) * 1.5, Math.max(nx, nz) + 4, 0x3a414c, 0x262b33);
    grid.position.y = min[1] - ext * 0.002;
    this.content.add(grid);

    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(nx * sx, ny * sy, nz * sz)),
      new THREE.LineBasicMaterial({ color: 0x3a414c }),
    );
    outline.position.copy(u2t([0, min[1] + (ny * sy) / 2, 0]));
    this.content.add(outline);

    // Front faces follow the file's winding; the displayed winding is reversed when only the Z flip mirrors.
    this.frontSide = mappingDeterminant(s.axis) > 0 ? THREE.BackSide : THREE.FrontSide;
    const geoms = new Map<string, { solid: THREE.BufferGeometry; edges: THREE.BufferGeometry }>();
    const mats = new Map<number, THREE.Material>();
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x1b2028 });
    result.cells.forEach((v, i) => {
      if (v < 0) return;
      const variant = result.variants[v];
      const mesh = meshes[variant.proto];
      if (!mesh?.positions.length) return;
      const key = `${variant.proto}:${variant.rotation}`;
      let g = geoms.get(key);
      if (!g) {
        const solid = tileGeometry(mesh, indices[variant.proto], variant.rotation);
        g = { solid, edges: new THREE.EdgesGeometry(solid, 25) };
        geoms.set(key, g);
      }
      let mat = mats.get(variant.proto);
      if (!mat) {
        mat = new THREE.MeshStandardMaterial({
          color: protoColor(variant.proto),
          side: this.cull ? this.frontSide : THREE.DoubleSide,
          flatShading: true,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        });
        mats.set(variant.proto, mat);
        this.tileMaterials.push(mat);
      }
      const c = cellCoords(result.size, i);
      const pos = u2t(cellPos(c));
      const solid = new THREE.Mesh(g.solid, mat);
      solid.position.copy(pos);
      solid.userData.label = `${meshLabel(mesh)} · rot ${variant.rotation * 90}° · cell (${c.join(', ')})`;
      solid.userData.proto = variant.proto;
      const edges = new THREE.LineSegments(g.edges, edgeMat);
      edges.position.copy(pos);
      this.content.add(solid, edges);
      this.pickables.push(solid);
    });

    if (result.contradiction !== null) {
      const c = cellCoords(result.size, result.contradiction);
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(sx, sy, sz),
        new THREE.MeshBasicMaterial({ color: 0xff4d4d, transparent: true, opacity: 0.35, depthWrite: false }),
      );
      const p = cellPos(c);
      box.position.copy(u2t([p[0], p[1] + min[1] + sy / 2, p[2]]));
      box.userData.label = `Contradiction: no tile fits cell (${c.join(', ')})`;
      this.content.add(box);
      this.pickables.push(box);
    }

    if (resetView) {
      const target = u2t([0, min[1] + (ny * sy) / 2, 0]);
      this.controls.target.copy(target);
      // Like the tile preview: from behind (-Z) and above, +X to the right.
      this.camera.position.copy(target).add(u2t([ext * 0.8, ext * 0.9, -ext * 1.2]));
      this.camera.near = ext * 0.005;
      this.camera.far = ext * 100;
      this.camera.updateProjectionMatrix();
      this.controls.update();
    }
  }
}

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { mappingDeterminant, type Vec3 } from '../core/axis';
import { meshLabel, type MeshAnalysis, type Settings } from '../core/analysis';
import { cellBounds, rotateVec } from '../core/profile';
import { cellCoords, type WfcResult } from '../core/wfc';
import { disposeTree, u2t } from './preview';

/**
 * How the solve is drawn. `debug`: a colour per tile, outlines and the grid, for
 * reading the result. `shaded`: one neutral material with soft studio light,
 * shadows, ambient occlusion and tone mapping, for judging how it looks.
 */
export type Look = 'debug' | 'shaded';

const DEBUG_BACKGROUND = 0x15181d;
const SHADED_BACKGROUND = 0x2b2e33;
const SHADED_TILE = 0xa9a49b;

/**
 * A cheap stand-in for bounced light: darken the shaded tiles' colour toward
 * the ground, by height as a fraction of the grid (quadratic falloff, so the
 * darkening stays near the bottom). The uniforms are shared by every tile.
 */
function addGroundDarkening(mat: THREE.MeshStandardMaterial, uniforms: Record<string, THREE.IUniform>) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vGiY;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvGiY = (modelMatrix * vec4(transformed, 1.0)).y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGiY;\nuniform float uGiGround;\nuniform float uGiHeight;\nuniform float uGiIntensity;')
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\nfloat giDepth = 1.0 - clamp((vGiY - uGiGround) / uGiHeight, 0.0, 1.0);\ndiffuseColor.rgb *= 1.0 - uGiIntensity * giDepth * giDepth;',
      );
  };
  mat.customProgramCacheKey = () => 'ground-darkening';
}

/**
 * Screen-space cavity, like Blender's viewport option: the change of the view
 * normal across neighbouring pixels gives the curvature, positive on convex
 * edges (brightened by `ridge`) and negative on concave ones (darkened by
 * `valley`). Background pixels count as continuing the surface, so
 * silhouettes are left alone.
 */
const CavityShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tNormal: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    texel: { value: new THREE.Vector2(1, 1) },
    ridge: { value: 0.25 },
    valley: { value: 0.25 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tNormal;
    uniform sampler2D tDepth;
    uniform vec2 texel;
    uniform float ridge;
    uniform float valley;
    varying vec2 vUv;

    vec3 normalAt(vec2 uv, vec3 fallback) {
      if (texture2D(tDepth, uv).x >= 1.0) return fallback;
      return normalize(texture2D(tNormal, uv).xyz * 2.0 - 1.0);
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      if (texture2D(tDepth, vUv).x >= 1.0) {
        gl_FragColor = color;
        return;
      }
      vec3 n = normalAt(vUv, vec3(0.0, 0.0, 1.0));
      float curvature =
        normalAt(vUv + vec2(texel.x, 0.0), n).x - normalAt(vUv - vec2(texel.x, 0.0), n).x +
        normalAt(vUv + vec2(0.0, texel.y), n).y - normalAt(vUv - vec2(0.0, texel.y), n).y;
      float shade = 1.0 + ridge * max(curvature, 0.0) - valley * max(-curvature, 0.0);
      gl_FragColor = vec4(color.rgb * clamp(shade, 0.0, 2.0), color.a);
    }`,
};

/** Width of the cavity lines, in CSS pixels. */
const CAVITY_WIDTH = 1.5;

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
  private look: Look = 'debug';
  private hemi = new THREE.HemisphereLight(0xffffff, 0x404858, 1.6);
  private sun = new THREE.DirectionalLight(0xffffff, 1.8);
  private composer: EffectComposer;
  private gtao: GTAOPass;
  private cavity: ShaderPass;
  private environment: THREE.Texture | null = null;
  private gi = { uGiGround: { value: 0 }, uGiHeight: { value: 1 }, uGiIntensity: { value: 0.5 } };
  /** The last show() call, to rebuild the scene when the look changes. */
  private last: { result: WfcResult | null; meshes: readonly MeshAnalysis[]; indices: readonly (ArrayLike<number> | null | undefined)[]; s: Settings } | null = null;

  /** `onPick` gets the prototype (mesh) index of a tile clicked without dragging. */
  constructor(
    private container: HTMLElement,
    private tooltip: HTMLElement,
    private onPick: (mesh: number) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(DEBUG_BACKGROUND);
    this.sun.position.set(3, 5, 4);
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.radius = 3;
    this.scene.add(this.hemi, this.sun, this.sun.target, this.content);
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Shaded look: scene, ambient occlusion, then tone mapping and sRGB, then antialiasing
    // (the canvas's own MSAA does not reach the composer's render targets).
    this.composer = new EffectComposer(this.renderer);
    this.gtao = new GTAOPass(this.scene, this.camera);
    // The pass's normal buffer: hard edges as modelled (the tiles are flat shaded), and both sides drawn.
    this.gtao.normalMaterial.flatShading = true;
    this.gtao.normalMaterial.side = THREE.DoubleSide;
    this.cavity = new ShaderPass(CavityShader);
    this.cavity.uniforms.tNormal.value = this.gtao.normalTexture;
    this.cavity.uniforms.tDepth.value = this.gtao.depthTexture;
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(this.gtao);
    this.composer.addPass(this.cavity);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(new SMAAPass());
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
      if (this.look === 'shaded') this.composer.render();
      else this.renderer.render(this.scene, this.camera);
    });
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    // A step of CAVITY_WIDTH CSS pixels, in texture coordinates (the same at any pixel ratio).
    this.cavity.uniforms.texel.value.set(CAVITY_WIDTH / w, CAVITY_WIDTH / h);
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

  /** Switch between the debug and shaded looks, rebuilding the current solve in place. */
  setLook(look: Look) {
    if (look === this.look) return;
    this.look = look;
    if (this.last) this.show(this.last.result, this.last.meshes, this.last.indices, this.last.s, false);
    else this.applyLook();
  }

  /** How much the shaded look darkens tiles at ground level, 0 to 1. Applies live. */
  setGroundDarkening(intensity: number) {
    this.gi.uGiIntensity.value = intensity;
  }

  /** Cavity strengths for the shaded look, 0 to 1: brightening of convex edges, darkening of concave ones. Applies live. */
  setCavity(ridge: number, valley: number) {
    this.cavity.uniforms.ridge.value = ridge;
    this.cavity.uniforms.valley.value = valley;
  }

  /** Renderer, lights and environment for the current look. */
  private applyLook() {
    const shaded = this.look === 'shaded';
    this.renderer.shadowMap.enabled = shaded;
    this.renderer.toneMapping = shaded ? THREE.AgXToneMapping : THREE.NoToneMapping;
    (this.scene.background as THREE.Color).setHex(shaded ? SHADED_BACKGROUND : DEBUG_BACKGROUND);
    if (shaded && !this.environment) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
    }
    this.scene.environment = shaded ? this.environment : null;
    this.scene.environmentIntensity = 0.35;
    this.hemi.intensity = shaded ? 0.15 : 1.6;
    this.sun.intensity = shaded ? 2.2 : 1.8;
    this.sun.castShadow = shaded;
  }

  show(
    result: WfcResult | null,
    meshes: readonly MeshAnalysis[],
    indices: readonly (ArrayLike<number> | null | undefined)[],
    s: Settings,
    resetView: boolean,
  ) {
    this.last = { result, meshes, indices, s };
    disposeTree(this.content);
    this.content.clear();
    this.pickables = [];
    this.tileMaterials = [];
    this.tooltip.style.display = 'none';
    this.applyLook();
    if (!result) return;
    const shaded = this.look === 'shaded';

    const [sx, sy, sz] = s.cellSize;
    const [nx, ny, nz] = result.size;
    const { min } = cellBounds({ size: s.cellSize, pivot: s.pivot });
    // Unity position of a cell's pivot, with the grid centred on the origin in x and z.
    const cellPos = (c: Vec3): Vec3 => [(c[0] - (nx - 1) / 2) * sx, c[1] * sy, (c[2] - (nz - 1) / 2) * sz];

    const ext = Math.max(nx * sx, ny * sy, nz * sz);
    const floorSize = Math.max(nx * sx, nz * sz) * 1.5;
    const cellMax = Math.max(sx, sy, sz);
    if (shaded) {
      // A floor to catch shadows, a hair under the ground tiles so they don't z-fight.
      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(floorSize, 64),
        new THREE.MeshStandardMaterial({ color: SHADED_BACKGROUND, roughness: 1 }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = min[1] - ext * 0.002;
      floor.receiveShadow = true;
      this.content.add(floor);
      // Sun from above and to the side, its shadow camera fitted around the grid.
      const centre = u2t([0, min[1] + (ny * sy) / 2, 0]);
      this.sun.target.position.copy(centre);
      this.sun.position.copy(centre).add(new THREE.Vector3(0.9, 0.8, -0.55).normalize().multiplyScalar(ext * 2));
      const cam = this.sun.shadow.camera;
      cam.left = cam.bottom = -ext;
      cam.right = cam.top = ext;
      cam.near = ext * 0.1;
      cam.far = ext * 4;
      cam.updateProjectionMatrix();
      this.sun.shadow.bias = -0.0005;
      this.sun.shadow.normalBias = cellMax * 0.02;
      this.gtao.updateGtaoMaterial({ radius: cellMax * 0.5, thickness: cellMax });
      this.gi.uGiGround.value = min[1];
      this.gi.uGiHeight.value = ny * sy;
    } else {
      this.sun.position.set(3, 5, 4);
      this.sun.target.position.set(0, 0, 0);
      const grid = new THREE.GridHelper(floorSize, Math.max(nx, nz) + 4, 0x3a414c, 0x262b33);
      grid.position.y = min[1] - ext * 0.002;
      this.content.add(grid);

      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(nx * sx, ny * sy, nz * sz)),
        new THREE.LineBasicMaterial({ color: 0x3a414c }),
      );
      outline.position.copy(u2t([0, min[1] + (ny * sy) / 2, 0]));
      this.content.add(outline);
    }

    // Front faces follow the file's winding; the displayed winding is reversed when only the Z flip mirrors.
    this.frontSide = mappingDeterminant(s.axis) > 0 ? THREE.BackSide : THREE.FrontSide;
    const geoms = new Map<string, { solid: THREE.BufferGeometry; edges: THREE.BufferGeometry | null }>();
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
        g = { solid, edges: shaded ? null : new THREE.EdgesGeometry(solid, 25) };
        geoms.set(key, g);
      }
      // Shaded: one material for every tile (key -1). Debug: a colour per prototype.
      const matKey = shaded ? -1 : variant.proto;
      let mat = mats.get(matKey);
      if (!mat) {
        mat = new THREE.MeshStandardMaterial({
          color: shaded ? SHADED_TILE : protoColor(variant.proto),
          roughness: shaded ? 0.85 : 1,
          side: this.cull ? this.frontSide : THREE.DoubleSide,
          flatShading: true,
          // The offset only keeps the debug outlines on top.
          polygonOffset: !shaded,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        });
        if (shaded) addGroundDarkening(mat as THREE.MeshStandardMaterial, this.gi);
        mats.set(matKey, mat);
        this.tileMaterials.push(mat);
      }
      const c = cellCoords(result.size, i);
      const pos = u2t(cellPos(c));
      const solid = new THREE.Mesh(g.solid, mat);
      solid.position.copy(pos);
      solid.userData.label = `${meshLabel(mesh)} · rot ${variant.rotation * 90}° · cell (${c.join(', ')})`;
      solid.userData.proto = variant.proto;
      solid.castShadow = solid.receiveShadow = shaded;
      this.content.add(solid);
      if (!shaded) {
        const edges = new THREE.LineSegments(g.edges!, edgeMat);
        edges.position.copy(pos);
        this.content.add(edges);
      }
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
    } else if (this.camera.far < ext * 100) {
      // The view stays put, but a grown grid must not be clipped.
      this.camera.far = ext * 100;
      this.camera.updateProjectionMatrix();
    }
  }
}

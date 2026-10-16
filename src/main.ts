import './style.css';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import {
  AXIS_PRESETS,
  cloneMapping,
  describeSource,
  parseSource,
  presetForMapping,
  validateMapping,
  type AxisPresetId,
} from './core/axis';
import {
  analyze,
  boundarySockets,
  importedBoundary,
  buildExport,
  computeIds,
  defaultSettings,
  exportText,
  findUnmatchedFaces,
  importProposals,
  meshSockets,
  parseImport,
  prototypeTags,
  tagsFromName,
  EMPTY_NAME,
  meshLabel,
  originAtGround,
  sameOriginHeights,
  verticalSocket,
  wfcBoundaryDefaults,
  type WfcBoundary,
  type Analysis,
  type ExportJson,
  type FaceRef,
  type IdState,
  type Prototype,
  type RawMesh,
  type Settings,
} from './core/analysis';
import { readUnitScaleFactor } from './core/fbxUnits';
import { checkHId, checkVBase, reverseString } from './core/ids';
import { ALL_FACES, H_FACES, OPPOSITE, rotatePoint, type Face } from './core/profile';
import { plotH, plotV } from './ui/plots';
import { BACK_FACE_COLOR, FACE_COLORS, Preview } from './ui/preview';
import { SolutionView, protoColor, type Look } from './ui/solution';
import { buildVariants, solveWfc, tagFilter, type WfcResult } from './core/wfc';
import { ICONS, injectIcons } from './ui/icons';
import { installTooltips } from './ui/tooltip';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** UI preferences (tab, panel widths, open sections); storage can be unavailable. */
const prefs = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`wfc-tool:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`wfc-tool:${key}`, value);
    } catch {
      /* not persisted */
    }
  },
};

function toast(text: string, level: 'error' | 'info' = 'error') {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = text;
  $('toasts').append(el);
  setTimeout(() => el.classList.add('out'), 4500);
  setTimeout(() => el.remove(), 4900);
}

const state = {
  fileName: '',
  raws: [] as RawMesh[],
  settings: defaultSettings(),
  analysis: null as Analysis | null,
  ids: { h: new Map(), v: new Map() } as IdState,
  /** User renames, applied before everything else. */
  renamesH: new Map<string, string>(),
  renamesV: new Map<string, string>(),
  imported: null as ExportJson | null,
  importedName: '',
  importMessages: [] as string[],
  weights: [] as number[],
  selected: 0,
  loadError: '',
  unitNote: '',
  /** Add the format's empty tiles (mesh_name "-1"), outside and inside air, to the prototypes. */
  emptyTile: true,
  /** Enclosed space: inside/outside sampling, except for tiles with a tag in `off`. Tags start enabled. */
  enclosed: { on: prefs.get('enclosed') !== 'off', off: new Set<string>(JSON.parse(prefs.get('enclosedOff') ?? '[]') as string[]) },
  wfc: {
    size: [10, 3, 10] as [number, number, number],
    seed: 1,
    /** Boundary sockets; empty means unconstrained. */
    outer: '',
    /** Sides of layer 0, used instead of `outer` there when top/bottom sockets are on. */
    outerGround: '',
    bottom: '',
    top: '',
    /** Boundary inputs the user has edited; the others follow wfcDefaults. */
    edited: new Set<WfcBoundary>(),
    /** Tags turned off in the solve: tiles carrying any of them are left out. */
    hiddenTags: new Set<string>(),
    result: null as WfcResult | null,
    ms: 0,
  },
};

const WFC_BOUNDARY_INPUTS = [
  ['outer', 'wfcOuter'],
  ['outerGround', 'wfcOuterGround'],
  ['bottom', 'wfcBottom'],
  ['top', 'wfcTop'],
] as const;

const preview = new Preview($('preview'));
const solutionView = new SolutionView($('wfcView'), $('wfcTooltip'), (mesh) => selectMesh(mesh));

// ---------------------------------------------------------------- loading

/**
 * FBXLoader passes object names through PropertyBinding.sanitizeNodeName,
 * which turns spaces into underscores and strips characters like "." and ":".
 * Unity keeps the original names, so disable that while parsing.
 */
function parseFbxKeepingNames(buffer: ArrayBuffer): THREE.Group {
  const binding = THREE.PropertyBinding as unknown as { sanitizeNodeName: (n: string) => string };
  const original = binding.sanitizeNodeName;
  binding.sanitizeNodeName = (n) => n;
  try {
    return new FBXLoader().parse(buffer, '');
  } finally {
    binding.sanitizeNodeName = original;
  }
}

async function loadFbx(file: File) {
  try {
    const buffer = await file.arrayBuffer();
    const group = parseFbxKeepingNames(buffer);
    group.updateMatrixWorld(true);
    const raws: RawMesh[] = [];
    const v = new THREE.Vector3();
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geom = mesh.geometry as THREE.BufferGeometry;
      const attr = geom.getAttribute('position');
      if (!attr) return;
      const positions = new Float64Array(attr.count * 3);
      for (let i = 0; i < attr.count; i++) {
        v.fromBufferAttribute(attr, i).applyMatrix4(mesh.matrixWorld);
        positions[i * 3] = v.x;
        positions[i * 3 + 1] = v.y;
        positions[i * 3 + 2] = v.z;
      }
      const origin = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
      // A mirroring transform (negative scale) reverses the winding; undo it so normals stay true.
      let index: number[] | null = geom.index ? Array.from(geom.index.array) : null;
      if (mesh.matrixWorld.determinant() < 0) {
        index ??= Array.from({ length: attr.count }, (_, i) => i);
        for (let t = 0; t + 2 < index.length; t += 3) [index[t + 1], index[t + 2]] = [index[t + 2], index[t + 1]];
      }
      raws.push({
        name: mesh.name || mesh.parent?.name || `Mesh${raws.length}`,
        positions,
        index,
        origin: [origin.x, origin.y, origin.z],
      });
    });
    if (!raws.length) throw new Error('No meshes found in this FBX.');
    const unitFactor = readUnitScaleFactor(buffer);
    if (unitFactor !== null && unitFactor > 0) {
      state.settings.scale = unitFactor / 100;
      $<HTMLInputElement>('scale').value = String(state.settings.scale);
      $<HTMLInputElement>('scale').classList.remove('invalid');
    }
    state.unitNote =
      unitFactor === null
        ? 'No UnitScaleFactor found in the FBX; scale left unchanged.'
        : `FBX UnitScaleFactor ${unitFactor} → scale ${+(unitFactor / 100).toPrecision(6)}, matching Unity's "Convert Units".`;
    $('scaleRow').dataset.tip = `${SCALE_TIP}\n\n${state.unitNote}`;
    state.fileName = file.name;
    state.raws = raws;
    state.weights = raws.map((r) => importedWeight(r.name) ?? 1);
    state.selected = 0;
    state.loadError = '';
    // Meshes whose origins sit at different heights are stacked tiles: turn top/bottom sockets on by default.
    if (!validateMapping(state.settings.axis) && !sameOriginHeights(raws, state.settings)) {
      state.settings.vertical = true;
      $<HTMLInputElement>('vertical').checked = true;
    }
    recompute(true);
  } catch (e) {
    state.loadError = `Could not load ${file.name}: ${(e as Error).message}`;
    toast(state.loadError);
    render(false);
  }
}

/** The format's empty tile: air or interior, nothing is built for it. */
const EMPTY_TILES: RawMesh[] = (['o', 'i'] as const).map((emptySpace) => ({
  name: EMPTY_NAME,
  positions: [],
  index: null,
  origin: [0, 0, 0],
  emptySpace,
}));
/** Interior on the ground (bottom socket "g"), so rooms can reach down to layer 0. */
const INSIDE_GROUND_TILE: RawMesh = { ...EMPTY_TILES[1], ground: true };

/** Meshes to analyse: the FBX's, plus the empty tile when enabled. */
function tileRaws(): RawMesh[] {
  if (!state.emptyTile) return state.raws;
  const ground = state.raws.some((r) => originAtGround(r, state.settings));
  return [...state.raws, ...EMPTY_TILES, ...(ground ? [INSIDE_GROUND_TILE] : [])];
}

function importedTags(name: string): string[] | undefined {
  return state.imported?.prototypes.find((p) => p.mesh_name === name)?.tags;
}

function exportJson(a: Analysis): ExportJson {
  return buildExport(a, state.ids, state.weights, state.settings.vertical, a.meshes.map((m) => importedTags(m.name)));
}

function importedWeight(name: string): number | undefined {
  return state.imported?.prototypes.find((p) => p.mesh_name === name)?.weight;
}

async function loadJson(file: File) {
  try {
    state.imported = parseImport(await file.text());
    state.importedName = file.name;
    // Boundary sockets from the file replace the inputs' defaults, as if typed in.
    const boundary = importedBoundary(state.imported.boundary_sockets ?? {});
    for (const [key, id] of WFC_BOUNDARY_INPUTS) {
      const value = boundary[key];
      if (value === undefined) continue;
      state.wfc[key] = value;
      state.wfc.edited.add(key);
      $<HTMLInputElement>(id).value = value;
    }
    tileRaws().forEach((r, i) => {
      const w = importedWeight(r.name);
      if (w !== undefined) state.weights[i] = w;
    });
    state.loadError = '';
    recompute(false);
  } catch (e) {
    state.loadError = `Could not import ${file.name}: ${(e as Error).message}`;
    toast(state.loadError);
    render(false);
  }
}

function handleFile(file: File) {
  if (/\.json$/i.test(file.name)) loadJson(file);
  else loadFbx(file);
}

// ---------------------------------------------------------------- analysis

function recompute(resetView: boolean) {
  state.importMessages = [];
  if (!state.raws.length || validateMapping(state.settings.axis)) {
    state.analysis = null;
    render(resetView);
    return;
  }
  const raws = tileRaws();
  raws.forEach((r, i) => (state.weights[i] ??= importedWeight(r.name) ?? 1));
  state.settings.enclosedSpace = state.enclosed.on;
  state.settings.openTags = [...state.enclosed.off];
  const a = analyze(raws, state.settings);
  const imp = state.imported ? importProposals(a, state.imported) : { h: new Map(), v: new Map(), origin: new Map() };
  // Priority: user renames > imported JSON > previous IDs (keeps IDs stable across setting changes) > automatic.
  const res = computeIds(a, [state.renamesH, imp.h, state.ids.h], [state.renamesV, imp.v, state.ids.v]);
  for (const r of res.rejectedH.filter((r) => r.source === 1)) {
    state.importMessages.push(`Imported ID "${r.id}" from ${imp.origin.get(`h:${r.key}`)} not reused: ${r.reason}`);
  }
  if (state.settings.vertical) {
    for (const r of res.rejectedV.filter((r) => r.source === 1)) {
      state.importMessages.push(`Imported vertical ID "${r.id}" from ${imp.origin.get(`v:${r.key}`)} not reused: ${r.reason}`);
    }
  }
  state.analysis = a;
  state.ids = res.ids;
  render(resetView);
}

function renameH(key: string, value: string): string | null {
  const info = state.analysis!.hProfiles.get(key)!;
  const id = value.trim();
  if (id === state.ids.h.get(key)) return null;
  const owner = new Map([...state.ids.h].map(([k, i]) => [i, k]));
  const err = checkHId(id, info.symmetric, [key, info.mirror.key], owner);
  if (err) return err;
  state.renamesH.delete(info.mirror.key);
  state.renamesH.set(key, id);
  recompute(false);
  return null;
}

function renameV(classKey: string, value: string): string | null {
  const base = value.trim();
  if (base === state.ids.v.get(classKey)) return null;
  const owner = new Map([...state.ids.v].map(([k, b]) => [b, k]));
  const err = checkVBase(base, classKey, owner);
  if (err) return err;
  state.renamesV.set(classKey, base);
  recompute(false);
  return null;
}

// ---------------------------------------------------------------- settings UI

function buildSettings() {
  const s = state.settings;
  const sources = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
  const presetOptions = Object.entries(AXIS_PRESETS)
    .map(([id, p]) => `<option value="${id}">${esc(p.label)}</option>`)
    .join('');
  const prop = (label: string, tip: string, control: string, attrs = '') =>
    `<div class="prop" data-tip="${esc(tip)}" ${attrs}><label>${label}</label>${control}</div>`;
  const toggle = (id: string) => `<div class="ctl"><label class="switch"><input type="checkbox" id="${id}"><span></span></label></div>`;
  const section = (key: string, title: string, body: string) =>
    `<details class="sect" data-key="${key}" open><summary>${title}</summary><div class="props">${body}</div></details>`;
  $('settings').innerHTML =
    section(
      'import',
      'Import',
      prop('Scale', SCALE_TIP, `<input type="number" id="scale" step="any" min="0" value="${s.scale}">`, 'id="scaleRow"') +
        prop('Axes', '', `<select id="axisPreset">${presetOptions}<option value="manual">Manual</option></select>`, 'id="axisRow"') +
        prop(
          'Unity from',
          'The file axis each Unity axis comes from.',
          `<div class="vec">${(['x', 'y', 'z'] as const)
            .map(
              (k) =>
                `<label class="${k}"><span>${k.toUpperCase()}</span><select id="axis_${k}">${sources
                  .map((o) => `<option value="${o}">${o}</option>`)
                  .join('')}</select></label>`,
            )
            .join('')}</div>`,
          'id="axisManual"',
        ) +
        `<div class="prop-error" id="axisError"></div>` +
        prop(
          'Ignore position',
          "Ignore each object's position in the file, for tiles laid out side by side.",
          toggle('ignoreTranslation'),
        ),
    ) +
    section(
      'cell',
      'Cell',
      prop(
        'Size',
        'Size of one tile cell in Unity units.',
        `<div class="vec">${(['X', 'Y', 'Z'] as const)
          .map(
            (k, i) =>
              `<label class="${k.toLowerCase()}"><span>${k}</span><input type="number" id="cell${k}" step="any" min="0" value="${s.cellSize[i]}"></label>`,
          )
          .join('')}</div>`,
      ) +
        prop(
          'Pivot',
          "Where each tile's origin sits in its cell.",
          `<select id="pivot"><option value="bottom">Bottom center</option><option value="center">Center</option></select>`,
        ) +
        prop(
          'Epsilon',
          'Tolerance for points counting as on a face, and as equal.',
          `<input type="number" id="epsilon" step="any" min="0" value="${s.epsilon}">`,
        ),
    ) +
    section(
      'sockets',
      'Sockets',
      prop(
        'Top / bottom',
        'Write posY / negY sockets.\n\nOff: Unity infers top and bottom from the sides (posX|negZ|negX|posZ), which assumes straight prisms.',
        toggle('vertical'),
      ) +
        prop('Empty tiles', 'Add "-1" air tiles: outside air, inside air, and inside air on the ground.', toggle('emptyTile')) +
        prop(
          'Enclosed space',
          'Inside/outside sampling, so interiors only connect to interiors.\n\nTurn a tag off for tiles that enclose nothing (roads, ground): tiles with a tag that is off count as outside everywhere.',
          toggle('enclosedSpace'),
        ) +
        `<div class="chip-row" id="enclosedTags"></div>`,
    );
  syncSettingsInputs();

  const num = (id: string) => {
    const el = $<HTMLInputElement>(id);
    const v = Number(el.value);
    const ok = el.value !== '' && Number.isFinite(v) && v > 0;
    el.classList.toggle('invalid', !ok);
    return ok ? v : null;
  };
  const onChange = () => {
    const vals = [num('cellX'), num('cellY'), num('cellZ'), num('epsilon'), num('scale')];
    if (vals.some((v) => v === null)) return;
    const [x, y, z, eps, scale] = vals as number[];
    s.cellSize = [x, y, z];
    s.epsilon = eps;
    s.scale = scale;
    s.pivot = $<HTMLSelectElement>('pivot').value as Settings['pivot'];
    s.ignoreTranslation = $<HTMLInputElement>('ignoreTranslation').checked;
    s.vertical = $<HTMLInputElement>('vertical').checked;
    state.emptyTile = $<HTMLInputElement>('emptyTile').checked;
    recompute(true);
  };
  for (const id of ['cellX', 'cellY', 'cellZ', 'epsilon', 'scale', 'pivot', 'ignoreTranslation', 'vertical', 'emptyTile']) {
    $(id).addEventListener('change', onChange);
  }
  $('enclosedSpace').addEventListener('change', () => {
    state.enclosed.on = $<HTMLInputElement>('enclosedSpace').checked;
    prefs.set('enclosed', state.enclosed.on ? 'on' : 'off');
    recompute(false);
  });
  $('enclosedTags').addEventListener('click', (e) => {
    const tag = (e.target as Element).closest<HTMLElement>('.tag-chip')?.dataset.tag;
    if (tag === undefined) return;
    const off = state.enclosed.off;
    if (!off.delete(tag)) off.add(tag);
    prefs.set('enclosedOff', JSON.stringify([...off]));
    recompute(false);
  });
  $('axisPreset').addEventListener('change', () => {
    const id = $<HTMLSelectElement>('axisPreset').value as AxisPresetId;
    if (id !== 'manual') s.axis = cloneMapping(AXIS_PRESETS[id].mapping);
    syncSettingsInputs(id);
    recompute(true);
  });
  for (const k of ['x', 'y', 'z'] as const) {
    $(`axis_${k}`).addEventListener('change', () => {
      s.axis[k] = parseSource($<HTMLSelectElement>(`axis_${k}`).value);
      syncSettingsInputs('manual');
      recompute(true);
    });
  }
}

function syncSettingsInputs(preset: AxisPresetId = presetForMapping(state.settings.axis)) {
  const s = state.settings;
  $<HTMLSelectElement>('pivot').value = s.pivot;
  $<HTMLInputElement>('ignoreTranslation').checked = s.ignoreTranslation;
  $<HTMLInputElement>('vertical').checked = s.vertical;
  $<HTMLInputElement>('emptyTile').checked = state.emptyTile;
  $<HTMLInputElement>('enclosedSpace').checked = state.enclosed.on;
  $<HTMLSelectElement>('axisPreset').value = preset;
  $('axisRow').dataset.tip =
    preset === 'manual' ? 'Pick the file axis each Unity axis comes from.' : AXIS_PRESETS[preset].description;
  $('axisManual').hidden = preset !== 'manual';
  for (const k of ['x', 'y', 'z'] as const) $<HTMLSelectElement>(`axis_${k}`).value = describeSource(s.axis[k]);
  const err = validateMapping(s.axis);
  $('axisError').textContent = err ?? '';
  $('axisError').hidden = !err;
}

const SCALE_TIP = 'Multiplier on file positions. Set from the FBX UnitScaleFactor on load.';

// ---------------------------------------------------------------- rendering

function faceLabel(ref: FaceRef): string {
  return `${meshLabel(state.analysis!.meshes[ref.mesh])}.${ref.face}`;
}

function currentSockets() {
  const a = state.analysis!;
  return a.meshes.map((m) => meshSockets(a, state.ids, m.index, state.settings.vertical));
}

/** Every tag from the loaded tiles' names, sorted. */
function fileTags(): string[] {
  return [...new Set(state.raws.flatMap((r) => tagsFromName(r.name)))].sort((x, y) => x.localeCompare(y));
}

/** The Enclosed space tag chips, with how many tiles carry each tag. */
function renderEnclosedTags() {
  const el = $('enclosedTags');
  el.hidden = !state.enclosed.on;
  const counts = new Map<string, number>();
  for (const r of state.raws) for (const t of tagsFromName(r.name)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const tags = fileTags();
  el.innerHTML = tags.length
    ? tags
        .map((t) => {
          const on = !state.enclosed.off.has(t);
          return `<button class="tag-chip${on ? '' : ' off'}" data-tag="${esc(t)}" aria-pressed="${on}" data-tip="${on ? 'Sampled' : 'Not sampled'}: ${counts.get(t)} tile${counts.get(t) === 1 ? '' : 's'}">${esc(t)}</button>`;
        })
        .join('')
    : `<span class="muted">${state.raws.length ? 'No tags in this file.' : 'Load an FBX to pick tags.'}</span>`;
}

function render(resetView: boolean) {
  const a = state.analysis;
  renderEnclosedTags();
  $('fileChip').innerHTML = state.fileName
    ? `${esc(state.fileName)} <span class="muted">${state.raws.length} mesh${state.raws.length === 1 ? '' : 'es'}</span>`
    : '';
  document.title = state.fileName ? `${state.fileName} · WFC Socket Tool` : 'WFC Socket Tool';
  $<HTMLButtonElement>('exportBtn').disabled = !a;
  $('importChip').innerHTML = state.imported
    ? `<span class="chip" data-tip="Socket IDs and weights are reused from ${esc(state.importedName)} (${state.imported.prototypes.length} prototypes).">IDs: ${esc(state.importedName)}<button id="clearImport" data-icon="x" aria-label="Stop reusing imported IDs"></button></span>`
    : '';
  injectIcons($('importChip'));
  $('clearImport')?.addEventListener('click', () => {
    state.imported = null;
    recompute(false);
  });
  $('emptyState').hidden = state.raws.length > 0;
  syncResetWeights();

  if (!a) {
    preview.show(null, null, state.settings, resetView);
    $('previewInfo').innerHTML = '';
    $('legend').innerHTML = '';
    $('tileCount').textContent = '';
    $('profileCount').textContent = '';
    $('meshes').innerHTML = `<div class="placeholder">${state.raws.length ? 'Fix the axis mapping to analyse the tiles.' : 'No tiles loaded.'}</div>`;
    const errs = [state.loadError, validateMapping(state.settings.axis)].filter(Boolean) as string[];
    renderIssues(errs.map((text) => ({ level: 'error', text })));
    $('statusMsg').textContent = state.raws.length ? '' : 'Ready';
    $('idTables').innerHTML = '';
    solveAndRender(resetView);
    return;
  }

  const sockets = currentSockets();
  const unmatched = findUnmatchedFaces(sockets);
  renderMeshes(sockets, unmatched);
  renderWarnings(sockets, unmatched);
  const counts = renderIdTables();
  applyTileSearch();
  $('profileCount').textContent = String(counts.h + counts.v);
  $('statusMsg').textContent =
    `${a.meshes.length} tiles · ${counts.h} side profiles` + (state.settings.vertical ? ` · ${counts.v} top/bottom profiles` : '');
  renderPreview(resetView);
  solveAndRender(resetView);
}

function renderPreview(resetView: boolean) {
  const a = state.analysis!;
  const m = a.meshes[state.selected];
  preview.show(m, state.raws[state.selected]?.index, state.settings, resetView);
  const fmt = (v: number[]) => v.map((x) => +x.toFixed(3)).join(', ');
  $('previewInfo').innerHTML = m
    ? `<span class="pill"${m.bounds ? ` data-tip="Bounds (${fmt(m.bounds.min)}) to (${fmt(m.bounds.max)})"` : ''}>` +
      `<strong>${esc(meshLabel(m))}</strong><span class="muted">${m.positions.length / 3} verts</span></span>`
    : '';
  $('legend').innerHTML =
    ALL_FACES.filter((f) => state.settings.vertical || H_FACES.includes(f as never))
      .map((f) => `<span class="key"><span class="swatch" style="background:${FACE_COLORS[f]}"></span>${f}</span>`)
      .join('') +
    `<span class="key" data-tip="Back faces by the FBX winding"><span class="swatch" style="background:#${BACK_FACE_COLOR.toString(16).padStart(6, '0')}"></span>back</span>`;
}

function renderMeshes(sockets: ReturnType<typeof currentSockets>, unmatched: FaceRef[]) {
  const a = state.analysis!;
  const faces: Face[] = state.settings.vertical ? [...ALL_FACES] : [...H_FACES];
  const counts = new Map<string, number>();
  for (const m of a.meshes) if (m.name !== EMPTY_NAME) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
  const bad = new Set(unmatched.map((u) => `${u.mesh}:${u.face}`));
  $('meshes').innerHTML = `
    <table>
      <thead><tr><th>Name</th>${faces
        .map((f) => `<th><span class="swatch" style="background:${FACE_COLORS[f]}"></span>${f}</th>`)
        .join('')}<th class="num" data-tip="Weight: relative chance to be picked. 0 = only as a fallback.">Wt</th><th class="num" data-tip="Tiles placed in the current solve">Used</th></tr></thead>
      <tbody>${a.meshes
        .map((m, i) => {
          const dup = (counts.get(m.name) ?? 0) > 1;
          const flag = m.outsideCount
            ? `<span class="flag" data-tip="${m.outsideCount} of ${m.positions.length / 3} vertices lie outside the cell">${ICONS.alert}</span>`
            : '';
          const tags = prototypeTags(m.name, importedTags(m.name));
          const tip = (tags.length ? `Tags: ${tags.join(', ')}` : 'No tags') + (dup ? '\nDuplicate mesh name' : '');
          return `
        <tr class="mesh-row${i === state.selected ? ' selected' : ''}" data-mesh="${i}" data-tip="${esc(tip)}">
          <td><div class="name${dup ? ' name-dup' : ''}"><span class="swatch sq" style="background:#${protoColor(i).getHexString()}"></span><span class="label">${esc(meshLabel(m))}</span>${flag}</div></td>
          ${faces
            .map((f) => {
              const isBad = bad.has(`${i}:${f}`);
              const open = m.faces[f].open;
              const tip = isBad
                ? 'No tile in any rotation can sit on this side'
                : open
                  ? 'Open: only a surface facing out of the cell, so it matches an empty face'
                  : '';
              return `<td class="sock${isBad ? ' bad' : ''}${open ? ' open' : ''}"${tip ? ` data-tip="${tip}"` : ''}>${esc(sockets[i][f] ?? '')}</td>`;
            })
            .join('')}
          <td class="num"><input type="number" class="weight" data-mesh="${i}" min="0" step="any" value="${state.weights[i] ?? 1}"></td>
          <td class="num placed" data-mesh="${i}"></td>
        </tr>`;
        })
        .join('')}</tbody>
    </table>`;
}

type Issue = { level: 'error' | 'warn'; text: string };

function renderIssues(items: Issue[]) {
  const errors = items.filter((i) => i.level === 'error').length;
  const btn = $('issuesBtn');
  btn.hidden = !state.raws.length && !items.length;
  btn.className = `status-btn ${errors ? 'error' : items.length ? 'warn' : 'ok'}`;
  btn.innerHTML = items.length
    ? `${ICONS.alert}${items.length} issue${items.length > 1 ? 's' : ''}`
    : `${ICONS.check}No issues`;
  $('issuesList').innerHTML = items.length
    ? `<ul>${items.map((i) => `<li class="${i.level}">${ICONS.alert}<span>${esc(i.text)}</span></li>`).join('')}</ul>`
    : '<div class="ok">No problems found.</div>';
}

function renderWarnings(sockets: ReturnType<typeof currentSockets>, unmatched: FaceRef[]) {
  const a = state.analysis!;
  const s = state.settings;
  const items: Issue[] = [];
  if (state.loadError) items.push({ level: 'error', text: state.loadError });

  const counts = new Map<string, number>();
  // The empty tiles share "-1" on purpose.
  for (const m of a.meshes) if (m.name !== EMPTY_NAME) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
  for (const [name, n] of counts) {
    if (n > 1) items.push({ level: 'error', text: `Duplicate mesh name "${name}" (${n} meshes).` });
  }

  const maxCell = Math.max(...s.cellSize);
  for (const m of a.meshes) {
    if (!m.outsideCount) continue;
    let text = `${m.name}: ${m.outsideCount} of ${m.positions.length / 3} vertices lie outside the cell.`;
    if (m.bounds) {
      const extent = Math.max(...[0, 1, 2].map((i) => m.bounds!.max[i] - m.bounds!.min[i]));
      if (extent > maxCell * 20) text += ` The mesh is ${Math.round(extent / maxCell)}× the cell size; try Scale = 0.01.`;
      else if (!s.ignoreTranslation && a.meshes.length > 1) text += ' If tiles are laid out side by side, try "ignore object position".';
    }
    items.push({ level: 'warn', text });
  }

  if (s.cellSize[0] !== s.cellSize[2]) {
    items.push({ level: 'warn', text: 'Cell X and Z sizes differ, so 90° rotations do not map the cell onto itself.' });
  }

  for (const u of unmatched) {
    const id = sockets[u.mesh][u.face]!;
    items.push({
      level: 'warn',
      text:
        u.face === 'posY' || u.face === 'negY'
          ? `${faceLabel(u)} ("${id}") has nothing to stack against: no tile in any rotation has ${OPPOSITE[u.face]} = "${id}" (given or inferred from its sides). Fine only if it is the stack's ${u.face === 'negY' ? 'bottom' : 'top'} socket.`
          : `${faceLabel(u)} ("${id}") has no possible neighbour: no tile in any rotation has ${OPPOSITE[u.face]} = "${reverseString(id)}".`,
    });
  }
  for (const msg of state.importMessages) items.push({ level: 'warn', text: msg });

  renderIssues(items);
}

function usageCell(refs: FaceRef[]): string {
  return `<span class="usage" data-tip="${esc(refs.map(faceLabel).join('\n'))}">${refs.length}</span>`;
}

const info = (tip: string) => `<span class="info" data-tip="${esc(tip)}">${ICONS.info}</span>`;

/** Renders the profile tables; returns the number of rows in each. */
function renderIdTables(): { h: number; v: number } {
  const a = state.analysis!;
  const s = state.settings;
  const eps = s.epsilon;
  const [sx, sy, sz] = s.cellSize;

  // One row per mirror pair: skip a profile whose mirror already has a row.
  const shown = new Set<string>();
  const hRows = [...a.hProfiles.values()]
    .filter((p) => {
      if (shown.has(p.mirror.key)) return false;
      shown.add(p.key);
      return true;
    })
    .map((p) => {
      const face = p.usage[0].face;
      const width = face === 'posX' || face === 'negX' ? sz : sx;
      const id = state.ids.h.get(p.key)!;
      const mirrorUsage = p.symmetric ? null : (a.hProfiles.get(p.mirror.key)?.usage ?? []);
      // Edges come from the first face using the profile; the mirror's are those flipped in u.
      const edges = a.meshes[p.usage[0].mesh].faces[face].edges;
      const mirrorEdges = edges.map(([e0, e1]) => [[0 - e0[0], e0[1]], [0 - e1[0], e1[1]]] as const);
      return `<tr>
        <td>${plotH(p.profile, edges, eps, width, sy, '#4aa3ff')}</td>
        <td>${p.symmetric ? '<span class="muted">same</span>' : plotH(p.mirror, mirrorEdges, eps, width, sy, '#b07cff')}</td>
        <td>${p.symmetric ? 'yes' : 'no'}</td>
        <td><input class="id-input" data-kind="h" data-key="${esc(p.key)}" value="${esc(id)}"></td>
        <td class="id-mono">${p.symmetric ? '<span class="muted">(itself)</span>' : esc(state.ids.h.get(p.mirror.key)!)}</td>
        <td>${usageCell(p.usage)}${mirrorUsage ? ` / ${usageCell(mirrorUsage)}` : ''}</td>
      </tr>`;
    })
    .join('');

  let vSection = '';
  if (s.vertical) {
    const vRows = [...a.vProfiles.values()]
      .map((p) => {
        const base = state.ids.v.get(p.classKey)!;
        const cls = a.vClasses.get(p.classKey)!;
        // Edges come from the first face using the profile; turning them back r quarter turns gives the canonical form.
        const edges = a.meshes[p.usage[0].mesh].faces[p.usage[0].face].edges;
        const canonicalEdges = edges.map((e) => [rotatePoint(e[0], -p.r), rotatePoint(e[1], -p.r)] as const);
        return `<tr>
          <td>${plotV(p.profile, edges, eps, sx, sz, '#3ddc84')}</td>
          <td>${plotV(cls.canonical, canonicalEdges, eps, sx, sz, '#f5d142')}</td>
          <td>${p.period}</td>
          <td><input class="id-input" data-kind="v" data-key="${esc(p.classKey)}" value="${esc(base)}" maxlength="2"></td>
          <td class="id-mono">${esc(verticalSocket(a, state.ids, p.key))}</td>
          <td class="muted">r = ${p.r}</td>
          <td>${usageCell(p.usage)}</td>
        </tr>`;
      })
      .join('');
    vSection = `
      <h2>Top / bottom profiles ${info('posY / negY faces, plotted in Unity (x, z) from above. Profiles equal under 90° rotation share a base letter; 4-part sockets turn with the tile.')}</h2>
      <table>
        <thead><tr><th>Profile</th><th>Canonical</th><th data-tip="Quarter turns after which the profile repeats">Period</th><th>Base</th><th>Socket</th><th data-tip="Quarter turns from the canonical form">Rotation</th><th data-tip="Faces using this profile">Faces</th></tr></thead>
        <tbody>${vRows}</tbody>
      </table>`;
  }

  $('idTables').innerHTML = `
    <h2>Side profiles ${info(
      'Seen from inside the tile. Lines are mesh edges in the face plane. Filled ■ = surface in the face facing out of the cell, hollow □ = facing in. Dotted ticks: which way an edge-on surface (a wall) faces. Shaded = inside.\n\nEdit an ID to rename it; its mirror follows.',
    )}</h2>
    <table>
      <thead><tr><th>Profile</th><th>Mirror</th><th>Symmetric</th><th>ID</th><th>Mirror ID</th><th data-tip="Faces using the profile / its mirror">Faces</th></tr></thead>
      <tbody>${hRows}</tbody>
    </table>
    ${vSection}`;
  return { h: shown.size, v: s.vertical ? a.vProfiles.size : 0 };
}

// ---------------------------------------------------------------- WFC preview

/** Suggestions for the boundary socket inputs: every side and every top/bottom socket in use. */
function fillSocketLists(variants: ReturnType<typeof buildVariants>) {
  const sides = new Set<string>();
  const faces = new Set<string>();
  for (const v of variants) {
    for (const f of H_FACES) sides.add(v.sockets[f]);
    faces.add(v.sockets.posY).add(v.sockets.negY);
  }
  const opts = (set: Set<string>) => [...set].sort().map((id) => `<option value="${esc(id)}">`).join('');
  $('wfcSides').innerHTML = opts(sides);
  $('wfcFaces').innerHTML = opts(faces);
}

/** Put the defaults into every boundary input the user hasn't edited. */
function applyWfcDefaults(a: Analysis, protos: readonly Prototype[]) {
  const defaults = wfcBoundaryDefaults(a, protos);
  for (const [key, id] of WFC_BOUNDARY_INPUTS) {
    if (state.wfc.edited.has(key)) continue;
    state.wfc[key] = defaults[key];
    $<HTMLInputElement>(id).value = defaults[key];
  }
}

/** Run WFC on the current sockets (as exported) and show the result. */
function solveAndRender(resetView: boolean) {
  const a = state.analysis;
  $<HTMLButtonElement>('wfcNewSeed').disabled = !a;
  // With top and bottom sockets the ground level is told apart: it gets its own outer socket.
  const split = state.settings.vertical;
  $('wfcOuterGroundRow').hidden = !split;
  const status = $('wfcStatus');
  const dot = $('solveDot');
  if (!a) {
    state.wfc.result = null;
    solutionView.show(null, [], [], state.settings, resetView);
    status.className = 'pill';
    status.textContent = '';
    delete status.dataset.tip;
    dot.className = 'dot';
    return;
  }
  const protos = exportJson(a).prototypes;
  const kept = tagFilter(protos, state.wfc.hiddenTags);
  renderTagFilter(protos);
  document.querySelectorAll<HTMLElement>('tr.mesh-row').forEach((row) => {
    const out = !kept[Number(row.dataset.mesh)];
    row.classList.toggle('filtered', out);
    const used = row.querySelector<HTMLElement>('td.placed')!;
    if (out) used.dataset.tip = 'Left out of the solve by the tag filter';
    else delete used.dataset.tip;
  });
  const variants = buildVariants(protos).filter((v) => kept[v.proto]);
  fillSocketLists(variants);
  applyWfcDefaults(a, protos);
  if (!variants.length) {
    state.wfc.result = null;
    solutionView.show(null, [], [], state.settings, resetView);
    status.className = 'pill error';
    dot.className = 'dot error';
    status.innerHTML = `${ICONS.alert}No tiles left`;
    status.dataset.tip = 'Every tile carries a tag that is turned off.';
    document.querySelectorAll<HTMLElement>('td.placed').forEach((td) => (td.textContent = '·'));
    return;
  }
  const { size, seed, outer, outerGround, bottom, top } = state.wfc;
  const start = performance.now();
  const res = solveWfc(variants, { size, seed, outer, outerGround: split ? outerGround : undefined, bottom, top });
  state.wfc.ms = performance.now() - start;
  state.wfc.result = res;
  solutionView.show(res, a.meshes, tileRaws().map((r) => r.index), state.settings, resetView);

  const time = `${state.wfc.ms.toFixed(0)} ms`;
  const attempts = `${res.attempts} attempt${res.attempts > 1 ? 's' : ''}`;
  status.className = `pill ${res.ok ? 'ok' : 'error'}`;
  dot.className = `dot ${res.ok ? 'ok' : 'error'}`;
  status.innerHTML = res.ok
    ? `${ICONS.check}Solved <span class="muted">${variants.length} variants · ${time}</span>`
    : `${ICONS.alert}No solution <span class="muted">${attempts} · ${time}</span>`;
  status.dataset.tip = res.ok
    ? `Solved in ${attempts} with ${variants.length} tile variants (all rotations).`
    : 'The red cell is where the last attempt ran out of tiles. Check the issues and the boundary sockets.';
  const placed = new Map<number, number>();
  for (const v of res.cells) if (v >= 0) placed.set(res.variants[v].proto, (placed.get(res.variants[v].proto) ?? 0) + 1);
  document.querySelectorAll<HTMLElement>('td.placed').forEach((td) => {
    const n = placed.get(Number(td.dataset.mesh)) ?? 0;
    td.textContent = n ? String(n) : '·';
  });
}

/** The tag chips (with tile counts) and the count of tags turned off on the button. */
function renderTagFilter(protos: readonly Prototype[]) {
  const counts = new Map<string, number>();
  for (const p of protos) for (const t of p.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  const tags = [...counts.keys()].sort((x, y) => x.localeCompare(y));
  const off = tags.filter((t) => state.wfc.hiddenTags.has(t)).length;
  $('tagFilterCount').textContent = off ? String(off) : '';
  $('tagFilterBtn').classList.toggle('active', off > 0);
  $<HTMLButtonElement>('tagFilterReset').disabled = !off;
  $('tagChips').innerHTML = tags.length
    ? tags
        .map((t) => {
          const on = !state.wfc.hiddenTags.has(t);
          return `<button class="tag-chip${on ? '' : ' off'}" data-tag="${esc(t)}" aria-pressed="${on}">${esc(t)}<span class="n">${counts.get(t)}</span></button>`;
        })
        .join('')
    : '<span class="empty-note">No tiles have tags.</span>';
}

const LOOKS: Look[] = ['debug', 'shaded'];

/** Draw the solve in `look` and show it in the menu; remembered between sessions. */
function setLook(look: Look) {
  solutionView.setLook(look);
  document.querySelectorAll<HTMLElement>('#lookPanel .menu-setting').forEach((el) => {
    el.classList.toggle('disabled', look !== 'shaded');
    el.querySelector('input')!.disabled = look !== 'shaded';
  });
  $('lookLabel').textContent = look === 'debug' ? 'Debug' : 'Shaded';
  document.querySelectorAll<HTMLElement>('.menu-item[data-look]').forEach((el) => {
    el.setAttribute('aria-checked', String(el.dataset.look === look));
  });
  prefs.set('look', look);
}

function toggleLookMenu(open = $('lookPanel').hidden) {
  $('lookPanel').hidden = !open;
}
$('lookBtn').addEventListener('click', () => toggleLookMenu());
$('lookPanel').addEventListener('click', (e) => {
  const look = (e.target as Element).closest<HTMLElement>('.menu-item')?.dataset.look as Look | undefined;
  if (!look) return;
  setLook(look);
  toggleLookMenu(false);
});
setLook(LOOKS.includes(prefs.get('look') as Look) ? (prefs.get('look') as Look) : 'debug');

/** The shaded look's sliders, 0 to 1 each, shown as a percentage and remembered between sessions. */
const lookSettings = { groundDarkening: 0.5, cavityRidge: 0.25, cavityValley: 0.25 };
const LOOK_SLIDERS: [keyof typeof lookSettings, string, string][] = [
  ['groundDarkening', 'giIntensity', 'giValue'],
  ['cavityRidge', 'cavityRidge', 'cavityRidgeValue'],
  ['cavityValley', 'cavityValley', 'cavityValleyValue'],
];
function applyLookSettings() {
  solutionView.setGroundDarkening(lookSettings.groundDarkening);
  solutionView.setCavity(lookSettings.cavityRidge, lookSettings.cavityValley);
  for (const [key, input, label] of LOOK_SLIDERS) {
    $<HTMLInputElement>(input).value = String(lookSettings[key]);
    $(label).textContent = `${Math.round(lookSettings[key] * 100)}%`;
  }
}
for (const [key, input] of LOOK_SLIDERS) {
  const saved = Number(prefs.get(key) ?? NaN);
  if (saved >= 0 && saved <= 1) lookSettings[key] = saved;
  $(input).addEventListener('input', () => {
    lookSettings[key] = Number($<HTMLInputElement>(input).value);
    prefs.set(key, String(lookSettings[key]));
    applyLookSettings();
  });
}
applyLookSettings();

function toggleTagFilter(open = $('tagFilterPanel').hidden) {
  $('tagFilterPanel').hidden = !open;
}
$('tagFilterBtn').addEventListener('click', () => toggleTagFilter());
$('tagChips').addEventListener('click', (e) => {
  const tag = (e.target as Element).closest<HTMLElement>('.tag-chip')?.dataset.tag;
  if (tag === undefined) return;
  const hidden = state.wfc.hiddenTags;
  if (!hidden.delete(tag)) hidden.add(tag);
  solveAndRender(false);
});
$('tagFilterReset').addEventListener('click', () => {
  state.wfc.hiddenTags.clear();
  solveAndRender(false);
});

function readWfcInputs(): boolean {
  const int = (id: string, max: number) => {
    const el = $<HTMLInputElement>(id);
    const v = Number(el.value);
    const ok = Number.isInteger(v) && v >= 1 && v <= max;
    el.classList.toggle('invalid', !ok);
    return ok ? v : null;
  };
  const x = int('wfcX', 32);
  const y = int('wfcY', 8);
  const z = int('wfcZ', 32);
  const seedEl = $<HTMLInputElement>('wfcSeed');
  const seed = Number(seedEl.value);
  const seedOk = seedEl.value !== '' && Number.isInteger(seed) && seed >= 0;
  seedEl.classList.toggle('invalid', !seedOk);
  if (x === null || y === null || z === null || !seedOk) return false;
  state.wfc.size = [x, y, z];
  state.wfc.seed = seed;
  state.wfc.outer = $<HTMLInputElement>('wfcOuter').value.trim();
  state.wfc.outerGround = $<HTMLInputElement>('wfcOuterGround').value.trim();
  state.wfc.bottom = $<HTMLInputElement>('wfcBottom').value.trim();
  state.wfc.top = $<HTMLInputElement>('wfcTop').value.trim();
  return true;
}

for (const [key, id] of WFC_BOUNDARY_INPUTS) {
  $(id).addEventListener('change', () => state.wfc.edited.add(key));
}
for (const id of ['wfcX', 'wfcY', 'wfcZ', 'wfcSeed', ...WFC_BOUNDARY_INPUTS.map(([, id]) => id)]) {
  $(id).addEventListener('change', () => {
    if (readWfcInputs()) solveAndRender(false);
  });
}
$('wfcCull').addEventListener('change', () => solutionView.setCullBackFaces($<HTMLInputElement>('wfcCull').checked));
$('wfcNewSeed').addEventListener('click', () => rerollSeed());

// ---------------------------------------------------------------- events

/** Show a mesh in the tile preview and highlight its row, scrolling the mesh table (not the page) to it. */
function selectMesh(mesh: number) {
  state.selected = mesh;
  let row: HTMLElement | null = null;
  document.querySelectorAll<HTMLElement>('tr.mesh-row').forEach((r) => {
    const hit = Number(r.dataset.mesh) === mesh;
    r.classList.toggle('selected', hit);
    if (hit) row = r;
  });
  const panel = $('tileList');
  const r = row as HTMLElement | null;
  if (r) {
    const header = (panel.querySelector<HTMLElement>('.panel-head')?.offsetHeight ?? 0) + (panel.querySelector('thead')?.offsetHeight ?? 0);
    const p = panel.getBoundingClientRect();
    const rr = r.getBoundingClientRect();
    const visTop = p.top + header;
    if (rr.top < visTop || rr.bottom > p.bottom) panel.scrollTop += rr.top - visTop - (p.bottom - visTop - rr.height) / 2;
  }
  renderPreview(false);
}

$('meshes').addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('input')) return;
  const row = target.closest<HTMLElement>('tr.mesh-row');
  if (row) selectMesh(Number(row.dataset.mesh));
});

$('meshes').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (!input.classList.contains('weight')) return;
  const v = Number(input.value);
  const ok = input.value !== '' && Number.isFinite(v) && v >= 0;
  input.classList.toggle('invalid', !ok);
  if (ok) {
    state.weights[Number(input.dataset.mesh)] = v;
    syncResetWeights();
    solveAndRender(false);
  }
});

/** The reset button is only live while some tile's weight differs from 1. */
function syncResetWeights() {
  const n = state.analysis?.meshes.length ?? 0;
  $<HTMLButtonElement>('resetWeights').disabled = !state.weights.slice(0, n).some((w) => (w ?? 1) !== 1);
}

$('resetWeights').addEventListener('click', () => {
  const a = state.analysis;
  if (!a) return;
  for (const m of a.meshes) state.weights[m.index] = 1;
  document.querySelectorAll<HTMLInputElement>('input.weight').forEach((input) => {
    input.value = '1';
    input.classList.remove('invalid');
  });
  syncResetWeights();
  solveAndRender(false);
});

$('idTables').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (!input.classList.contains('id-input')) return;
  const key = input.dataset.key!;
  const err = input.dataset.kind === 'h' ? renameH(key, input.value) : renameV(key, input.value);
  if (err) {
    toast(err);
    input.value = input.dataset.kind === 'h' ? state.ids.h.get(key)! : state.ids.v.get(key)!;
  }
});

$('idTables').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') (e.target as HTMLElement).blur();
});

function exportFile() {
  const a = state.analysis;
  if (!a) return;
  const text = exportText({ ...exportJson(a), boundary_sockets: boundarySockets(state.wfc, state.settings.vertical) });
  const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = (state.fileName.replace(/\.fbx$/i, '') || 'sockets') + '.json';
  link.click();
  URL.revokeObjectURL(url);
}

$('exportBtn').addEventListener('click', exportFile);
$('browseBtn').addEventListener('click', () => $('fbxInput').click());
$('openBtn').addEventListener('click', () => $('fbxInput').click());
$('importBtn').addEventListener('click', () => $('jsonInput').click());
$<HTMLInputElement>('fbxInput').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.files?.[0]) loadFbx(input.files[0]);
  input.value = '';
});
$<HTMLInputElement>('jsonInput').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.files?.[0]) loadJson(input.files[0]);
  input.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragging');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  for (const file of e.dataTransfer?.files ?? []) handleFile(file);
});

// ---------------------------------------------------------------- shell

type Tab = 'solve' | 'profiles';
const TABS: Tab[] = ['solve', 'profiles'];

function setTab(tab: Tab) {
  document.querySelectorAll<HTMLElement>('.tab').forEach((el) => {
    const on = el.dataset.tab === tab;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll<HTMLElement>('.tab-pane').forEach((el) => el.classList.toggle('active', el.dataset.pane === tab));
  prefs.set('tab', tab);
}
document.querySelectorAll<HTMLElement>('.tab').forEach((el) => el.addEventListener('click', () => setTab(el.dataset.tab as Tab)));

function toggleIssues(open = $('issuesPanel').hidden) {
  $('issuesPanel').hidden = !open;
}
$('issuesBtn').addEventListener('click', () => toggleIssues());
$('issuesClose').addEventListener('click', () => toggleIssues(false));
document.addEventListener('pointerdown', (e) => {
  const t = e.target as Element;
  if (!$('issuesPanel').hidden && !t.closest('#issuesPanel, #issuesBtn')) toggleIssues(false);
  if (!$('tagFilterPanel').hidden && !t.closest('.tag-filter')) toggleTagFilter(false);
  if (!$('lookPanel').hidden && !t.closest('.vp-menu')) toggleLookMenu(false);
});

const helpDialog = $<HTMLDialogElement>('helpDialog');
$('helpBtn').addEventListener('click', () => helpDialog.showModal());
// Close on a click on the backdrop.
helpDialog.addEventListener('click', (e) => {
  if (e.target === helpDialog) helpDialog.close();
});

function rerollSeed() {
  if (!state.analysis) return;
  $<HTMLInputElement>('wfcSeed').value = String(Math.floor(Math.random() * 1e6));
  if (readWfcInputs()) solveAndRender(false);
}

/** Show only the tiles list rows whose name or tags contain every word of the search, ignoring case. */
function applyTileSearch() {
  const a = state.analysis;
  if (!a) return;
  const words = $<HTMLInputElement>('tileSearch').value.toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  document.querySelectorAll<HTMLElement>('tr.mesh-row').forEach((row) => {
    const m = a.meshes[Number(row.dataset.mesh)];
    const text = [meshLabel(m), ...prototypeTags(m.name, importedTags(m.name))].join(' ').toLowerCase();
    const hit = words.every((w) => text.includes(w));
    row.hidden = !hit;
    if (hit) shown++;
  });
  $('tileCount').textContent = words.length ? `${shown} / ${a.meshes.length}` : String(a.meshes.length);
}
$('tileSearch').addEventListener('input', applyTileSearch);
$('tileSearch').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const input = e.target as HTMLInputElement;
  if (input.value) input.value = '';
  else input.blur();
  applyTileSearch();
});

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    $('fbxInput').click();
    return;
  }
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    exportFile();
    return;
  }
  const typing = (e.target as Element).closest?.('input, select, textarea');
  if (typing || mod || e.altKey || helpDialog.open) return;
  if (e.key === '?' || e.key === 'F1') {
    e.preventDefault();
    helpDialog.showModal();
  } else if (e.key === '/') {
    e.preventDefault();
    $('tileSearch').focus();
  } else if (e.key === 'Escape') {
    toggleIssues(false);
    toggleTagFilter(false);
    toggleLookMenu(false);
  } else if (['1', '2'].includes(e.key)) {
    setTab(TABS[Number(e.key) - 1]);
  } else if (e.key.toLowerCase() === 'r') {
    rerollSeed();
  }
});

/** Drag handle that resizes the panel next to it, stored as a CSS variable. */
function initSplitter(handle: HTMLElement) {
  const panel = handle.dataset.panel!;
  const name = `--${panel}-w`;
  const root = document.documentElement;
  const sign = panel === 'inspector' ? 1 : -1;
  const saved = Number(prefs.get(name));
  if (saved) root.style.setProperty(name, `${saved}px`);
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const start = $(panel).getBoundingClientRect().width;
    let width = start;
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent) => {
      width = Math.round(Math.min(Math.max(start + sign * (ev.clientX - startX), 200), innerWidth * 0.5));
      root.style.setProperty(name, `${width}px`);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing');
      prefs.set(name, String(width));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
  });
}

/** Drag handle between the tiles list and the tile inspector, which it resizes. */
function initTilePanelSplitter(handle: HTMLElement) {
  const name = '--tile-panel-h';
  const root = document.documentElement;
  const saved = Number(prefs.get(name));
  if (saved) root.style.setProperty(name, `${saved}px`);
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const start = $('tilePanel').getBoundingClientRect().height;
    const max = $('outliner').getBoundingClientRect().height - 80;
    let height = start;
    handle.classList.add('dragging');
    document.body.classList.add('resizing-v');
    const move = (ev: PointerEvent) => {
      height = Math.round(Math.min(Math.max(start - (ev.clientY - startY), 120), max));
      root.style.setProperty(name, `${height}px`);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing-v');
      prefs.set(name, String(height));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
  });
}

buildSettings();
document.querySelectorAll<HTMLElement>('.splitter').forEach(initSplitter);
initTilePanelSplitter(document.querySelector<HTMLElement>('.hsplitter')!);
// Remember which inspector sections are collapsed.
document.querySelectorAll<HTMLDetailsElement>('details.sect').forEach((d) => {
  if (prefs.get(`sect:${d.dataset.key}`) === 'closed') d.open = false;
  d.addEventListener('toggle', () => prefs.set(`sect:${d.dataset.key}`, d.open ? 'open' : 'closed'));
});
injectIcons();
installTooltips($('tooltip'));
setTab(TABS.includes(prefs.get('tab') as Tab) ? (prefs.get('tab') as Tab) : 'solve');
render(true);

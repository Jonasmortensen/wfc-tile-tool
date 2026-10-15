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
  buildExport,
  computeIds,
  defaultSettings,
  exportText,
  findUnmatchedFaces,
  importProposals,
  meshSockets,
  parseImport,
  EMPTY_NAME,
  meshLabel,
  sameOriginHeights,
  verticalSocket,
  type Analysis,
  type ExportJson,
  type FaceRef,
  type IdState,
  type RawMesh,
  type Settings,
} from './core/analysis';
import { readUnitScaleFactor } from './core/fbxUnits';
import { checkHId, checkVBase, reverseString } from './core/ids';
import { ALL_FACES, H_FACES, OPPOSITE, rotatePoint, type Face } from './core/profile';
import { plotH, plotV } from './ui/plots';
import { BACK_FACE_COLOR, FACE_COLORS, Preview } from './ui/preview';
import { SolutionView, protoColor } from './ui/solution';
import { buildVariants, solveWfc, type WfcResult } from './core/wfc';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
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
  idError: '',
  loadError: '',
  unitNote: '',
  /** Add the format's empty tiles (mesh_name "-1"), outside and inside air, to the prototypes. */
  emptyTile: false,
  wfc: {
    size: [10, 3, 10] as [number, number, number],
    seed: 1,
    /** Boundary sockets; empty means unconstrained. */
    outer: '',
    bottom: '',
    top: '',
    result: null as WfcResult | null,
    ms: 0,
  },
};

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
    $('scaleHint').textContent = state.unitNote;
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

/** Meshes to analyse: the FBX's, plus the empty tile when enabled. */
function tileRaws(): RawMesh[] {
  return state.emptyTile ? [...state.raws, ...EMPTY_TILES] : state.raws;
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
    tileRaws().forEach((r, i) => {
      const w = importedWeight(r.name);
      if (w !== undefined) state.weights[i] = w;
    });
    state.loadError = '';
    recompute(false);
  } catch (e) {
    state.loadError = `Could not import ${file.name}: ${(e as Error).message}`;
    render(false);
  }
}

function handleFile(file: File) {
  if (/\.json$/i.test(file.name)) loadJson(file);
  else loadFbx(file);
}

// ---------------------------------------------------------------- analysis

function recompute(resetView: boolean) {
  state.idError = '';
  state.importMessages = [];
  if (!state.raws.length || validateMapping(state.settings.axis)) {
    state.analysis = null;
    render(resetView);
    return;
  }
  const raws = tileRaws();
  raws.forEach((r, i) => (state.weights[i] ??= importedWeight(r.name) ?? 1));
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
  $('settings').innerHTML = `
    <div class="settings-grid">
      <label>Cell size</label>
      <div class="row">
        <input type="number" id="cellX" step="any" min="0" value="${s.cellSize[0]}" title="X">
        <input type="number" id="cellY" step="any" min="0" value="${s.cellSize[1]}" title="Y">
        <input type="number" id="cellZ" step="any" min="0" value="${s.cellSize[2]}" title="Z">
      </div>
      <label for="pivot">Pivot</label>
      <select id="pivot">
        <option value="bottom">Bottom-center</option>
        <option value="center">Center</option>
      </select>
      <label for="epsilon">Epsilon</label>
      <input type="number" id="epsilon" step="any" min="0" value="${s.epsilon}">
      <label for="scale">Scale</label>
      <input type="number" id="scale" step="any" min="0" value="${s.scale}" title="Multiplier on file positions. Set automatically from the FBX's UnitScaleFactor on load.">
      <div class="hint" id="scaleHint">Set automatically from the FBX units on load.</div>
      <label for="ignoreTranslation">Object position</label>
      <label class="row"><input type="checkbox" id="ignoreTranslation"> ignore (tiles laid out apart)</label>
      <label for="axisPreset">Axes</label>
      <select id="axisPreset">${presetOptions}<option value="manual">Manual</option></select>
      <div class="hint" id="axisHint"></div>
      <label>Manual</label>
      <div class="axis-grid">
        ${(['x', 'y', 'z'] as const)
          .map(
            (k) =>
              `<span>Unity ${k.toUpperCase()} =</span><select id="axis_${k}">${sources
                .map((o) => `<option value="${o}">file ${o}</option>`)
                .join('')}</select>`,
          )
          .join('')}
      </div>
      <div class="hint error-text" id="axisError"></div>
      <label for="vertical">Vertical</label>
      <label class="row"><input type="checkbox" id="vertical"> posY / negY sockets</label>
      <div class="hint">Off: Unity infers top and bottom from the sides (posX|negZ|negX|posZ), which assumes straight prisms.</div>
      <label for="emptyTile">Empty tile</label>
      <label class="row"><input type="checkbox" id="emptyTile"> add "-1" outside and inside air</label>
    </div>`;
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
  $<HTMLSelectElement>('axisPreset').value = preset;
  $('axisHint').textContent = preset === 'manual' ? 'Pick the file axis each Unity axis comes from.' : AXIS_PRESETS[preset].description;
  for (const k of ['x', 'y', 'z'] as const) $<HTMLSelectElement>(`axis_${k}`).value = describeSource(s.axis[k]);
  $('axisError').textContent = validateMapping(s.axis) ?? '';
}

// ---------------------------------------------------------------- rendering

function faceLabel(ref: FaceRef): string {
  return `${meshLabel(state.analysis!.meshes[ref.mesh])}.${ref.face}`;
}

function currentSockets() {
  const a = state.analysis!;
  return a.meshes.map((m) => meshSockets(a, state.ids, m.index, state.settings.vertical));
}

function render(resetView: boolean) {
  const a = state.analysis;
  $('fileLabel').textContent = state.fileName ? `${state.fileName} · ${state.raws.length} mesh(es)` : 'No FBX loaded';
  $<HTMLButtonElement>('exportBtn').disabled = !a;
  $('importInfo').innerHTML = state.imported
    ? `<div class="muted">IDs imported from <strong>${esc(state.importedName)}</strong> (${state.imported.prototypes.length} prototypes). <button id="clearImport">Clear</button></div>`
    : '';
  $('clearImport')?.addEventListener('click', () => {
    state.imported = null;
    recompute(false);
  });

  if (!a) {
    preview.show(null, null, state.settings, resetView);
    $('previewInfo').textContent = '';
    $('meshes').innerHTML = `<div class="placeholder">Load an FBX containing your tile meshes.</div>`;
    const errs = [state.loadError, validateMapping(state.settings.axis)].filter(Boolean) as string[];
    $('warnings').innerHTML = errs.length
      ? `<h2>Warnings</h2><ul>${errs.map((e) => `<li class="error">${esc(e)}</li>`).join('')}</ul>`
      : `<h2>Warnings</h2><div class="muted">Nothing loaded.</div>`;
    $('idTables').innerHTML = '';
    solveAndRender(resetView);
    return;
  }

  const sockets = currentSockets();
  const unmatched = findUnmatchedFaces(sockets);
  renderMeshes(sockets, unmatched);
  renderWarnings(sockets, unmatched);
  renderIdTables();
  renderPreview(resetView);
  solveAndRender(resetView);
}

function renderPreview(resetView: boolean) {
  const a = state.analysis!;
  const m = a.meshes[state.selected];
  preview.show(m, state.raws[state.selected]?.index, state.settings, resetView);
  const fmt = (v: number[]) => v.map((x) => +x.toFixed(3)).join(', ');
  $('previewInfo').innerHTML = m
    ? `<strong>${esc(meshLabel(m))}</strong> · ${m.positions.length / 3} verts` +
      (m.bounds ? `<br>bounds (${fmt(m.bounds.min)}) – (${fmt(m.bounds.max)})` : '')
    : '';
  $('legend').innerHTML = ALL_FACES.filter((f) => state.settings.vertical || H_FACES.includes(f as never))
    .map((f) => `<span><span class="swatch" style="background:${FACE_COLORS[f]}"></span>${f}</span>`)
    .join('') + `<span><span class="swatch" style="background:#${BACK_FACE_COLOR.toString(16).padStart(6, '0')}"></span>back face</span>`;
}

function renderMeshes(sockets: ReturnType<typeof currentSockets>, unmatched: FaceRef[]) {
  const a = state.analysis!;
  const faces: Face[] = state.settings.vertical ? [...ALL_FACES] : [...H_FACES];
  const counts = new Map<string, number>();
  for (const m of a.meshes) if (m.name !== EMPTY_NAME) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
  const bad = new Set(unmatched.map((u) => `${u.mesh}:${u.face}`));
  $('meshes').innerHTML = `
    <h2>Meshes</h2>
    <table>
      <thead><tr><th>Name</th>${faces
        .map((f) => `<th><span class="swatch" style="background:${FACE_COLORS[f]}"></span>${f}</th>`)
        .join('')}<th>Weight</th></tr></thead>
      <tbody>${a.meshes
        .map(
          (m, i) => `
        <tr class="mesh-row${i === state.selected ? ' selected' : ''}" data-mesh="${i}">
          <td class="${(counts.get(m.name) ?? 0) > 1 ? 'name-dup' : ''}">${esc(meshLabel(m))}${m.outsideCount ? ' ⚠' : ''}</td>
          ${faces
            .map((f) => {
              const isBad = bad.has(`${i}:${f}`);
              const open = m.faces[f].open;
              const title = isBad
                ? 'No tile in any rotation can sit on this side'
                : open
                  ? `${f}: open (only a surface facing out of the cell), matches an empty face`
                  : f;
              return `<td class="sock${isBad ? ' bad' : ''}${open ? ' open' : ''}" title="${title}">${esc(sockets[i][f] ?? '')}</td>`;
            })
            .join('')}
          <td><input type="number" class="weight" data-mesh="${i}" min="0" step="any" value="${state.weights[i] ?? 1}"></td>
        </tr>`,
        )
        .join('')}</tbody>
    </table>`;
}

function renderWarnings(sockets: ReturnType<typeof currentSockets>, unmatched: FaceRef[]) {
  const a = state.analysis!;
  const s = state.settings;
  const items: { level: 'error' | 'warn'; text: string }[] = [];
  if (state.loadError) items.push({ level: 'error', text: state.loadError });

  const counts = new Map<string, number>();
  // The two empty tiles share "-1" on purpose.
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

  $('warnings').innerHTML = `<h2>Warnings</h2>${
    items.length
      ? `<ul>${items.map((i) => `<li class="${i.level}">${esc(i.text)}</li>`).join('')}</ul>`
      : '<div class="ok">No problems found.</div>'
  }`;
}

function usageCell(refs: FaceRef[]): string {
  return `<span class="usage" title="${esc(refs.map(faceLabel).join('\n'))}">${refs.length}</span>`;
}

function renderIdTables() {
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
      <h2>Vertical profiles (posY / negY)</h2>
      <table>
        <thead><tr><th>Profile (from above)</th><th>Canonical</th><th>Period</th><th>Base</th><th>Socket</th><th>Rotation</th><th>Faces</th></tr></thead>
        <tbody>${vRows}</tbody>
      </table>`;
  }

  $('idTables').innerHTML = `
    <div class="id-error" id="idError">${esc(state.idError)}</div>
    <h2>Horizontal profiles</h2>
    <div class="muted plot-key">Lines are mesh edges in the face plane. Squares mark surfaces lying in the face: filled ■ faces out of the cell, hollow □ faces into it. Dotted ticks show which way the front of a surface meeting the face edge-on (a wall) points. Shaded areas are inside (behind a surface), unshaded outside. Tiles only match back to back, so a roof (out) and a ground (in) on the same outline get different sockets, and a wall only continues a wall facing the same way.</div>
    <table>
      <thead><tr><th>Profile (from inside)</th><th>Mirror</th><th>Symmetric</th><th>ID</th><th>Mirror ID</th><th>Faces (profile / mirror)</th></tr></thead>
      <tbody>${hRows}</tbody>
    </table>
    ${vSection}`;
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

/** Run WFC on the current sockets (as exported) and show the result. */
function solveAndRender(resetView: boolean) {
  const a = state.analysis;
  $<HTMLButtonElement>('wfcNewSeed').disabled = !a;
  const status = $('wfcStatus');
  if (!a) {
    state.wfc.result = null;
    solutionView.show(null, [], [], state.settings, resetView);
    status.className = 'muted';
    status.textContent = 'Load an FBX to run WFC on its sockets.';
    $('wfcLegend').innerHTML = '';
    return;
  }
  const variants = buildVariants(exportJson(a).prototypes);
  fillSocketLists(variants);
  const { size, seed, outer, bottom, top } = state.wfc;
  const start = performance.now();
  const res = solveWfc(variants, { size, seed, outer, bottom, top });
  state.wfc.ms = performance.now() - start;
  state.wfc.result = res;
  solutionView.show(res, a.meshes, tileRaws().map((r) => r.index), state.settings, resetView);

  const time = `${state.wfc.ms.toFixed(0)} ms`;
  if (res.ok) {
    status.className = 'ok';
    status.textContent = `Solved with ${variants.length} variants (${res.attempts} attempt${res.attempts > 1 ? 's' : ''}, ${time}).`;
  } else {
    status.className = 'error';
    status.textContent =
      `No solution after ${res.attempts} attempts (${time}). The red cell is where the last attempt ran out of tiles; ` +
      'check the warnings and the boundary sockets.';
  }
  const placed = new Map<number, number>();
  for (const v of res.cells) if (v >= 0) placed.set(res.variants[v].proto, (placed.get(res.variants[v].proto) ?? 0) + 1);
  $('wfcLegend').innerHTML = a.meshes
    .map(
      (m, i) =>
        `<span><span class="swatch" style="background:#${protoColor(i).getHexString()}"></span>${esc(meshLabel(m))} <span class="count">${placed.get(i) ?? 0}</span></span>`,
    )
    .join('');
}

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
  state.wfc.bottom = $<HTMLInputElement>('wfcBottom').value.trim();
  state.wfc.top = $<HTMLInputElement>('wfcTop').value.trim();
  return true;
}

for (const id of ['wfcX', 'wfcY', 'wfcZ', 'wfcSeed', 'wfcOuter', 'wfcBottom', 'wfcTop']) {
  $(id).addEventListener('change', () => {
    if (readWfcInputs()) solveAndRender(['wfcX', 'wfcY', 'wfcZ'].includes(id));
  });
}
$('wfcCull').addEventListener('change', () => solutionView.setCullBackFaces($<HTMLInputElement>('wfcCull').checked));
$('wfcNewSeed').addEventListener('click', () => {
  $<HTMLInputElement>('wfcSeed').value = String(Math.floor(Math.random() * 1e6));
  if (readWfcInputs()) solveAndRender(false);
});

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
  const panel = $('meshes');
  const r = row as HTMLElement | null;
  if (r) {
    const top = r.offsetTop - panel.offsetTop;
    const header = panel.querySelector('thead')?.offsetHeight ?? 0;
    if (top - header < panel.scrollTop || top + r.offsetHeight > panel.scrollTop + panel.clientHeight) {
      panel.scrollTop = top - header - (panel.clientHeight - header - r.offsetHeight) / 2;
    }
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
    solveAndRender(false);
  }
});

$('idTables').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (!input.classList.contains('id-input')) return;
  const key = input.dataset.key!;
  const err = input.dataset.kind === 'h' ? renameH(key, input.value) : renameV(key, input.value);
  if (err) {
    state.idError = err;
    $('idError').textContent = err;
    input.value = input.dataset.kind === 'h' ? state.ids.h.get(key)! : state.ids.v.get(key)!;
  }
});

$('idTables').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') (e.target as HTMLElement).blur();
});

$('exportBtn').addEventListener('click', () => {
  const a = state.analysis;
  if (!a) return;
  const text = exportText(exportJson(a));
  const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = (state.fileName.replace(/\.fbx$/i, '') || 'sockets') + '.json';
  link.click();
  URL.revokeObjectURL(url);
});

$('browseBtn').addEventListener('click', () => $('fbxInput').click());
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

buildSettings();
render(true);

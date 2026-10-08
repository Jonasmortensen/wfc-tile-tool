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
  verticalPeriods,
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
import { ALL_FACES, H_FACES, OPPOSITE, type Face } from './core/profile';
import { plotH, plotV } from './ui/plots';
import { FACE_COLORS, Preview } from './ui/preview';

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
};

const preview = new Preview($('preview'));

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
      raws.push({
        name: mesh.name || mesh.parent?.name || `Mesh${raws.length}`,
        positions,
        index: geom.index ? Array.from(geom.index.array) : null,
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
    recompute(true);
  } catch (e) {
    state.loadError = `Could not load ${file.name}: ${(e as Error).message}`;
    render(false);
  }
}

function importedWeight(name: string): number | undefined {
  return state.imported?.prototypes.find((p) => p.mesh_name === name)?.weight;
}

async function loadJson(file: File) {
  try {
    state.imported = parseImport(await file.text());
    state.importedName = file.name;
    state.raws.forEach((r, i) => {
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
  const a = analyze(state.raws, state.settings);
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
    recompute(true);
  };
  for (const id of ['cellX', 'cellY', 'cellZ', 'epsilon', 'scale', 'pivot', 'ignoreTranslation', 'vertical']) {
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
  return `${state.analysis!.meshes[ref.mesh].name}.${ref.face}`;
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
    return;
  }

  const sockets = currentSockets();
  const periods = state.settings.vertical ? verticalPeriods(a, state.ids) : {};
  const unmatched = findUnmatchedFaces(sockets, periods);
  renderMeshes(sockets, unmatched);
  renderWarnings(sockets, unmatched);
  renderIdTables();
  renderPreview(resetView);
}

function renderPreview(resetView: boolean) {
  const a = state.analysis!;
  const m = a.meshes[state.selected];
  preview.show(m, state.raws[state.selected]?.index, state.settings, resetView);
  const fmt = (v: number[]) => v.map((x) => +x.toFixed(3)).join(', ');
  $('previewInfo').innerHTML = m
    ? `<strong>${esc(m.name)}</strong> · ${m.positions.length / 3} verts` +
      (m.bounds ? `<br>bounds (${fmt(m.bounds.min)}) – (${fmt(m.bounds.max)})` : '')
    : '';
  $('legend').innerHTML = ALL_FACES.filter((f) => state.settings.vertical || H_FACES.includes(f as never))
    .map((f) => `<span><span class="swatch" style="background:${FACE_COLORS[f]}"></span>${f}</span>`)
    .join('');
}

function renderMeshes(sockets: ReturnType<typeof currentSockets>, unmatched: FaceRef[]) {
  const a = state.analysis!;
  const faces: Face[] = state.settings.vertical ? [...ALL_FACES] : [...H_FACES];
  const counts = new Map<string, number>();
  for (const m of a.meshes) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
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
          <td class="${counts.get(m.name)! > 1 ? 'name-dup' : ''}">${esc(m.name)}${m.outsideCount ? ' ⚠' : ''}</td>
          ${faces
            .map((f) => {
              const isBad = bad.has(`${i}:${f}`);
              return `<td class="sock${isBad ? ' bad' : ''}" title="${isBad ? 'No tile in any rotation can sit on this side' : f}">${esc(sockets[i][f] ?? '')}</td>`;
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
  for (const m of a.meshes) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
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
      text: `${faceLabel(u)} ("${id}") has no possible neighbour: no tile in any rotation has ${OPPOSITE[u.face]} = "${reverseString(id)}".`,
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
        <td>${plotH(p.profile.points, edges, eps, width, sy, '#4aa3ff')}</td>
        <td>${p.symmetric ? '<span class="muted">same</span>' : plotH(p.mirror.points, mirrorEdges, eps, width, sy, '#b07cff')}</td>
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
        return `<tr>
          <td>${plotV(p.profile.points, eps, sx, sz, '#3ddc84')}</td>
          <td>${plotV(cls.canonical.points, eps, sx, sz, '#f5d142')}</td>
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
    <table>
      <thead><tr><th>Profile (from outside)</th><th>Mirror</th><th>Symmetric</th><th>ID</th><th>Mirror ID</th><th>Faces (profile / mirror)</th></tr></thead>
      <tbody>${hRows}</tbody>
    </table>
    ${vSection}`;
}

// ---------------------------------------------------------------- events

$('meshes').addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('input')) return;
  const row = target.closest<HTMLElement>('tr.mesh-row');
  if (!row) return;
  state.selected = Number(row.dataset.mesh);
  document.querySelectorAll('tr.mesh-row').forEach((r) => r.classList.toggle('selected', r === row));
  renderPreview(false);
});

$('meshes').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (!input.classList.contains('weight')) return;
  const v = Number(input.value);
  const ok = input.value !== '' && Number.isFinite(v) && v >= 0;
  input.classList.toggle('invalid', !ok);
  if (ok) state.weights[Number(input.dataset.mesh)] = v;
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
  const text = exportText(buildExport(a, state.ids, state.weights, state.settings.vertical));
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

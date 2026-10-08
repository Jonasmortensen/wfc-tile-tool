export type Vec3 = [number, number, number];
export type AxisIndex = 0 | 1 | 2;

/** Where one Unity axis comes from: a file axis and a sign. */
export interface AxisSource {
  axis: AxisIndex;
  sign: 1 | -1;
}

/** For each Unity axis, the file axis (and sign) it is read from. */
export interface AxisMapping {
  x: AxisSource;
  y: AxisSource;
  z: AxisSource;
}

export type AxisPresetId = 'blender' | 'zup' | 'unity' | 'manual';

export interface AxisPreset {
  label: string;
  description: string;
  mapping: AxisMapping;
}

export const AXIS_PRESETS: Record<Exclude<AxisPresetId, 'manual'>, AxisPreset> = {
  blender: {
    label: 'Blender default export',
    description:
      'Blender FBX exporter defaults (Forward -Z, Up Y): the file is already Y-up and Unity negates X for handedness. ' +
      'Unity = (-x, y, z).',
    mapping: { x: { axis: 0, sign: -1 }, y: { axis: 1, sign: 1 }, z: { axis: 2, sign: 1 } },
  },
  zup: {
    label: 'Z-up file data (no axis conversion)',
    description:
      'Raw Blender coordinates (Z up, -Y forward), e.g. exported with Up = Z. Unity = (-x, z, -y).',
    mapping: { x: { axis: 0, sign: -1 }, y: { axis: 2, sign: 1 }, z: { axis: 1, sign: -1 } },
  },
  unity: {
    label: 'Unity-native / already Y-up',
    description: 'File coordinates are used as Unity coordinates unchanged.',
    mapping: { x: { axis: 0, sign: 1 }, y: { axis: 1, sign: 1 }, z: { axis: 2, sign: 1 } },
  },
};

export function cloneMapping(m: AxisMapping): AxisMapping {
  return { x: { ...m.x }, y: { ...m.y }, z: { ...m.z } };
}

export function validateMapping(m: AxisMapping): string | null {
  if (new Set([m.x.axis, m.y.axis, m.z.axis]).size !== 3) {
    return 'Axis mapping must use each file axis exactly once.';
  }
  return null;
}

export function fileToUnity(p: Readonly<Vec3>, m: AxisMapping): Vec3 {
  return [m.x.sign * p[m.x.axis], m.y.sign * p[m.y.axis], m.z.sign * p[m.z.axis]];
}

export function describeSource(s: AxisSource): string {
  return `${s.sign < 0 ? '-' : '+'}${'XYZ'[s.axis]}`;
}

export function parseSource(text: string): AxisSource {
  const sign = text[0] === '-' ? -1 : 1;
  const axis = 'XYZ'.indexOf(text[1]) as AxisIndex;
  if (axis < 0) throw new Error(`Bad axis source "${text}"`);
  return { axis, sign };
}

export function presetForMapping(m: AxisMapping): AxisPresetId {
  for (const [id, preset] of Object.entries(AXIS_PRESETS)) {
    const p = preset.mapping;
    if ((['x', 'y', 'z'] as const).every((k) => p[k].axis === m[k].axis && p[k].sign === m[k].sign)) {
      return id as AxisPresetId;
    }
  }
  return 'manual';
}

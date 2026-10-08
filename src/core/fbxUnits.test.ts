import { describe, expect, it } from 'vitest';
import { readUnitScaleFactor } from './fbxUnits';

function binaryFbx(value: number): ArrayBuffer {
  const enc = new TextEncoder();
  const str = (s: string) => [0x53, s.length, 0, 0, 0, ...enc.encode(s)];
  const d = new Uint8Array(9);
  d[0] = 0x44;
  new DataView(d.buffer).setFloat64(1, value, true);
  const prop = [...str('OriginalUnitScaleFactor'), ...str('double'), ...str('Number'), ...str(''), 0x44, 0, 0, 0, 0, 0, 0, 0, 0];
  return new Uint8Array([
    ...enc.encode('Kaydara FBX Binary  \0'),
    ...prop,
    ...str('UnitScaleFactor'), ...str('double'), ...str('Number'), ...str(''), ...d,
  ]).buffer;
}

describe('FBX unit scale', () => {
  it('reads binary FBX, ignoring OriginalUnitScaleFactor', () => {
    expect(readUnitScaleFactor(binaryFbx(2.54))).toBe(2.54);
  });
  it('reads ASCII FBX', () => {
    const text = '; FBX 7.4.0 project file\nP: "UnitScaleFactor", "double", "Number", "",100\n';
    expect(readUnitScaleFactor(new TextEncoder().encode(text).buffer as ArrayBuffer)).toBe(100);
  });
  it('returns null when missing', () => {
    expect(readUnitScaleFactor(new TextEncoder().encode('nothing').buffer as ArrayBuffer)).toBeNull();
  });
});

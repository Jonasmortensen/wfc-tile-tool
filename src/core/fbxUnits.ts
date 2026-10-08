/**
 * Read GlobalSettings.UnitScaleFactor (centimetres per file unit) from an FBX.
 * three's FBXLoader ignores it, but Unity's "Convert Units" import option
 * applies it, so Unity positions = file positions * UnitScaleFactor / 100.
 * Blender's default export writes UnitScaleFactor 1 with objects scaled 100.
 */
export function readUnitScaleFactor(buffer: ArrayBuffer): number | null {
  const bytes = new Uint8Array(buffer);
  const magic = new TextDecoder().decode(bytes.subarray(0, 18));
  return magic === 'Kaydara FBX Binary' ? readBinary(bytes) : readAscii(new TextDecoder().decode(bytes));
}

function readAscii(text: string): number | null {
  const m = /"UnitScaleFactor"\s*,\s*"double"\s*,\s*"Number"\s*,\s*"[^"]*"\s*,\s*([-+0-9.eE]+)/.exec(text);
  return m ? Number(m[1]) : null;
}

function readBinary(bytes: Uint8Array): number | null {
  // Property records are typed: 'S' + uint32 length + bytes for strings, 'D' + float64 for doubles.
  const name = 'UnitScaleFactor';
  const needle = new Uint8Array([0x53, name.length, 0, 0, 0, ...[...name].map((c) => c.charCodeAt(0))]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  outer: for (let i = 0; i + needle.length < bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    let p = i + needle.length;
    // Skip the type, label and flags strings.
    for (let s = 0; s < 3; s++) {
      if (bytes[p] !== 0x53) return null;
      p += 5 + view.getUint32(p + 1, true);
    }
    const type = String.fromCharCode(bytes[p]);
    if (type === 'D') return view.getFloat64(p + 1, true);
    if (type === 'F') return view.getFloat32(p + 1, true);
    if (type === 'I') return view.getInt32(p + 1, true);
    return null;
  }
  return null;
}

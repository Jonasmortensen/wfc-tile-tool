import { describe, expect, it } from 'vitest';
import {
  GROUND_SOCKET,
  analyze,
  boundarySockets,
  buildExport,
  computeIds,
  exportText,
  findUnmatchedFaces,
  importProposals,
  importedBoundary,
  meshLabel,
  meshSockets,
  parseImport,
  sameOriginHeights,
  tagsFromName,
} from './analysis';
import { assignHorizontalIds, checkHId, checkVBase, isPalindrome, reverseString } from './ids';
import { H_FACES, mirrorH } from './profile';
import { AXIS_PRESETS } from './axis';
import { box, rawMesh, unitySettings } from './testUtils';

/** A varied set of tiles: symmetric walls, off-centre ledges, corners and empties. */
function tileSet() {
  return [
    rawMesh('Empty', box([-0.1, 0.1, -0.1], [0.1, 0.2, 0.1])),
    rawMesh('Wall', box([-0.5, 0, -0.1], [0.5, 1, 0.1])),
    rawMesh('EdgeWall', [...box([-0.5, 0, 0.1], [0.5, 1, 0.3]), ...box([-0.5, 0, -0.5], [0.5, 0.2, 0.5])]),
    rawMesh('Ledge', box([0.2, 0.4, 0.1], [0.5, 0.6, 0.35])),
    rawMesh('LedgeEnd', box([-0.5, 0.4, 0.1], [-0.1, 0.6, 0.35])),
    rawMesh('Corner', [...box([0, 0, 0], [0.5, 1, 0.2]), ...box([0, 0, 0], [0.2, 1, 0.5])]),
    rawMesh('Floor', box([-0.5, 0, -0.5], [0.5, 0.2, 0.5])),
  ];
}

describe('horizontal IDs', () => {
  const a = analyze(tileSet(), unitySettings());
  const { ids } = computeIds(a);

  it('detects symmetry', () => {
    const wall = a.meshes[1].faces;
    expect(a.hProfiles.get(wall.posX.profile.key)!.symmetric).toBe(true);
    const ledge = a.meshes[3].faces;
    expect(a.hProfiles.get(ledge.posX.profile.key)!.symmetric).toBe(false);
  });

  it('gives symmetric profiles palindromes and asymmetric ones reversible pairs', () => {
    for (const info of a.hProfiles.values()) {
      const id = ids.h.get(info.key)!;
      if (info.symmetric) {
        expect(isPalindrome(id)).toBe(true);
        expect(id.length).toBe(1);
      } else {
        expect(isPalindrome(id)).toBe(false);
        expect(ids.h.get(info.mirror.key)).toBe(reverseString(id));
      }
    }
  });

  it('never shares an ID between profiles', () => {
    const seen = new Map<string, string>();
    for (const [key, id] of ids.h) {
      expect(seen.get(id) ?? key).toBe(key);
      seen.set(id, key);
    }
  });

  it('makes faces compatible exactly when reverse(idA) == idB', () => {
    const faces = a.meshes.flatMap((m) => H_FACES.map((f) => m.faces[f].profile));
    let compatiblePairs = 0;
    for (const pa of faces) {
      for (const pb of faces) {
        const geometric = pb.key === mirrorH(pa).key;
        const byId = reverseString(ids.h.get(pa.key)!) === ids.h.get(pb.key)!;
        expect(byId).toBe(geometric);
        if (geometric) compatiblePairs++;
      }
    }
    expect(compatiblePairs).toBeGreaterThan(faces.length); // sanity: the set has real matches
  });

  it('reserves the reverse of IDs whose mirror is not used', () => {
    const { ids } = assignHorizontalIds([
      { key: 'A', mirrorKey: 'A*', symmetric: false },
      { key: 'B', mirrorKey: 'B*', symmetric: false },
    ]);
    expect(ids.get('A')).toBe('ab');
    expect(ids.get('A*')).toBe('ba');
    expect(ids.get('B')).toBe('ac');
  });
});

describe('rename validation', () => {
  const owner = new Map([
    ['f', 'F'],
    ['ewf', 'E'],
    ['fwe', 'E*'],
  ]);
  it('requires palindromes for symmetric profiles', () => {
    expect(checkHId('ab', true, ['S'], owner)).toMatch(/not a palindrome/);
    expect(checkHId('aba', true, ['S'], owner)).toBeNull();
  });
  it('forbids palindromes for asymmetric profiles', () => {
    expect(checkHId('aa', false, ['X', 'X*'], owner)).toMatch(/is a palindrome/);
  });
  it('rejects collisions, including with the reverse', () => {
    expect(checkHId('f', true, ['S'], owner)).toMatch(/already used/);
    expect(checkHId('few', false, ['X', 'X*'], owner)).toBeNull();
    expect(checkHId('fwe', false, ['X', 'X*'], owner)).toMatch(/already used/);
    // Renaming within the same pair is fine.
    expect(checkHId('fwe', false, ['E', 'E*'], owner)).toBeNull();
    expect(checkHId('', true, ['S'], owner)).toMatch(/empty/);
    expect(checkHId('a|a', true, ['S'], owner)).toMatch(/contain "\|"/);
  });
});

describe('JSON import and export', () => {
  const a = analyze(tileSet(), unitySettings({ vertical: true }));

  it('reuses IDs from an imported JSON', () => {
    const imported = parseImport(
      JSON.stringify({
        prototypes: [{ mesh_name: 'Ledge', sockets: { posX: 'ewf', negZ: 'zz', negX: 'q', posZ: 'p' }, weight: 3 }],
      }),
    );
    const prop = importProposals(a, imported);
    const { ids, rejectedH } = computeIds(a, [prop.h], [prop.v]);
    const ledge = a.meshes[3].faces;
    expect(ids.h.get(ledge.posX.profile.key)).toBe('ewf');
    expect(ids.h.get(mirrorH(ledge.posX.profile).key)).toBe('fwe');
    // LedgeEnd's negX is that mirror.
    expect(ids.h.get(a.meshes[4].faces.negX.profile.key)).toBe('fwe');
    // The ledge's other faces are empty: the first imported ID for that profile wins.
    expect(ids.h.get(ledge.negZ.profile.key)).toBe('zz');
    expect(rejectedH).toEqual([]);
  });

  it('rejects imported IDs that break the rules', () => {
    const imported = parseImport(
      JSON.stringify({ prototypes: [{ mesh_name: 'Ledge', sockets: { posX: 'aa', negZ: 'xy' } }] }),
    );
    const prop = importProposals(a, imported);
    const { ids, rejectedH } = computeIds(a, [prop.h], [prop.v]);
    expect(rejectedH.map((r) => r.id).sort()).toEqual(['aa', 'xy']);
    const ledge = a.meshes[3].faces;
    expect(isPalindrome(ids.h.get(ledge.posX.profile.key)!)).toBe(false);
  });

  it('exports in the required shape and key order', () => {
    const { ids } = computeIds(a);
    const json = buildExport(a, ids, a.meshes.map(() => 1), true);
    expect(Object.keys(json.prototypes[0].sockets)).toEqual(['posX', 'negZ', 'negX', 'posZ', 'posY', 'negY']);
    expect('vertical_socket_periods' in json).toBe(false);
    expect(exportText(json)).toContain('\n    "prototypes"');
    const flat = buildExport(a, ids, a.meshes.map(() => 2), false);
    expect(Object.keys(flat.prototypes[0].sockets)).toEqual(['posX', 'negZ', 'negX', 'posZ']);
    expect(flat.prototypes[0].weight).toBe(2);
    expect(flat.prototypes[0].tags).toEqual(['Empty']);
  });

  it('keeps tags and reads a missing weight as 0', () => {
    const imported = parseImport(
      JSON.stringify({ prototypes: [{ mesh_name: 'Ledge', sockets: {}, tags: ['LastResort', 3] }] }),
    );
    expect(imported.prototypes[0]).toEqual({ mesh_name: 'Ledge', sockets: {}, weight: 0, tags: ['LastResort'] });
    const { ids } = computeIds(a);
    const json = buildExport(a, ids, [], false, [, , , ['LastResort']]);
    expect(json.prototypes[3].tags).toEqual(['Ledge', 'LastResort']);
    expect(json.prototypes[0].tags).toEqual(['Empty']);
  });
});

describe('tagsFromName', () => {
  it('splits PascalCase, acronyms, digits and separators', () => {
    expect(tagsFromName('WallCornerInner')).toEqual(['Wall', 'Corner', 'Inner']);
    expect(tagsFromName('UIPanel_02')).toEqual(['UI', 'Panel', '02']);
    expect(tagsFromName('roof edge-Left')).toEqual(['roof', 'edge', 'Left']);
    expect(tagsFromName('WallWall')).toEqual(['Wall']);
    expect(tagsFromName('-1')).toEqual([]);
  });
});

describe('boundary sockets', () => {
  const b = { outer: 'oo', outerGround: 'g1', bottom: 'g', top: '' };

  it('exports after the prototypes, with inside only when top/bottom sockets are on', () => {
    expect(boundarySockets(b, true)).toEqual({ outside: 'oo', inside: 'g1', bottom: 'g', top: '' });
    expect(boundarySockets(b, false)).toEqual({ outside: 'oo', bottom: 'g', top: '' });
    const text = exportText({ prototypes: [], boundary_sockets: boundarySockets(b, true) });
    expect(text.indexOf('"prototypes"')).toBeLessThan(text.indexOf('"boundary_sockets"'));
  });

  it('round-trips through import, keeping only string keys', () => {
    const json = JSON.stringify({ prototypes: [], boundary_sockets: { ...boundarySockets(b, true), top: 3 } });
    const imported = parseImport(json);
    expect(importedBoundary(imported.boundary_sockets!)).toEqual({ outer: 'oo', outerGround: 'g1', bottom: 'g' });
    expect(parseImport('{"prototypes": []}').boundary_sockets).toBeUndefined();
  });
});

describe('sameOriginHeights', () => {
  it('compares the Unity height of the object origins', () => {
    const at = (name: string, origin: [number, number, number]) => ({ ...rawMesh(name, []), origin });
    const s = unitySettings();
    expect(sameOriginHeights([at('A', [0, 0, 0]), at('B', [3, 0, -2])], s)).toBe(true);
    expect(sameOriginHeights([at('A', [0, 0, 0]), at('B', [3, 1, 0])], s)).toBe(false);
    // Z-up file data: file Z is Unity Y.
    const zup = unitySettings({ axis: AXIS_PRESETS.zup.mapping });
    expect(sameOriginHeights([at('A', [0, 0, 0]), at('B', [0, 5, 0])], zup)).toBe(true);
    expect(sameOriginHeights([at('A', [0, 0, 0]), at('B', [0, 0, 5])], zup)).toBe(false);
  });
});

describe('ground socket', () => {
  const at = (name: string, origin: [number, number, number]) => ({ ...rawMesh(name, box([-0.5, 0, -0.1], [0.5, 1, 0.1])), origin });
  const s = unitySettings({ epsilon: 0.001 });
  const a = analyze([at('Ground', [3, 0, 0]), at('Upper', [3, 1, 0]), { ...rawMesh('-1', []), origin: [0, 0, 0], emptySpace: 'o' }], s);
  const { ids } = computeIds(a);

  it('gives tiles whose origin is at height 0 the g bottom, with or without vertical sockets', () => {
    expect(a.meshes.map((m) => m.grounded)).toEqual([true, false, false]);
    expect(buildExport(a, ids, [], true).prototypes[0].sockets.negY).toBe(GROUND_SOCKET);
    expect(buildExport(a, ids, [], false).prototypes[0].sockets).toEqual({ ...meshSockets(a, ids, 0, false) });
    expect(meshSockets(a, ids, 0, false).negY).toBe(GROUND_SOCKET);
    expect(meshSockets(a, ids, 1, true).negY).not.toBe(GROUND_SOCKET);
    expect(meshSockets(a, ids, 1, false).negY).toBeUndefined();
  });

  it('uses the Unity height, after scale and axis mapping', () => {
    const zup = analyze([at('A', [0, 5, 0]), at('B', [0, 0, 500])], unitySettings({ axis: AXIS_PRESETS.zup.mapping }));
    expect(zup.meshes.map((m) => m.grounded)).toEqual([true, false]);
    const cm = analyze([at('A', [0, 0.05, 0])], unitySettings({ scale: 0.01 }));
    expect(cm.meshes[0].grounded).toBe(true);
  });

  it('is not reported as unmatched, reserved, and not imported as a vertical ID', () => {
    const sockets = a.meshes.map((m) => meshSockets(a, ids, m.index, true));
    expect(findUnmatchedFaces(sockets)).not.toContainEqual({ mesh: 0, face: 'negY' });
    expect(checkVBase(GROUND_SOCKET, 'k', new Map())).toMatch(/reserved/);
    const prop = importProposals(a, parseImport(JSON.stringify({ prototypes: [{ mesh_name: 'Ground', sockets: { negY: 'g' } }] })));
    expect(prop.v.size).toBe(0);
  });

  it('puts the ground socket under an empty tile marked as ground', () => {
    const inside = { ...rawMesh('-1', []), origin: [0, 5, 0] as [number, number, number], emptySpace: 'i' as const };
    const b = analyze([inside, { ...inside, ground: true }], s);
    const { ids } = computeIds(b);
    const [air, floor] = b.meshes.map((m) => meshSockets(b, ids, m.index, true));
    expect(floor.negY).toBe(GROUND_SOCKET);
    expect({ ...floor, negY: air.negY }).toEqual(air);
    expect(meshLabel(b.meshes[1])).toBe('-1 (inside air on ground)');
  });
});

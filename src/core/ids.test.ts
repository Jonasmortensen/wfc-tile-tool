import { describe, expect, it } from 'vitest';
import { analyze, computeIds, importProposals, parseImport, buildExport, exportText } from './analysis';
import { assignHorizontalIds, checkHId, isPalindrome, reverseString } from './ids';
import { H_FACES, mirrorH } from './profile';
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
    expect(json.vertical_socket_periods).toBeDefined();
    expect(exportText(json)).toContain('\n    "prototypes"');
    const flat = buildExport(a, ids, a.meshes.map(() => 2), false);
    expect(Object.keys(flat.prototypes[0].sockets)).toEqual(['posX', 'negZ', 'negX', 'posZ']);
    expect('vertical_socket_periods' in flat).toBe(false);
    expect(flat.prototypes[0].weight).toBe(2);
  });
});


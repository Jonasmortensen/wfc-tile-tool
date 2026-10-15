import type { Period } from './profile';

export function reverseString(s: string): string {
  return [...s].reverse().join('');
}

export function isPalindrome(s: string): boolean {
  return reverseString(s) === s;
}

/** a, b, ..., z, aa, ab, ... */
export function* idSequence(alphabet: string): Generator<string> {
  const chars = [...alphabet];
  for (let len = 1; ; len++) {
    const total = chars.length ** len;
    for (let n = 0; n < total; n++) {
      let s = '';
      for (let i = 0, rest = n; i < len; i++, rest = Math.floor(rest / chars.length)) {
        s = chars[rest % chars.length] + s;
      }
      yield s;
    }
  }
}

export const H_ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
/** Single-character bases for vertical sockets; Greek letters that don't look like Latin ones as overflow. */
export const V_POOL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZΓΔΘΛΞΠΣΦΨΩ';

export interface HEntry {
  key: string;
  mirrorKey: string;
  symmetric: boolean;
}

export interface Rejection {
  key: string;
  id: string;
  reason: string;
  /** Index of the proposal map the rejected ID came from. */
  source: number;
}

/**
 * Check that `id` can be given to a horizontal profile. `selfKeys` are the
 * profile and its mirror (their current IDs don't count as conflicts);
 * `owner` maps every assigned ID to its profile key.
 */
export function checkHId(
  id: string,
  symmetric: boolean,
  selfKeys: readonly string[],
  owner: ReadonlyMap<string, string>,
): string | null {
  if (!id) return 'ID cannot be empty.';
  if (/\s/.test(id)) return 'ID cannot contain whitespace.';
  if (id.includes('|')) return 'Side IDs cannot contain "|"; it separates the parts of top and bottom faces.';
  if (symmetric && !isPalindrome(id)) {
    return `"${id}" is not a palindrome. Symmetric profiles need an ID that reads the same reversed.`;
  }
  if (!symmetric && isPalindrome(id)) {
    return `"${id}" is a palindrome. Asymmetric profiles need an ID whose reverse is a different string (the mirror profile gets the reverse).`;
  }
  for (const s of symmetric ? [id] : [id, reverseString(id)]) {
    const o = owner.get(s);
    if (o !== undefined && !selfKeys.includes(o)) return `"${s}" is already used by another profile.`;
  }
  return null;
}

/**
 * Assign horizontal socket IDs. Proposals are applied in priority order
 * (earlier maps win), then every remaining profile gets an automatic ID.
 * The result also holds IDs for mirror profiles that no face uses, so their
 * reversed strings stay reserved.
 */
export function assignHorizontalIds(
  entries: readonly HEntry[],
  proposals: readonly ReadonlyMap<string, string>[] = [],
): { ids: Map<string, string>; rejected: Rejection[] } {
  const byKey = new Map<string, HEntry>();
  for (const e of entries) byKey.set(e.key, e);
  for (const e of entries) {
    if (!byKey.has(e.mirrorKey)) byKey.set(e.mirrorKey, { key: e.mirrorKey, mirrorKey: e.key, symmetric: e.symmetric });
  }

  const ids = new Map<string, string>();
  const owner = new Map<string, string>();
  const rejected: Rejection[] = [];

  const assign = (e: HEntry, id: string) => {
    ids.set(e.key, id);
    owner.set(id, e.key);
    if (!e.symmetric) {
      const rev = reverseString(id);
      ids.set(e.mirrorKey, rev);
      owner.set(rev, e.mirrorKey);
    }
  };

  proposals.forEach((map, source) => {
    for (const [key, id] of map) {
      const e = byKey.get(key);
      if (!e) continue;
      const current = ids.get(key);
      if (current !== undefined) {
        if (current !== id) rejected.push({ key, id, source, reason: `profile already has ID "${current}".` });
        continue;
      }
      const reason = checkHId(id, e.symmetric, [e.key, e.mirrorKey], owner);
      if (reason) rejected.push({ key, id, source, reason });
      else assign(e, id);
    }
  });

  for (const e of entries) {
    if (ids.has(e.key)) continue;
    for (const id of idSequence(H_ALPHABET)) {
      const ok = e.symmetric
        ? isPalindrome(id) && !owner.has(id)
        : !isPalindrome(id) && !owner.has(id) && !owner.has(reverseString(id));
      if (ok) {
        assign(e, id);
        break;
      }
    }
  }
  return { ids, rejected };
}

export function checkVBase(base: string, selfKey: string, owner: ReadonlyMap<string, string>): string | null {
  if ([...base].length !== 1) return 'Vertical IDs must be a single character.';
  if (/[\s0-9|]/.test(base)) return 'Vertical IDs cannot be a digit, whitespace or "|".';
  const o = owner.get(base);
  if (o !== undefined && o !== selfKey) return `"${base}" is already used by another vertical profile class.`;
  return null;
}

/** Assign one base character per vertical rotation class (keyed by canonical profile key). */
export function assignVerticalBases(
  classKeys: readonly string[],
  proposals: readonly ReadonlyMap<string, string>[] = [],
): { bases: Map<string, string>; rejected: Rejection[] } {
  const known = new Set(classKeys);
  const bases = new Map<string, string>();
  const owner = new Map<string, string>();
  const rejected: Rejection[] = [];

  proposals.forEach((map, source) => {
    for (const [key, base] of map) {
      if (!known.has(key)) continue;
      const current = bases.get(key);
      if (current !== undefined) {
        if (current !== base) rejected.push({ key, id: base, source, reason: `class already has ID "${current}".` });
        continue;
      }
      const reason = checkVBase(base, key, owner);
      if (reason) rejected.push({ key, id: base, source, reason });
      else {
        bases.set(key, base);
        owner.set(base, key);
      }
    }
  });

  for (const key of classKeys) {
    if (bases.has(key)) continue;
    const base = [...V_POOL].find((c) => !owner.has(c));
    if (!base) throw new Error(`More than ${[...V_POOL].length} vertical profile classes; rename some to free characters.`);
    bases.set(key, base);
    owner.set(base, key);
  }
  return { bases, rejected };
}

/**
 * A top or bottom face socket in the prototype format. A face that looks the
 * same in every rotation is one part ("A"). Otherwise it has four parts in the
 * order posX|negZ|negX|posZ, each the base plus a turn index, chosen so that
 * the loader's turn (last part to the front) gives the socket of the turned
 * profile: "B0|B1|B2|B3" turned once is "B3|B0|B1|B2". Period 2 repeats:
 * "C0|C1|C0|C1".
 */
export function encodeVertical(base: string, r: number, period: Period): string {
  if (period === 1) return base;
  return [0, 1, 2, 3].map((i) => `${base}${(((i - r) % period) + period) % period}`).join('|');
}

/** The base of a face socket written by encodeVertical, or by older versions ("B2B"). */
export function parseVertical(s: string): { base: string } | null {
  const chars = [...s];
  if (chars.length === 1 && !/[\s0-9|]/.test(chars[0])) return { base: chars[0] };
  if (chars.length === 3 && chars[0] === chars[2] && /^[0-9]$/.test(chars[1])) return { base: chars[0] };
  const parts = s.split('|').map((p) => [...p]);
  if (parts.length === 4 && parts.every((p) => p.length === 2 && p[0] === parts[0][0] && /^[0-9]$/.test(p[1]))) {
    return { base: parts[0][0] };
  }
  return null;
}

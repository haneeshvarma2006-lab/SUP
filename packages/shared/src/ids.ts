/**
 * Prefixed, sortable identifiers.
 *
 * IDs are `<prefix>_<timeComponent><randomComponent>`. The time component makes
 * IDs lexicographically sortable by creation time, which lets us use them as
 * stable tie-breakers in ordered queries without an extra column.
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export const ID_PREFIXES = {
  user: 'usr',
  workspace: 'wsp',
  membership: 'mem',
  agent: 'agt',
  task: 'tsk',
  message: 'msg',
  event: 'evt',
  memory: 'mry',
  file: 'fil',
  run: 'run',
  step: 'stp',
  approval: 'apv',
  session: 'ses',
  delegation: 'dlg',
  toolCall: 'tcl',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

function randomChars(n: number): string {
  let out = '';
  const bytes = new Uint8Array(n);
  // globalThis.crypto is available in Node >= 19 and all target browsers.
  globalThis.crypto.getRandomValues(bytes);
  for (let i = 0; i < n; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

function base36Time(ms: number): string {
  // 8 chars of base36 covers timestamps until the year ~5138.
  return Math.floor(ms).toString(36).padStart(8, '0');
}

export function newId(prefix: IdPrefix, at: number = Date.now()): string {
  return `${prefix}_${base36Time(at)}${randomChars(10)}`;
}

export function isId(value: unknown, prefix?: IdPrefix): value is string {
  if (typeof value !== 'string') return false;
  const idx = value.indexOf('_');
  if (idx <= 0) return false;
  if (prefix !== undefined && value.slice(0, idx) !== prefix) return false;
  return value.length > idx + 1;
}

/** Extracts the creation timestamp encoded in an id, or null if unparseable. */
export function idCreatedAt(id: string): number | null {
  const idx = id.indexOf('_');
  if (idx < 0) return null;
  const t = parseInt(id.slice(idx + 1, idx + 9), 36);
  return Number.isFinite(t) ? t : null;
}

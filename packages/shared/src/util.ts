import type { ActorRef } from './entities.js';

export function actorKey(actor: ActorRef): string {
  return `${actor.type}:${actor.id}`;
}

export function sameActor(a: ActorRef | null, b: ActorRef | null): boolean {
  if (!a || !b) return false;
  return a.type === b.type && a.id === b.id;
}

export function systemActor(): ActorRef {
  return { type: 'system', id: 'system', name: 'System' };
}

/** Deterministic channel name for a direct message between two actors. */
export function dmChannel(a: ActorRef, b: ActorRef): string {
  const keys = [actorKey(a), actorKey(b)].sort();
  return `dm:${keys[0]}:${keys[1]}`;
}

export function taskChannel(taskId: string): string {
  return `task:${taskId}`;
}

export const MAIN_CHANNEL = 'main';

/**
 * Extracts `@name` mentions from a message body and resolves them against the
 * supplied roster. Matching is case-insensitive and prefers the longest name,
 * so `@Atlas Prime` wins over `@Atlas` when both exist.
 */
export function extractMentions(
  body: string,
  roster: ReadonlyArray<{ type: ActorRef['type']; id: string; name: string }>,
): ActorRef[] {
  const byLength = [...roster].sort((a, b) => b.name.length - a.name.length);
  const found = new Map<string, ActorRef>();
  const lower = body.toLowerCase();
  for (const entry of byLength) {
    const needle = `@${entry.name.toLowerCase()}`;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      const after = lower[at + needle.length];
      // Require a word boundary after the mention.
      if (after === undefined || !/[a-z0-9_-]/.test(after)) {
        found.set(`${entry.type}:${entry.id}`, { type: entry.type, id: entry.id, name: entry.name });
      }
      from = at + needle.length;
    }
  }
  return [...found.values()];
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Stable JSON stringify — used for idempotency keys and content hashes. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(',')}}`;
}

const AVATAR_PALETTE = [
  '#7c8cff', '#4fd1c5', '#f6ad55', '#fc8181', '#b794f4',
  '#63b3ed', '#68d391', '#f687b3', '#f6e05e', '#9f7aea',
];

/** Deterministic avatar colour so a user looks the same to everyone. */
export function avatarColorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]!;
}

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workspace';
}

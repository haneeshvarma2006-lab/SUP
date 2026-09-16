import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './schema.js';
import type { Logger } from '../util/logger.js';

export type Db = Database.Database;

export interface DbHandle {
  db: Db;
  close(): void;
  /**
   * Runs `fn` inside an IMMEDIATE transaction. better-sqlite3 is synchronous,
   * so a transaction here is genuinely serialised against every other writer in
   * the process — this is the primitive the concurrency layer builds on.
   */
  tx<T>(fn: (db: Db) => T): T;
}

export function openDatabase(databasePath: string, logger: Logger): DbHandle {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const db = new Database(databasePath);

  // WAL gives us concurrent readers alongside a writer, which matters as soon
  // as several agent runs and several browser clients touch the DB at once.
  if (databasePath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  // Fail fast rather than hanging forever if another writer holds the lock.
  db.pragma('busy_timeout = 5000');

  migrate(db, logger);

  const runTx = db.transaction((fn: (d: Db) => unknown) => fn(db));

  return {
    db,
    close: () => db.close(),
    tx<T>(fn: (d: Db) => T): T {
      return runTx.immediate(fn as (d: Db) => unknown) as T;
    },
  };
}

function migrate(db: Db, logger: Logger): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  const applied = new Set<number>(
    db
      .prepare<[], { version: number }>('SELECT version FROM schema_migrations')
      .all()
      .map((r) => r.version),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        Date.now(),
      );
    });
    apply();
    logger.info('migration applied', { version: migration.version, name: migration.name });
  }
}

// ---------------------------------------------------------------------------
// Column codecs — SQLite has no JSON or boolean type, so every repo goes
// through these rather than open-coding JSON.parse at each call site.
// ---------------------------------------------------------------------------

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export const toBool = (value: number | null | undefined): boolean => value === 1;
export const fromBool = (value: boolean): number => (value ? 1 : 0);

export function encodeVector(vector: Float32Array | null): Buffer | null {
  if (!vector) return null;
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function decodeVector(buf: Buffer | Uint8Array | null | undefined): Float32Array | null {
  if (!buf || buf.byteLength === 0) return null;
  const copy = new ArrayBuffer(buf.byteLength);
  new Uint8Array(copy).set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  return new Float32Array(copy);
}

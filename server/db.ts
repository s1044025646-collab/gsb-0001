import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

let instance: DatabaseSync | null = null;

export function openDb(path: string): DatabaseSync {
  if (instance) return instance;
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=10000");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA synchronous=NORMAL");
  migrate(db);
  instance = db;
  return db;
}

export function getDb(): DatabaseSync {
  if (!instance) throw new Error("DB not initialised");
  return instance;
}

/** Test helper: each test uses an isolated temp file. */
export function resetDb(path: string): DatabaseSync {
  if (instance) {
    try {
      instance.close();
    } catch {
      /* ignore */
    }
  }
  instance = null;
  return openDb(path);
}

function migrate(db: DatabaseSync) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS workflows(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    def TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runs(
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    idempotency_key TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(idempotency_key)
  );
  CREATE TABLE IF NOT EXISTS node_execs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    input TEXT,
    output TEXT,
    error TEXT,
    branch_taken TEXT,
    claimed_by TEXT,
    lease_expires INTEGER,
    started_at INTEGER,
    finished_at INTEGER,
    UNIQUE(run_id, node_id)
  );
  CREATE TABLE IF NOT EXISTS logs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    node_id TEXT,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS spawned_processes(
    pid INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    exec_id INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    ended INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_execs_claim ON node_execs(status, lease_expires);
  CREATE INDEX IF NOT EXISTS idx_logs_run ON logs(run_id, id);
  `);
}

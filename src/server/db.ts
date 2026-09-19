import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

let dbInstance: DatabaseSync | null = null;

export function getDb(dbPath = process.env.WF_DB || "data/workflow.db"): DatabaseSync {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  dbInstance = db;
  return db;
}

function migrate(db: DatabaseSync) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT UNIQUE,
    state TEXT NOT NULL,
    graph TEXT NOT NULL,
    input TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS node_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id),
    node_id TEXT NOT NULL,
    state TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    result TEXT,
    error TEXT,
    worker_id TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    lease_expires_at INTEGER,
    pid INTEGER,
    UNIQUE(run_id, node_id)
  );
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    node_id TEXT,
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_node_runs_state ON node_runs(state);
  CREATE INDEX IF NOT EXISTS idx_logs_run ON logs(run_id, id);
  `);
}

export function resetDb(dbPath = process.env.WF_DB || "data/workflow.db") {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
  return getDb(dbPath);
}

export function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

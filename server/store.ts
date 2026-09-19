import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db.ts";
import { upstreamEdges } from "../shared/dag.ts";
import type { NodeStatus, RunStatus, WorkflowDef } from "../shared/types.ts";

export const LEASE_MS = 30_000;
export const DEFAULT_CONCURRENCY = 3;

type Row = Record<string, any>;

export class Store {
  constructor(private db: DatabaseSync = getDb()) {}

  saveWorkflow(def: WorkflowDef) {
    this.db
      .prepare(
        `INSERT INTO workflows(id,name,def,updated_at) VALUES(?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,def=excluded.def,updated_at=excluded.updated_at`
      )
      .run(def.id, def.name, JSON.stringify(def), Date.now());
  }

  loadWorkflow(id: string): WorkflowDef | null {
    const row = this.db.prepare(`SELECT def FROM workflows WHERE id=?`).get(id) as Row | undefined;
    return row ? (JSON.parse(row.def) as WorkflowDef) : null;
  }

  listWorkflows(): { id: string; name: string }[] {
    return this.db.prepare(`SELECT id,name FROM workflows ORDER BY updated_at DESC`).all() as Row[] as any;
  }

  /** Idempotent submission: same key returns the existing run. */
  startRun(workflowId: string, idempotencyKey?: string): { runId: string; duplicated: boolean } {
    const key = idempotencyKey ?? null;
    if (key) {
      const existing = this.db.prepare(`SELECT id FROM runs WHERE idempotency_key=?`).get(key) as Row | undefined;
      if (existing) return { runId: existing.id as string, duplicated: true };
    }
    const runId = randomUUID();
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT INTO runs(id,workflow_id,idempotency_key,status,created_at,updated_at)
           VALUES(?,?,?,?,?,?)`
        )
        .run(runId, workflowId, key, "running", now, now);
    } catch (e: any) {
      if (String(e.message).includes("UNIQUE")) {
        const row = this.db.prepare(`SELECT id FROM runs WHERE idempotency_key=?`).get(key) as Row;
        return { runId: row.id as string, duplicated: true };
      }
      throw e;
    }
    const def = this.loadWorkflow(workflowId)!;
    const ins = this.db.prepare(
      `INSERT INTO node_execs(run_id,node_id,status,attempt) VALUES(?,?,'pending',0)`
    );
    for (const n of def.nodes) ins.run(runId, n.id);
    this.log(runId, null, "info", `运行 ${runId.slice(0, 8)} 已创建（工作流 ${def.name}）`);
    this.recompute(runId, def);
    return { runId, duplicated: false };
  }

  setRunStatus(runId: string, status: RunStatus) {
    this.db.prepare(`UPDATE runs SET status=?,updated_at=? WHERE id=?`).run(status, Date.now(), runId);
  }

  getRun(runId: string): Row | undefined {
    return this.db.prepare(`SELECT * FROM runs WHERE id=?`).get(runId) as Row | undefined;
  }

  listRuns(limit = 50): Row[] {
    return this.db.prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`).all(limit) as Row[];
  }

  log(runId: string, nodeId: string | null, level: string, message: string) {
    this.db
      .prepare(`INSERT INTO logs(run_id,node_id,ts,level,message) VALUES(?,?,?,?,?)`)
      .run(runId, nodeId, Date.now(), level, message);
  }

  logs(runId: string, afterId = 0): Row[] {
    return this.db
      .prepare(`SELECT * FROM logs WHERE run_id=? AND id>? ORDER BY id`)
      .all(runId, afterId) as Row[];
  }

  execs(runId: string): Row[] {
    return this.db.prepare(`SELECT * FROM node_execs WHERE run_id=? ORDER BY id`).all(runId) as Row[];
  }

  /**
   * Atomically claim one ready node. IMMEDIATE takes the write lock up front so
   * two workers never claim the same row; also enforces the global quota.
   */
  claim(workerId: string, concurrency: number): { exec: Row; def: WorkflowDef } | null {
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const active = (db.prepare(`SELECT COUNT(*) c FROM node_execs WHERE status IN ('claimed','running')`).get() as Row).c as number;
      if (active >= concurrency) {
        db.exec("COMMIT");
        return null;
      }
      const row = db
        .prepare(
          `SELECT ne.* FROM node_execs ne
           JOIN runs r ON r.id=ne.run_id
           WHERE ne.status='ready' AND r.status='running'
           ORDER BY ne.id LIMIT 1`
        )
        .get() as Row | undefined;
      if (!row) {
        db.exec("COMMIT");
        return null;
      }
      const lease = Date.now() + LEASE_MS;
      db.prepare(
        `UPDATE node_execs SET status='claimed',claimed_by=?,lease_expires=?,attempt=attempt+1 WHERE id=?`
      ).run(workerId, lease, row.id);
      db.exec("COMMIT");
      const def = this.loadWorkflow((this.getRun(row.run_id) as Row).workflow_id as string)!;
      return { exec: { ...row, status: "claimed", claimed_by: workerId, lease_expires: lease }, def };
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  markRunning(execId: number, pid: number) {
    const row = this.db.prepare(`SELECT * FROM node_execs WHERE id=?`).get(execId) as Row;
    this.db
      .prepare(`UPDATE node_execs SET status='running',started_at=COALESCE(started_at,?) WHERE id=?`)
      .run(Date.now(), execId);
    this.db
      .prepare(
        `INSERT INTO spawned_processes(pid,run_id,node_id,exec_id,started_at) VALUES(?,?,?,?,?)
         ON CONFLICT(pid) DO UPDATE SET ended=0,exec_id=excluded.exec_id`
      )
      .run(pid, row.run_id, row.node_id, execId, Date.now());
  }

  recordProcessEnd(pid: number) {
    this.db.prepare(`UPDATE spawned_processes SET ended=1 WHERE pid=?`).run(pid);
  }

  liveProcesses(): Row[] {
    return this.db.prepare(`SELECT * FROM spawned_processes WHERE ended=0`).all() as Row[];
  }

  /** Persist result, apply retry, propagate branches, close run when settled. */
  complete(
    execId: number,
    outcome: { success: boolean; output: string; error?: string; branchTaken?: "true" | "false" }
  ): { runId: string; nodeId: string; status: NodeStatus } {
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const exec = db.prepare(`SELECT * FROM node_execs WHERE id=?`).get(execId) as Row;
      const def = this.loadWorkflow((this.getRun(exec.run_id) as Row).workflow_id as string)!;
      if (outcome.success) {
        db.prepare(
          `UPDATE node_execs SET status='success',output=?,error=NULL,branch_taken=?,finished_at=?,lease_expires=NULL WHERE id=?`
        ).run(outcome.output, outcome.branchTaken ?? null, Date.now(), execId);
      } else {
        const node = def.nodes.find((n) => n.id === exec.node_id)!;
        const maxAttempts = 1 + (node.config.retries ?? 0);
        if (exec.attempt < maxAttempts) {
          db.prepare(
            `UPDATE node_execs SET status='ready',error=?,claimed_by=NULL,lease_expires=NULL WHERE id=?`
          ).run(outcome.error ?? "failed", execId);
          db.exec("COMMIT");
          return { runId: exec.run_id, nodeId: exec.node_id, status: "ready" };
        }
        db.prepare(
          `UPDATE node_execs SET status='failed',error=?,finished_at=?,lease_expires=NULL WHERE id=?`
        ).run(outcome.error ?? "failed", Date.now(), execId);
      }
      this.recomputeLocked(exec.run_id, def);
      db.exec("COMMIT");
      return { runId: exec.run_id, nodeId: exec.node_id, status: outcome.success ? "success" : "failed" };
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  recompute(runId: string, def: WorkflowDef) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.recomputeLocked(runId, def);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private recomputeLocked(runId: string, def: WorkflowDef) {
    const rows = this.db.prepare(`SELECT * FROM node_execs WHERE run_id=?`).all(runId) as Row[];
    const byNode = new Map(rows.map((r) => [r.node_id as string, r] as const));
    const ups = upstreamEdges(def);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of def.nodes) {
        const r = byNode.get(node.id)!;
        if (r.status !== "pending") continue;
        const incoming = ups.get(node.id) ?? [];
        if (incoming.length === 0) {
          this.flip(runId, node.id, "ready");
          r.status = "ready";
          changed = true;
          continue;
        }
        const upRows = incoming.map((e) => byNode.get(e.source)!);
        const unfinished = upRows.some((u) => ["pending", "ready", "claimed", "running"].includes(u.status));
        if (unfinished) continue;
        const open = incoming.find((e) => {
          const u = byNode.get(e.source)!;
          if (u.status === "skipped" || u.status === "cancelled" || u.status === "failed") return false;
          if (e.branchLabel && e.branchLabel !== "then") return u.branch_taken === e.branchLabel;
          return true;
        });
        this.flip(runId, node.id, open ? "ready" : "skipped");
        r.status = open ? "ready" : "skipped";
        changed = true;
      }
    }
    this.closeRunIfDone(runId, def, byNode);
  }

  private flip(runId: string, nodeId: string, status: NodeStatus) {
    this.db.prepare(`UPDATE node_execs SET status=? WHERE run_id=? AND node_id=?`).run(status, runId, nodeId);
  }

  private closeRunIfDone(runId: string, def: WorkflowDef, byNode: Map<string, Row>) {
    const run = this.db.prepare(`SELECT status FROM runs WHERE id=?`).get(runId) as Row;
    if (run.status !== "running" && run.status !== "paused") return;
    const active = def.nodes.some((n) => ["pending", "ready", "claimed", "running"].includes(byNode.get(n.id)!.status));
    if (active) return;
    const anyFailed = def.nodes.some((n) => byNode.get(n.id)!.status === "failed");
    this.db.prepare(`UPDATE runs SET status=?,updated_at=? WHERE id=?`).run(
      anyFailed ? "failed" : "completed",
      Date.now(),
      runId
    );
  }

  pauseRun(runId: string) {
    this.setRunStatus(runId, "paused");
  }

  resumeRun(runId: string, def: WorkflowDef) {
    this.setRunStatus(runId, "running");
    this.recompute(runId, def);
  }

  cancelRun(runId: string, def: WorkflowDef): number[] {
    this.setRunStatus(runId, "cancelled");
    const pids = this.liveProcesses()
      .filter((p) => p.run_id === runId)
      .map((p) => p.pid as number);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `UPDATE node_execs SET status='cancelled',finished_at=?,lease_expires=NULL
           WHERE run_id=? AND status IN ('pending','ready','claimed')`
        )
        .run(Date.now(), runId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.recompute(runId, def);
    return pids;
  }

  /** Stale leases -> ready; returns leftover child pids that may need killing. */
  reapExpiredLeases(): number[] {
    const cutoff = Date.now();
    const rows = this.db
      .prepare(
        `SELECT id FROM node_execs
         WHERE status IN ('claimed','running') AND lease_expires IS NOT NULL AND lease_expires < ?`
      )
      .all(cutoff) as Row[];
    const pids: number[] = [];
    for (const r of rows) {
      const procs = this.db.prepare(`SELECT pid FROM spawned_processes WHERE exec_id=? AND ended=0`).all(r.id) as Row[];
      pids.push(...procs.map((p) => p.pid as number));
    }
    this.db
      .prepare(
        `UPDATE node_execs SET status='ready',claimed_by=NULL,lease_expires=NULL
         WHERE status IN ('claimed','running') AND lease_expires IS NOT NULL AND lease_expires < ?`
      )
      .run(cutoff);
    return pids;
  }
}

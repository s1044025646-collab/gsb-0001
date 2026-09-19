import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db";
import { validateAndCompile, type CompiledGraph } from "./graph";
import { evalExpression } from "./expr";
import { runCommand, parseResult } from "./exec";
import { emit, runEvent } from "./events";
import type { RunSummary, WorkflowDef } from "../shared/types";

const LEASE_MS = Number(process.env.WF_LEASE_MS || 15000);
const STALE_MS = Number(process.env.WF_STALE_MS || 30000);
const TICK_MS = Number(process.env.WF_TICK_MS || 150);

interface RunRow {
  id: string;
  idempotency_key: string | null;
  state: string;
  graph: string;
  input: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface NodeRow {
  id: number;
  run_id: string;
  node_id: string;
  state: string;
  attempt: number;
  result: string | null;
  error: string | null;
  worker_id: string | null;
  started_at: number | null;
  finished_at: number | null;
  lease_expires_at: number | null;
  pid: number | null;
}

function tail(s: string) {
  const t = s.trim();
  return t ? `: ${t.slice(-300)}` : "";
}

function hydrateRun(row: RunRow): RunSummary {
  return {
    id: row.id,
    idempotency_key: row.idempotency_key,
    state: row.state as RunSummary["state"],
    created_at: row.created_at,
    updated_at: row.updated_at,
    graph: JSON.parse(row.graph),
    input: row.input == null ? null : JSON.parse(row.input),
    error: row.error,
  };
}

export class Engine {
  db: DatabaseSync;
  workerId = randomUUID().slice(0, 8);
  private compiled = new Map<string, CompiledGraph>();
  private leaseTimers = new Map<number, NodeJS.Timeout>();
  private cancels = new Map<number, { cancelled: boolean }>();
  private tickHandle?: NodeJS.Timeout;
  private quota: number;
  private active = 0;

  constructor(quota = Number(process.env.WF_QUOTA || 2)) {
    this.db = getDb();
    this.quota = quota;
    this.recover();
  }

  start() {
    if (this.tickHandle) return;
    this.tickHandle = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    clearInterval(this.tickHandle);
    this.tickHandle = undefined;
    for (const t of this.leaseTimers.values()) clearInterval(t);
  }

  // ---------- submission / idempotency ----------

  submit(graph: WorkflowDef, options: { idempotencyKey?: string; input?: unknown } = {}): RunSummary {
    const compiled = validateAndCompile(graph);
    if (options.idempotencyKey) {
      const existing = this.db
        .prepare("SELECT * FROM runs WHERE idempotency_key = ?")
        .get(options.idempotencyKey) as RunRow | undefined;
      if (existing) return hydrateRun(existing);
    }
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO runs (id, idempotency_key, state, graph, input, error, created_at, updated_at)
         VALUES (?, ?, 'running', ?, ?, NULL, ?, ?)`
      )
      .run(
        id,
        options.idempotencyKey ?? null,
        JSON.stringify(graph),
        JSON.stringify(options.input ?? null),
        now,
        now
      );
    this.compiled.set(id, compiled);
    this.seedNodeRows(id, graph);
    this.log(id, null, "info", `run created (worker ${this.workerId})`);
    emit(runEvent(id, "run-created", { state: "running" }));
    return this.getRun(id)!;
  }

  // ---------- run control ----------

  pause(runId: string) {
    const res = this.db
      .prepare("UPDATE runs SET state='paused', updated_at=? WHERE id=? AND state='running'")
      .run(Date.now(), runId);
    if (res.changes) {
      this.log(runId, null, "info", "run paused");
      emit(runEvent(runId, "run-state", { state: "paused" }));
    }
  }

  resume(runId: string) {
    const res = this.db
      .prepare("UPDATE runs SET state='running', updated_at=? WHERE id=? AND state='paused'")
      .run(Date.now(), runId);
    if (res.changes) {
      this.log(runId, null, "info", "run resumed");
      emit(runEvent(runId, "run-state", { state: "running" }));
    }
  }

  cancel(runId: string) {
    const run = this.getRun(runId);
    if (!run || ["succeeded", "failed", "cancelled"].includes(run.state)) return;
    this.db.prepare("UPDATE runs SET state='cancelled', updated_at=? WHERE id=?").run(Date.now(), runId);
    const rows = this.db
      .prepare("SELECT id, node_id, pid FROM node_runs WHERE run_id=? AND state IN ('claimed','running','ready','pending')")
      .all(runId) as Array<{ id: number; node_id: string; pid: number | null }>;
    for (const r of rows) {
      const sig = this.cancels.get(r.id);
      if (sig) sig.cancelled = true;
      else if (r.pid) this.killPid(r.pid);
      this.markNode(runId, r.node_id, "cancelled", { clearWorker: true });
    }
    this.log(runId, null, "info", "run cancelled");
    emit(runEvent(runId, "run-state", { state: "cancelled" }));
  }

  // ---------- crash recovery ----------

  recover() {
    const rows = this.db
      .prepare("SELECT * FROM node_runs WHERE state IN ('claimed','running')")
      .all() as unknown as NodeRow[];
    for (const row of rows) {
      if (row.pid && this.isAlive(row.pid)) {
        this.log(row.run_id, row.node_id, "info", `killing orphaned subprocess pid=${row.pid}`);
        this.killPid(row.pid);
      }
      this.db
        .prepare(
          `UPDATE node_runs SET state='ready', worker_id=NULL, pid=NULL, lease_expires_at=NULL,
           error=COALESCE(NULLIF(error,''), '') || ' [interrupted by engine restart, requeued]'
           WHERE id=?`
        )
        .run(row.id);
      emit(runEvent(row.run_id, "node-state", { nodeId: row.node_id, state: "ready" }));
    }
  }

  // ---------- scheduler ----------

  private tick() {
    this.requeueStaleLeases();
    this.activateReadyNodes();
    while (this.active < this.quota) {
      const job = this.claimNext();
      if (!job) break;
      this.active++;
      this.execute(job).finally(() => this.active--);
    }
    this.checkRunCompletion();
  }

  private graphFor(runId: string): CompiledGraph | null {
    let g = this.compiled.get(runId);
    if (g) return g;
    const row = this.db.prepare("SELECT graph FROM runs WHERE id=?").get(runId) as
      | { graph: string }
      | undefined;
    if (!row) return null;
    g = validateAndCompile(JSON.parse(row.graph) as WorkflowDef);
    this.compiled.set(runId, g);
    return g;
  }

  private activateReadyNodes() {
    const runs = this.db
      .prepare("SELECT id FROM runs WHERE state='running'")
      .all() as Array<{ id: string }>;
    for (const run of runs) {
      const g = this.graphFor(run.id);
      if (!g) continue;
      for (const n of g.def.nodes) {
        const nr = this.nodeRun(run.id, n.id);
        if (!nr || nr.state !== "pending") continue;
        if (this.dependenciesSatisfied(g, run.id, n.id)) {
          this.markNode(run.id, n.id, "ready");
        }
      }
      this.skipInactiveBranches(g, run.id);
    }
  }

  /** Nodes reachable only via the non-taken condition branch are skipped. */
  private skipInactiveBranches(g: CompiledGraph, runId: string) {
    for (const n of g.def.nodes) {
      if (n.kind !== "condition") continue;
      const nr = this.nodeRun(runId, n.id);
      if (!nr || nr.state !== "succeeded") continue;
      const taken = nr.result == null ? null : (JSON.parse(nr.result).branch as boolean);
      for (const edge of g.outgoing.get(n.id) ?? []) {
        if (edge.branch !== (taken ? "true" : "false")) {
          const target = this.nodeRun(runId, edge.target);
          if (target && target.state === "pending" && !this.hasActiveIncoming(g, runId, edge.target)) {
            this.markNode(runId, edge.target, "skipped", { propagate: g });
          }
        }
      }
    }
  }

  /** True if any incoming edge comes from a node that can still succeed on an active branch. */
  private hasActiveIncoming(g: CompiledGraph, runId: string, nodeId: string): boolean {
    for (const edge of g.incoming.get(nodeId) ?? []) {
      const src = this.nodeRun(runId, edge.source);
      if (!src) return true;
      const srcDef = g.node.get(edge.source)!;
      if (srcDef.kind === "condition" && src.state === "succeeded") {
        if (String(JSON.parse(src.result!).branch) === edge.branch) return true;
      } else if (!["skipped", "cancelled", "failed"].includes(src.state)) {
        return true;
      }
    }
    return false;
  }

  private markNode(
    runId: string,
    nodeId: string,
    state: string,
    opts: { clearWorker?: boolean; propagate?: CompiledGraph } = {}
  ) {
    const nr = this.nodeRun(runId, nodeId);
    if (!nr) return;
    const finished = ["succeeded", "failed", "skipped", "cancelled"].includes(state);
    this.db
      .prepare(
        `UPDATE node_runs SET state=?,
         worker_id=CASE WHEN ? THEN NULL ELSE worker_id END,
         finished_at=CASE WHEN ? THEN ? ELSE finished_at END
         WHERE id=?`
      )
      .run(state, opts.clearWorker ? 1 : 0, finished ? 1 : 0, Date.now(), nr.id);
    emit(runEvent(runId, "node-state", { nodeId, state }));
    if (state === "skipped" && opts.propagate) {
      for (const e of opts.propagate.outgoing.get(nodeId) ?? []) {
        const downstream = this.nodeRun(runId, e.target);
        if (
          downstream &&
          ["pending", "ready"].includes(downstream.state) &&
          !this.hasActiveIncoming(opts.propagate, runId, e.target)
        ) {
          this.markNode(runId, e.target, "skipped", { propagate: opts.propagate });
        }
      }
    }
  }

  private dependenciesSatisfied(g: CompiledGraph, runId: string, nodeId: string): boolean {
    const incoming = g.incoming.get(nodeId) ?? [];
    if (incoming.length === 0) return true;
    let activeEdge = false;
    for (const edge of incoming) {
      const src = this.nodeRun(runId, edge.source);
      if (!src) return false;
      const srcDef = g.node.get(edge.source)!;
      if (srcDef.kind === "condition") {
        if (src.state === "succeeded") {
          const branch = src.result == null ? null : JSON.parse(src.result).branch;
          if (String(branch) !== edge.branch) continue;
        }
      }
      if (src.state === "skipped" || src.state === "cancelled") continue;
      activeEdge = true;
      if (src.state !== "succeeded") return false;
    }
    return activeEdge;
  }

  /** Single-statement atomic claim; concurrent workers serialize via SQLite write lock. */
  private claimNext(): NodeRow | null {
    const now = Date.now();
    const info = this.db
      .prepare(
        `UPDATE node_runs
         SET state='claimed', worker_id=?, lease_expires_at=?,
             started_at=COALESCE(started_at, ?), attempt=attempt+1
         WHERE id = (
           SELECT nr.id FROM node_runs nr JOIN runs r ON r.id = nr.run_id
           WHERE nr.state='ready' AND r.state='running'
           ORDER BY nr.id LIMIT 1
         ) AND state='ready'
         RETURNING *`
      )
      .get(this.workerId, now + LEASE_MS, now) as NodeRow | undefined;
    return info ?? null;
  }

  private requeueStaleLeases() {
    const cutoff = Date.now() - STALE_MS;
    const rows = this.db
      .prepare("SELECT * FROM node_runs WHERE state IN ('claimed','running') AND lease_expires_at < ?")
      .all(cutoff) as unknown as NodeRow[];
    for (const row of rows) {
      if (row.pid) this.killPid(row.pid);
      this.db
        .prepare("UPDATE node_runs SET state='ready', worker_id=NULL, pid=NULL, lease_expires_at=? WHERE id=?")
        .run(Date.now() + LEASE_MS, row.id);
      this.log(row.run_id, row.node_id, "error", "lease lost: requeued for another worker");
      emit(runEvent(row.run_id, "node-state", { nodeId: row.node_id, state: "ready" }));
    }
  }

  // ---------- node execution ----------

  private async execute(nodeRow: NodeRow) {
    const g = this.graphFor(nodeRow.run_id);
    if (!g) return;
    const def = g.node.get(nodeRow.node_id)!;
    this.startLeaseRenewal(nodeRow.id);
    this.markNode(nodeRow.run_id, def.id, "running", { clearWorker: false });
    this.log(nodeRow.run_id, def.id, "info", `attempt ${nodeRow.attempt} starting (${def.kind})`);

    try {
      if (def.kind === "condition") {
        const ctx = this.buildContext(g, nodeRow.run_id, def.id);
        const branch = evalExpression(def.expression || "false", ctx);
        this.log(nodeRow.run_id, def.id, "info", `condition -> ${branch}`);
        this.finishNode(nodeRow, { ...ctx, branch }, null);
        return;
      }
      const ctx = this.buildContext(g, nodeRow.run_id, def.id);
      const timeoutMs = def.timeoutMs ?? 30000;
      const signal = { cancelled: false };
      this.cancels.set(nodeRow.id, signal);
      const outcome = await runCommand(
        def.command ?? "echo {}",
        JSON.stringify({ input: this.runInput(nodeRow.run_id), upstream: ctx }),
        timeoutMs,
        (child) =>
          setImmediate(() => {
            const pid = child.pid;
            if (typeof pid !== "number" || !Number.isInteger(pid)) {
              this.log(nodeRow.run_id, def.id, "error", `cannot record non-integer pid: ${String(pid)}`);
              return;
            }
            try {
              this.db
                .prepare("UPDATE node_runs SET pid = :pid WHERE id = :id")
                .run({ pid, id: Number(nodeRow.id) });
            } catch (err) {
              this.log(nodeRow.run_id, def.id, "error", `record pid failed: ${(err as Error).message}`);
            }
          }),
        signal
      );

      if (signal.cancelled || this.runState(nodeRow.run_id) === "cancelled") {
        this.markNode(nodeRow.run_id, def.id, "cancelled", { clearWorker: true });
        return;
      }
      if (outcome.timedOut) throw new Error(`timeout after ${timeoutMs}ms${tail(outcome.stderr)}`);
      if (outcome.code !== 0) throw new Error(`exit ${outcome.code}${tail(outcome.stderr)}`);
      if (outcome.stderr.trim()) {
        this.log(nodeRow.run_id, def.id, "info", `stderr: ${outcome.stderr.trim().slice(-400)}`);
      }
      const result = parseResult(outcome.stdout);
      this.finishNode(nodeRow, result, null);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const retries = def.retries ?? 0;
      if (nodeRow.attempt <= retries) {
        this.log(nodeRow.run_id, def.id, "error", `attempt ${nodeRow.attempt} failed: ${error} -> retry`);
        this.db
          .prepare(
            "UPDATE node_runs SET state='ready', worker_id=NULL, pid=NULL, lease_expires_at=NULL, error=? WHERE id=?"
          )
          .run(error, nodeRow.id);
        emit(runEvent(nodeRow.run_id, "node-state", { nodeId: def.id, state: "ready" }));
      } else {
        this.log(nodeRow.run_id, def.id, "error", `failed permanently: ${error}`);
        this.finishNode(nodeRow, null, error);
      }
    } finally {
      this.cancels.delete(nodeRow.id);
      this.stopLeaseRenewal(nodeRow.id);
    }
  }

  private finishNode(nodeRow: NodeRow, result: unknown, error: string | null) {
    const state = error ? "failed" : "succeeded";
    this.db
      .prepare(
        "UPDATE node_runs SET state=?, result=?, error=?, finished_at=?, pid=NULL WHERE id=?"
      )
      .run(state, result == null ? null : JSON.stringify(result), error, Date.now(), nodeRow.id);
    emit(runEvent(nodeRow.run_id, "node-state", { nodeId: nodeRow.node_id, state }));
  }

  /**
   * Context for a node: every succeeded node is available keyed by node id.
   * Scalar fields of DIRECT upstream nodes are flattened, with nearer edges winning,
   * so expressions like $v naturally read the immediate predecessor's output.
   */
  private buildContext(g: CompiledGraph, runId: string, nodeId?: string): Record<string, unknown> {
    const ctx: Record<string, unknown> = {};
    for (const n of g.def.nodes) {
      const nr = this.nodeRun(runId, n.id);
      if (nr?.state === "succeeded" && nr.result != null) {
        ctx[n.id] = JSON.parse(nr.result);
      }
    }
    if (nodeId) {
      // direct predecessors first (earlier edges lose on key collision)
      const direct = (g.incoming.get(nodeId) ?? []).map((e) => e.source);
      for (const srcId of direct) {
        const val = ctx[srcId];
        if (val && typeof val === "object" && !Array.isArray(val)) {
          for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
            ctx[k] = v;
          }
        }
      }
    }
    return ctx;
  }

  private checkRunCompletion() {
    const active = this.db
      .prepare("SELECT id FROM runs WHERE state IN ('running','paused')")
      .all() as Array<{ id: string }>;
    for (const { id } of active) {
      const state = this.runState(id);
      if (state !== "running") continue;
      const rows = this.db
        .prepare("SELECT state FROM node_runs WHERE run_id=?")
        .all(id) as Array<{ state: string }>;
      if (rows.length === 0) continue;
      if (rows.some((r) => r.state === "failed")) {
        this.finishRun(id, "failed", "a node failed");
      } else if (
        rows.every((r) => ["succeeded", "skipped", "cancelled"].includes(r.state)) &&
        rows.some((r) => r.state === "succeeded")
      ) {
        this.finishRun(id, "succeeded", null);
      }
    }
  }

  private finishRun(id: string, state: "succeeded" | "failed" | "cancelled", error: string | null) {
    this.db
      .prepare("UPDATE runs SET state=?, error=?, updated_at=? WHERE id=? AND state IN ('running','paused')")
      .run(state, error, Date.now(), id);
    this.log(id, null, "info", `run ${state}`);
    emit(runEvent(id, "run-state", { state }));
  }

  // ---------- process handling ----------

  private startLeaseRenewal(id: number) {
    const t = setInterval(() => {
      this.db
        .prepare("UPDATE node_runs SET lease_expires_at=? WHERE id=? AND state='running'")
        .run(Date.now() + LEASE_MS, id);
    }, Math.floor(LEASE_MS / 3));
    this.leaseTimers.set(id, t);
  }

  private stopLeaseRenewal(id: number) {
    const t = this.leaseTimers.get(id);
    if (t) {
      clearInterval(t);
      this.leaseTimers.delete(id);
    }
  }

  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private killPid(pid: number) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch {
      /* gone */
    }
  }

  // ---------- small DB helpers ----------

  private ensureNodeRun(runId: string, nodeId: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO node_runs (run_id, node_id, state, attempt) VALUES (?,?,'pending',0)")
      .run(runId, nodeId);
  }

  private nodeRun(runId: string, nodeId: string): NodeRow | undefined {
    return this.db
      .prepare("SELECT * FROM node_runs WHERE run_id=? AND node_id=?")
      .get(runId, nodeId) as NodeRow | undefined;
  }

  runState(runId: string): string | undefined {
    return (this.db.prepare("SELECT state FROM runs WHERE id=?").get(runId) as { state: string } | undefined)
      ?.state;
  }

  private runInput(runId: string): unknown {
    const row = this.db.prepare("SELECT input FROM runs WHERE id=?").get(runId) as
      | { input: string | null }
      | undefined;
    return row?.input == null ? null : JSON.parse(row.input);
  }

  log(runId: string, nodeId: string | null, level: "info" | "error", message: string) {
    this.db
      .prepare("INSERT INTO logs (run_id, node_id, level, message, ts) VALUES (?,?,?,?,?)")
      .run(runId, nodeId, level, message, Date.now());
    emit(runEvent(runId, "log", { nodeId, level, message, ts: Date.now() }));
  }

  // ---------- query API ----------

  getRun(id: string): RunSummary | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as RunRow | undefined;
    return row ? hydrateRun(row) : null;
  }

  listRuns(limit = 50): RunSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?")
      .all(limit) as unknown as RunRow[];
    return rows.map(hydrateRun);
  }

  listNodes(runId: string) {
    return this.db
      .prepare("SELECT * FROM node_runs WHERE run_id=? ORDER BY id")
      .all(runId) as Array<Record<string, unknown>>;
  }

  listLogs(runId?: string, afterId = 0) {
    if (runId) {
      return this.db
        .prepare("SELECT * FROM logs WHERE run_id=? AND id>? ORDER BY id LIMIT 500")
        .all(runId, afterId) as Array<Record<string, unknown>>;
    }
    return this.db
      .prepare("SELECT * FROM logs WHERE id>? ORDER BY id LIMIT 500")
      .all(afterId) as Array<Record<string, unknown>>;
  }

  /** Create pending rows for every graph node (used right after submit). */
  seedNodeRows(runId: string, graph: WorkflowDef) {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO node_runs (run_id, node_id, state, attempt) VALUES (?,?,'pending',0)"
    );
    for (const n of graph.nodes) stmt.run(runId, n.id);
  }
}


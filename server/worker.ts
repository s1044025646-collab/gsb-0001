import { randomUUID } from "node:crypto";
import { Store, DEFAULT_CONCURRENCY } from "./store.ts";
import { buildInput, runNode } from "./executor.ts";
import { publish } from "./events.ts";
import { killTree } from "./procutil.ts";
import { withLock } from "./tx.ts";

export interface WorkerOptions {
  id?: string;
  concurrency?: number;
  pollMs?: number;
  keepAlive?: boolean;
}

export class Worker {
  readonly id: string;
  private store = new Store();
  private concurrency: number;
  private pollMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private busy = false;
  private keepAlive: boolean;

  constructor(opts: WorkerOptions = {}) {
    this.id = opts.id ?? `worker-${randomUUID().slice(0, 8)}`;
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    this.pollMs = opts.pollMs ?? 200;
    this.keepAlive = opts.keepAlive ?? true;
  }

  start() {
    if (this.timer) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try {
        await this.pump();
      } catch (e) {
        // contention (SQLITE_BUSY) etc. - just retry next tick
      }
      this.timer = setTimeout(tick, this.pollMs);
      if (!this.keepAlive) this.timer.unref?.();
    };
    void tick();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Drain as many ready tasks as the quota allows in one pass. */
  private async pump() {
    // One in-flight node per worker. Multiple workers (separate processes, or
    // embedded) reach the global quota; claim() still enforces it atomically.
    if (this.busy) return;
    const task = await withLock(() => this.store.claim(this.id, this.concurrency));
    if (!task) return;
    this.busy = true;
    try {
      await this.execute(task.exec.id, task.def, task.exec.run_id, task.exec.node_id, task.exec.attempt as number);
    } catch (e) {
      this.store.log(task.exec.run_id, task.exec.node_id, "error", `worker 内部错误: ${String(e)}`);
    } finally {
      this.busy = false;
    }
  }

  private async execute(execId: number, def: any, runId: string, nodeId: string, attempt: number) {
    const node = def.nodes.find((n: any) => n.id === nodeId);
    const execRows = this.store.execs(runId);
    const outputs = new Map<string, string | null>();
    for (const e of execRows) outputs.set(e.node_id as string, (e.output as string) ?? null);
    const input = buildInput(def, node, outputs);

    this.store.log(runId, nodeId, "info", `${this.id} 领取任务（第 ${attempt} 次尝试）`);
    publish({ type: "node", runId, data: { execId, status: "claimed", worker: this.id } });

    let pid = -1;
    const result = await runNode({
      node,
      input,
      onSpawn: (p) => {
        pid = p;
        if (p > 0) this.store.markRunning(execId, p);
        publish({ type: "node", runId, data: { execId, status: "running", pid: p } });
      },
      isCancelled: () => (this.store.getRun(runId) as any)?.status === "cancelled",
    });

    if (pid > 0) this.store.recordProcessEnd(pid);
    const outcome = await withLock(() =>
      this.store.complete(execId, {
        success: result.success,
        output: result.output,
        error: result.error,
        branchTaken: result.branchTaken,
      })
    );

    if (result.success) {
      this.store.log(runId, nodeId, "info", `成功${result.output ? `，输出: ${truncate(result.output)}` : ""}`);
    } else if (outcome.status === "ready") {
      this.store.log(runId, nodeId, "warn", `失败（将重试）: ${result.error}`);
    } else {
      this.store.log(runId, nodeId, "error", `最终失败: ${result.error}`);
    }
    await withLock(() => this.store.recompute(runId, def));
    publish({ type: "node", runId, data: { execId, status: outcome.status } });
    publish({ type: "run", runId, data: this.store.getRun(runId) });
  }

}

/**
 * Crash recovery on boot: child processes recorded as live belong to a dead
 * coordinator. Kill the leftover process tree, mark it ended, and release any
 * expired leases so nodes re-enter the ready queue.
 */
export function recoverOrphans(store: Store) {
  const tracked = store.liveProcesses();
  const trackedExecs = new Set(tracked.map((p) => p.exec_id as number));
  for (const p of tracked) {
    const pid = p.pid as number;
    killTree(pid);
    store.recordProcessEnd(pid);
  }
  // Every tracked child belonged to the previous (dead) process and has been
  // killed, so its in-flight exec can safely re-enter the ready queue even if
  // the lease has not yet expired.
  let reaped = 0;
  for (const execId of trackedExecs) {
    const row = (store as any).db.prepare(`SELECT status FROM node_execs WHERE id=?`).get(execId);
    if (row && ["claimed", "running"].includes(row.status)) {
      (store as any).db
        .prepare(`UPDATE node_execs SET status='ready',claimed_by=NULL,lease_expires=NULL WHERE id=?`)
        .run(execId);
      reaped++;
    }
  }
  return tracked.length + reaped;
}

function truncate(s: string) {
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

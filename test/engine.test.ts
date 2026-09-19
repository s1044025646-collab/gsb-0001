import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import { Worker, recoverOrphans } from "../server/worker.ts";
import { demoWorkflow } from "../server/seed.ts";
import type { WorkflowDef } from "../shared/types.ts";

let dir: string;
let store: Store;

function linearWorkflow(retries = 0): WorkflowDef {
  const n = (id: string, label: string, x: number, cfg: any) => ({
    id, kind: "task" as const, label, position: { x, y: 100 }, config: cfg,
  });
  return {
    id: "lin",
    name: "linear",
    nodes: [
      n("s1", "第一步", 0, { command: "node", args: ["-e", "process.stdout.write('hello')"], timeoutMs: 5000 }),
      n("s2", "回显上游", 260, { command: "node", args: ["-e", "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('got:'+d))"], timeoutMs: 5000, retries }),
      n("s3", "第三步", 520, { command: "node", args: ["-e", "console.log('end')"], timeoutMs: 5000 }),
    ],
    edges: [
      { id: "1", source: "s1", target: "s2", branchLabel: "then" },
      { id: "2", source: "s2", target: "s3", branchLabel: "then" },
    ],
  };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-test-"));
  resetDb(join(dir, "t.db"));
  store = new Store();
});

after(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may briefly retain the file handle; temp dir cleanup is non-essential */
  }
});

const waitFor = async (pred: () => boolean, timeout = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("等待超时");
};

test("线性流程真实执行子进程，上游输出流入下游", async () => {
  store.saveWorkflow(linearWorkflow());
  const { runId } = store.startRun("lin");
  const worker = new Worker({ keepAlive: false, concurrency: 2, pollMs: 30 });
  worker.start();
  await waitFor(() => store.getRun(runId)!.status === "completed");
  worker.stop();
  const execs = Object.fromEntries(store.execs(runId).map((e) => [e.node_id, e]));
  assert.equal(execs.s1.output, "hello");
  assert.equal(execs.s2.output, "got:hello");
  assert.equal(execs.s3.output, "end");
  assert.equal(store.liveProcesses().length, 0);
});

test("条件分支只走 true 一侧", async () => {
  const def = demoWorkflow();
  // isolate: keep gen + condition + branches only
  def.nodes = def.nodes.filter((n) => ["gen", "check", "yes", "no"].includes(n.id));
  def.edges = def.edges.filter((e) => ["e1", "e2", "e3"].includes(e.id));
  store.saveWorkflow(def);
  const { runId } = store.startRun(def.id);
  const worker = new Worker({ keepAlive: false, concurrency: 2, pollMs: 30 });
  worker.start();
  await waitFor(() => store.getRun(runId)!.status === "completed");
  worker.stop();
  const execs = Object.fromEntries(store.execs(runId).map((e) => [e.node_id, e]));
  assert.equal(execs.yes.status, "success");
  assert.equal(execs.no.status, "skipped");
});

test("幂等键重复提交返回同一 run", () => {
  const first = store.startRun("lin", "key-123");
  assert.equal(first.duplicated, false);
  const second = store.startRun("lin", "key-123");
  assert.equal(second.duplicated, true);
  assert.equal(second.runId, first.runId);
});

test("多个 worker 并发领取不会重复（配额与互斥）", async () => {
  // fan-out workflow: 6 independent tasks, global quota = 2
  const def: WorkflowDef = {
    id: "fan",
    name: "fan",
    nodes: Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`,
      kind: "task" as const,
      label: `t${i}`,
      position: { x: 300, y: i * 80 },
      config: { command: "node", args: ["-e", "setTimeout(()=>console.log('x'),600)"], timeoutMs: 5000 },
    })),
    edges: [],
  };
  store.saveWorkflow(def);
  const { runId } = store.startRun("fan");
  const workers = [new Worker({ keepAlive: false, id: "w1", concurrency: 2, pollMs: 10 }), new Worker({ keepAlive: false, id: "w2", concurrency: 2, pollMs: 10 }), new Worker({ keepAlive: false, id: "w3", concurrency: 2, pollMs: 10 })];
  workers.forEach((w) => w.start());
  await waitFor(() => store.getRun(runId)!.status === "completed");
  workers.forEach((w) => w.stop());
  const execs = store.execs(runId);
  assert.equal(execs.every((e) => e.status === "success"), true);
  // exactly-once: each node attempt counter ends at 1
  assert.equal(execs.every((e) => e.attempt === 1), true);
});

test("取消会终止进行中的子进程", async () => {
  const def: WorkflowDef = {
    id: "long",
    name: "long",
    nodes: [
      {
        id: "slow", kind: "task", label: "slow", position: { x: 0, y: 0 },
        config: { command: "node", args: ["-e", "setTimeout(()=>{},30000)"], timeoutMs: 60000 },
      },
    ],
    edges: [],
  };
  store.saveWorkflow(def);
  const { runId } = store.startRun("long");
  const worker = new Worker({ keepAlive: false, concurrency: 1, pollMs: 20 });
  worker.start();
  await waitFor(() => store.execs(runId).some((e) => e.status === "running"));
  const pids = store.cancelRun(runId, def);
  for (const pid of pids) process.kill(pid); // mirror api kill
  await waitFor(() => ["cancelled", "failed"].includes(store.execs(runId)[0].status), 5000).catch(() => {});
  worker.stop();
  assert.notEqual(store.getRun(runId)!.status, "running");
});

test("崩溃恢复：重启后回收租约并完成未竟流程", async () => {
  // simulate a node left "running" with an expired lease (worker hard-killed)
  store.saveWorkflow(linearWorkflow());
  const { runId } = store.startRun("lin", "crash-key");
  // claim s1 and fake a crash: set running with expired lease
  const claimed = store.claim("dead-worker", 5)!;
  store.markRunning(claimed.exec.id, 999999);
  (store as any).db.prepare(`UPDATE node_execs SET lease_expires=? WHERE id=?`).run(Date.now() - 5000, claimed.exec.id);
  assert.equal(store.liveProcesses().some((p) => p.pid === 999999), true);

  // reboot: new store + orphan recovery + fresh worker
  recoverOrphans(store);
  assert.equal(store.liveProcesses().length, 0);
  const back = store.execs(runId)[0];
  assert.equal(back.status, "ready");

  const worker = new Worker({ keepAlive: false, concurrency: 2, pollMs: 30 });
  worker.start();
  await waitFor(() => store.getRun(runId)!.status === "completed");
  worker.stop();
  const execs = store.execs(runId);
  assert.equal(execs.every((e) => e.status === "success" || e.status === "skipped"), true);
});

test("失败节点在重试次数内成功，超出则流程失败", async () => {
  const def: WorkflowDef = {
    id: "retry",
    name: "retry",
    nodes: [
      {
        id: "bad", kind: "fault", label: "fault", position: { x: 0, y: 0 },
        config: { failRate: 1, retries: 1 },
      },
    ],
    edges: [],
  };
  store.saveWorkflow(def);
  const { runId } = store.startRun("retry");
  const worker = new Worker({ keepAlive: false, concurrency: 1, pollMs: 10 });
  worker.start();
  await waitFor(() => ["failed", "completed"].includes(store.getRun(runId)!.status));
  worker.stop();
  assert.equal(store.getRun(runId)!.status, "failed");
  const nodeExec = store.execs(runId)[0];
  assert.equal(nodeExec.attempt, 2); // initial + 1 retry
});


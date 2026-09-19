import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import type { WorkflowDef } from "../shared/types.ts";

let dir: string;
let dbPath: string;
let store: Store;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-mp-"));
  dbPath = join(dir, "mp.db");
  resetDb(dbPath);
  store = new Store();
  const def: WorkflowDef = {
    id: "mp",
    name: "mp",
    nodes: Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`,
      kind: "task" as const,
      label: `t${i}`,
      position: { x: 200, y: i * 70 },
      config: {
        command: "node",
        args: ["-e", `setTimeout(()=>console.log('${i}'),${300 + i * 60})`],
        timeoutMs: 10000,
      },
    })),
    edges: [],
  };
  store.saveWorkflow(def);
});

after(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* ignore */
  }
});

test("两个独立 OS 进程 worker 不重复领取任务，完成全部节点", async () => {
  const { runId } = store.startRun("mp");
  const env = { ...process.env, WF_DB: dbPath, WF_CONCURRENCY: "2" };
  const procs = [
    spawn(process.execPath, ["--import", "tsx", "server/worker-cli.ts"], { env, stdio: "ignore" }),
    spawn(process.execPath, ["--import", "tsx", "server/worker-cli.ts"], { env, stdio: "ignore" }),
  ];
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (store.getRun(runId)!.status === "completed") break;
    await new Promise((r) => setTimeout(r, 150));
  }
  procs.forEach((p) => p.kill());
  assert.equal(store.getRun(runId)!.status, "completed");
  const execs = store.execs(runId);
  assert.equal(execs.length, 8);
  assert.ok(execs.every((e) => e.status === "success"));
  assert.ok(execs.every((e) => e.attempt === 1), "每个节点恰好执行一次");
  const workers = new Set(execs.map((e) => e.claimed_by));
  assert.ok(workers.size >= 1);
});

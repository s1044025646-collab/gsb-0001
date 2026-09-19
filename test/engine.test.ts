import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { resetDb, closeDb } from "../src/server/db";
import { Engine } from "../src/server/engine";
import type { WorkflowDef } from "../src/shared/types";

const DB = "data/test-engine.db";
process.env.WF_DB = DB;
process.env.WF_QUOTA = "2";
process.env.WF_TICK_MS = "20";
process.env.WF_LEASE_MS = "2000";
process.env.WF_STALE_MS = "1500";

const node = (js: string) =>
  "nodejs:" +
  `let b="";
process.stdin.on("data", (d) => (b += d));
process.stdin.on("end", () => {
  const p = JSON.parse(b || "{}");
${js}
});`;

function linearGraph(retries = 0, timeout = 10000): WorkflowDef {
  return {
    nodes: [
      { id: "a", kind: "start", label: "a", x: 0, y: 0, command: node(`process.stdout.write(JSON.stringify({ x: 1 }));`) },
      { id: "b", kind: "task", label: "b", x: 1, y: 0, retries, timeoutMs: timeout, command: node(`process.stdout.write(JSON.stringify({ x: (p.upstream.x || 0) + 1 }));`) },
      { id: "c", kind: "end", label: "c", x: 2, y: 0, command: node(`process.stdout.write(JSON.stringify({ x: (p.upstream.x || 0) + 1 }));`) },
    ],
    edges: [
      { id: "e1", source: "a", target: "b" },
      { id: "e2", source: "b", target: "c" },
    ],
  };
}

function waitFor(engine: Engine, runId: string, timeout = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const timer = setInterval(() => {
      const run = engine.getRun(runId);
      if (run && ["succeeded", "failed", "cancelled"].includes(run.state)) {
        clearInterval(timer);
        run.state === "succeeded" ? resolve() : reject(new Error(`run ${run.state}: ${run.error}`));
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error("timeout waiting for run"));
      }
    }, 30);
  });
}

before(() => resetDb(DB));
after(() => {
  closeDb();
  for (const f of ["", "-wal", "-shm"]) fs.rmSync(DB + f, { force: true });
});

test("upstream JSON output flows into downstream stdin and run succeeds", async () => {
  const engine = new Engine();
  engine.start();
  const run = engine.submit(linearGraph());
  await waitFor(engine, run.id);
  const nodes = Object.fromEntries(engine.listNodes(run.id).map((n) => [n.node_id, n]));
  assert.equal(nodes.c.state, "succeeded");
  assert.deepEqual(JSON.parse(String(nodes.c.result)), { x: 3 });
  engine.stop();
});

test("idempotency key: duplicate submissions return the same run", () => {
  const engine = new Engine();
  const r1 = engine.submit(linearGraph(), { idempotencyKey: "idem-1" });
  const r2 = engine.submit(linearGraph(), { idempotencyKey: "idem-1" });
  assert.equal(r1.id, r2.id);
  assert.equal(engine.listRuns().filter((r) => r.idempotency_key === "idem-1").length, 1);
});

test("concurrent engines share SQLite and each node is claimed exactly once", async () => {
  resetDb(DB);
  const graph: WorkflowDef = {
    nodes: Array.from({ length: 6 }, (_, i) => ({
      id: `n${i}`,
      kind: (i === 0 ? "start" : "task") as "start" | "task",
      label: `n${i}`,
      x: i,
      y: 0,
      timeoutMs: 5000,
      command: node(`setTimeout(() => process.stdout.write(JSON.stringify({ i: ${i} })), 120);`),
    })),
    edges: Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, source: `n${i}`, target: `n${i + 1}` })),
  };
  const engines = [new Engine(1), new Engine(1), new Engine(1)];
  const run = engines[0].submit(graph);
  engines.forEach((e) => e.start());
  await waitFor(engines[0], run.id, 30000);
  const rows = engines[0].listNodes(run.id);
  assert.equal(rows.length, 6);
  for (const r of rows) assert.equal(r.state, "succeeded");
  // a node is claimed exactly once => exactly one successful attempt per node
  for (const r of rows) assert.equal(Number(r.attempt), 1, `node ${r.node_id} claimed ${r.attempt} times`);
  engines.forEach((e) => e.stop());
});

test("retry: failing node eventually succeeds within retry budget", async () => {
  resetDb(DB);
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/.flaky-test-retry", "0");
  const graph: WorkflowDef = {
    nodes: [
      {
        id: "a", kind: "start", label: "a", retries: 3, timeoutMs: 5000,
        command: node(`
          const fs = require("fs");
          const f = "data/.flaky-test-retry";
          let n = +fs.readFileSync(f, "utf8");
          n++; fs.writeFileSync(f, String(n));
          if (n < 3) { console.error("fail " + n); process.exit(1); }
          process.stdout.write(JSON.stringify({ ok: true, n }));`),
      },
    ],
    edges: [],
  };
  const engine = new Engine();
  engine.start();
  const run = engine.submit(graph);
  await waitFor(engine, run.id);
  const a = engine.listNodes(run.id)[0];
  assert.equal(a.state, "succeeded");
  assert.equal(Number(a.attempt), 3);
  engine.stop();
});

test("timeout: node exceeding timeoutMs fails after exhausting retries", async () => {
  resetDb(DB);
  const graph: WorkflowDef = {
    nodes: [
      { id: "a", kind: "start", label: "a", retries: 1, timeoutMs: 300, command: node(`setTimeout(() => process.stdout.write("{}"), 5000);`) },
    ],
    edges: [],
  };
  const engine = new Engine();
  engine.start();
  const run = engine.submit(graph);
  await waitFor(engine, run.id, 20000).catch(() => {});
  assert.equal(engine.getRun(run.id)?.state, "failed");
  engine.stop();
});

test("pause prevents claims; resume continues", async () => {
  resetDb(DB);
  const engine = new Engine(1);
  engine.start();
  const run = engine.submit(linearGraph());
  engine.pause(run.id);
  await new Promise((r) => setTimeout(r, 500));
  const done = engine.listNodes(run.id).filter((n) => n.state === "succeeded");
  assert.equal(done.length, 0);
  engine.resume(run.id);
  await waitFor(engine, run.id);
  engine.stop();
});

test("cancel kills in-flight work and marks run cancelled", async () => {
  resetDb(DB);
  const graph: WorkflowDef = {
    nodes: [{ id: "a", kind: "start", label: "a", timeoutMs: 10000, command: node(`setInterval(() => {}, 1000);`) }],
    edges: [],
  };
  const engine = new Engine();
  engine.start();
  const run = engine.submit(graph);
  await new Promise((r) => setTimeout(r, 600));
  engine.cancel(run.id);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(engine.getRun(run.id)?.state, "cancelled");
  engine.stop();
});

test("conditional branch: only the taken branch executes", async () => {
  resetDb(DB);
  const graph: WorkflowDef = {
    nodes: [
      { id: "a", kind: "start", label: "a", command: node(`process.stdout.write(JSON.stringify({ v: 20 }));`) },
      { id: "cond", kind: "condition", label: "c", expression: "$v > 10" },
      { id: "yes", kind: "task", label: "yes", command: node(`process.stdout.write('{"y":1}');`) },
      { id: "no", kind: "task", label: "no", command: node(`process.stdout.write('{"n":1}');`) },
    ],
    edges: [
      { id: "e1", source: "a", target: "cond" },
      { id: "e2", source: "cond", target: "yes", branch: "true" },
      { id: "e3", source: "cond", target: "no", branch: "false" },
    ],
  };
  const engine = new Engine();
  engine.start();
  const run = engine.submit(graph);
  await new Promise((r) => setTimeout(r, 2500));
  const map = Object.fromEntries(engine.listNodes(run.id).map((n) => [n.node_id, n.state]));
  assert.equal(map.yes, "succeeded");
  assert.equal(map.no, "skipped");
  engine.stop();
});


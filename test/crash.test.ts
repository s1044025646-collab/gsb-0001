import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { resetDb, getDb, closeDb } from "../src/server/db";
import type { WorkflowDef } from "../src/shared/types";

const DB = "data/test-crash.db";
process.env.WF_DB = DB;
process.env.WF_QUOTA = "1";
process.env.WF_TICK_MS = "30";

const node = (js: string) =>
  "nodejs:" +
  `let b="";
process.stdin.on("data", (d) => (b += d));
process.stdin.on("end", () => {
  const p = JSON.parse(b || "{}");
${js}
});`;

const graph: WorkflowDef = {
  nodes: [
    { id: "a", kind: "start", label: "a", command: node(`process.stdout.write(JSON.stringify({ x: 42 }));`) },
    {
      id: "b", kind: "task", label: "b", timeoutMs: 60000,
      command: node(`
        const fs = require("fs");
        fs.writeFileSync("data/.crash-child-pid", String(process.pid));
        if (!fs.existsSync("data/.crash-hung")) {
          fs.writeFileSync("data/.crash-hung", "1");
          setInterval(() => {}, 1000);
        } else {
          process.stdout.write(JSON.stringify({ recovered: true }));
        }`),
    },
    {
      id: "c", kind: "end", label: "c",
      command: node(`process.stdout.write(JSON.stringify({ done: true, x: p.upstream.a && p.upstream.a.x }));`),
    },
  ],
  edges: [
    { id: "e1", source: "a", target: "b" },
    { id: "e2", source: "b", target: "c" },
  ],
};

function startServer(port: number): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
    env: { ...process.env, WF_DB: DB, WF_QUOTA: "1", PORT: String(port), WF_TICK_MS: "30" },
    stdio: "ignore",
    windowsHide: true,
  });
}

async function postRun(port: number): Promise<{ id: string }> {
  const res = await fetch(`http://localhost:${port}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ graph }),
  });
  return res.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isPidAlive(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      try {
        process.kill(pid, 0);
        resolve(true);
      } catch {
        resolve(false);
      }
      return;
    }
    execFile("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { windowsHide: true }, (_err, stdout) => {
      resolve(String(stdout).includes(String(pid)));
    });
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error("condition not met before timeout");
}

before(() => resetDb(DB));
after(() => {
  closeDb();
  for (const f of ["", "-wal", "-shm"]) fs.rmSync(DB + f, { force: true });
  fs.rmSync("data/.crash-child-pid", { force: true });
  fs.rmSync("data/.crash-hung", { force: true });
});

test("forced kill + restart: orphan killed, completed results kept, run finishes", async () => {
  fs.rmSync("data/.crash-child-pid", { force: true });
  fs.rmSync("data/.crash-hung", { force: true });
  const server1 = startServer(8901);
  try {
    await sleep(1800);
    const run = await postRun(8901);
    await waitFor(() => fs.existsSync("data/.crash-child-pid"));

    const db = getDb(DB);
    await waitFor(() => {
      const b = db.prepare("SELECT state FROM node_runs WHERE run_id=? AND node_id='b'").get(run.id) as { state: string };
      return b.state === "running";
    });
    const a = db.prepare("SELECT state, result FROM node_runs WHERE run_id=? AND node_id='a'").get(run.id) as {
      state: string; result: string;
    };
    assert.equal(a.state, "succeeded");
    assert.deepEqual(JSON.parse(a.result), { x: 42 });

    const childPid = Number(fs.readFileSync("data/.crash-child-pid", "utf8"));
    server1.kill("SIGKILL");
    await sleep(600);

    const server2 = startServer(8902);
    try {
      await waitFor(() => {
        return isPidAlive(childPid).then((alive) => {
          return !alive;
        });
      }, 10000);
      const aliveAfterRecovery = await isPidAlive(childPid);
      assert.equal(aliveAfterRecovery, false, "orphan subprocess must be killed on recovery");

      const db2 = getDb(DB);
      const a2 = db2.prepare("SELECT state, result FROM node_runs WHERE run_id=? AND node_id='a'").get(run.id) as {
        state: string; result: string;
      };
      assert.equal(a2.state, "succeeded");
      assert.deepEqual(JSON.parse(a2.result), { x: 42 });

      await waitFor(() => {
        const r = db2.prepare("SELECT state FROM runs WHERE id=?").get(run.id) as { state: string };
        return r.state === "succeeded";
      }, 20000);

      const c = db2.prepare("SELECT result FROM node_runs WHERE run_id=? AND node_id='c'").get(run.id) as { result: string };
      assert.deepEqual(JSON.parse(c.result), { done: true, x: 42 });
    } finally {
      server2.kill("SIGTERM");
      await sleep(300);
    }
  } finally {
    if (!server1.killed) server1.kill("SIGTERM");
  }
});




import express from "express";
import type { Server } from "node:http";
import { Store } from "./store.ts";
import { subscribe } from "./events.ts";
import { validateDag } from "../shared/dag.ts";
import { killTree } from "./procutil.ts";
import type { WorkflowDef } from "../shared/types.ts";

export function createApi(store: Store) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

  app.get("/api/workflows", (_req, res) => res.json(store.listWorkflows()));

  app.get("/api/workflows/:id", (req, res) => {
    const def = store.loadWorkflow(req.params.id);
    def ? res.json(def) : res.status(404).json({ error: "not found" });
  });

  app.put("/api/workflows", (req, res) => {
    const def = req.body as WorkflowDef;
    const errors = validateDag(def);
    if (errors.length) return res.status(400).json({ errors });
    store.saveWorkflow(def);
    res.json({ ok: true, id: def.id });
  });

  app.post("/api/runs", (req, res) => {
    const { workflowId, idempotencyKey } = req.body ?? {};
    if (!store.loadWorkflow(workflowId)) return res.status(404).json({ error: "workflow not found" });
    const result = store.startRun(workflowId, idempotencyKey);
    res.status(result.duplicated ? 200 : 201).json(result);
  });

  app.get("/api/runs", (_req, res) => res.json(store.listRuns()));

  app.get("/api/runs/:id", (req, res) => {
    const run = store.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: "not found" });
    const def = store.loadWorkflow(run.workflow_id as string);
    res.json({ run, workflow: def, execs: store.execs(req.params.id), logs: store.logs(req.params.id) });
  });

  app.post("/api/runs/:id/pause", (req, res) => {
    store.pauseRun(req.params.id);
    res.json({ ok: true });
  });

  app.post("/api/runs/:id/resume", (req, res) => {
    const run = store.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: "not found" });
    store.resumeRun(req.params.id, store.loadWorkflow(run.workflow_id as string)!);
    res.json({ ok: true });
  });

  app.post("/api/runs/:id/cancel", (req, res) => {
    const run = store.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: "not found" });
    const pids = store.cancelRun(req.params.id, store.loadWorkflow(run.workflow_id as string)!);
    for (const pid of pids) killTree(pid);
    res.json({ ok: true, killed: pids.length });
  });

  // Server-sent events: node/run/log updates streamed live to the browser.
  app.get("/api/events", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();
    res.write(`event: hello\ndata: {"ok":true}\n\n`);
    const unsub = subscribe((e) => {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    });
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      unsub();
    });
  });

  return app;
}

export function listen(app: ReturnType<typeof createApi>, port: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(port, () => resolve(server));
  });
}

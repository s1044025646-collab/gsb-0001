import express from "express";
import { Engine } from "./engine";
import { addSseClient } from "./events";
import type { WorkflowDef } from "../shared/types";

export function createApp(engine: Engine) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, worker: engine.workerId, quota: process.env.WF_QUOTA || 2 })
  );

  app.post("/api/runs", (req, res) => {
    try {
      const { graph, idempotencyKey, input } = req.body as {
        graph: WorkflowDef;
        idempotencyKey?: string;
        input?: unknown;
      };
      const run = engine.submit(graph, { idempotencyKey, input });
      res.status(201).json(run);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/runs", (_req, res) => res.json(engine.listRuns()));
  app.get("/api/runs/:id", (req, res) => {
    const run = engine.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: "not found" });
    res.json(run);
  });
  app.get("/api/runs/:id/nodes", (req, res) => res.json(engine.listNodes(req.params.id)));
  app.get("/api/runs/:id/logs", (req, res) =>
    res.json(engine.listLogs(req.params.id, Number(req.query.after ?? 0)))
  );

  app.post("/api/runs/:id/pause", (req, res) => {
    engine.pause(req.params.id);
    res.json(engine.getRun(req.params.id));
  });
  app.post("/api/runs/:id/resume", (req, res) => {
    engine.resume(req.params.id);
    res.json(engine.getRun(req.params.id));
  });
  app.post("/api/runs/:id/cancel", (req, res) => {
    engine.cancel(req.params.id);
    res.json(engine.getRun(req.params.id));
  });

  app.get("/events", (_req, res) => addSseClient(res));

  // static built client (optional)
  app.use(express.static("dist"));
  return app;
}

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import express from "express";
import { openDb } from "./db.ts";
import { Store } from "./store.ts";
import { Worker } from "./worker.ts";
import { recoverOrphans } from "./worker.ts";
import { createApi, listen } from "./api.ts";
import { seedDemo } from "./seed.ts";

const port = Number(process.env.PORT ?? 5174);
const dbPath = process.env.WF_DB ?? resolve(process.cwd(), "data/workflow.db");
openDb(dbPath);

const store = new Store();
const orphans = recoverOrphans(store);
if (orphans > 0) console.log(`恢复：清理遗留进程/租约 ${orphans} 项`);

seedDemo(store);

const concurrency = Number(process.env.WF_CONCURRENCY ?? 3);
const embeddedWorkers = Number(process.env.WF_WORKERS ?? 2);
for (let i = 0; i < embeddedWorkers; i++) new Worker({ concurrency, id: `embedded-${i + 1}` }).start();
console.log(`内置 worker ${embeddedWorkers} 个，全局并发配额 ${concurrency}`);

const app = createApi(store);
const distDir = resolve(process.cwd(), "dist");
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(resolve(distDir, "index.html")));
}

listen(app, port).then(() => {
  console.log(`工作流引擎已启动: http://localhost:${port}`);
});

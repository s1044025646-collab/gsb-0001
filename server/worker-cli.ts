import { openDb } from "./db.ts";
import { Worker } from "./worker.ts";
import { resolve } from "node:path";

const dbPath = process.env.WF_DB ?? resolve(process.cwd(), "data/workflow.db");
openDb(dbPath);
const concurrency = Number(process.env.WF_CONCURRENCY ?? 3);
const worker = new Worker({ concurrency });
worker.start();
console.log(`[${worker.id}] 已启动，并发配额=${concurrency}，DB=${dbPath}`);

const shutdown = () => {
  worker.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

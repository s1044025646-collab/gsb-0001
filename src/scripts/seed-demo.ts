import { Engine } from "../server/engine";
import { demoGraph } from "../client/demoGraph";

const engine = new Engine();
const run = engine.submit(demoGraph, { idempotencyKey: "demo-seed", input: { v: 4 } });
console.log("seeded run", run.id);

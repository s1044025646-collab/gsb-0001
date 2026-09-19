import { createApp } from "./api";
import { Engine } from "./engine";

const port = Number(process.env.PORT || 8787);
const engine = new Engine();
engine.start();

const server = createApp(engine).listen(port, () => {
  console.log(`[worker ${engine.workerId}] API listening on http://localhost:${port}`);
});

const shutdown = () => {
  console.log("shutting down...");
  engine.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

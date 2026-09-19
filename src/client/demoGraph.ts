import type { WorkflowDef } from "../shared/types";

const node = (js: string) =>
  "nodejs:" +
  `let b="";
process.stdin.on("data", (d) => (b += d));
process.stdin.on("end", () => {
  const p = JSON.parse(b || "{}");
${js}
});`;

export const demoGraph: WorkflowDef = {
  nodes: [
    {
      id: "start",
      kind: "start",
      label: "Start (v=4)",
      x: 20,
      y: 160,
      command: node(`  process.stdout.write(JSON.stringify({ v: (p.input && p.input.v) || 4 }));`),
    },
    {
      id: "flaky",
      kind: "task",
      label: "Flaky fetch（前两次失败）",
      x: 250,
      y: 40,
      retries: 3,
      timeoutMs: 8000,
      command: node(`  const fs = require("fs");
  const f = "data/.flaky-" + (process.env.WF_FAULT_KEY || "default");
  let n = 0;
  try { n = +fs.readFileSync(f, "utf8"); } catch {}
  n++;
  fs.writeFileSync(f, String(n));
  if (n < 3) { console.error("injected failure #" + n); process.exit(1); }
  process.stdout.write(JSON.stringify({ v: ((p.upstream && p.upstream.v) || 0) + 10, attempts: n }));`),
    },
    {
      id: "slow",
      kind: "task",
      label: "Slow job（首次超时，重试成功）",
      x: 250,
      y: 280,
      timeoutMs: 1500,
      retries: 2,
      command: node(`  const fs = require("fs");
  const f = "data/.slow-" + (process.env.WF_FAULT_KEY || "default");
  let n = 0;
  try { n = +fs.readFileSync(f, "utf8"); } catch {}
  n++; fs.writeFileSync(f, String(n));
  const wait = n < 2 ? 4000 : 200;
  setTimeout(() => process.stdout.write(JSON.stringify({ late: n > 1, tries: n })), wait);`),
    },
    {
      id: "check",
      kind: "condition",
      label: "v > 10 ?",
      x: 530,
      y: 140,
      expression: "$v > 10",
    },
    {
      id: "branchA",
      kind: "task",
      label: "Branch A（true 热路径）",
      x: 780,
      y: 60,
      command: node(`  process.stdout.write(JSON.stringify({ path: "A", v: (p.upstream && p.upstream.v) || 0 }));`),
    },
    {
      id: "branchB",
      kind: "task",
      label: "Branch B（false 冷路径）",
      x: 780,
      y: 240,
      command: node(`  process.stdout.write(JSON.stringify({ path: "B" }));`),
    },
    {
      id: "end",
      kind: "end",
      label: "End",
      x: 1040,
      y: 150,
      command: node(`  process.stdout.write(JSON.stringify({ done: true }));`),
    },
  ],
  edges: [
    { id: "e1", source: "start", target: "flaky" },
    { id: "e2", source: "start", target: "slow" },
    { id: "e3", source: "flaky", target: "check" },
    { id: "e4", source: "check", target: "branchA", branch: "true" },
    { id: "e5", source: "check", target: "branchB", branch: "false" },
    { id: "e6", source: "branchA", target: "end" },
    { id: "e7", source: "branchB", target: "end" },
    { id: "e8", source: "slow", target: "end" },
  ],
};


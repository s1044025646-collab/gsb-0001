import type { Store } from "./store.ts";
import type { WorkflowDef } from "../shared/types.ts";

export const DEMO_ID = "demo-pipeline";

const node = (id: string, label: string, kind: any, x: number, y: number, config: any) => ({
  id,
  label,
  kind,
  position: { x, y },
  config,
});

export function demoWorkflow(): WorkflowDef {
  return {
    id: DEMO_ID,
    name: "演示流水线（条件分支/故障注入/并发）",
    nodes: [
      node("gen", "生成数值 5", "task", 80, 180, {
        command: "node",
        args: ["-e", "process.stdout.write('5')"],
        timeoutMs: 5000,
      }),
      node("check", "判断 > 3?", "condition", 340, 180, { expression: "$input > 3" }),
      node("yes", "分支: 大于3", "task", 620, 60, {
        command: "node",
        args: ["-e", "console.log('high-value')"],
        timeoutMs: 5000,
      }),
      node("no", "分支: 不大于3", "task", 620, 300, {
        command: "node",
        args: ["-e", "console.log('low-value')"],
        timeoutMs: 5000,
      }),
      node("wait1", "并发任务 A (1.5s)", "task", 340, 400, {
        command: "node",
        args: ["-e", "setTimeout(()=>console.log('A done'),1500)"],
        timeoutMs: 8000,
      }),
      node("wait2", "并发任务 B (1.5s)", "task", 620, 420, {
        command: "node",
        args: ["-e", "setTimeout(()=>console.log('B done'),1500)"],
        timeoutMs: 8000,
      }),
      node("wait3", "并发任务 C (3s)", "task", 900, 420, {
        command: "node",
        args: ["-e", "setTimeout(()=>console.log('C done'),3000)"],
        timeoutMs: 8000,
      }),
      node("flaky", "故障注入(70%失败,重试2)", "fault", 620, 200, { failRate: 0.7, sleepMs: 300, retries: 2 }),
    ],
    edges: [
      { id: "e1", source: "gen", target: "check", branchLabel: "then" },
      { id: "e2", source: "check", target: "yes", branchLabel: "true" },
      { id: "e3", source: "check", target: "no", branchLabel: "false" },
      { id: "e4", source: "gen", target: "wait1", branchLabel: "then" },
      { id: "e5", source: "wait1", target: "wait2", branchLabel: "then" },
      { id: "e6", source: "wait2", target: "wait3", branchLabel: "then" },
      { id: "e7", source: "gen", target: "flaky", branchLabel: "then" },
    ],
  };
}

export function seedDemo(store: Store) {
  if (!store.loadWorkflow(DEMO_ID)) store.saveWorkflow(demoWorkflow());
}

import { spawn } from "node:child_process";
import { platform } from "node:os";
import { evaluateExpression } from "../shared/dag.ts";
import type { WorkflowDef, WorkflowNodeDef } from "../shared/types.ts";

export interface ExecResult {
  success: boolean;
  output: string;
  error?: string;
  branchTaken?: "true" | "false";
  pid: number;
}

const isWin = platform() === "win32";

/** Resolve upstream outputs that feed this node into a single stdin payload. */
export function buildInput(def: WorkflowDef, node: WorkflowNodeDef, upstreamOutput: Map<string, string | null>): string {
  const preds = def.edges.filter((e) => e.target === node.id);
  const parts: string[] = [];
  for (const e of preds) {
    if (e.branchLabel && e.branchLabel !== "then") {
      // only the taken branch feeds input
    }
    const out = upstreamOutput.get(e.source);
    if (out != null) parts.push(out.trim());
  }
  return parts.join("\n");
}

export interface RunNodeArgs {
  node: WorkflowNodeDef;
  input: string;
  onSpawn: (pid: number) => void;
  isCancelled: () => boolean;
}

export function runNode({ node, input, onSpawn, isCancelled }: RunNodeArgs): Promise<ExecResult> {
  if (node.kind === "condition") return Promise.resolve(runCondition(node, input));
  if (node.kind === "fault") return Promise.resolve(runFault(node)).then((r) => ({ ...r, pid: -1 }));
  return runProcess(node, input, onSpawn, isCancelled);
}

function runCondition(node: WorkflowNodeDef, input: string): ExecResult {
  const value = (input.split(/\r?\n/).find(Boolean) ?? "").trim();
  const ok = evaluateExpression(node.config.expression ?? "$input", value);
  return {
    success: true,
    output: String(ok),
    branchTaken: ok ? "true" : "false",
    pid: -1,
  };
}

async function runFault(node: WorkflowNodeDef): Promise<Omit<ExecResult, "pid">> {
  const rate = node.config.failRate ?? 1;
  const sleep = node.config.sleepMs ?? 0;
  if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));
  const fail = Math.random() < rate;
  return fail
    ? { success: false, output: "", error: `故障注入：按概率 ${rate} 主动失败` }
    : { success: true, output: `fault-node ok (rate=${rate})` };
}

function runProcess(
  node: WorkflowNodeDef,
  input: string,
  onSpawn: (pid: number) => void,
  isCancelled: () => boolean
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const command = node.config.command ?? "";
    const args = node.config.args ?? [];
    const timeoutMs = node.config.timeoutMs ?? 60_000;
    let settled = false;
    let stdout = "";
    let stderr = "";

    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    onSpawn(child.pid!);

    const timer = setTimeout(() => {
      if (settled) return;
      killTree(child.pid!);
      finish({ success: false, output: stdout, error: `超时 ${timeoutMs}ms，已终止子进程`, pid: child.pid! });
    }, timeoutMs);
    timer.unref?.();

    const cancelPoll = setInterval(() => {
      if (isCancelled()) {
        killTree(child.pid!);
        finish({ success: false, output: stdout, error: "运行已取消，子进程被终止", pid: child.pid! });
      }
    }, 200);
    cancelPoll.unref?.();

    const finish = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelPoll);
      resolve(r);
    };

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => finish({ success: false, output: stdout, error: err.message, pid: child.pid ?? -1 }));
    child.on("close", (code, signal) => {
      if (code === 0) finish({ success: true, output: stdout.trimEnd(), pid: child.pid! });
      else
        finish({
          success: false,
          output: stdout.trimEnd(),
          error: `退出码 ${code}${signal ? ` 信号 ${signal}` : ""}${stderr ? `\n${stderr.trimEnd()}` : ""}`,
          pid: child.pid!,
        });
    });

    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function killTree(pid: number) {
  try {
    if (isWin) {
      spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { windowsHide: true, stdio: "ignore" });
    } else {
      try {
        process.kill(-pid);
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    /* already dead */
  }
}

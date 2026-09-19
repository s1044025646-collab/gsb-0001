import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import isWin from "../shared/platform";

function childEnv(): NodeJS.ProcessEnv {
  if (!isWin) return process.env;
  const join = (a?: string, b?: string) =>
    [a, b].filter(Boolean).join(";").replace(/;+/g, ";");
  return {
    ...process.env,
    PATH: join(
      process.env.PATH,
      join(
        (process.env.SystemRoot ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot};` : "") +
          "C:\\Program Files\\nodejs",
        undefined
      )
    ),
  };
}

export interface ExecOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ChildHandle {
  pid: number;
  kill(signal?: NodeJS.Signals): void;
}

export function runCommand(
  command: string,
  inputJson: string,
  timeoutMs: number,
  onStart: (child: ChildHandle) => void,
  signal?: { cancelled: boolean }
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    let tmpFile: string | undefined;
    let file: string;
    let args: string[];
    if (command.startsWith("nodejs:")) {
      // first-class JS execution: write to a temp file, spawn node directly (no shell quoting issues)
      tmpFile = path.join(os.tmpdir(), `wf-node-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
      fs.writeFileSync(tmpFile, command.slice("nodejs:".length), "utf8");
      file = process.execPath;
      args = [tmpFile];
    } else {
      file = isWin ? "cmd.exe" : "/bin/sh";
      args = isWin ? ["/s", "/c", command] : ["-c", command];
    }
    const child = spawn(file, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: childEnv(),
    });
    onStart({ pid: child.pid!, kill: (sig) => child.kill(sig) });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer: NodeJS.Timeout = setTimeout(() => {
      timedOut = true;
      killTree(child.pid!);
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ code: null, signal: null, stdout, stderr: stderr + String(err), timedOut });
      }
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      if (tmpFile) fs.rm(tmpFile, { force: true }, () => {});
      if (!settled) {
        settled = true;
        resolve({ code, signal: sig, stdout, stderr, timedOut });
      }
    });

    child.stdin.end(inputJson);

    const cancelPoll: NodeJS.Timeout | null = signal
      ? setInterval(() => {
          if (signal.cancelled) {
            if (cancelPoll) clearInterval(cancelPoll);
            killTree(child.pid!);
          }
        }, 100)
      : null;
    child.on("close", () => cancelPoll && clearInterval(cancelPoll));
  });
}

function killTree(pid: number) {
  try {
    if (isWin) {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, env: childEnv() });
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

/** Parse command stdout: prefer a trailing JSON line, fall back to trimmed text. */
export function parseResult(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("{") || line.startsWith("[")) {
      try {
        return JSON.parse(line);
      } catch {
        /* try earlier line */
      }
    }
  }
  return trimmed;
}


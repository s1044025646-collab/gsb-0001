import { spawn } from "node:child_process";
import { platform } from "node:os";

const isWin = platform() === "win32";

/** Best-effort check whether a pid is alive. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM";
  }
}

export function killTree(pid: number) {
  try {
    if (isWin) {
      spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { windowsHide: true, stdio: "ignore" });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    /* already dead */
  }
}

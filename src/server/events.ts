import type { Response } from "express";

type Listener = (event: unknown) => void;
const listeners = new Set<Listener>();

export function emit(event: unknown) {
  for (const l of listeners) {
    try {
      l(event);
    } catch {
      /* ignore */
    }
  }
}

export function addSseClient(res: Response) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();
  res.write(`retry: 1000\n\n`);
  const listener: Listener = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  listeners.add(listener);
  res.on("close", () => listeners.delete(listener));
}

export function runEvent(runId: string, type: string, extra: Record<string, unknown> = {}) {
  return { type, runId, ts: Date.now(), ...extra };
}

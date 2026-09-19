import type { SseEvent } from "../shared/types.ts";

type Listener = (e: SseEvent) => void;
const listeners = new Set<Listener>();

export function publish(e: SseEvent) {
  for (const l of listeners) {
    try {
      l(e);
    } catch {
      /* listener error ignored */
    }
  }
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}


// In-process lock so embedded workers sharing one SQLite connection never issue
// nested BEGIN statements (node:sqlite transactions are per-connection).
// Across separate OS processes, SQLite's own BEGIN IMMEDIATE write lock provides
// the mutual exclusion.
let chain: Promise<unknown> = Promise.resolve();

export function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = chain.then(() => fn(), () => fn());
  // keep the chain alive even if this caller rejects
  chain = next.catch(() => {});
  return next;
}

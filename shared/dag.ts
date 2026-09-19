import type { WorkflowDef, WorkflowEdgeDef } from "./types.ts";

export interface ValidationError {
  message: string;
  cycle?: string[];
}

export function adjacency(def: WorkflowDef): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const n of def.nodes) map.set(n.id, []);
  for (const e of def.edges) {
    if (!map.has(e.source) || !map.has(e.target)) continue;
    map.get(e.source)!.push(e.target);
  }
  return map;
}

/** Detect a directed cycle; returns node ids forming the cycle or null. */
export function detectCycle(def: WorkflowDef): string[] | null {
  const adj = adjacency(def);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const dfs = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const next of adj.get(id) ?? []) {
      const s = state.get(next) ?? 0;
      if (s === 0) {
        const found = dfs(next);
        if (found) return found;
      } else if (s === 1) {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };

  for (const id of adj.keys()) {
    if ((state.get(id) ?? 0) === 0) {
      const found = dfs(id);
      if (found) return found;
    }
  }
  return null;
}

export function validateDag(def: WorkflowDef): ValidationError[] {
  const errors: ValidationError[] = [];
  const ids = new Set(def.nodes.map((n) => n.id));
  if (def.nodes.length === 0) errors.push({ message: "工作流没有节点" });
  for (const e of def.edges) {
    if (!ids.has(e.source) || !ids.has(e.target))
      errors.push({ message: `边 ${e.id} 引用了不存在的节点` });
  }
  const cycle = detectCycle(def);
  if (cycle) errors.push({ message: `检测到循环依赖: ${cycle.join(" -> ")}`, cycle });
  const indeg = new Map<string, number>(def.nodes.map((n) => [n.id, 0]));
  for (const e of def.edges)
    if (ids.has(e.source) && ids.has(e.target))
      indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const roots = def.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0);
  if (roots.length === 0 && def.nodes.length > 0)
    errors.push({ message: "没有无入边的起始节点" });
  return errors;
}

export function upstreamEdges(def: WorkflowDef): Map<string, WorkflowEdgeDef[]> {
  const map = new Map<string, WorkflowEdgeDef[]>();
  for (const n of def.nodes) map.set(n.id, []);
  for (const e of def.edges) (map.get(e.target) ?? []).push(e);
  return map;
}

export function downstreamEdges(def: WorkflowDef): Map<string, WorkflowEdgeDef[]> {
  const map = new Map<string, WorkflowEdgeDef[]>();
  for (const n of def.nodes) map.set(n.id, []);
  for (const e of def.edges) (map.get(e.source) ?? []).push(e);
  return map;
}

/** Minimal safe expression evaluator: one comparison using == != > < >= <=. */
export function evaluateExpression(expr: string, value: string): boolean {
  const v = expr.trim();
  const op = ["==", "!=", ">=", "<=", ">", "<"].find((o) => v.includes(o));
  if (!op) {
    if (v === "$input" || v === "input") return value.trim() !== "" && value.trim() !== "0";
    return v === "true";
  }
  const [rawLeft, ...rest] = v.split(op);
  const rawRight = rest.join(op);
  const clean = (s: string) => s.trim().replace(/^["'`]|["'`]$/g, "");
  const resolve = (s: string) => (s === "$input" || s === "input" ? value : s);
  const lhs = resolve(clean(rawLeft));
  const rhs = resolve(clean(rawRight));
  if (op === "==") return lhs === rhs;
  if (op === "!=") return lhs !== rhs;
  const ln = Number(lhs);
  const rn = Number(rhs);
  if (!Number.isFinite(ln) || !Number.isFinite(rn)) return false;
  if (op === ">") return ln > rn;
  if (op === "<") return ln < rn;
  if (op === ">=") return ln >= rn;
  return ln <= rn;
}

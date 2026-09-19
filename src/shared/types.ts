export type NodeKind = "task" | "condition" | "start" | "end";
export type NodeRunState =
  | "pending"
  | "ready"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";
export type RunState = "running" | "paused" | "succeeded" | "failed" | "cancelled";

export interface WorkflowNodeDef {
  id: string;
  kind: NodeKind;
  label: string;
  /** command run as a real subprocess for kind === "task" */
  command?: string;
  /** expression evaluated for kind === "condition", e.g. $x > 3 */
  expression?: string;
  timeoutMs?: number;
  retries?: number;
  /** UI position */
  x?: number;
  y?: number;
}

export interface WorkflowEdgeDef {
  id: string;
  source: string;
  target: string;
  /** condition edges fire only when this ("true"/"false") matches branch result */
  branch?: "true" | "false";
}

export interface WorkflowDef {
  nodes: WorkflowNodeDef[];
  edges: WorkflowEdgeDef[];
}

export interface SubmitOptions {
 idempotencyKey?: string;
  /** initial input payload available to the start node */
  input?: unknown;
}

export interface RunSummary {
  id: string;
  idempotency_key: string | null;
  state: RunState;
  created_at: number;
  updated_at: number;
  graph: WorkflowDef;
  input: unknown;
  error: string | null;
}

export interface NodeRunView {
  id: number;
  run_id: string;
  node_id: string;
  state: NodeRunState;
  attempt: number;
  result: unknown;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
  worker_id: string | null;
}

export interface LogLine {
  id: number;
  run_id: string;
  node_id: string | null;
  level: "info" | "error";
  message: string;
  ts: number;
}

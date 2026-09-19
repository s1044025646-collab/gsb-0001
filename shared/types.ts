export type NodeKind = "task" | "condition" | "fault";

export interface WorkflowNodeDef {
  id: string;
  kind: NodeKind;
  label: string;
  position: { x: number; y: number };
  config: NodeConfig;
}

export interface NodeConfig {
  command?: string;
  args?: string[];
  timeoutMs?: number;
  retries?: number;
  expression?: string;
  failRate?: number;
  sleepMs?: number;
}

export interface WorkflowEdgeDef {
  id: string;
  source: string;
  target: string;
  branchLabel?: "true" | "false" | "then";
}

export interface WorkflowDef {
  id: string;
  name: string;
  nodes: WorkflowNodeDef[];
  edges: WorkflowEdgeDef[];
}

export type NodeStatus =
  | "pending"
  | "ready"
  | "claimed"
  | "running"
  | "success"
  | "failed"
  | "skipped"
  | "cancelled";

export type RunStatus = "running" | "paused" | "completed" | "failed" | "cancelled";

export interface ExecRecord {
  id: number;
  run_id: string;
  node_id: string;
  status: NodeStatus;
  attempt: number;
  input: string | null;
  output: string | null;
  error: string | null;
  claimed_by: string | null;
  lease_expires: number | null;
  started_at: number | null;
  finished_at: number | null;
}

export interface SseEvent {
  type: "run" | "node" | "log";
  runId?: string;
  data: unknown;
}

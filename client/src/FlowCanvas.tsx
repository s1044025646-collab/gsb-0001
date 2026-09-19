import { useCallback, useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { NodeStatus, WorkflowDef, WorkflowNodeDef } from "../../shared/types.ts";

const STATUS_COLORS: Record<NodeStatus, string> = {
  pending: "#94a3b8",
  ready: "#facc15",
  claimed: "#60a5fa",
  running: "#3b82f6",
  success: "#22c55e",
  failed: "#ef4444",
  skipped: "#cbd5e1",
  cancelled: "#a8a29e",
};

const KIND_LABEL: Record<string, string> = {
  task: "任务",
  condition: "条件",
  fault: "故障注入",
};

export interface RuntimeNode {
  status: NodeStatus;
  attempt?: number;
  branchTaken?: string | null;
}

function FlowNode({ data }: NodeProps) {
  const d = data as any;
  const color = STATUS_COLORS[d.status as NodeStatus] ?? STATUS_COLORS.pending;
  const isCond = d.kind === "condition";
  return (
    <div className={`flow-node ${isCond ? "cond" : ""}`} style={{ borderColor: color }}>
      <Handle type="target" position={Position.Left} />
      <div className="fn-head">
        <span className="fn-kind">{KIND_LABEL[d.kind as string]}</span>
        <span className="fn-status" style={{ background: color }}>
          {d.status}
          {d.attempt ? ` #${d.attempt}` : ""}
        </span>
      </div>
      <div className="fn-label">{d.label}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { flow: FlowNode };

interface Props {
  def: WorkflowDef;
  runtime: Record<string, RuntimeNode>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (def: WorkflowDef) => void;
}

export function FlowCanvas({ def, runtime, selectedId, onSelect, onChange }: Props) {
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const nodes: Node[] = useMemo(
    () =>
      def.nodes.map((n) => ({
        id: n.id,
        type: "flow",
        position: n.position,
        data: {
          label: n.label,
          kind: n.kind,
          status: runtime[n.id]?.status ?? "pending",
          attempt: runtime[n.id]?.attempt,
        },
        selected: n.id === selectedId,
      })),
    [def.nodes, runtime, selectedId]
  );

  const edges: Edge[] = useMemo(
    () =>
      def.edges.map((e) => {
        const taken =
          e.branchLabel && e.branchLabel !== "then"
            ? runtime[e.source]?.branchTaken === e.branchLabel
            : false;
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.branchLabel === "then" ? undefined : e.branchLabel,
          animated: runtime[e.target]?.status === "running",
          style: { stroke: taken ? "#22c55e" : e.branchLabel === "false" ? "#cbd5e1" : "#64748b", strokeWidth: taken ? 2 : 1 },
        };
      }),
    [def, runtime]
  );

  // keep external state synced when def/runtime props change
  useMemo(() => {
    setRfNodes(nodes);
    setRfEdges(edges);
  }, [nodes, edges, setRfNodes, setRfEdges]);

  const onConnect = useCallback(
    (c: Connection) => {
      const source = def.nodes.find((n) => n.id === c.source);
      const branchLabel = source?.kind === "condition" ? "true" : "then";
      const newEdge = {
        id: `edge-${Date.now()}`,
        source: c.source!,
        target: c.target!,
        branchLabel,
      } as any;
      onChange({ ...def, edges: addEdge(newEdge, def.edges as any) as any });
    },
    [def, onChange]
  );

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      onChange({
        ...def,
        nodes: def.nodes.map((n) =>
          n.id === node.id ? { ...n, position: { x: node.position.x, y: node.position.y } } : n
        ),
      });
    },
    [def, onChange]
  );

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeDragStop={onNodeDragStop}
      onNodeClick={(_, n) => onSelect(n.id)}
      fitView
      deleteKeyCode={["Delete", "Backspace"]}
      onNodesDelete={(deleted) => {
        const ids = new Set(deleted.map((d) => d.id));
        onChange({
          ...def,
          nodes: def.nodes.filter((n) => !ids.has(n.id)),
          edges: def.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target)),
        });
      }}
      onEdgesDelete={(deleted) => {
        const ids = new Set(deleted.map((d) => d.id));
        onChange({ ...def, edges: def.edges.filter((e) => !ids.has(e.id)) });
      }}
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
}

export function addNode(def: WorkflowDef, kind: WorkflowNodeDef["kind"]): WorkflowDef {
  const id = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
  const n: WorkflowNodeDef = {
    id,
    kind,
    label: kind === "condition" ? "新条件" : kind === "fault" ? "故障注入" : "新任务",
    position: { x: 120 + Math.random() * 200, y: 120 + Math.random() * 160 },
    config:
      kind === "condition"
        ? { expression: "$input > 0" }
        : kind === "fault"
        ? { failRate: 1, sleepMs: 0, retries: 0 }
        : { command: "node", args: ["-e", "console.log('hi')"], timeoutMs: 10000, retries: 0 },
  };
  return { ...def, nodes: [...def.nodes, n] };
}

import { useCallback, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Node,
  type Edge,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { WorkflowDef, NodeRunState } from "../shared/types";

interface Props {
  graph: WorkflowDef;
  nodeStates: Record<string, { state: NodeRunState; attempt: number }>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (graph: WorkflowDef) => void;
  readOnly: boolean;
}

function buildFlowNodes(
  graph: WorkflowDef,
  nodeStates: Props["nodeStates"],
  selectedId: string | null
): Node[] {
  return graph.nodes.map((n) => {
    const st = nodeStates[n.id]?.state ?? "pending";
    return {
      id: n.id,
      position: { x: n.x ?? 100, y: n.y ?? 100 },
      data: { label: n.label || n.id, kind: n.kind, state: st, attempt: nodeStates[n.id]?.attempt ?? 0 },
      selected: n.id === selectedId,
      className: `rf-node kind-${n.kind} ns-${st}`,
      style: { opacity: st === "skipped" || st === "cancelled" ? 0.45 : 1 },
    };
  });
}

function buildFlowEdges(graph: WorkflowDef): Edge[] {
  return graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.branch,
    animated: true,
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: e.branch === "false" ? "#9ca3af" : e.branch === "true" ? "#d97706" : "#6b7280" },
  }));
}

export default function GraphCanvas({ graph, nodeStates, selectedId, onSelect, onChange, readOnly }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState(buildFlowNodes(graph, nodeStates, selectedId));
  const [edges, setEdges, onEdgesChange] = useEdgesState(buildFlowEdges(graph));

  useEffect(() => {
    setNodes(buildFlowNodes(graph, nodeStates, selectedId));
    setEdges(buildFlowEdges(graph));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, nodeStates, selectedId]);

  const persist = useCallback(
    (nextNodes: Node[], nextEdges: Edge[]) => {
      onChange({
        nodes: nextNodes.map((n) => {
          const def = graph.nodes.find((d) => d.id === n.id)!;
          return { ...def, x: n.position.x, y: n.position.y };
        }),
        edges: nextEdges.map((e) => {
          const def = graph.edges.find((d) => d.id === e.id);
          const sourceKind = graph.nodes.find((n) => n.id === e.source)?.kind;
          return {
            id: e.id,
            source: e.source,
            target: e.target,
            ...(sourceKind === "condition" ? { branch: (def?.branch as "true" | "false") ?? "true" } : {}),
          };
        }),
      });
    },
    [graph, onChange]
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (readOnly) return;
      const sourceKind = graph.nodes.find((n) => n.id === conn.source)?.kind;
      const withNew = addEdge(
        {
          ...conn,
          id: `e-${conn.source}-${conn.target}-${Math.random().toString(36).slice(2, 6)}`,
          label: sourceKind === "condition" ? "true" : undefined,
        },
        edges
      );
      setEdges(withNew);
      persist(nodes, withNew);
    },
    [readOnly, graph, edges, nodes, setEdges, persist]
  );

  const onNodeDragStop = useCallback(
    (_: unknown, n: Node) => {
      const next = nodes.map((x) => (x.id === n.id ? n : x));
      setNodes(next);
      persist(next, edges);
    },
    [nodes, edges, setNodes, persist]
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={{}}
      onNodesChange={(changes) => {
        if (!readOnly) onNodesChange(changes);
      }}
      onEdgesChange={readOnly ? undefined : onEdgesChange}
      onConnect={onConnect}
      onNodeDragStop={onNodeDragStop}
      onNodeClick={(_, n) => onSelect(n.id)}
      onPaneClick={() => onSelect(null)}
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      fitView
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
}

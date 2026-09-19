import type { WorkflowDef, WorkflowNodeDef, WorkflowEdgeDef } from "../shared/types";

export class GraphError extends Error {}

export interface CompiledGraph {
  def: WorkflowDef;
  node: Map<string, WorkflowNodeDef>;
  outgoing: Map<string, WorkflowEdgeDef[]>;
  incoming: Map<string, WorkflowEdgeDef[]>;
  startNodes: string[];
}

export function validateAndCompile(def: WorkflowDef): CompiledGraph {
  if (!def || !Array.isArray(def.nodes) || !Array.isArray(def.edges)) {
    throw new GraphError("workflow must have nodes and edges arrays");
  }
  const node = new Map<string, WorkflowNodeDef>();
  for (const n of def.nodes) {
    if (!n.id) throw new GraphError("node missing id");
    if (node.has(n.id)) throw new GraphError(`duplicate node id: ${n.id}`);
    node.set(n.id, n);
  }
  if (node.size === 0) throw new GraphError("workflow has no nodes");

  const outgoing = new Map<string, WorkflowEdgeDef[]>();
  const incoming = new Map<string, WorkflowEdgeDef[]>();
  for (const n of def.nodes) {
    outgoing.set(n.id, []);
    incoming.set(n.id, []);
  }
  for (const e of def.edges) {
    if (!node.has(e.source) || !node.has(e.target)) {
      throw new GraphError(`edge ${e.id} references missing node`);
    }
    if (e.source === e.target) throw new GraphError(`self loop on node ${e.source}`);
    outgoing.get(e.source)!.push(e);
    incoming.get(e.target)!.push(e);
    const src = node.get(e.source)!;
    if (src.kind === "condition" && e.branch !== "true" && e.branch !== "false") {
      throw new GraphError(`condition node ${e.source} edges must declare branch true/false`);
    }
  }

  // Iterative DFS cycle detection (white / gray / black)
  const color = new Map<string, 0 | 1 | 2>();
  for (const id of node.keys()) color.set(id, 0);
  for (const root of node.keys()) {
    if (color.get(root) !== 0) continue;
    const stack: Array<{ id: string; idx: number }> = [{ id: root, idx: 0 }];
    color.set(root, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const next = outgoing.get(frame.id)![frame.idx++];
      if (!next) {
        color.set(frame.id, 2);
        stack.pop();
      } else if (color.get(next.target) === 1) {
        throw new GraphError(`cycle detected involving edge ${next.source} -> ${next.target}`);
      } else if (color.get(next.target) === 0) {
        color.set(next.target, 1);
        stack.push({ id: next.target, idx: 0 });
      }
    }
  }

  const startNodes = def.nodes.filter((n) => n.kind === "start").map((n) => n.id);
  if (startNodes.length === 0) {
    // fall back to nodes with no incoming edges
    for (const n of def.nodes) if (incoming.get(n.id)!.length === 0) startNodes.push(n.id);
  }
  return { def, node, outgoing, incoming, startNodes };
}

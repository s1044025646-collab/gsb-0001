import { useCallback, useEffect, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import GraphCanvas from "./GraphCanvas";
import type {
  WorkflowDef,
  WorkflowNodeDef,
  RunSummary,
  NodeRunState,
  NodeRunView,
  LogLine,
} from "../shared/types";
import { demoGraph } from "./demoGraph";

type Tab = "logs" | "nodes" | "history";

interface NodeStateInfo {
  state: NodeRunState;
  attempt: number;
  result?: unknown;
  error?: string | null;
}

const demoTaskCmd =
  "nodejs:let b='';\nprocess.stdin.on('data',d=>b+=d).on('end',()=>{const p=JSON.parse(b||'{}');process.stdout.write(JSON.stringify({echo:p.input}))});";

export default function App() {
  const [graph, setGraph] = useState<WorkflowDef>(() => {
    const saved = localStorage.getItem("wf-graph");
    return saved ? (JSON.parse(saved) as WorkflowDef) : demoGraph;
  });
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [nodeStates, setNodeStates] = useState<Record<string, NodeStateInfo>>({});
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [tab, setTab] = useState<Tab>("logs");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [runInput, setRunInput] = useState('{"v":4}');
  const [workerInfo, setWorkerInfo] = useState("");

  const currentRun = runs.find((r) => r.id === currentRunId) ?? null;
  const readOnly = currentRun != null;

  useEffect(() => localStorage.setItem("wf-graph", JSON.stringify(graph)), [graph]);

  const refreshRun = useCallback(async (runId: string) => {
    const [nodesRes, logsRes] = await Promise.all([
      fetch(`/api/runs/${runId}/nodes`).then((r) => r.json()),
      fetch(`/api/runs/${runId}/logs`).then((r) => r.json()),
    ]);
    const map: Record<string, NodeStateInfo> = {};
    for (const n of nodesRes as NodeRunView[]) {
      map[n.node_id] = {
        state: n.state,
        attempt: n.attempt,
        result: n.result == null ? null : JSON.parse(String(n.result)),
        error: n.error,
      };
    }
    setNodeStates(map);
    setLogs(logsRes);
  }, []);

  const loadRuns = useCallback(async () => {
    setRuns((await fetch("/api/runs").then((r) => r.json())) as RunSummary[]);
  }, []);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) => setWorkerInfo(`worker ${h.worker} · 配额 ${h.quota}`));
    loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    const es = new EventSource("/events");
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data);
      if (currentRunId && e.runId === currentRunId) {
        if (e.type === "node-state") {
          setNodeStates((prev) => ({
            ...prev,
            [e.nodeId]: { ...(prev[e.nodeId] ?? { attempt: 0 }), state: e.state },
          }));
          setTimeout(() => refreshRun(currentRunId), 300);
        } else if (e.type === "log") {
          setLogs((prev) => [
            ...prev,
            {
              id: Date.now() + Math.random(),
              run_id: e.runId,
              node_id: e.nodeId,
              level: e.level,
              message: e.message,
              ts: e.ts,
            },
          ]);
        } else if (e.type === "run-state") {
          loadRuns();
        }
      } else if (e.type === "run-created") {
        loadRuns();
      }
    };
    return () => es.close();
  }, [currentRunId, refreshRun, loadRuns]);

  useEffect(() => {
    if (currentRunId) refreshRun(currentRunId);
    else {
      setNodeStates({});
      setLogs([]);
    }
  }, [currentRunId, refreshRun]);

  const submit = async () => {
    let input: unknown = null;
    try {
      input = runInput.trim() ? JSON.parse(runInput) : null;
    } catch {
      alert("输入 JSON 不合法");
      return;
    }
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ graph, idempotencyKey: idempotencyKey || undefined, input }),
    });
    if (!res.ok) return alert((await res.json()).error);
    const run = (await res.json()) as RunSummary;
    setIdempotencyKey("");
    await loadRuns();
    setCurrentRunId(run.id);
    setTab("logs");
  };

  const control = async (action: "pause" | "resume" | "cancel") => {
    if (!currentRunId) return;
    await fetch(`/api/runs/${currentRunId}/${action}`, { method: "POST" });
    await loadRuns();
  };

  const addNode = (kind: WorkflowNodeDef["kind"]) => {
    const id = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    const node: WorkflowNodeDef = {
      id,
      kind,
      label: kind,
      x: 120 + Math.random() * 200,
      y: 120 + Math.random() * 160,
      ...(kind === "task" ? { command: demoTaskCmd, timeoutMs: 30000, retries: 0 } : {}),
      ...(kind === "condition" ? { expression: "$x > 0" } : {}),
    };
    setGraph({ ...graph, nodes: [...graph.nodes, node] });
    setSelectedId(id);
  };

  const updateSelected = (patch: Partial<WorkflowNodeDef>) => {
    if (!selectedId) return;
    setGraph({ ...graph, nodes: graph.nodes.map((n) => (n.id === selectedId ? { ...n, ...patch } : n)) });
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    setGraph({
      nodes: graph.nodes.filter((n) => n.id !== selectedId),
      edges: graph.edges.filter((e) => e.source !== selectedId && e.target !== selectedId),
    });
    setSelectedId(null);
  };

  const selectedNode = graph.nodes.find((n) => n.id === selectedId) ?? null;
  const shownGraph = readOnly && currentRun ? currentRun.graph : graph;

  return (
    <ReactFlowProvider>
      <div className="app">
        <div className="topbar">
          <h1>⚙ 本地工作流引擎</h1>
          <span style={{ color: "#9ca3af" }}>{workerInfo}</span>
          <span className="spacer" />
          {readOnly ? (
            <>
              <button onClick={() => control("pause")} disabled={currentRun?.state !== "running"}>暂停</button>
              <button onClick={() => control("resume")} disabled={currentRun?.state !== "paused"}>恢复</button>
              <button
                onClick={() => control("cancel")}
                disabled={["succeeded", "failed", "cancelled"].includes(currentRun?.state ?? "")}
              >
                取消
              </button>
              <button className="primary" onClick={() => setCurrentRunId(null)}>← 返回编辑器</button>
            </>
          ) : (
            <>
              <input style={{ width: 160 }} placeholder="幂等键（可选）" value={idempotencyKey} onChange={(e) => setIdempotencyKey(e.target.value)} />
              <input style={{ width: 120 }} placeholder='输入，如 {"v":4}' value={runInput} onChange={(e) => setRunInput(e.target.value)} />
              <button onClick={() => { setGraph(demoGraph); setSelectedId(null); }}>载入演示</button>
              <button className="primary" onClick={submit}>提交运行</button>
            </>
          )}
        </div>
        <div className="main">
          <div className="sidebar">
            {!readOnly ? (
              <>
                <h3 style={{ marginTop: 0 }}>添加节点（点击）</h3>
                <div className="palette-item" onClick={() => addNode("start")}>▶ 开始节点<br /><small>流程入口</small></div>
                <div className="palette-item" onClick={() => addNode("task")}>⚙ 任务节点<br /><small>执行真实子进程命令</small></div>
                <div className="palette-item" onClick={() => addNode("condition")}>◆ 条件节点<br /><small>表达式分支 true / false</small></div>
                <div className="palette-item" onClick={() => addNode("end")}>■ 结束节点</div>
                {selectedNode && (
                  <div className="panel">
                    <h3>节点属性</h3>
                    <label>名称</label>
                    <input value={selectedNode.label} onChange={(e) => updateSelected({ label: e.target.value })} />
                    {selectedNode.kind === "task" && (
                      <>
                        <label>命令（stdin 收到 {"{ input, upstream }"} JSON）</label>
                        <textarea rows={5} value={selectedNode.command ?? ""} onChange={(e) => updateSelected({ command: e.target.value })} />
                        <label>超时 (ms)</label>
                        <input type="number" value={selectedNode.timeoutMs ?? 30000} onChange={(e) => updateSelected({ timeoutMs: Number(e.target.value) })} />
                        <label>重试次数</label>
                        <input type="number" value={selectedNode.retries ?? 0} onChange={(e) => updateSelected({ retries: Number(e.target.value) })} />
                      </>
                    )}
                    {selectedNode.kind === "condition" && (
                      <>
                        <label>表达式（用 $字段 引用上游输出）</label>
                        <input value={selectedNode.expression ?? ""} onChange={(e) => updateSelected({ expression: e.target.value })} />
                      </>
                    )}
                    <button onClick={deleteSelected} style={{ background: "#dc2626", color: "#fff", border: 0, borderRadius: 6, padding: "6px 10px" }}>
                      删除节点
                    </button>
                  </div>
                )}
                <div className="panel">
                  <h3>连线说明</h3>
                  <p className="muted">从条件节点拉出的边默认是 true 分支；false 分支请在历史图 JSON 或演示图中设置 branch:false。</p>
                </div>
              </>
            ) : (
              <>
                <h3 style={{ marginTop: 0 }}>
                  运行 <span className={`badge state-${currentRun?.state}`}>{currentRun?.state}</span>
                </h3>
                <div className="kv">
                  <div>id: {currentRun?.id}</div>
                  <div>幂等键: {currentRun?.idempotency_key ?? "—"}</div>
                  <div>初始输入: {JSON.stringify(currentRun?.input)}</div>
                  {currentRun?.error && <div style={{ color: "#dc2626" }}>错误: {currentRun.error}</div>}
                </div>
              </>
            )}
          </div>
          <div className="canvas">
            <GraphCanvas
              graph={shownGraph}
              nodeStates={nodeStates}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onChange={setGraph}
              readOnly={readOnly}
            />
          </div>
          <div className="rightbar">
            <div className="tabs">
              <button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")}>实时日志</button>
              <button className={tab === "nodes" ? "active" : ""} onClick={() => setTab("nodes")}>节点状态</button>
              <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>历史执行</button>
            </div>
            <div className="tabbody">
              {tab === "logs" && <LogsView logs={logs} />}
              {tab === "nodes" && <NodesView graph={shownGraph} nodeStates={nodeStates} />}
              {tab === "history" && (
                <HistoryView runs={runs} currentRunId={currentRunId} onSelect={(id) => setCurrentRunId(id)} />
              )}
            </div>
          </div>
        </div>
      </div>
    </ReactFlowProvider>
  );
}

function LogsView({ logs }: { logs: LogLine[] }) {
  if (logs.length === 0) return <p className="muted">暂无日志</p>;
  return (
    <>
      {logs.map((l) => (
        <div key={l.id} className={`log ${l.level}`}>
          [{new Date(l.ts).toLocaleTimeString()}]{l.node_id ? ` (${l.node_id})` : ""} {l.message}
        </div>
      ))}
    </>
  );
}

function NodesView({ graph, nodeStates }: { graph: WorkflowDef; nodeStates: Record<string, NodeStateInfo> }) {
  return (
    <>
      {graph.nodes.map((n) => {
        const info = nodeStates[n.id];
        const state = info?.state ?? "pending";
        return (
          <div key={n.id} style={{ borderBottom: "1px solid #f3f4f6", padding: "6px 2px" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <strong>{n.label}</strong>
              <span className={`ns-${state}`}>{state}{info?.attempt ? ` x${info.attempt}` : ""}</span>
            </div>
            {info?.result != null && <div className="kv muted">结果: {JSON.stringify(info.result)}</div>}
            {info?.error && <div className="kv" style={{ color: "#dc2626" }}>{info.error}</div>}
          </div>
        );
      })}
    </>
  );
}

function HistoryView({
  runs,
  currentRunId,
  onSelect,
}: {
  runs: RunSummary[];
  currentRunId: string | null;
  onSelect: (id: string) => void;
}) {
  if (runs.length === 0) return <p className="muted">暂无历史执行</p>;
  return (
    <>
      {runs.map((r) => (
        <div
          key={r.id}
          className={`run-row ${r.id === currentRunId ? "selected" : ""}`}
          onClick={() => onSelect(r.id)}
        >
          <div>
            <div>{new Date(r.created_at).toLocaleString()}</div>
            <div className="muted">{r.id.slice(0, 8)} · {r.idempotency_key ?? "无幂等键"}</div>
          </div>
          <span className={`badge state-${r.state}`}>{r.state}</span>
        </div>
      ))}
    </>
  );
}




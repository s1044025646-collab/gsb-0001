import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NodeStatus, WorkflowDef } from "../../shared/types";
import { validateDag } from "../../shared/dag.ts";
import { api } from "./api.ts";
import { addNode, FlowCanvas, type RuntimeNode } from "./FlowCanvas.tsx";
import { Inspector } from "./Inspector.tsx";

const STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export function App() {
  const [def, setDef] = useState<WorkflowDef | null>(null);
  const [workflows, setWorkflows] = useState<{ id: string; name: string }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<any>(null);
  const [execs, setExecs] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [saveMsg, setSaveMsg] = useState<string>("");
  const [idemKey, setIdemKey] = useState("");
  const logEndRef = useRef<HTMLDivElement>(null);

  const refreshRuns = useCallback(() => api.runs().then(setRuns).catch(() => {}), []);

  useEffect(() => {
    api.workflows().then((ws) => {
      setWorkflows(ws);
      if (ws[0]) loadWorkflow(ws[0].id);
    });
    refreshRuns();
  }, [refreshRuns]);

  const loadWorkflow = async (id: string) => {
    const d = await api.workflow(id);
    setDef(d);
    setSelectedId(null);
    setRunId(null);
    setRun(null);
    setExecs([]);
    setLogs([]);
  };

  const loadRun = useCallback(async (id: string) => {
    const detail = await api.run(id);
    setRun(detail.run);
    setDef(detail.workflow);
    setExecs(detail.execs);
    setLogs(detail.logs);
    setRunId(id);
  }, []);

  // live updates: SSE triggers a targeted refresh; poll as a safety net
  useEffect(() => {
    if (!runId) return;
    const es = new EventSource("/api/events");
    es.onmessage = () => loadRun(runId);
    const poll = setInterval(() => loadRun(runId), 1500);
    return () => {
      es.close();
      clearInterval(poll);
    };
  }, [runId, loadRun]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const runtime = useMemo(() => {
    const map: Record<string, RuntimeNode> = {};
    for (const e of execs)
      map[e.node_id] = {
        status: e.status as NodeStatus,
        attempt: e.attempt,
        branchTaken: e.branch_taken,
      };
    return map;
  }, [execs]);

  const selectedExec = execs.find((e) => e.node_id === selectedId);
  const errors = def ? validateDag(def) : [];

  const save = async () => {
    if (!def) return;
    const errs = validateDag(def);
    if (errs.length) {
      setSaveMsg("无法保存：" + errs.map((e) => e.message).join("；"));
      return;
    }
    await api.saveWorkflow(def);
    setSaveMsg("已保存 ✓");
    refreshRuns();
    setTimeout(() => setSaveMsg(""), 2000);
  };

  const start = async () => {
    if (!def) return;
    await save();
    const { runId: id, duplicated } = await api.startRun(def.id, idemKey.trim() || undefined);
    setSaveMsg(duplicated ? "幂等命中：返回已有运行" : "已启动新运行");
    setIdemKey("");
    await loadRun(id);
    refreshRuns();
  };

  const control = async (action: "pause" | "resume" | "cancel") => {
    if (!runId) return;
    await api[action](runId);
    await loadRun(runId);
    refreshRuns();
  };

  if (!def) return <div className="loading">加载中…</div>;

  return (
    <div className="app">
      <header className="topbar">
        <strong>工作流引擎</strong>
        <select value={def.id} onChange={(e) => loadWorkflow(e.target.value)}>
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <div className="tb-group">
          <button onClick={() => setDef(addNode(def, "task"))}>+ 任务</button>
          <button onClick={() => setDef(addNode(def, "condition"))}>+ 条件</button>
          <button onClick={() => setDef(addNode(def, "fault"))}>+ 故障注入</button>
        </div>
        <button className="primary" onClick={save}>
          保存定义
        </button>
        <div className="tb-group">
          <input
            placeholder="幂等键(可选)"
            value={idemKey}
            onChange={(e) => setIdemKey(e.target.value)}
          />
          <button className="primary" onClick={start}>
            ▶ 启动
          </button>
          <button onClick={() => control("pause")} disabled={run?.status !== "running"}>
            暂停
          </button>
          <button onClick={() => control("resume")} disabled={run?.status !== "paused"}>
            恢复
          </button>
          <button className="danger" onClick={() => control("cancel")} disabled={!run || ["completed", "failed", "cancelled"].includes(run.status)}>
            取消
          </button>
        </div>
        <span className="save-msg">{saveMsg}</span>
      </header>

      {errors.length > 0 && (
        <div className="cycle-warn">⚠ {errors.map((e) => e.message).join("；")}</div>
      )}

      <div className="body">
        <div className="canvas-wrap">
          <FlowCanvas
            def={def}
            runtime={runtime}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onChange={setDef}
          />
        </div>
        <aside className="sidebar">
          {run && (
            <div className={`run-banner status-${run.status}`}>
              运行状态：{STATUS_LABEL[run.status] ?? run.status}
              <span className="run-id">{run.id.slice(0, 8)}</span>
            </div>
          )}
          <Inspector
            def={def}
            nodeId={selectedId}
            onChange={setDef}
            runtimeInfo={
              selectedExec
                ? {
                    status: selectedExec.status,
                    output: selectedExec.output,
                    error: selectedExec.error,
                    attempt: selectedExec.attempt,
                  }
                : undefined
            }
          />
          <div className="logs">
            <div className="panel-title">实时日志</div>
            <div className="log-list">
              {logs.map((l) => (
                <div key={l.id} className={`log-line ${l.level}`}>
                  <span className="log-ts">{new Date(l.ts).toLocaleTimeString()}</span>
                  {l.node_id && <span className="log-node">[{l.node_id}]</span>} {l.message}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
          <div className="history">
            <div className="panel-title">历史执行</div>
            <div className="hist-list">
              {runs.map((r) => (
                <button
                  key={r.id}
                  className={`hist-item status-${r.status} ${r.id === runId ? "active" : ""}`}
                  onClick={() => loadRun(r.id)}
                >
                  <span>{r.id.slice(0, 8)}</span>
                  <span>{STATUS_LABEL[r.status] ?? r.status}</span>
                  <span>{new Date(r.created_at).toLocaleTimeString()}</span>
                </button>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

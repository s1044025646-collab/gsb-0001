import type { WorkflowDef, WorkflowNodeDef } from "../../shared/types.ts";

interface Props {
  def: WorkflowDef;
  nodeId: string | null;
  runtimeInfo?: { status: string; output: string | null; error: string | null; attempt: number };
  onChange: (def: WorkflowDef) => void;
}

export function Inspector({ def, nodeId, runtimeInfo, onChange }: Props) {
  const node = def.nodes.find((n) => n.id === nodeId);
  if (!node) return <div className="inspector empty">选中一个节点以编辑配置</div>;

  const update = (patch: Partial<WorkflowNodeDef>) =>
    onChange({ ...def, nodes: def.nodes.map((n) => (n.id === node.id ? { ...n, ...patch } : n)) });
  const updateCfg = (patch: Partial<WorkflowNodeDef["config"]>) =>
    update({ config: { ...node.config, ...patch } });

  const outgoing = def.edges.filter((e) => e.source === node.id);

  return (
    <div className="inspector">
      <div className="in-row">
        <label>名称</label>
        <input value={node.label} onChange={(e) => update({ label: e.target.value })} />
      </div>
      <div className="in-row">
        <label>类型</label>
        <span className="badge">{node.kind}</span>
      </div>

      {node.kind === "task" && (
        <>
          <div className="in-row">
            <label>命令</label>
            <input
              value={node.config.command ?? ""}
              onChange={(e) => updateCfg({ command: e.target.value })}
            />
          </div>
          <div className="in-row">
            <label>参数(逗号)</label>
            <input
              value={(node.config.args ?? []).join(", ")}
              onChange={(e) =>
                updateCfg({
                  args: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </div>
          <div className="in-row">
            <label>超时(ms)</label>
            <input
              type="number"
              value={node.config.timeoutMs ?? 60000}
              onChange={(e) => updateCfg({ timeoutMs: Number(e.target.value) })}
            />
          </div>
          <div className="in-row">
            <label>重试次数</label>
            <input
              type="number"
              value={node.config.retries ?? 0}
              onChange={(e) => updateCfg({ retries: Number(e.target.value) })}
            />
          </div>
        </>
      )}

      {node.kind === "condition" && (
        <div className="in-row">
          <label>表达式</label>
          <input
            value={node.config.expression ?? ""}
            placeholder="$input > 3"
            onChange={(e) => updateCfg({ expression: e.target.value })}
          />
        </div>
      )}

      {node.kind === "fault" && (
        <>
          <div className="in-row">
            <label>失败概率(0-1)</label>
            <input
              type="number"
              step={0.1}
              value={node.config.failRate ?? 1}
              onChange={(e) => updateCfg({ failRate: Number(e.target.value) })}
            />
          </div>
          <div className="in-row">
            <label>耗时(ms)</label>
            <input
              type="number"
              value={node.config.sleepMs ?? 0}
              onChange={(e) => updateCfg({ sleepMs: Number(e.target.value) })}
            />
          </div>
          <div className="in-row">
            <label>重试次数</label>
            <input
              type="number"
              value={node.config.retries ?? 0}
              onChange={(e) => updateCfg({ retries: Number(e.target.value) })}
            />
          </div>
        </>
      )}

      {node.kind === "condition" && (
        <div className="branch-editor">
          <div className="be-title">出边分支（点击切换 true/false）</div>
          {outgoing.length === 0 && <div className="muted">暂无出边</div>}
          {outgoing.map((e) => (
            <button
              key={e.id}
              className={`branch-btn ${e.branchLabel}`}
              onClick={() =>
                onChange({
                  ...def,
                  edges: def.edges.map((x) =>
                    x.id === e.id
                      ? { ...x, branchLabel: x.branchLabel === "true" ? "false" : "true" }
                      : x
                  ),
                })
              }
            >
              → {def.nodes.find((n) => n.id === e.target)?.label ?? e.target} [{e.branchLabel}]
            </button>
          ))}
        </div>
      )}

      {runtimeInfo && (
        <div className="runtime-info">
          <div className="ri-title">最近执行（第 {runtimeInfo.attempt} 次）</div>
          <div>状态：{runtimeInfo.status}</div>
          {runtimeInfo.output != null && (
            <pre className="io">{runtimeInfo.output || "(空输出)"}</pre>
          )}
          {runtimeInfo.error && <pre className="io err">{runtimeInfo.error}</pre>}
        </div>
      )}
    </div>
  );
}

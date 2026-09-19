# 本地可视化工作流引擎

一个**完全运行在本机**、仅依赖 SQLite 的可视化 DAG 工作流引擎。
技术栈：TypeScript + Node.js（内置 `node:sqlite`，无需编译原生模块）+ React + React Flow + Express + SSE。

## 一键启动（Windows）

```cmd
start.cmd
```

脚本会自动安装依赖、构建前端并启动服务。启动后打开：

- **页面**：http://localhost:8787/
- **健康检查**：http://localhost:8787/api/health

开发模式（前端热更新，Vite 5173 代理到后端 8787）：

```cmd
start-dev.cmd
```

手动方式：

```cmd
npm install
npm run build     # 构建 React 页面到 dist/
npm start         # 启动 API + 托管静态页面（端口 8787）
```

## 在页面上能验证什么

1. 点击左侧“载入演示”，得到一个包含故障注入的 DAG：
   - `flaky`：前两次执行退出码 1，第 3 次成功 → 验证**超时/失败重试**。
   - `slow`：第一次执行超过 1200ms 超时被杀死，重试后快速成功 → 验证**超时杀进程 + 重试**。
   - `check`：条件表达式 `$v > 10`，只有 true 分支执行，false 分支 `branchB` 显示为 skipped。
   - `end`：在 `branchA` 与 `slow` 都成功后汇合（fan-out → join）。
2. 顶栏填入“幂等键”，重复点“提交运行”，只会得到**同一个 run**。
3. 运行中可点 **暂停 / 恢复 / 取消**：暂停后不再领取新节点；取消会杀死在跑的子进程。
4. 右侧三个标签页：**实时日志**（SSE 推送）、**节点状态**（含尝试次数与结果）、**历史执行**。
5. 画布支持拖拽节点、连线；条件节点拉出的边为 `true` 分支（橙），`false` 分支（灰）。
   选中任务节点可在左侧编辑命令、超时、重试次数。

### 节点命令约定

- 普通命令通过 shell 执行（Windows 用 `cmd /s /c`，Unix 用 `sh -c`）。
- 命令以 `nodejs:` 开头时，引擎把后面的 JS 写入临时文件并直接 `node 文件` 运行，避免 shell 引号问题。
- 每个子进程通过 **stdin 收到一行 JSON**：`{ "input": <提交时输入>, "upstream": { ...所有已成功节点的输出 } }`。
- 子进程 stdout 的最后一段 JSON（一行 `{...}` 或 `[...]`）作为该节点的结构化输出，供下游 `$字段` 或 `$节点id.字段` 引用。

## 持久化与多 worker

- 数据文件：`data/workflow.db`（WAL 模式）。表：`runs` / `node_runs` / `logs`。
- **不重复领取**：领取是单条原子 SQL（`UPDATE ... WHERE id=(SELECT ... state='ready') RETURNING`），
  配合 SQLite 写锁，多个 worker 进程同时抢同一节点只有一个成功。
- **租约**：运行中的节点周期性续约；崩溃或卡死的节点超过 `WF_STALE_MS` 会被重新置为 ready 给其他 worker。
- **幂等**：`runs.idempotency_key` 唯一约束，重复提交返回原 run。
- **崩溃恢复**：服务重启时，`Engine.recover()` 会：
  1. 找到所有 `claimed/running` 的遗留节点；
  2. 若记录的子进程 pid 仍存活（遗留孤儿进程），用 `taskkill /T /F`（Windows）或 `SIGKILL` 杀掉进程树；
  3. 将其重新排队为 `ready`，由新 worker 重新执行；
  4. **已成功节点的结果原样保留**，下游可直接使用。
- **并发配额**：`WF_QUOTA`（默认 2）限制单 worker 同时运行的子进程数；启动多个进程即多个 worker。

启动第二个 worker（同一 DB）：

```cmd
set WF_QUOTA=2
node --import tsx src/server/main.ts
```

### 关键环境变量

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `PORT` | 8787 | API/页面端口 |
| `WF_DB` | data/workflow.db | SQLite 文件路径 |
| `WF_QUOTA` | 2 | 单 worker 并发子进程上限 |
| `WF_TICK_MS` | 150 | 调度 tick 间隔 |
| `WF_LEASE_MS` | 15000 | 租约时长（运行中会自动续约） |
| `WF_STALE_MS` | 30000 | 超过该时长未续约视为僵尸，重新排队 |

## 自动化测试

```cmd
npm test
```

覆盖 16 个用例：

- `test/graph.test.ts`：DAG 校验、直接环/自环检测、悬空边、条件边必须标注分支；表达式求值与注入拦截。
- `test/engine.test.ts`：
  - 上游输出经 stdin 传递并逐级累加；
  - 幂等键重复提交；
  - **3 个并发 worker 抢同一批节点，每个节点恰好被领取一次（attempt=1）**；
  - 故障重试（前两次失败、第三次成功）；
  - 超时节点在重试耗尽后失败；
  - 暂停不领取、恢复继续；
  - 取消杀死在跑进程并标记 cancelled；
  - 条件分支只执行命中的分支。
- `test/crash.test.ts`：**强杀（SIGKILL）服务进程后重启**，断言：
  - 遗留的孤儿子进程被新实例清理；
  - 已完成节点 `a` 的结果 `{x:42}` 保留；
  - 中断的节点 `b` 被重新执行成功；
  - 下游 `c` 能读到 `a.x=42`，整个 run 最终成功。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/runs` | 提交 `{ graph, idempotencyKey?, input? }`，返回 run（400 = DAG 非法） |
| GET | `/api/runs` / `/api/runs/:id` | 历史 / 详情 |
| GET | `/api/runs/:id/nodes` | 各节点状态、尝试次数、结果、错误、worker |
| GET | `/api/runs/:id/logs?after=N` | 日志 |
| POST | `/api/runs/:id/pause` `/resume` `/cancel` | 运行控制 |
| GET | `/events` | SSE：节点状态、日志、run 状态实时推送 |

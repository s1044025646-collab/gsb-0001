# 本地可视化工作流引擎

纯本机运行的可视化 DAG 工作流引擎。TypeScript + Node.js + React，持久化仅使用 **SQLite（Node 内置 `node:sqlite`，零原生编译依赖）**，无任何外部服务。

## 能力一览

- **拖拽编辑 DAG**：React Flow 画布，可拖拽移动、连线、增删节点；保存时做 **循环依赖检测**（含成环节点提示）。
- **真实子进程执行**：每个任务节点用 `child_process.spawn` 运行真实命令；**上游节点 stdout 通过 stdin 传给下游**。
- **条件分支**：条件节点用安全的迷你表达式（`$input > 3`、`==`、`!=` 等）求值，只有命中的分支被执行，另一分支标记 `skipped`。
- **并发配额**：全局活跃任务数受配额限制；领取用 SQLite `BEGIN IMMEDIATE` 原子事务，**多个 worker 进程绝不重复领取**。
- **超时 / 重试**：节点可配置 `timeoutMs` 与 `retries`；超时会强杀整个进程树，失败在次数内自动重新入队。
- **暂停 / 取消**：暂停后不再领取新任务（在跑任务继续）；取消会终止未开始任务并 `taskkill /T`（Windows）杀进行中的子进程树。
- **执行状态持久化**：
  - 运行、节点执行、日志、子进程 PID 全部落 SQLite（WAL）。
  - **幂等键**：相同 `idempotencyKey` 重复提交返回同一个 run。
  - **崩溃恢复**：服务被强杀后重启，启动时清理遗留子进程、把在途节点（含租约未到期的）重新置为 `ready`，**已成功节点的结果保留不重跑**，流程继续走完。
- **实时界面**：SSE + 轮询双通道，节点状态颜色、日志流、历史执行列表。
- **故障注入**：内置 `fault` 节点，可配置失败概率 / 耗时 / 重试。

## 环境要求

- Node.js ≥ 22（建议 24/25，需要内置 `node:sqlite`）。本仓库在 Node v25 上验证。
- Windows（命令以 PowerShell 为例；子进程使用 `node -e` 做演示，跨平台可运行）。

## 一键启动

```powershell
npm install
npm start
```

`npm start` 会先构建 React 到 `dist/`，再启动服务（含 2 个内置 worker，全局并发配额 3）。
打开 <http://localhost:5174>。

数据文件位于 `data/workflow.db`（SQLite + WAL）。

### 可选：独立 worker 进程（验证多进程）

另开一个或多个终端，它们会与服务共用同一个 SQLite 文件：

```powershell
$env:WF_DB = "$PWD\data\workflow.db"; $env:WF_CONCURRENCY = "2"
npm run worker
```

### 开发模式（热更新）

```powershell
npm run dev:server   # 终端 1：API + worker，:5174
npm run dev:client   # 终端 2：Vite，:5173（已配置 /api 代理）
```

环境变量：`PORT`（默认 5174）、`WF_WORKERS`（内置 worker 数，默认 2）、`WF_CONCURRENCY`（全局配额，默认 3）、`WF_DB`。

## 在页面上验证

启动后自带“演示流水线”，点击 **▶ 启动**：

- `生成数值 5 → 判断 >3?`：命中 `true`，执行“大于3”，“不大于3”显示 `skipped`。
- 三个 `并发任务` 扇出，可观察受配额限制的并发。
- `故障注入(70%失败,重试2)`：通常重试到第 3 次成功；节点上显示 `success #3`。
- 顶部可填 **幂等键**，重复点启动会提示“幂等命中”。
- 运行中可点 **暂停 / 恢复 / 取消**；右侧实时日志、下方历史执行可点选回看任意一次运行。
- 拖一条边形成环（如把末尾节点连回起点）后保存，顶部出现“检测到循环依赖”。

## 演示脚本

```powershell
powershell -ExecutionPolicy Bypass -File scripts/smoke.ps1       # API 端到端 + 幂等
powershell -ExecutionPolicy Bypass -File scripts/crash-demo.ps1  # 强杀进程后的崩溃恢复
```

`crash-demo.ps1` 会：启动一个 20 秒的慢任务 → 任务运行中 **强杀服务进程**（模拟断电）→ 重启，观察遗留子进程被杀、在途节点重新排队、**最终 completed 且输出保留**。

## 自动化测试

```powershell
npm test
```

覆盖（共 11 个用例）：

- `test/dag.test.ts`：DAG 校验、**成环检测**、条件表达式。
- `test/engine.test.ts`：真实子进程与上下游 stdin/stdout、条件分支跳过、**幂等提交**、多 worker 并发恰好一次、取消杀进程、**崩溃恢复（保留结果/回收租约/清理遗留进程）**、重试上限与流程失败。
- `test/multiproc.test.ts`：拉起 **两个独立 OS 进程 worker** 共用一个 SQLite，断言 8 个节点全部恰好执行一次（跨进程竞争）。

## 架构

```
client/          React + @xyflow/react 画布（SSE 实时状态/日志/历史）
server/
  db.ts          node:sqlite 连接、WAL、建表迁移
  store.ts       SQL 编排：幂等提交、原子 claim（配额+互斥）、完成/重试、
                 分支传播、暂停/取消、租约回收
  executor.ts    子进程 spawn、stdin 接线、超时树杀、取消轮询、条件/故障节点
  worker.ts      轮询循环、进程内锁、recoverOrphans 崩溃恢复
  tx.ts          同连接事务互斥锁（跨进程由 SQLite IMMEDIATE 保证）
  api.ts         REST + SSE
  seed.ts        演示工作流
shared/          类型、DAG/环检测/表达式
test/            node:test 自动化测试
```

关键表：`runs`（幂等唯一键）、`node_execs`（状态/租约/尝试次数/输入输出，`(run_id,node_id)` 唯一）、`logs`、`spawned_processes`（PID 台账，用于崩溃清理）。

### 一致性说明

- **同机多进程**：每个进程独立连接，`claim` 使用 `BEGIN IMMEDIATE` 抢写锁，SQLite 串行化写事务，保证一行任务只被一个 worker 领取。
- **同进程多 worker**：共用一条连接，额外用内存互斥锁避免嵌套事务。
- **worker 假死**：租约 30 秒；重启时以 `spawned_processes` PID 台账为准清理进程树并把在途节点重新入队。

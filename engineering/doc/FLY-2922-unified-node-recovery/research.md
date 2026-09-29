# FLY-2922 房间 tmux 探活隔离 — 调研
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-28
基于: exploration.md

## 证据范围

本轮以 QA@3 失败描述、carrier PR #297、nested product PR #1374 的当前远端状态与 exact commit patch 为权威证据。carrier 起点为 `fa47a6ce6`；nested PR 在本轮调研时已前进到 `7d5d084cfc`，其中 main merge 为 `bbd36fde30`、harness 修复为 `5f182869af`。远端已经存在的实现只用于核对接口可行性和当前事实；设计节点不修改 nested product repository，也不把远端实现状态替代设计评审。

QA@3 的直接事实是：slot 4 generalized 真房通过 step 0–3，step 4 等待近两小时；实现 execution `08ed6083` 已是 `ship_parked`，当前 park 为 `rework_reachable_wait`，QA 已派发；pane `@5` 在房间 server 上存活。driver 从 CommDB 读到 `tmux_window` 后以宿主 env 调 `tmux display-message`，因此查询了错误 server，返回非零并把 liveness 投影为 dead。

## 房间 tmux 合同

`scripts/test-deploy.sh` 将 slot 根固定为 `/tmp/flywheel-test-slot-${SLOT}`，再通过 `qa_slot_env_contract_render "$SLOT_DIR" ...` 给房内 Bridge 注入环境。该合同把房间的 `TMUX_TMPDIR` 设为 slot 根；tmux 据此解析到该房间独立的 unix socket 命名空间。

宿主 Codex/Lead 自己也可能在 tmux 中运行，并带有另一组 `TMUX`、`TMUX_PANE` 和 `TMUX_TMPDIR`。删除 `TMUX` / `TMUX_PANE` 只能避免把命令当成当前 client 的子命令，不能选择正确 server；没有覆写 `TMUX_TMPDIR` 时，tmux 仍从宿主命名空间找 socket。

因此 probe 的最小完备环境转换是：

```text
host env
  - TMUX
  - TMUX_PANE
  + TMUX_TMPDIR = validated absolute slotDir
  -> tmux display-message -p -t <session:@window|session:%pane>
```

不需要自行拼接 `tmux-<uid>/default`，也不应修改 process-wide `process.env`。

## 现有探活与分类

`scripts/qa-529-generalized-e2e.mjs` 的 `probeExecution(slotDir, commDb, executionId)` 汇总两类证据：stub state 记录的 pid 是否存活，以及 CommDB 记录的 tmux target 是否存活。返回的 `liveness` 是 `pidAlive || tmuxAlive ? "alive" : "dead"`。

tmux target 解析与观测校验已经在 `scripts/lib/qa-generalized-e2e-lib.mjs`：

- `parseTmuxTargetIdentity` 只接受可选 session 前缀加 `@<digits>` 或 `%<digits>`；
- `tmuxObservationIsAlive` 校验 exact window/pane id、`pane_dead === "0"` 与 `@flywheel_exec_id === expectedExecutionId`。

step 4 的 `classifyImplementPark` 还要求：node state 为 done、session 为非终态 `ship_parked`、park open 且 reason 与 run-start lifecycle flag 匹配。default-off 的本轮路径要求 `rework_reachable_wait`、无 standby process body、liveness alive。换言之，修复 socket 选择不会把弱证据升级为通过；它只是让既有强校验看到正确 server 的事实。

同一 `probeExecution` 还被 step 2 design completion、step 9 actor retirement、A3 QA termination 和 prior-run drain 使用。它们此前也可能因错误 server 过早认定 dead。集中 helper 会恢复它们原本的「真实等待 pane 退出」语义，这是必要的一致性修复，不是扩大产品范围。

## 文件边界

建议修改：

- `scripts/lib/qa-generalized-e2e-lib.mjs`：新增并导出 room-scoped pane probe，保留现有 parser/observation predicate。
- `scripts/qa-529-generalized-e2e.mjs`：删除内联 tmux spawn；`probeExecution` 传入 `slotDir`、`process.env` 与 `spawnSync`。
- `scripts/__tests__/qa-generalized-e2e-lib.test.mjs`：纯注入单测 + real-tmux 隔离 socket 的 RED/GREEN + step-4 分类对照。
- `scripts/__tests__/test-deploy-generalized.test.sh`：结构守卫，证明 helper 写入 `TMUX_TMPDIR: slotDir` 且 driver 不直接 spawn tmux。
- `engineering/doc/milestones/FLY-2922.md`：记录 QA@3 根因、merge 取舍和定向证据。

禁止修改产品 `StateStore`、workflow engine、recovery coordinator、runner adapter、QA role、review coordinator 或证据裁判。本修复没有产品状态迁移或数据库 schema 变化。

## Main 同步与冲突

QA 交接时 product PR 头 `36b143b2a` 与 `origin/main` 在 `scripts/test-deploy.sh` 冲突。main 带入 FLY-2957 的 `--codex-source-home <prepared-dir>`，本单已有 `--stub-runner|--qa-stub-runner`。两者分别控制 Codex source-home fixture 与 QA-only Claude stub，解析和校验互相独立。

正确解法是 merge、不 rebase，并在 usage 注释同时列出两组参数；自动合并区继续保留双方各自 parser、validation 和 Bridge env 注入。不得为消冲突删除任一 flag，也不得让一个 flag 成为另一个 flag 的隐式前置条件。远端 merge `bbd36fde30` 的唯一文本冲突正是这行 usage，commit message 也记录了「keep both sides」。

## 测试发现与选择

按本地测试政策，implementation 在运行前必须以旧/新 literal 和 changed path 做发现：

```bash
git grep -lF -- 'paneAlive'
git grep -lF -- 'probeRoomPaneAlive'
git grep -lF -- 'tmuxObservationIsAlive'
git grep -lF -- 'TMUX_TMPDIR'
git grep -lF -- 'scripts/qa-529-generalized-e2e.mjs'
git grep -lF -- 'scripts/lib/qa-generalized-e2e-lib.mjs'
git grep -lF -- 'scripts/__tests__/qa-generalized-e2e-lib.test.mjs'
git grep -lF -- 'scripts/__tests__/test-deploy-generalized.test.sh'
```

必须保留的直接测试：

- `node --test scripts/__tests__/qa-generalized-e2e-lib.test.mjs`；
- `bash scripts/__tests__/test-deploy-generalized.test.sh`（`scripts/__tests__/*.test.sh` 必须逐文件运行）。

实现者应逐条记录发现结果中被排除的测试及理由。已知相近但不直接消费该 driver probe 的符号包括：房间 fixture 自写同名文件、产品侧 `paneAlive`、历史 prompt/JSON fixture；不能只凭名字相似纳入，也不能不记录就跳过。因为本轮不改 TypeScript，`vitest related` 的 changed-TypeScript 要求不触发；若 merge 冲突或实现意外产生 TypeScript diff，应停止并向 Lead 报告设计范围已失效，而不是临场扩大测试图。

## 证明矩阵

| 证据 | 应得结论 | 不得声称 |
|---|---|---|
| 注入 spawn 捕获 env | helper 钉死 `TMUX_TMPDIR=slotDir`，不污染 caller env | 真实 socket 存在 |
| 两个隔离 tmux server 的负控/正控 | 旧宿主 probe miss、room probe 命中同一活 pane | generalized 全链完成 |
| wrong execution / dead / malformed target | 身份与 liveness fail closed | 所有 tmux 故障都可恢复 |
| step-4 classifier 对照 | 正确 room liveness 允许既有 `rework_reachable_wait` 形态，host miss 返回 null | QA 已证明 held 恢复产品行为 |
| shell 结构守卫 | driver 没有绕开集中 helper 的直接 tmux spawn | 未来所有仓库代码都遵循同一口 |
| exact-head CI | broad repository checks 在该 head 通过 | 真房拓扑和外部服务已验收 |
| QA@4 real room | 两 Lead、真实 Claude review、完整 held → recovery → dispatch 链 | 未覆盖的生产场景自动成立 |

## 结论

根因不是 `classifyImplementPark` 状态规则，也不是 FLY-2922 的产品恢复事务，而是 driver 观察了错误的 tmux server。最小且完整的修复是把 server 选择收口到 `probeRoomPaneAlive`，以 validated `slotDir` 作为唯一 namespace authority，保留原有 exact target/execution 校验，并用真实隔离 socket 证明旧逻辑必败、新逻辑必成。产品代码不需要改动。

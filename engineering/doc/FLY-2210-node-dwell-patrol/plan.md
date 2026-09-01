# FLY-2210 节点停留巡检 — 实施计划
Issue: FLY-2210 (https://linear.app/geoforge3d/issue/FLY-2210/巡检舰队规范-3小时节点停留规则超阈强制-deep-dive勾销台账重置计时等-founder-提醒founder-拍板-v2-设计)
日期: 2026-08-31
基于: research.md

## 0. 锁定范围

逐字节遵循 founder 已批准 v2：一个新表、现有巡检工具新增停留 STEP、scoped 阈值、收据重置计时、等待 founder 的 thread 提醒去重、Lead 纪律文本；不加 daemon，不改引擎 `started_at`，不扩巡检 owner scope。

## 1. Schema 与阈值（TDD）

1. RED：新增 StateStore 测试，断言 `node_dwell_review` 尚不存在，并覆盖复合 PK、verdict CHECK、重开与失败写不污染已有收据。
2. GREEN：在现有 workflow migration 内加入批准 DDL；只做幂等建表。
3. RED：扩展 feature-flag registry/store/route 测试，要求 `node_dwell_threshold_hours` 是默认 `3` 的 project-scoped scalar，project 行优先 `*`，只接受有限正数；同时先锁住现有 project boolean 的 0/1 行为不变。
4. GREEN（窄化扩展现有四道机械门，不做 blanket relaxation）：
   - registry 用 `source=project_config`、精确 `configKey=patrol.node_dwell_threshold_hours`、`valueKind=value`、默认字符串 `"3"` 与严格 codec 登记该 identity；
   - `store-policy.ts` 只允许 **有严格 codec 的 project value** 加入 project store，仍拒绝 enum、治理 gate、dormant、readonly、wildcard configKey 与无 codec scalar；新增 policy 负测证明 permissive scalar 仍红；
   - `flag-store-runtime.ts` 增加类型安全的 `readScopedValue` 与命名 wrapper `storeNodeDwellThresholdHours`，project→`*`→default 的解析结果必须是有限正数；现有 `readScopedBoolean` 不改语义；wrapper 继续接收真实 `StateStore`，不得用 raw DB 假造 runtime；
   - `drift-scan/index.ts` 的 exact-reader allowlist 只增加 `readScopedValue`，并以真实生产调用点 `packages/teamlead/src/node-dwell-control.ts` 为 delegated/call-time consumer；缺 import、错 flag 名或未调用 wrapper 的 mutant 继续失败；
   - project flag stage/apply route 按 `valueKind` 分流：boolean 仍只收 bool/0/1，value 只收 string、先经 codec 校验、canonical `rawTo` 写原值，apply 时再次 codec 校验，clear 仍表示继承。
5. GREEN：新增 `node-dwell-control` threshold 子命令，由 snapshot 每轮实际调用：
   - 精确使用 `StateStore.openForMaintenance(dbPath, { readonly: true })`，它不建库、不迁移、不改 journal、不在 close 时 checkpoint；把该实例装入 `FlagStoreRuntime` 后调用上述 wrapper，禁止 `StateStore.create()` 与第二条 direct-SQL flag read；`maintenance_database_missing` 和 schema mismatch 都映射为稳定 non-zero unavailable token；
   - 新增 **committed mode `100755`** 的 `scripts/flywheel-node-dwell-control` ESM/shebang wrapper；它先用 `realpathSync(fileURLToPath(import.meta.url))` 解析自身真实 source，再从 trusted checkout 动态 import built `packages/teamlead/dist/node-dwell-control.js`。wrapper 必须有真实诊断/usage/错误映射与安全说明，且字节数严格大于 `scripts/lib/script-sanity.sh` 的 `FLYWHEEL_SCRIPT_MIN_BYTES`（当前 1024），这是 strict-source stub 检测合同，禁止靠无意义 padding 过门；
   - `scripts/converge-flywheel-bin.sh` 只把这个 committed wrapper 作为 `flywheel-node-dwell-control` strict symlink 安装在 snapshot 同一 `bin` 目录；missing dist 只让 helper 运行时 non-zero，不让 converge 阻断整个 Lead wave；converge 合同必须断言 `git ls-files -s scripts/flywheel-node-dwell-control` 为 `100755`、source `-x` 且 size 大于 sanity floor，避免 converge 首次 chmod trusted checkout 或因过短拒绝整个 Lead wave；
   - snapshot 只按 `$SCRIPT_DIR/flywheel-node-dwell-control` 寻址，不猜 `../packages`，也不提供 env-controlled executable override，并 fail closed 验证 helper 可执行；
   - shell 回归必须从一个上层没有 repo 的临时目录通过 symlink 调 snapshot/helper，证明 production invocation shape 可达；converge 合同测试证明 strict target 是 trusted main checkout 的 committed wrapper、断链 fail loud，而 temp/worktree root 是明确 no-op（不得安装或重指向）。
6. REFACTOR：集中阈值解析常量，运行 config authoring-policy、drift、runtime、route、converge 与 StateStore 定向套件。

## 2. 快照与收据（TDD）

1. RED：扩展 `scripts/__tests__/lead-patrol-snapshot.test.sh`，先证明 4h active 节点当前未出现在报告。
2. GREEN：在既有 STEP 6 **之后**新增独立 `STEP DWELL`，避免污染 STEP 1–6 的现有 awk extractor；复用 owner attribution，输出停留时长表与超阈名单，阈值通过 `node-dwell-control` 读取 project→`*`→默认 3。
   - active predicate 逐字锁定为 `workflow_run.status='active' AND workflow_run_node.ended_at IS NULL AND state IN ('running','review','admitted')`；不擅自加入 `pending`，也不改变 founder v2 的 `max(started_at, latest examined_at)` 基线。
   - 另做只读 invariant guard：若 active run 中 `state IN ('running','review','admitted')` 却带 non-null `ended_at`，输出聚合 `NODE_DWELL_STATE_END_MISMATCH count=N`，避免未来 reopen 同 attempt 时静默漏检；该 guard 不把异常行纳入 dwell 计时。
   - owner 无法唯一归属的 project-scope node 不带敏感 identifier，作为聚合 `NODE_DWELL_ATTRIBUTION_INCOMPLETE reason=<token> count=N` 出现在该 project 每个 Department Lead 的报告中；同时仍输出本 Lead 可归属 node 的 dwell facts。这样既不扩大 pane/issue 处置权，也不会让无主 node 被所有 Lead 静默过滤。回归断言双 Lead 都看见同一个 aggregate、都看不见 foreign identifier。
   - **状态优先级锁定**：只要本 Lead 有任一可归属 `over_threshold=yes` 行，段状态必须是 `STEP DWELL: FINDING`，即使同时存在上述 aggregate/schema degradation；每个 distinct overdue route 和 aggregate cause 都必须有对应 `FINDING step=DWELL ...` accountability 行，degradation 另写 `UNAVAILABLE_CAUSE step=DWELL class=structural token=<stable>`。只有在 **没有任何 actionable overdue row** 时，degradation 才能把段状态定为 `UNAVAILABLE(...)`；`UNAVAILABLE` 报告禁止夹带 `over_threshold=yes` 行。无 overdue、无 degradation 才是 OK。
3. RED：加入 receipt reset 用例，要求写收据后同轮不再超阈，倒填收据三小时后再次超阈。
4. GREEN：为同一 snapshot 工具增加显式 batch receipt 前端，内部委托 `node-dwell-control` 的 Node writer：
   - writer 用真正的 `better-sqlite3` `?` 参数绑定与 transaction，不使用 sqlite3 CLI `.param`；独立 rw 连接设置 5s busy timeout，`SQLITE_BUSY` 必须 non-zero 并打印稳定 `RECEIPT_BUSY`，绝不打印成功形状；
   - `FLYWHEEL_LEAD_ID` 是写模式的运行身份，caller 的 `--lead` 必须与它逐字相同；再以 CommDB owner ledger 验证 project、active run、精确 node/attempt/state 与 owner 后才写。这里明确接受单用户主机同 UID 进程可伪造 env 的 trust-domain 风险；env 只防误操作，不被描述成强认证边界；
   - 一次 stdin JSON batch 覆盖同 issue 一条合并提醒涉及的全部 node；`BEGIN IMMEDIATE` 内逐 node 原子分配 `cycle_no=max+1`，任一项失败则全批 rollback，`examined_at` 由 DB 生成。
5. RED/GREEN：加入 `founder_gate/review` 与未答 `approve_to_ship` 两个取或用例，断言 `route=founder_reminder` 且从不出现 `route=deep_dive`。
   - criterion 2 不猜 `mailbox_message_projection.issue_id`：以无条件存在的 StateStore `workflow_gate_holder(run_id, question_id, gate_node_id, attempt)` 为 primary binding，取 live-unanswered holder state `IN ('materializing','awaiting_review')`，再联 CommDB canonical open shape（question + `approve_to_ship` + 非 terminal/superseded + 无 response child）。仅对切换前缺 holder 的历史行才使用 `q.from_agent -> comm.sessions.execution_id -> issue_id` 唯一映射；映射缺失/歧义时该 node fail closed 为 unavailable，禁止误走 deep dive。`workflow_ship_target_binding` 不作 primary，因为 `engine_terminal` 当前 run 合法缺表行。
6. 负向覆盖：answered/superseded gate、结束节点、inactive run、非法阈值、非法 verdict、跨 Lead 与跨 project 都不能产生错误提醒或收据。
7. 合并提醒回归：同一 issue 的 N 个 waiting-founder node 只生成一条 reminder skeleton；成功投递后的单个 batch 必须落 N 张 `waiting_founder` 收据，缺任一目标则整批失败，下一 tick 不得部分重报。

## 3. Lead 规范（TDD）

1. RED：扩展 `fly369-patrol-rule.test.ts`，断言 `STEP DWELL`、三小时阈值、两种 waiting-founder 判据、同 issue thread 合并、投递后才写收据，以及 FLY-2178 教训原文。
2. GREEN：更新 `runner-patrol-rules.md`，明确超阈非 founder 等待必须读终端内容与工作日志，判推进/空转，禁止只看画面刷新；处置后按四值写收据。
   - deep dive 先读最新 workflow transition；若证明是 threshold 窗内刚发生的同-attempt re-admission，则这是 founder v2 `started_at` 不重写下的预期首轮 false positive，仍完成内容核验后写 `normal` 收据重置基线，不反复做无界排查。
3. 更新报告最终完成门：数字行仍必须恰好六个，另要求恰好一个 `STEP DWELL: OK|FINDING|UNAVAILABLE(...)`；任何 candidate/unset 仍失败。rule test 必须分别抽取并执行 numeric 与 DWELL 两个 regex（包括 DWELL unavailable fixture），不得继续用只命中第一个 `grep -Ec` 的非 global matcher。
4. 窄化扩展 FLY-2080 accountability grammar：
   - required-step parser 接受且只接受 `[1-6]|DWELL`；解析 `$2` 时显式去尾部 `:`（不能沿用 `substr(...,1,1)`）；`STEP DWELL: FINDING` 必须恰好配一条或多条 `FINDING step=DWELL ...`，缺 owner/next/evidence/epic receipt 仍失败；
   - validator 额外扫描 `NODE_DWELL ... over_threshold=yes`：出现任一行却不是 `STEP DWELL: FINDING`，或 `STEP DWELL: UNAVAILABLE(...)` 中夹带 overdue 行，都失败；每个 `UNAVAILABLE_CAUSE step=DWELL` 也必须被同 step 的 accountability detail 覆盖；
   - 规则 prose 把 `UNAVAILABLE_CAUSE` 的 `multiple_unavailable` 聚合明确限定为 **STEP 6 自己的 Linear-accounting causes**，不得让 `step=DWELL` 改写 STEP 6；FINDING 模板同步改成 `step=<1-6|DWELL>` 并由测试锁住。
   - `FINDING step=7` 与其他符号仍失败，现有 STEP 1–6 语义不变；
   - executable fixture 证明 finalized dwell finding + accountability 行可通过，缺行失败，原有 seven-step mutant 继续失败。

## 4. 验证与交付

1. 运行所有相关 package tests 与新增 `scripts/__tests__/lead-patrol-snapshot.test.sh`，保存 red→green 证据。
2. 运行准确全仓门：`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`，再运行每个新增/改动的 `scripts/__tests__/*.test.sh`。
3. 通过 `codex:rescue` 做独立代码审查，随后注册 `review_code` gate；任何 blocking finding 都先修复、复测并新开一轮。
4. 部署顺序写入 handoff：先 build teamlead dist、安装 committed `flywheel-node-dwell-control` wrapper 的 strict symlink并让 Bridge 重开 StateStore/完成表迁移，再 respawn Lead 载入新规则，最后验证一轮含 `STEP DWELL` 的 tick 可完成；snapshot 若先看到新代码但 helper/表尚未 ready，只能 fail closed 产生未完成 unavailable/candidate 报告，不能 fallback 默认值或误报完成。
5. push 并创建 PR；最后一个 commit 只新增 `engineering/doc/milestones/FLY-2210.md`，不修改 `CLAUDE.md`。
6. 通过 `flywheel-comm ask --report` 汇报，然后执行 `complete --route needs_review --pr <number>`；不 dispatch QA、不请求 ship、不 merge。

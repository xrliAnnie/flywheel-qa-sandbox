# FLY-3256 手动切号后解冻额度待命 — 实施计划
Issue: FLY-3256 (https://linear.app/geoforge3d/issue/FLY-3256/额度standby-撞墙进-codex-quota-standby-的体永远不解冻手动整机切号不产生-permitcapacity)
日期: 2026-10-06
基于: research.md

> **For agentic workers:** 按任务逐项 TDD；每一步只跑本计划列出的具体测试文件。实现节点必须遵守 runner local-test-policy/v2，禁止任何 package test alias、目录、glob 或全量测试。

**目标：** 人工整机切换到有额度的 Codex 账号后，以新鲜读数铸造 permit，让所有合格 standby execution 在原 thread/原模型原地续跑；同时修复巡检漏名册与 oldest=0m。

**架构：** 不新增 permit 类型或第二套状态机。人工切号仍只记录 external generation；容量由现有 `reading_confirmed` 因果围栏证明。巡检以 TeamLeadDB 当前 standby carrier 补全 CommDB live roster，时间统一在数据库边界按 UTC 解析。

**技术栈：** TypeScript、better-sqlite3、Vitest、Bash、SQLite `EXPLAIN QUERY PLAN`。

---

## 前置同步与冲突约束

实施节点先 fetch 并取得 Lead 提供的生产 base SHA；该 SHA 必须同时包含 FLY-2900 提交 `5c16c19b` 与 FLY-2195 PR #1499 的 merge commit，并且 `git cat-file -e <sha>:packages/teamlead/src/codex-quota/hotswap-candidate.ts` 成功。当前 sandbox 没有能满足这三个条件的 ref，因此**未取得并验证精确 SHA 前必须停下向 Lead 升级，禁止从 `5c16c19b` 整包回灌或凭冲突描述猜代码**。验证后才 merge 对应生产 main，只解决 `codex-quota-store.ts` 与 `hotswap-candidate.ts` 的既有冲突，保留：

- FLY-2195：满载/无候选时原 execution 原地重试；
- FLY-3256：人工切号并取得 permit 后，standby execution 原地续跑。

不得借冲突扩展功能。同步完成后用 `git diff origin/main...HEAD --` 列出真实变更文件，再以 `node "$FLYWHEEL_COMM_CLI" local-tests` 输出为本地测试上限。

### Task 1：用生产交错形状钉住 permit 缺口

**文件：**

- 修改：`packages/teamlead/src/codex-quota/__tests__/capacity-permit.test.ts`
- 修改：`packages/teamlead/src/codex-quota/__tests__/resume-loop.test.ts`
- 只读：`packages/teamlead/src/bridge/codex-quota-store.ts`
- 只读：`packages/teamlead/src/codex-quota/resume-loop.ts`

- [ ] 写 store 现状证明（预期先 GREEN）：4 个 carrier 在 account A 撞墙；`reconcileExternalRoot()` 人工切到 B；旧 A snapshot 不发 permit；B 的 requestSeq 晚于全部 wall、身份一致且窗口未满时，只生成 1 张 `reading_confirmed` permit，4 个 carrier 均 eligible。此用例证明核心事务不是 RED 根因，钉住后先不改 `codex-quota-store.ts`。
- [ ] 写 resume-loop RED：`authority_unavailable` 来自 inventory 不完整或某个 home ownership/activity unknown，但 occupancy guard 仍能读取 B 的新 requestSeq；loop 应 reconcile 人工 root、发 permit、设置 `lastRoot/context.root`，probe/install/rotate 调用数为 0。
- [ ] 写拒绝对照：collector 抛错使 occupancy guard=`unknown` 时 observer 只能 carry 旧 requestSeq，结果保持 `reading_predates_wall`/可见 refusal，不得发 permit；`canonical_unavailable`、`credential_not_shared`、`readiness_receipt_*` 均保持硬拒。
- [ ] 写 RED：refresh promise 完成前不误发；完成后下一次 evaluation 使用 B snapshot；refresh 失败保留机器可读 refusal reason。
- [ ] 写负例：只发生人工 generation、B 无读数/读数旧/身份错/非 active/窗口满/requestSeq 不晚于 wall/request 后新 wall，表仍为 0 行。
- [ ] 显式运行：`pnpm --filter flywheel-teamlead exec vitest run packages/teamlead/src/codex-quota/__tests__/capacity-permit.test.ts packages/teamlead/src/codex-quota/__tests__/resume-loop.test.ts`，确认 store 证明 GREEN、resume-loop 新正例 FAIL、负例保持 GREEN。
- [ ] 提交测试：`test(FLY-3256): reproduce manual switch standby freeze`。

### Task 2：连接人工 canonical 与 reading-confirmed permit

**文件：**

- 修改（只有 RED 证明事务本身缺陷时）：`packages/teamlead/src/bridge/codex-quota-store.ts`
- 修改：`packages/teamlead/src/codex-quota/resume-loop.ts`
- 修改：readiness 接线所在的最新 main 文件（5c16 基线为 `packages/teamlead/src/bridge/plugin.ts` 调用 `checkCodexQuotaReadiness`）
- 可能修改（仅传递结构化结果）：`packages/teamlead/src/codex-quota/runtime.ts`、`packages/teamlead/src/codex-quota/codex-accounts-observer.ts`
- 测试：Task 1 两个文件

- [ ] 让 canonical reconciliation 返回稳定的 root identity 与是否观察到 external generation；不得在 `reconcileExternalRoot()` 内直接发 permit。
- [ ] resume loop 将 `reconcile → readiness → read snapshot → reading-confirmed` 固定为同一 generation 的一次评估；root 移动时返回 `generation_moved` 并等待下一 tick。
- [ ] 只容忍可读子形状的 `authority_unavailable`：inventory/home ownership/activity unknown 但 observer 已产生新 requestSeq。其余 readiness code 与 collector error/guard unknown 硬拒；修改现有 readiness 合同测试时只改变这一种子形状。
- [ ] 容忍分支也必须设置 `lastRoot/context.root`，否则 standby resumer 会在 `if (!context.root) return` 提前退出。安全后盾是拉起时 `codex-home.ts` 的 truth-path/canonical-copy 与 `credential_link_drift` fail-close。
- [ ] 观察到 external generation 新于 snapshot 时，`reading_not_active`、`reading_identity_mismatch`、`reading_window_unknown` 也触发 single-flight refresh；刷新完成不直接旁路写 permit，仍回到 `issueReadingConfirmedPermit()` 的事务围栏。
- [ ] evidence ref/audit detail 记录 external generation 与 reading request sequence，便于解释人工切号为何放行；不增加 permit kind。
- [ ] 确认 `insertPermit()` 唯一键使同一证据重放返回已有行，不重复推进 generation。
- [ ] 跑 Task 1 的两个具体测试文件，预期全部 PASS。
- [ ] 提交：`fix(FLY-3256): mint permit after verified manual switch`。

### Task 3：守住 FLY-2195 hotswap 共存语义

**文件：**

- 修改（仅冲突整合需要时）：`packages/teamlead/src/codex-quota/hotswap-candidate.ts`
- 修改：其同名直接测试 `packages/teamlead/src/codex-quota/__tests__/hotswap-candidate.test.ts`（以最新 main 实际路径为准）
- 修改：`packages/teamlead/src/codex-quota/__tests__/standby-resumer.test.ts`

- [ ] 写/保留 RED-GREEN 对照：无 candidate 或 candidate 满载时不创建替身、不消费不存在的 permit，原 carrier 保持 standby。
- [ ] permit 到达后只由 standby resumer claim；恢复请求必须携带同 execution、thread、model 与 permit authorization。
- [ ] 单 Bridge 全局恢复并发仍受现有 `≤2` 限制（不是按账号限流）；新 wall 使 permit 失效并回 standby，不立刻 fallback。
- [ ] 运行两个具体测试文件；预期 FLY-2195 的原地重试和 FLY-3256 的 permit 恢复同时 PASS。
- [ ] 提交：`fix(FLY-3256): preserve loaded hotswap retry semantics`（若无源改则不单独提交）。

### Task 4：把 standby carrier 纳入巡检 roster

**文件：**

- 修改：`scripts/lead-patrol-snapshot.sh`
- 修改：`scripts/__tests__/lead-patrol-snapshot.test.sh`

- [ ] 写 RED：CommDB execution status=`timeout`，TeamLeadDB 对应 run active、node 当前、standby state=`standby`，巡检输出 `ROSTER_EVIDENCE quota_standby=1` 且不会报告 roster 空。
- [ ] 写负例：`released|closed`、非当前 node execution、run terminal、operator close intent 均不进入 roster。
- [ ] 构建两源 union：正常 CommDB `running|blocked` + TeamLeadDB 当前 standby carrier；standby 查询用 `CROSS JOIN`/等价固定起表方式并在带 `ANALYZE` fixture 上证明从 state index 起表；按 execution/target 去重，CommDB identity 通过 `sessions.execution_id` 主键取 1 行，冲突 owner/target fail-visible。
- [ ] `quota_standby=1` 行不因无 pane 产生 `MISSING_PANE`，不进入普通 continuity completeness 分母，也不产生 `STALLED_60M`/`REQUIRED`/nudge；STEP 2 只显示额度待命事实。给每一项加正反例。
- [ ] 不把所有 timeout session 纳入；standby 表是唯一补集入口。
- [ ] 对新 SQL 跑 `EXPLAIN QUERY PLAN` fixture，断言从 `codex_quota_standby_state` 起表并以 workflow PK lookup；记录最坏扫描为非终态 standby 数。
- [ ] 运行：`bash scripts/__tests__/lead-patrol-snapshot.test.sh`，预期 PASS。
- [ ] 提交：`fix(FLY-3256): include standby turn holders in patrol roster`。

### Task 5：统一解析数据库 UTC 时间

**文件：**

- 新增或修改：`packages/teamlead/src/codex-quota/database-time.ts`（若最新 main 已有公共 helper，复用而不新建）
- 修改：`packages/teamlead/src/codex-quota/standby-page.ts`
- 修改：`packages/teamlead/src/codex-quota/__tests__/standby-page.test.ts`
- 修改：`scripts/__tests__/codex-quota-summary.test.sh`（仅公共投影契约需要时）

- [ ] 写 RED：`entered_at='2026-10-04 11:24:00'` 在 America/Los_Angeles 仍按 UTC；给定固定 now 显示真实分钟数而非 0。
- [ ] 写 RED：ISO Z 与 SQLite UTC 结果相同；DST 前后不偏移；任一 active row 非法/未来时 oldest fail visible，不能跳过坏行取其余最小值。
- [ ] 写 RED：audit `at` 的 SQLite UTC 与 ISO UTC 在 resumed_24h、fallback_24h、claudeFallbacks14d 中计数相同；`countStandbyEntriesSince` 也不做混合格式字符串比较。
- [ ] 实现严格 parser：只接受 ISO UTC 与 SQLite UTC 两种形状，后者补 `T`/`Z`；返回 epoch/null。
- [ ] oldest 在全部 active row 均可解析后按 epoch 求 min；统一 parser 同时用于 audit 窗口和 standby 入场次数。formatter 与 JSON writer 对非法值输出 unavailable/null。
- [ ] 运行：`pnpm --filter flywheel-teamlead exec vitest run packages/teamlead/src/codex-quota/__tests__/standby-page.test.ts`；若 shell fixture 修改，再运行 `bash scripts/__tests__/codex-quota-summary.test.sh`。
- [ ] 提交：`fix(FLY-3256): parse standby timestamps as UTC`。

### Task 6：集成验收与可回滚性

**文件：**

- 修改：`packages/teamlead/src/codex-quota/__tests__/standby-bench.test.ts`
- 修改：`engineering/doc/FLY-3256-manual-switch-permit/progress.md`

- [ ] 集成 RED/GREEN：4 个真实 StateStore carrier → 人工 A→B → B 后墙新读数 → 1 permit → 4 个同 execution/thread/model 恢复；0 个 fallback execution；0 个盲换。
- [ ] straggler 收敛：4 个 carrier 外加 1 个仍在 A 上的旧进程在 B reading request 后撞墙；先断言 `reading_superseded` 可见且旧 permit 不 claim，待所有旧进程停下后下一份 B 读数产生 1 张覆盖全部 5 个 wall 的新 permit，不永久冻结。
- [ ] 重启对照：external generation 已提交、permit 写入前 Bridge 重启；恢复后刷新读数并只写 1 permit。
- [ ] operator 对照：permit 前后 cancel/terminate 均阻止未启动 carrier，已释放行不会被 roster 或 resumer 复活。
- [ ] 跑具体 `standby-bench.test.ts`，再按 `node "$FLYWHEEL_COMM_CLI" local-tests` 逐条运行 guard 列出的具体文件；不得扩大。
- [ ] 跑 `pnpm lint`、受影响包 build/typecheck（若 exported API/type 改变）。
- [ ] 更新进度与提交最终实现；进入 code review 前确认 diff 仅在本计划范围。

## 发布与回滚

- schema 无变化，无数据迁移。
- 回滚代码不会破坏已有 permit 表；关 `codex_quota_standby` 后新 wall 回旧路径，已有 standby 仍按现有 drain 合同处理。
- 若人工切号后 reading-confirmed 路径异常，拒发 permit并保留 standby，失败可见；不得用自动 fallback 掩盖证据故障。
- merge 与部署分开，只由独立 updater 在部署窗口上线。

## 查询与索引

不新增表或索引。

实施必须把以下 EXPLAIN 证据写入 PR：

1. patrol standby 补集：带 `ANALYZE` 的 fixture 上 `SEARCH s USING INDEX codex_quota_standby_state`，随后 workflow node/run 主键 lookup；必要时用 `CROSS JOIN` 固定 standby 起表。最坏行数为非终态 standby 数，patrol 周期查询。
2. CommDB identity：`sessions.execution_id` PRIMARY KEY lookup，每 execution 恰 1 行；patrol 周期查询。
3. permit eligibility 的 5c16 实测计划是 `SCAN p USING INDEX sqlite_autoindex_codex_quota_capacity_permit_2`；相关 signal 检查为 MULTI-INDEX OR，`COALESCE(signal_seq,0)` 使 signal-seq 索引不可用。最坏为 permit 数 × 未绑定 signal 数 / carrier / resumer tick，且两表不裁剪。实现必须在 RED 修复恢复可达性后重跑带统计信息的 EXPLAIN：若该乘积无明确小界，需补界或索引/查询改写并增加同文件测试，不能宣称常数级。
4. 若实际生产 base 的 schema/索引名不同，以真实 `EXPLAIN QUERY PLAN` 为准调整 SQL，不得用“数据量小”接受事件表或 sessions 全扫。

## 完成判据

- 手动整机切号本身不放行；新账号的后墙新鲜可用读数放行。
- 没有新 wall 时，一次人工 generation + 一份读数证据恰好产生 1 张 permit并覆盖全部较早 carrier；新 wall 会作废旧 permit，后续更新证据可合法产生新 permit。
- 4 个 carrier 原 execution/thread/model 续跑，无 Claude fallback。
- patrol 能看见 CommDB timeout 的当前 standby TURN holder，并且不把有意 standby 误报为 pane/continuity 故障。
- UTC SQLite 时间显示真实 oldest，不再被压成 0m；24h/14d 计数和入场次数同样正确。
- FLY-2195 满载原地重试与本单行为同时通过直接测试。

# FLY-2125 停驻申报按机器状态收敛 — 实施计划
Issue: FLY-2125 (https://linear.app/geoforge3d/issue/FLY-2125/病根-停驻体的-runner-stopped-申报无服务端合并节流同内容申报逐轮铸出lead-节律指令双重回执后仍-160-秒连发-7)
日期: 2026-09-03
基于: research.md

## 1. 目标与锁定口径

在既有 `flywheel-comm runner-stopped` 服务端事务中，把申报 identity 从自由文本正文
改为机器状态 key：同一机器状态即使 final answer 逐轮改写，也只在首次和每满 30 分钟时
铸出；机器状态变化即使最终正文逐字相同，也立即铸出。

Lead 通过 `[lead-instruction 2125-semantic-key-ruling]` 锁定以下判据：

- key 只能由机器推导来源与结构化字段计算；绝不解析、提取或比较自然语言 `detail`；
- A（防吞）：状态真的变了、正文完全相同，必须立即放行；
- B（防刷）：状态没变、正文不同，必须折叠；
- fallback idle 使用稳定 key，同 key 每 30 分钟最多一条心跳；
- ACK 语义、runner 每轮申报行为与现有告警层级不变。

research 的状态 key 表已按该裁决同步；设计 review 通过后只按下列范围实现。

## 2. 非目标

- 不做自然语言相似度、关键词归一化或 LLM 判重。
- 不给 mailbox `collapse_key` 增加通用执行语义。
- 不改 hook 调用频率、resident goal 合同、Lead prompt/rules 或 TeamLead delivery。
- 不增加环境开关、配置项、依赖、timer、alert/event family。
- 不永久去重某个状态；30 分钟心跳到点后仍可报告当前诊断正文。
- 不改变普通 ask/gate、question id、report kind、batch/event ACK、breadcrumb 消费或旧沿退役规则。

## 3. 机器状态 key 合同

`runner-stopped.ts` 在 reason/detail 推导旁维护内部 `stateKey`。key 只使用枚举、id、route、
status 等结构化字段，不使用最终 `detail`：

| 分支（现有优先级） | state key |
|---|---|
| `claude-stop-failure` | `stop_failure\0<error-code>\0<reason-enum>` |
| completion breadcrumb | `completion\0<completionEventId>\0<route>\0<pr-or->` |
| terminal session | `session\0<status>` |
| pending gate | `pending_gate\0<question-id>\0<checkpoint>` |
| pending ordinary question | `pending_question\0<question-id>` |
| declared park | `declared\0parked` |
| Codex quota/context classification | `codex_classification\0<reason-enum>` |
| fallback idle | `fallback\0idle_without_declared_completion` |

说明：

- stop failure 的 `error` 是 hook payload 的结构化错误码；`errorDetails` 不进 key。
- completion 使用不可变 event id，新的 completion action 是新状态事件，即使渲染正文相同也放行。
- park 的 free-text reason 不进 key；重复 `park` 或改写 reason 仍是 parked 状态。离开 park 后更高优先级
  状态/fallback key 会变化，重新进入 park 又形成真实 A→B→A。
- Codex quota/context 是现有分类枚举；原始 message/detail 不进 key。
- key 不是 wire 字段，不向 Lead 暴露，也不改变 canonical content。

为避免在分支间漏赋值，内部推导对象收敛为现有 `reason/detail/route` 加 `stateKey`；不新增
通用 class 或跨包 abstraction。

## 4. CommDB schema 与迁移

修改 `packages/flywheel-comm/src/db.ts` 的现有表：

```sql
runner_stop_declarations (
  execution_id,
  state_hash,
  state_key,
  content_hash,
  content,
  question_id,
  derived_at_ms,
  emitted_at_ms,
  updated_at
)
```

### 4.1 新库

`SCHEMA` 直接创建三个新 NOT NULL 列。`state_hash=sha256(stateKey)`，同时保存完整 key 并
双比；`emitted_at_ms` 初始等于首次 `derivedAtMs`。

### 4.2 旧库

`applyMigrations()` 读取 `PRAGMA table_info(runner_stop_declarations)`，只对缺列执行：

- `state_hash TEXT NOT NULL DEFAULT ''`
- `state_key TEXT NOT NULL DEFAULT ''`
- `emitted_at_ms INTEGER NOT NULL DEFAULT 0`

只有本次 open 实际新增至少一列时，才在同一迁移事务中回填旧行：空 `state_hash` 取
`content_hash`、空 `state_key` 取 `content`、零 `emitted_at_ms` 取 `derived_at_ms`。
后续每次 open 不再执行回填，不能覆盖新 key 或发送水位。空 default 只用于安全 ALTER；
“不得残留”指回填后既有行没有空 key/hash，不要求高风险重建表来移除列 default。
迁移库与新库的列 default/物理列序可以不同；本路径禁止 `SELECT *` 和位置绑定，新写入始终
显式绑定三个新列。
部署后的第一次新 state key 最多形成一条 cutover edge，此后进入稳定窗口。

不创建新表/索引：一 execution 一主键查询已经是常数范围。

## 5. 原子 compare-and-insert

扩充 `recordRunnerStopDeclaration(input)`：新增必填 `stateKey`，保留现有 `derivedAtMs`。
常量 `RUNNER_STOP_HEARTBEAT_MS = 30 * 60_000` 固定在本包。

在同一个 `transaction(...).immediate()` 内按顺序判定：

1. 校验 `derivedAtMs` 非负安全整数、`stateKey` 非空；计算 state/content 两个 SHA-256。
2. 读取 current row。
3. 若 state 与 content 都完全相同：永远 duplicate；仅当新推导更新时单调推进
   `derived_at_ms`，不推进发送水位。
4. 除上述 exact duplicate 外，若推导时间早于 current `derived_at_ms`：一律 stale，不写。
5. 若 state key 相同：
   - `derivedAtMs - emittedAtMs < 30min`：semantic duplicate，单调推进 `derived_at_ms`，
     返回 `contentMatched=false`；
   - 达到窗口：允许一条心跳。
6. 若 state key 不同：无视窗口立即继续；相同正文也必须放行。
7. 复用现有 deterministic question id 检查与 `insertQuestion(kind=report)`。
8. 若 qid 已存在，只有投影与输入完全匹配时才可按既有逻辑重建 current；冲突继续抛错/
   保留第一内容，不能推进一个未入队状态。
9. 复用现有“上一条已有 delivery/ACK 才 supersede”的逻辑。
10. 原子 upsert state/content、`derived_at_ms=max(derivedAtMs,current.derived_at_ms)` 与
    `emitted_at_ms=derivedAtMs`；第 4 步保证心跳不会回退水位。

负时间差（clock/乱序）不能错误满足窗口；除 exact duplicate 的幂等命中外，一律按 stale 处理。

## 6. 严格 TDD 批次

### M1 — 决策原语双向保护

文件：`packages/flywheel-comm/src/__tests__/runner-stopped.test.ts`、
`packages/flywheel-comm/src/db.ts`。

1. RED-A：直接调用 `recordRunnerStopDeclaration()`，相同 content、不同 stateKey、间隔 1ms；
   期待两次 `sent`、两条 mailbox row。
2. 最小 GREEN：加入 state key schema/API 与“key 变化立即放行”，保持现有 content 行为。
3. RED-B：不同 content、同 stateKey、间隔不足 30 分钟；期待首条 sent、后续 duplicate、
   mailbox 仅一行。
4. 最小 GREEN：加入 same-key 窗口分支与独立 emitted 水位。
5. RED 窗口：同 key 不同 content 在 `W-1` 折叠、`W` 放行；exact content 即使超过 W 仍折叠。
6. GREEN/refactor：只提取一段 current-row 类型/最小更新语句，不造策略 class。

每个 RED 必须先运行聚焦 Vitest 并确认是预期断言失败；每个 GREEN 立即重跑。

### M2 — 端到端 key 生成

文件：`packages/flywheel-comm/src/commands/runner-stopped.ts`、同一 test。

1. RED-B-E2E：不同 Codex turn、不同 `lastMessage`、同 fallback 机器状态，在窗口内只一条；
2. GREEN：各 reason 分支附结构化 key；
3. RED-A-E2E：在窗口内从 fallback 切到 pending gate/park/completion，均立即 sent；
4. GREEN：补齐所有分支，并用行为断言锁死 key 材料不含自然语言 detail：
   - 固定 StopFailure `error` code，只改 `errorDetails`，窗口内仍只有一条 mailbox row；
   - 两条不同 Codex quota 原文落到同一 classification，窗口内仍只有一条；
   - 同一 completion event/route/PR 只改 summary，窗口内仍只有一条；
   - declared park 只改 free-text reason 的折叠由下一步旧测试改写覆盖。
5. 改写旧测试而不削弱分支覆盖：
   - 旧的 park reason `A→B→A` 不再是假装的状态沿；新增断言 reason 改写在窗口内折叠；
   - supersede 测试改用真实机器状态 `parked → completion breadcrumb → parked`。首个 parked
     已 delivery 后允许被 completion supersede；completion 未 delivery 时不得被最终 parked
     supersede，继续覆盖现有“仅已送达/ACK 才退役”分支；
   - 直接 DB stale 测试给 newer/older 两次调用传入不同 stateKey，继续断言旧机器状态不能回退；
     另加 same-key 不同正文但推导更旧的 stale 断言；
   - completion consumption 与 unanchored Claude tests 原样回归。
6. 增加窗口内 `fallback → pending → fallback → pending` flap 测试，固定四个真实状态转换都
   `sent`。这是 Lead 判据 A 的刻意边界：如果机器状态逐轮真实切换，最坏仍是一轮一条；本单
   只收敛连续同状态的文案改写，不把真实状态沿当噪声吞掉。cutover 后按 stderr status 统计
   连续同 qid duplicate 与交替 sent，分别度量已收敛风暴和这项剩余边界。

### M3 — 迁移、重启与并发

文件：`runner-stopped.test.ts`、`runner-stop-declaration-race.test.ts`。

1. 旧 schema 模拟：创建数据库后移除/重建旧表列，再开 `CommDB`，断言三列存在且旧行回填；
2. 关闭/重开 CommDB 后，same-key different-content 窗口仍折叠；
3. race worker 接收 stateKey：六进程同 key/不同正文同时写，只一条 sent，无 `SQLITE_BUSY`；
4. 不同 key/同正文竞态按 `derivedAtMs` 保留两个真实沿或把旧推导判 stale，沿用当前顺序合同。

### M4 — 明确变异证据

在干净 GREEN 上做两次临时本地变异，每次都还原并用 `git diff --exit-code` 证明无残留：

1. 删除/反转“state key changed 立即放行”条件：RED-A 必须失败，RED-B 仍通过；
2. 删除/反转“same key 在窗口内 duplicate”条件：RED-B 必须失败，RED-A 仍通过。

记录具体失败测试名和预期/实际行数到 commit/PR body；不把 mutation 脚本或产物加入仓库。

## 7. 验证矩阵

聚焦阶段：

```bash
pnpm --filter flywheel-comm test:run -- src/__tests__/runner-stopped.test.ts
pnpm --filter flywheel-comm build
pnpm --filter flywheel-comm test:run -- src/__tests__/runner-stop-declaration-race.test.ts
scripts/hooks/test-runner-stop-notify.sh
```

CLI 继续只在 stdout 输出 qid，避免破坏调用合同；另在 stderr 增加一行
`[runner-stopped] status=<sent|duplicate|stale> questionId=<id>`。hook 已合并 stdout/stderr 到
`runner-stop-notify.log`，因此 cutover 后可直接按 status 统计折叠率，并抽查同一 qid 的
`duplicate` 是否对应同状态；这是首日发现过度抑制的最小观测面，不新增 alert/event。
在 `packages/flywheel-comm/src/__tests__/cli.test.ts` 用 Node `spawnSync` 捕获双流，分别制造
`sent`、`duplicate`、`stale`，断言 stdout 始终只有 qid 且 stderr 含精确 status/qid 行。

全仓硬门（按派工原文，不替换）：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
bash scripts/__tests__/fly2045-milestone-layout.test.sh
```

并执行所有本次新增的 `scripts/__tests__/*.test.sh`；本计划不预期新增 shell test。

## 8. 提交、评审与交付

小提交顺序：

1. `test(comm): pin runner-stop machine-state dedupe directions`（若必须与首个最小 GREEN 同交）；
2. `fix(comm): throttle runner stops by machine state`；
3. `test(comm): cover runner-stop migration and races`；
4. review finding 修复（如有，每轮独立提交）；
5. `docs(milestone): record FLY-2125 implementation` 必须是 PR 的 literal last commit。

实现后：

1. `stage set code_review`；
2. 通过 `codex:rescue` 做本地 code review（不直接 `codex exec`）；
3. 实现/本地 review 修复完成后先 push feature branch，并创建 **draft PR** 取得真实 PR 号；
   此时还不发 review gate，也不声称 head 完成；
4. 用真实 PR 号新建 `engineering/doc/milestones/FLY-2125.md`，提交为 PR 的 literal-last commit；
   push 后执行 milestone layout guard 与全仓硬门；
5. 按 codex-author 合同开 `review_code` gate、`request-review --type code` 审这个完整最终 head；
6. CHANGES_REQUESTED 时先提交修复，再更新 milestone 证据并新增一个 literal-last docs commit，
   重跑受影响/full gate，push 后开新 gate/新 request；最终 APPROVED 必须绑定最终 PR head；
7. APPROVED advisories 报 Lead，recheck inbox，把同一个 draft PR 标为 ready；该动作不产生 commit；
8. 等待最终 head 自身的 CI，不能复用祖先 head 的 green；
9. 发送引用完整 `[lead-instruction 2125-scope]` 与
   `[lead-instruction 2125-semantic-key-ruling]` 的 DONE report；
10. 执行 `complete --route needs_review --pr <NUMBER>`，不 dispatch QA、不 merge、不 deploy。

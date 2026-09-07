# FLY-2427 Ship gate 死卡收敛 — 实施计划
Issue: FLY-2427 (https://linear.app/geoforge3d/issue/FLY-2427/批准通路-lead-对-approve-to-ship-gate-的非批准回复被接受并消耗掉这道门却不铸-source-event)
日期: 2026-09-07
基于: research.md

## 目标

交付两个闭环：

1. 从入口开始拒绝 Lead 对 founder-only `approve_to_ship` gate 的任意回复，
   并在 Bridge writer 保留同语义 fail-closed 后卫，之后不再产生
   response-without-source-event 的静默消费。
2. 在已有 GatePoller/materializer cadence 上增加有界、可重入的收敛 pass，
   自动把 active run 的不可回答 holder supersede，并按当前权威 head 走正常
   gate-holder + materializer 路径生成新卡。
3. 对同一 `(run,node,head)` 设置最多 3 次 durable recovery 上限；达到
   上限后停止铸卡并发一次性告警，避免与 FLY-2426 的错误杀卡形成无限循环。

不实现 Lead kickback authority，不写 founder-verbatim，不补数据，不修改
approval/claim/authority/consent/`pr_head_sha`，不终结 Runner，不 dispatch QA，
不 merge/deploy。

## 变更面

### flywheel-comm

- `packages/flywheel-comm/src/commands/respond.ts`
  - 认证 Lead 后，对 `approve_to_ship` 无条件抛出稳定错误；
  - 错误明确要求 founder 在 Discord ship 卡上 reaction/reply；
  - 删除这条 CLI 路径不再可达的 Bridge route helper，但保留参数解析兼容。
- `packages/flywheel-comm/src/index.ts`
  - 更新 respond/`--kickback` help，取消“Lead 可打回 ship gate”的暗示。
- `packages/flywheel-comm/src/db.ts`
  - 增加只读 inspection API：一次返回 question 是否存在、五类不可回答条件、
    response 存在性及 founder source-event 存在性；
  - source-event 检查使用复合主键上的两个前缀 range `EXISTS`。
- 对应 `respond.gate.test.ts` 与 DB 测试。
- 按 CLAUDE.md FLY-1914 对主仓、`external_plugins/`、本机 plugin cache 做带
  时间戳的消费者 sweep；拒绝不是成功 gate action，因此不 retire marker。

### teamlead

- `packages/config/src/feature-flags/registry.ts`、
  `packages/teamlead/src/bridge/flag-store-runtime.ts`
  - 注册项目级 `workflow_gate_question_recovery`，默认 ON，可用既有
    `feature-flags set --name workflow_gate_question_recovery --to off
    --project flywheel` 即时关闭；
  - 读取失败 fail closed 为 off。
- `packages/teamlead/src/bridge/approval-signal/write-gate-response.ts`
  - 携带 `leadRequest` 的 approve gate write 在任何 storage writer 前拒绝；
  - trusted founder source 路径保持不变。
- `packages/teamlead/src/StateStore.ts`
  - 增加有界 active/current/awaiting candidate reader；
  - 增加单事务 replacement API：CAS 旧 holder，使用稳定
    `question_unanswerable_recovery` reason，推进下一 gate attempt，复用
    epoch-1 land 的正常 `createWorkflowGateHolderTx`；
  - replacement 必须携带纯 origin inspection 返回的 frozen receipt，并在
    事务内逐项重验 question/run/node/head/current ship target/current PR
    binding；在 replacement holder/event 上记录 receipt digest/时间用于审计，
    但不让后续正常 materializer 跳过自己的 production preflight；
  - 新 holder/evidence/binding/events 与旧 holder supersede 同事务，任何失败
    全部回滚，commit 外永远保留一个 current holder；
  - 验证 current PR binding/head，写 gate/run events，不写 claims/approval；
  - 同 head 已 recovery 3 次时不再写 holder，改为 stable escalation uid 的
    durable alert，重复 tick 不重复告警。
- 新增
  `packages/teamlead/src/bridge/unanswerable-workflow-gate-reconciler.ts`
  - `enabled=false` 时在 candidate/CommDB/preflight/StateStore 之前返回
    disabled，保证关闭没有半截状态；
  - 默认 limit 20、最大 100；
  - 默认最短间隔 30 秒，复用 per-store durable-process throttle 形状；
  - 按 project 复用 CommDB，只处理坏 question 且无 founder source event；
  - 在 StateStore replacement 前调用与生产 preflight 同源的纯 origin
    inspection；非 `ok` 计 skipped，旧 holder/card 逐字段不变，并用 stable
    question-id UID 向既有 workflow alert outbox 告警一次；payload 固定为
    `origin_inspection_blocked` 且不含动态 reason，保证同 UID 重放逐字节一致；
  - 单候选错误隔离，返回 examined/recovered/skipped/failed/newQuestionIds。
- `packages/teamlead/src/bridge/gate-origin-preflight.ts`
  - 抽出零写入的共享 inspector；既有 materializer adapter 保持原 defer/hold
    行为，recovery 使用同一 guard/probe 分类但不改旧 holder；replacement
    holder 后续仍走正常 `gh pr view`，不增加 receipt 快路径。
- `packages/teamlead/src/bridge/plugin.ts`
  - 每个 project 在调用 pass 时读取项目级 flag；
  - 在已有 workflow-gate materialization single-flight 内，顺序改为
    sessionless → recovery admission/remint → materialize successor → void old
    card → watch；避免先把旧卡指向尚不存在的新卡。
- `packages/teamlead/src/bridge/workflow-gate-card-lifecycle.ts`
  - recovery old card 只有 current successor 已 completed 且有 card id 才可
    由 StateStore reader 列为 void 候选；未满足时不进入 void loop、不调用
    defer、不消耗重试预算；届时使用明确“旧卡已坏并自动重铸，请使用新卡”文案。
- 新增/更新 StateStore、reconciler、writer、wiring、card lifecycle 测试。

## TDD 纵切片

### Slice 1：CLI C1

1. 重写 `respond.gate.test.ts` 中全部 approve-to-ship bridge-success/错误路径：
   普通 feedback、显式 prefix、结构化批准、带/不带 bridge/token、workflow-gate
   marker、`--kickback` 都应在 fetch 前 reject，CommDB 无 response、marker
   不退休；错误指向 founder card。普通 checkpoint/source-thread 保持原合同。
2. 运行：
   `pnpm --filter flywheel-comm test:run -- src/__tests__/respond.gate.test.ts`
   并确认旧代码因仍 POST 而红。
3. 最小修改 `respond.ts` 与 help，重跑为绿。

### Slice 2：Bridge exact-call-site 后卫

1. 在 `write-gate-response.test.ts` 增加 Lead request + explicit kickback；
   断言 response writer、founder source writer、post-write hook 均未调用。
2. 运行：
   `pnpm --filter teamlead test:run -- src/bridge/__tests__/write-gate-response.test.ts`
   观察旧 else 分支写入而红。
3. 在 writer 增加最小 Lead rejection，重跑为绿；补 router HTTP 409 合同测试，
   确认 direct POST 也不消费 question。

### Slice 3：CommDB inspection

1. 先写真实临时 CommDB 测试，逐一构造：
   missing、terminal_disposed、superseded_at、resolved_at、response、healthy、
   response+founder source event。
2. 断言 classification 完整且 source-event 前缀的无 msg-id/有 msg-id 形状均
   命中。
3. 实现一个只读、parameterized API；重跑 DB 聚焦测试。

### Slice 4：StateStore 原子 replacement

1. 用真实 engine workflow fixture 打开并 materialize 一个 gate。
2. 先断言 replacement 应：
   - 旧 holder 变 `superseded/question_unanswerable_recovery`；
   - 保存 `superseded_from_state` 且旧卡进入 void pending；
   - 新 holder 使用下一 attempt、当前 PR head、不同 question id；
   - run 仍 active/current gate，Runner 不 terminal；
   - approval/claim 数量和 `pr_head_sha` 完全不变。
   - 没有 fresh origin receipt、receipt 过期或不精确匹配时零变化；
   - 在新 holder/evidence/binding/event 任一写点注入失败，事务回滚后旧 holder
     逐字段相等且 current holder 仍唯一；
   - 非 epoch-1 land holder 不进入 replacement，保持全字段不变。
3. 旧代码无 API，测试先红；实现最小事务 API后绿。
4. 同旧 question 重放，断言返回 idempotent 且不再新增 holder/event。

### Slice 5：有界收敛器与硬阴性

1. 真实 StateStore + CommDB 构造五种坏态、一张 healthy 和一张带合法 founder
   source event 的 disposed question。
2. 先写并运行：
   `pnpm --filter teamlead test:run -- src/bridge/__tests__/unanswerable-workflow-gate-reconciler.test.ts`
   确认缺实现而红。
3. 实现 bounded reconciler；断言坏态被 replacement，healthy holder
   `toEqual` 全字段不变、source-backed holder 不动；preflight
   defer/hold 各一时旧 holder/card 全字段不变且无新卡，stable alert 各恰好
   一条；重跑告警仍为一条。
4. 同一个 pass 连跑两次；第二次 recovered=0/newQuestionIds=[]，holder 状态
   变化=0。
5. limit 测试构造 limit+1 个候选，断言单轮最多处理 limit。
6. 连续把同 run/node/head 的前三张 replacement question 置坏并收敛；第 4
   次断言 holder 完全不变、新卡 0、durable alert 恰好 1。再次运行 alert
   仍为 1。
7. 30 秒内重复 tick 返回 throttled；跨过 30 秒才重开 CommDB/扫描。
8. flag 默认 ON；off 与 flag-read failure 都在任何 candidate/CommDB/preflight/
   mutation 前返回，所有 seam 调用数为 0。

### Slice 6：正常 materializer 与旧卡 void

1. 对 Slice 5 的 newQuestionIds 调真实 `materializeWorkflowGateHolder`，只
   mock `postCard`，注入确定性 preflight；断言每个 replacement 恰好一张
   新卡、正常 preflight 仍被调用、重放不重复 POST。再构造第二次 preflight
   失败，断言新 holder 保留、旧卡不 void。
2. 增加新 reason 的旧卡文案与 eligibility 测试：successor 未 completed 时
   old card 不可 void，completed+card id 后才可 void；临时把顺序改回“先
   supersede/void 后铸”时该阴性测试必须变红并保留 evidence。连续 N>5 个
   tick 未 completed 时 `card_void_state` 仍 pending、transient attempts 仍 0。
3. 增加 composition-root wiring 测试，锁定执行顺序：
   recover → materialize new holder → void old card。

## 判据 D mutation 证明

聚焦测试 green 后，临时把 reconciler 的 healthy 判断放宽一次（例如把
`relay_state='protected'` 也判坏），只运行 hard-negative 测试并保存 red
输出。立即恢复该临时 mutation，重跑 green。证据写入同 doc folder 的
`evidence/`，不把 mutation 提交。

## 判据 F 真数据副本证明

1. 先检查磁盘余量；用 `sqlite3 -readonly SOURCE ".backup DEST"` 分别生成
   `teamlead.db` / Flywheel `comm.db` 的一致临时副本。绝不以读写模式打开
   生产路径。
2. 在副本上记录 7 个 active holder 的完整 before JSON、approval/claim/
   `pr_head_sha` 计数与值。
3. 用当前 source/build 的 production reconciler 跑一轮。recovery admission
   与 materializer 使用生产 `createWorkflowGateOriginPreflight` 及其默认只读
   `gh pr view`；唯一 fake 是 Discord `postCard`，并记录每次 probe 返回、
   `origin_probe_*` before/after。若 PR 非 OPEN/非同 head，正确结果是 skip
   且旧 holder/card 不变，不能硬写成成功。
4. 在运行前先记录三条目标 PR 的 live state/head；冻结验收现场若仍是当前
   `OPEN`/非 draft/同 head，则命令输出必须给出：
   - recovered issues 恰好 `FLY-2381,FLY-2394,FLY-2408`；
   - 恰好 3 个新 holder/question/card；
   - `FLY-2379,FLY-2383,FLY-2397,FLY-2403` before/after 逐字段相等；
   - 第二轮 0 recovery / 0 post；
   - approval/claim/`pr_head_sha` 零变化，run/Runner 无 terminal 变化；
   - 三个 issue 的同-head recovery counter 都从 0 到 1，远低于上限 3。
5. 对纯 origin inspection 的 defer/hold 各用副本 fixture 证明：recovered=0、
   post=0、旧 holder/card 全字段不变、card void=0、stable alert=1；重复运行
   alert 仍为 1。
6. 将去敏后的命令、输出和摘要写入 `evidence/`，临时数据库不进 git。

## 回归与完整验证

聚焦套件全部 green 后依次运行：

1. 受影响两包的完整测试；
2. 所有新 `scripts/__tests__/*.test.sh`（若本计划不新增 shell test则明确
   记录“none”）；
3. `pnpm lint`；
4. `pnpm -r build`；
5. `pnpm test:packages:run`，按项目红线排除
   `**/tmux-viewer.macos.test.ts`，并精确报告排除边界；
6. `git merge-tree $(git merge-base HEAD origin/main) HEAD origin/main`，
   断言无冲突标记。

任何 SKIP、instrumentation failure 或排除都不能写成 full gate green。

## Review advisory follow-up 边界

Lead 在 round 1 后以判据 J 裁定：除 project-level kill switch、30 秒 throttle 与
判据 I 的 preflight/void safety 外，其余 MEDIUM/LOW advisory 不扩入本单。runner_ship
carrier recovery、epoch-0 recovery、Z2 policy 合并、recovery counter 的
episode 化另开 follow-up；reader 对这些形状只 skip，不 mutation。CLI
consumer sweep 与 marker 说明属于既有发布合同/evidence，不增加产品通路。

## Review、PR 与交接

1. 提交并 push 当前实现 head。
2. 通过项目规定的 `codex:rescue` 入口运行 code review，绝不直接执行
   `codex exec`。
3. `stage set code_review`，打开并注册 `review_code` gate；review 运行期间
   不 push 代码提交。CHANGES_REQUESTED 时修阻塞项、一次性 push、用新
   question id 发起新一轮；同源第二个 HIGH 立即报告 Lead。
4. review 通过后再次拉最新 `origin/main`，重跑 merge-tree 和必要 exact-head
   gates。
5. 新建 `engineering/doc/milestones/FLY-2427.md`，并让它成为 literal last
   commit；不修改 `CLAUDE.md`。
6. push final head，等待该 head 的 CI，创建 PR。
7. 分别用带完整 id 的 `ask --report "DONE: ..."` 回执
   `[lead-instruction e14993cb-b488-42ac-a68c-404baa206f6a]` 与
   `[lead-instruction f99c13b9-e30e-4480-bbb0-5ec75f4d5644]`；完成
   runner-memory closeout。
8. 运行
   `flywheel-comm complete --route needs_review --pr <NUMBER>`，不 dispatch
   QA、不请求 ship approval、不 merge/deploy。

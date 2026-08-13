# FLY-1674 删三段式旧路径 + QA 节点真启用 Opus 4.6 — 调研

Issue: FLY-1674 (https://linear.app/geoforge3d/issue/FLY-1674/chore-删掉三段式旧路径founder-直令-真启用-opus-46-于-qa-节点-让模型配置只剩-dag-一条路径验收真实-run)
日期: 2026-08-12
基于: exploration.md

## 1. 为什么「配置写了 ≠ 生效」— dispatch entry 优先级链(已核实)

`packages/teamlead/src/bridge/runs-route.ts` fresh main dispatch 的决策顺序:

1. `resolveWorkflowTemplateCandidateSchema`(work-kind binding → template candidate)
2. DAG v1 entry(`runs-route.ts:2214-2255`):`pipeline.dag === true` + schema-**1** candidate → `dagEntry = true`
3. 三段式 entry(`runs-route.ts:2262+`):**`!dagEntry` 且 `candidateSchemaAtEntry !== 2` 才进** — `resolveThreeStageEntry`(读 `pipeline.three_stage` → phases 表)
4. schema-2 generalized selection(`resolveWorkflowTemplateSelection`)— **生产现行唯一活路径**

生产 `.flywheel/config.yaml:257-273`:`three_stage: true` + `three_stage_channels` + `dag: true` + `work_kind: true` 同时开着。生产 `workflow_category_binding` 全部指向 5 个 menu template(`tpl_code/tpl_design/tpl_generic_menu/tpl_prd/tpl_prototype`,FLY-1436 cutover 2026-07-24)= **schema-2** ⇒ candidateSchema=2 同时短路了序位 2 和序位 3。三段式 entry 成为死代码路径,但其配置面(`phases` 表、`pipeline.three_stage`、env flags)还活着可写 —— 「写进废墟」的机理本体。

**生产 run 账面证据**(`~/.flywheel/teamlead.db` 只读,2026-08-12):

| schema_version | run 数 | 时间窗 |
|---|---|---|
| NULL(前快照格式) | 59 | 07-19 ~ 08-01 |
| 1 | 36 | 07-19 ~ **07-23**(绝迹) |
| 2 | 142 | 07-24 ~ 至今(08-12) |

最近 6 条含 qa 节点的 run 快照全部固化 `claude-opus-5[1m]`(= bindings.opus 现值)⇒ 事故陈述 100% 复现:`phases.qa=claude-opus-4-6[1m]` 从未流入任何 run。

**非终态 v1/NULL 残留(删除前预检收敛项,7 条)**:held ×6(FLY-1364/1356/1335/1414/1413/1412,07-19~07-22)+ active ×1(LEARN-219,08-01,NULL schema)。

## 2. QA 节点模型的真实决定链(bindings.opus → 4.6 的必经之路,已核实)

```
~/.flywheel/models.json bindings.opus
  → buildModelRegistry(bindings)  packages/config/src/model-builtins.ts:170
      bound(bindings.opus, ["opus"]) → claudeEntry(dispatch:true)
      effortsBySurface.workflow = supportedRoleEfforts(id)   ← FLY-1650 收窄:4.6 无 xhigh
  → parseMenuModel                packages/teamlead/src/workflow-menu.ts:137
      校验 menus/shapes/code.yaml qa 节点 allowedEfforts 逐字 == registry workflow 面(:162-172,不等则 throw)
  → compileWorkflowMenuSeed       workflow-menu.ts:334(resolveAlias("opus") → registry.id 固化进 seed manifest)
  → importWorkflowMenuSeeds       workflow-menu.ts:424(Bridge boot 调用 → throw = Bridge exit 1)
  → run 快照(workflow_run.snapshot resolved.nodes[qa].dispatch 固化 vendor/model/effort)
  → resolveNodeDispatchAtLaunch(workflow-dispatch-resolution.ts)→ spawn session --model <值>
```

两个硬结论(第二条被 plan Step 4-i **修订取代**,证据见 plan):
- **boot 炸弹位置精确**:`parseMenuModel` 的逐字相等校验。
- ~~顺序不可逆:菜单对齐必须先于 binding 切换、同窗原子生效~~ → **plan 修订(supersede)**:逐字相等使菜单 4 档对 opus-5(5 档面)同样不等 ⇒「只合代码不切 binding」的过渡态照炸,而 PR 合入与部署窗之间的重启(updater 自动车/KeepAlive)不可控 — 原子性靠运维顺序是赌运气。故 plan Step 4-i 把校验减弱为**子集**(`allowedEfforts ⊆ registry workflow 面`,保留「不许声明模型不支持档」防线 + defaultEffort∈声明面),双态 binding 都合法,炸弹结构性拆除;`allowedEfforts` 同时是 `resolveMenuOverrides` 的 override allowlist,收窄语义(4 档统一上限、不随 binding 回摆)是有意的产品策略,由行为层测试钉住(plan Step 4 TDD④)。

## 3. FLY-1650/1652 已交付基建(本单依赖面,已核实)

- registry:4.6 / 4.6[1m] 条目 + alias `opus-4-6` 等;`UNSUPPORTED_EFFORTS_BY_MODEL`(model-builtins.ts:74-79)按模型 id 收窄,binding 接管路径(bound())自动继承。
- `resolveAllowedEffort` 四咽喉点(runner tmux spawn / Lead launcher / workflow admission / cross-family reviewer):不支持档位 → 丢弃 + 出声(不 throw)。admission 处 `narrowEffort`(workflow-dispatch-resolution.ts:45-57)写不可变审计行。
- 4.6 **无 lead 面**:FLY-1652 QA 矩阵 F4 证实 `bindings.opus=4.6` 时 lead 面解析 THROW `ModelPolicyError` → 切 binding 预检必须含「fleet 无 Lead 绑 opus 档」。

## 4. 生产残留与安全预检(已核实,2026-08-12 只读)

| 项 | 值 | 含义 |
|----|----|----|
| `three_stage_turn` 表 | 0 行 | 三段式 turn 账本已空(表本身是 DAG 共用件,见 §5.3) |
| 三段式 sessions(workflow_node_id IS NULL)最后一跑 | design 07-31 / implement 08-05 / qa 07-29 | 无 in-flight |
| v1/NULL 非终态 run | 7 条(§1) | 删除前收敛 |
| `~/.flywheel/.env` | `FLYWHEEL_THREE_STAGE_CODEX_DESIGN=0`(:132)、`FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT=1`(:145) | 都是默认值;随 flag 删除清行 |

## 5. 删除边界全量盘点(50+ 文件逐一判定,行号级)

### 5.1 纯三段式 — 整删文件

| 文件 | 行数 | 前置条件 |
|---|---|---|
| `packages/teamlead/src/bridge/phase-orchestrator.ts` | 2376 | **先把 `reconcileTurnBelt`(L2209-2351)迁到 DAG 侧** — 它的 4 个消费点(DirectEventSink:1433 / event-route:2810,3025 / actions:1856 / plugin:9344)对 DAG session 的 TURN 回收同样必要,不迁 = DAG holder 死后 TURN 泄漏、整条 run 永久卡死 |
| `packages/teamlead/src/bridge/three-stage-policy.ts` | 339 | **先迁出 2 个共用符号**:`NO_THREE_STAGE_LABEL`(L86,DAG entry 的 opt-out 门)、`threeStageKeepAliveEnabled`(L335,Blueprint:1301,1619 + run-dispatcher:1743 的 DAG spawn 路径在读) |
| 三段式专属测试(phase-orchestrator*.test ×6、three-stage-policy.test、three-stage-dedup.test、StateStore.three-stage-qa.test、event-route-fly859-three-stage-qa.test 等) | — | 随主文件;`three-stage-turn.test.ts` 里的 DAG activation 断言要挑出保留 |
| `scripts/qa-fly921-real-discord-turn-belt-e2e.mjs` | — | 直接 import PhaseOrchestrator |

**明确不整删**:`three-stage-config-source.ts`(导出 `loadWorkKindConfigStrict` + `loadPipelineConfigByProject`,都是 DAG 必需)→ 只改名 `pipeline-config-source.ts`。

#### QA 返工补审:`runs-route.dag-recovery.test.ts` 是混合载体,不是三段式测试

原文件 455 行 / 13 条测试,全文没有三段式或 `PhaseOrchestrator` 引用。整文件删除的真实边界是:

- 11 条依赖已退役 schema-v1 fresh entry 与 `tpl_eng_heavy` 的恢复测试随该入口作废,不应为了留测试而复活生产路径;
- `#12c DAG_RUN_STATE_CORRUPT` 与 `#14 ACTIVE_ENGINE_RUN_UNCLASSIFIED` 两条 fail-closed 不变量在本分支仍成立,迁入 `runs-route.dag-entry.test.ts` 原样保留;
- 原 `crash-cut A/B` 同时承担活 schema-2 启动租约的路由层覆盖,不能随 v1 一起丢。替代测试改用现行 `tpl_code` menu seed,覆盖 keyless 首发 `202 LAUNCH_PENDING` → 活租约重试 `409 GENERALIZED_LAUNCH_HELD` → 租约过期后 generation 2 收敛 `200`。

因此旧文件仍整删,但删除理由与每类覆盖的去向现在逐项有账;没有把 DAG 共用安全缝当成三段式残骸一起删掉。

### 5.2 共用件 — 删三段式分支(主要位点)

| 文件 | 删除内容 | 保留内容 |
|---|---|---|
| `runs-route.ts` | 三段式 entry 整块(:2262+ `resolveThreeStageEntry` 调用与后续 activePhase 撞车检查中三段式专属部分);DAG v1 entry 块(:2214-2255,schema-1 candidate 已不可能);`allowSchemaV1Dispatch` 的 `\|\| (role==="design" && shareParentBranch===true)` 半边(:2464) | `freshNoThreeStageLegacy` 短路(:2157,label 语义=单 session,DAG 用);work-kind override 校验族 |
| `workflow-dispatch-resolution.ts` | schema-1 `current_config` 分支(:97-122,`resolvePhaseDispatch` 唯一 DAG 消费点)→ v1 run 节点退化为 live_template/snapshot_fallback(向后安全) | `narrowEffort` / live_template / snapshot_fallback |
| `plugin.ts` | PhaseOrchestrator 全部 wiring(:422-426, 1186-1192, 5082-5113, 8154-9364 段内三段式部分, 9634 守卫);`FLYWHEEL_THREE_STAGE_MAX_FIX_ROUNDS`(:8187) | orphan-parked 告警(:10057-10092,复用 kind 字符串);DAG rework/ship-carrier TURN wake(:9176/9309);display imports |
| `DirectEventSink.ts` | PhaseOrchestrator 依赖(:45,93-96,107-112)、`onPhaseComplete`(:1124-1131)、`finalizeThreeStagePhases`(:1224)、takeover-failure alert(:1353-1357)、`reconcileQaLoss` seam(:1364-1408)、`reconcileTurnBeltAfterTerminal` 改为调迁移后的 DAG 版(:1420-1441) | `isThreeStagePhaseRole`/`resolveCompletionSessionRole` 消费、`phase_design_complete` design-HTML 门(:568-578)、`design_backend` 传播 |
| `StateStore.ts` | 纯三段式方法:implement-count(:5711-5729)、`getThreeStageQaSessionsWithVerdictEvents`(:5736)、`getStrandedThreeStageQaPassSessions`(:5763)、`recordThreeStageVerdictHead`(:5939)、`getUnambiguousThreeStageVerdictHead`(:5969)、`three_stage_fix_round` 归因(:34255,确认无 DAG 消费后);事件类型 `three_stage_verdict/three_stage_fix_round/three_stage_verdict_head`;可选:`phase_chat_threads` 表(FLY-892 后已停写,只剩 read-only 反查 + boot-sweep archive) | 列 `design_backend`/`chat_thread_role`/`session_role`;共用查询 `getActivePhaseSessionForIssue`(runs-route:1828 DAG recovery 守卫在用)/`getPhaseSessionsForIssue`/`getParkedPhaseCandidates`/`getLatestPhaseSessionsForIssue`;`no-three-stage` CHECK(:17291,随 label 决策) |
| `run-infra.ts` | PhaseOrchestrator hook(:78, 631-642, 1083-1088) | `phaseRetryStartPointComputer`(:1278-1300,DAG 节点重试在用,改文案) |
| `merge-ship-gate.ts` | `finalizeThreeStagePhases?` 参数(:479-490, 563)——需先确认 DAG parked 节点的 post-ship 收尾等价物(post-ship-finalization / ship-carrier-coordinator)已覆盖 | 其余全部 |
| `crash-reaper.ts` | `onQaPhaseTerminated` 现实现指向 PhaseOrchestrator.reconcileQaLoss → 需换 DAG 等价恢复或明确由 DAG rework 机制覆盖(门 `chat_thread_role==='qa'` DAG qa 节点也命中) | 回调 seam 本体 |
| `ConfigLoader.ts` | `pipeline.three_stage` 校验(:416-419)、`three_stage_channels` 整块(:439-467) | `pipeline.dag`(:423-425)、`pipeline.work_kind`(:429-437) |
| `types.ts` | `PipelineConfig.three_stage`(:296)、`three_stage_channels`(:310)+ JSDoc | `dag`/`work_kind` 字段(:324 注释改文案) |
| `feature-flags/truth.ts` | `FLYWHEEL_THREE_STAGE_MAX_FIX_ROUNDS` 条目(:251-252) | :241 文案改 |
| `feature-flags/registry.ts` | 5 条 flag 定义(见 §5.4)+ owner-file 指针修正(:197, 967-968, 995-996, 1172-1179, 2698, 3078)— 有 drift 测试守卫路径存在性 | 其余 |
| `workflow-template-selection.ts` | — | schema-1 的 `allowSchemaV1Dispatch!==true → return null` 分支保留(schema-1 candidate → 单 session 的向后安全终态) |

### 5.3 共用语义迁移/改名(删不得)

| 符号/资产 | 现址 | 处置 |
|---|---|---|
| `isThreeStagePhaseRole`(11 消费点中 9 个 DAG)/`resolveCompletionSessionRole`(5 个全 DAG)/`ThreeStagePhase` 类型/`THREE_STAGE_PHASE_SEQUENCE`/`DEFAULT_PHASE_TIER`/`PHASE_THREAD_BADGE` 族/`phaseMessageTag`/`PhaseDispatchVendor`/`DesignBackend` 族 | `packages/config/src/three-stage-phases.ts` | 文件改名(→ `phase-roles.ts`)+ 符号去三段式命名(`isWorkflowPhaseRole`/`WorkPhase`/`PHASE_ROLE_SEQUENCE`…);删除其中 2 个零消费/纯三段式符号:`resolvePhaseModel`(:239)、`nextPhase`(:248);`resolvePhaseDispatch` + `DEFAULT_PHASE_DISPATCH` 随 §5.5 phases 段一起删 |
| `NO_THREE_STAGE_LABEL` | three-stage-policy.ts:86 | 迁到 `work-kind.ts`(它的 `ROUTING_OVERRIDES_ALLOWLIST` 已含该 label);**label 字符串本身不改名**(改名要动 Linear 存量 label + StateStore CHECK 约束 migration + founder 习惯,收益纯命名;注释讲清语义=「单 session 直跑」) |
| `threeStageKeepAliveEnabled` + `FLYWHEEL_THREE_STAGE_KEEPALIVE` | three-stage-policy.ts:335 | **flag 删除、行为固化为无条件 ON**(FLY-1466「不加新 flag」同款裁决:默认 ON、生产未设、rollback=git revert);函数体删,读点(Blueprint:1301,1619 / run-dispatcher:1743 / plugin:7946,8958)改为常量真 |
| `three_stage_turn` 表 + `flywheel-comm turn` | flywheel-comm/db.ts | **零逻辑删除**(4 个 DAG 专属列 + 7 个 DAG 消费文件);表名**不改**(rename=migration + CLI/Bridge 双写者 build-skew 风险);TS 类型名 `ThreeStageTurn`→`WorktreeTurn` + 全部 JSDoc 改文案 |
| alert kinds `three_stage_stuck`/`three_stage_takeover_failed` | LeadAlertNotifier/LeadWatchdog/infra-event-router/kind-contract/lead-alert.sh | **kind 字符串保留**(`three_stage_stuck` 被 FLY-1204 orphan-parked patrol 复用,患者含 DAG parked 节点;改字符串动 5 文件 + shell + 历史 claims 兼容),显示文案与注释改为 orphan-parked/phase 语义 |
| Blueprint 三段式提示词 | Blueprint.ts:1778-1855, 1943-1970, 2496-2546 | **分支保留、措辞改写**(schema-2 code-shape 的 design/implement/qa 节点经 dispatcher `shareParentBranch:true` 命中同一批分支 — 本 design 节点 session 自身的 TURN WAIT LAW 即出自 :1877,活路径铁证);去「three-stage pipeline」措辞 |
| `designer-labels.ts` / `progress-schema.ts` / `progress-resume.ts` / `WorktreeManager.resolveWorktreeKey` / `adapter-types.phaseKeepAlive` / claude-runner 4 文件 / terminal-mcp 2 文件 / core 3 文件 / `gemini-agent/loop.ts`(误命中,tool 三道闸) | — | 仅改注释/文案/类型名引用,零逻辑改动 |

### 5.4 flags / config 键台账(founder「flag 都清理掉」的执行面)

| flag / 键 | registry 位置 | 消费点 | 生产值 | 处置 |
|---|---|---|---|---|
| `FLYWHEEL_THREE_STAGE`(three_stage_killswitch) | registry.ts:856-882 | three-stage-policy.ts:112(随文件删) | 未设 | 删条目 → tombstone |
| `FLYWHEEL_THREE_STAGE_KEEPALIVE` | :885-917 | §5.3(固化 ON) | 未设 | 删条目 → tombstone |
| `FLYWHEEL_THREE_STAGE_QA_RESPAWN` | :921-947 | phase-orchestrator(随文件删) | 未设 | 删条目 → tombstone |
| `FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT` | :953-973 | resolvePhaseDispatch(随 §5.5 删) | =1(默认值) | 删条目 + 清 .env:145 → tombstone |
| `FLYWHEEL_THREE_STAGE_CODEX_DESIGN` | :977-1001 | resolvePhaseDispatch(随 §5.5 删) | =0(默认值) | 删条目 + 清 .env:132 → tombstone |
| `FLYWHEEL_THREE_STAGE_MAX_FIX_ROUNDS` | truth.ts:251-252 | plugin.ts:8187(随 orchestrator 删) | 未设 | 删条目 |
| `pipeline.three_stage` | ConfigLoader:416-419 | 三段式 entry(随删) | `true`(config.yaml:258) | 删 schema + 清两处 config.yaml |
| `pipeline.three_stage_channels` | ConfigLoader:439-467 | 同上 | 已设(:259) | 同上 |
| `FLYWHEEL_PARK_BIASED_HANDOFF`(park_biased_handoff) | registry.ts:185-203 | **唯一读点 phase-orchestrator.ts:1869**(亲手复核)→ 随 orchestrator 删 | 未设 | 删条目 → tombstone(第 6 条) |
| `FLYWHEEL_PARKED_PHASE_STALE_HOURS` | truth.ts:240(NON_FLAG_ALLOWLIST) | plugin.ts:6322 + HeartbeatService(parked-phase 回收,**DAG parked 节点也是患者**) | 未设 → 24 | **保留**,改 truth.ts:240 文案 |
| dispatch API `designBackend` | runs-route:1116-1139(body 校验)+ :1253-1268(早期门) | **admission 面整删**(生产无调用方,DAG 时代无人用);`sessions.design_backend` 列 + DAG 传播链(dispatcher:2473)零改动保留(历史兼容) | — | 随三段式 entry 删 |

注 1:盘点初判「codex_implement/codex_design 改名保留(DAG v1 在读)」的前提是 v1 `current_config` 分支存续;§5.5 裁决删除该分支后消费点归零 ⇒ **6 条 registry flag 全删**(含 park_biased_handoff),走 FLY-1466 范式:删 entry + `RETIRED_FLAGS` tombstone(`retiredBy:"FLY-1674"`,truth.ts:284-382,已核无重名)+ `flag-truth.test.ts` 正向退休断言 + claim 级 grep 零残留。`FLYWHEEL_THREE_STAGE_MAX_FIX_ROUNDS` 是 `NON_FLAG_ALLOWLIST` 条目非 registry flag → 删 allowlist 行 + 读点,**不进 tombstone**。
注 2:**`FLYWHEEL_THREE_STAGE_CODEX_DESIGN` 的删除推翻 FLY-1456 的「保持关」裁决**(execution-ledger.md:74)— 被 founder 2026-08-10 删三段式直令覆盖,PR 里显式声明。
注 3:ops 动作:生产 `~/.flywheel/.env` 删第 132/145 两行(否则 `validateFlagTruthEnvironment` 对 tombstone env fail-closed 报错 — 这是刻意的:tombstone 机制逼着清理)。
注 4:`workflow_vendor_at_dispatch`(DAG 核心,保留)的 description 提「phase/template dispatch」→ 改文案;`ConfigLoader.ts:432-441` work_kind 分支注释「preserves three_stage/dag」→ 同步改。

### 5.5 models.json `phases` 段与 DAG v1 路径的退役(本调研最重要的修正)

**推翻探索期假设**:`phases` 段并非只有三段式消费 —— `workflow-dispatch-resolution.ts:97-122` 在 `schema_version===1 && node.type∈{design,implement,qa}` 时调 `resolvePhaseDispatch(node.type, env)` 作为 DAG v1 节点的 launch dispatch(source: "current_config")。

与事故实证的调和:生产自 FLY-1436 cutover(07-24)起全部 run 为 schema-2,v1 run 07-23 绝迹;schema-2 走 live_template/snapshot(菜单编译时已按 bindings.opus 固化)⇒ phases 段对生产零影响 —— 但代码上它仍是活消费点。

**裁决:v1 `current_config` 分支随本单删除**(否则 phases 段删不掉,「模型配置只剩一个地方可写」不成立):
- 删 workflow-dispatch-resolution.ts:97-122 → v1 run 节点 dispatch 退化为 live_template → snapshot_fallback(pinned),行为向后安全;
- 删 runs-route DAG v1 entry 块(schema-1 candidate 生产已不可能;万一出现 → generalized selection 对 schema-1 返回 null → 单 session,fail-safe);
- 7 条 v1/NULL 非终态残留 run 在实施前收敛为终态(预检);
- 删 `resolvePhaseDispatch`/`DEFAULT_PHASE_DISPATCH`/`BUILTIN_PHASE_DISPATCH` + model-config.ts 的 phases 解析(§6)+ models.json phases 段 + `fleet/example/models.json` 的 phases 段。
- 与 FLY-1693(模板退役,**已合入 main `4b47fe3c`** — 调研期 pending 状态已过时,Codex R2#3 核出)无硬依赖;实施基线 rebase 最新 main,在旧模板已退役的现实上复核 v1 fallback。

## 6. models.json `phases` 段生命周期(解析/写路径/热重载,已核实)

### 6.1 解析与失败姿态

- 路径:`FLYWHEEL_MODELS_CONFIG` 或 `~/.flywheel/models.json`(model-config.ts:127-133);缓存 key = `path:dev:ino:mtimeMs:size` 的 stat 比对(:135-149),**无 watch、无 TTL** — 纯惰性热重载,改文件后下一次调用即生效。
- `phases` 段解析在 `createSnapshot`(:420-468):逐 phase 校验 vendor/model/effort,**任一不满足 → warn + 回落 `BUILTIN_PHASE_DISPATCH[phase]`,永不 fail-loud** — 这正是「配置写了不生效也不报错」的另一半病灶。
- `loadSnapshot`(:578-608)对**未知键不报错**(只校 `version===1`)⇒ 删代码后生产 models.json 里残留 `phases` 段不会炸,但按 founder 要求一并删文件里的段 + `fleet/example/models.json` + `fleet/README.md:29,40-41`。
- **写路径:全仓零个**。models.json 只有人手编辑(fleet console 写 projects.json,model console 写 template revision)。「配置只剩一个地方可写」成立的前提已在。

### 6.2 删 `phases` 不伤 `bindings`/`tiers`(逐字确认)

`ModelConfigFile` 四字段互不引用;`createSnapshot` 里 tiers 循环(:386-419)与 phases 循环(:420-468)是独立代码段,无共享变量;依赖方向单向(phases 读 bindings 的 registry 产物,反向不成立);`BUILTIN_PHASE_DISPATCH` 与 `BUILTIN_MODEL_TIERS` 是两个独立 frozen 常量。**结论:安全。**

`snapshot.phases` 全仓唯一直接读点 = `three-stage-phases.ts:206`(`resolvePhaseDispatch` 内);下游消费点中唯一 **dispatch 交界** = `workflow-dispatch-resolution.ts:97-122`(v1-only,§5.5 裁决随删)。**修正(Codex R1#2)**:此外还有 4 处显示/retry/rescue 消费(`actions.ts:934-951`、`runner-model-display.ts:31-38`、`rescue-runtime.ts:256-280`、`issue-display-refresher.ts:322,823`)与 legacy 影子桥 `workflow-shadow-writer.ts:585-653`(启动回放读 `three_stage_fix_round`/`three_stage_verdict`)— 逐一替代语义见 plan Step 2g/2h。

### 6.3 binding 切换的生效时机:「热快照 + 冷 seed」

- 层 A(热):`getModelConfigSnapshot()` stat 失效 → `getModelRegistryEntry`/别名解析下一次调用即新。例外:`model-tiers.ts:29` `ACCEPTED_DISPATCH_MODELS` 与 `model-builtins.ts:276` `MODEL_REGISTRY` 是 module-load 常量,停在进程启动快照(不碰本单,但影响「热切」预期)。
- 层 B(冷):**DAG 节点真正换模型必须重启 Bridge** — `importWorkflowMenuSeeds` 唯一调用点是 `plugin.ts:4223`(boot),无任何路由/cron 重导入。顺序:编辑 models.json → 重启 → 用新绑定重编译 5 个 menu seed → manifest 含新 model id ⇒ **contentHash 全变** → `importWorkflowTemplateSeed` 建新 revision + publish(生产 tpl_code 现 rev 4 → 切换后 rev 5;旧 revision 留作历史,已 materialize 的 run 仍指得到)→ 新 run 用新模型。
- **重启即炸弹现场**(与验收「重启一次不炸」天然合一):`plugin.ts:4223` 无 try/catch。
- seed_owner 预检:5 个模板 `seed_owner` 必须是 `system`(founder-owned seed 会 `refused`,切换「看起来没生效」)。

### 6.4 炸弹范围修正:5 个菜单 YAML,不止 code.yaml(亲手复核)

`grep 'defaultModel|- model:' menus/shapes/*.yaml`:**generic/design/prd/prototype 的唯一执行节点也全是 `opus` 别名**(`defaultModel: opus`),与 code.yaml qa 节点相同,且 5 处 opus 行全部声明 `allowedEfforts: [low,medium,high,xhigh,max]` + `defaultEffort: xhigh`。fable/codex 行不受影响(未被收窄)。

两个直接推论:
1. **菜单对齐范围 = 5 个 YAML 的 opus 行**(不是 issue 说的 code.yaml 一处)。
2. **⚠️ 影响面披露(必须给 founder 看)**:切 `bindings.opus → claude-opus-4-6[1m]` 后,**5 个 shape 的 opus 节点全部变 4.6** — code 的 qa 节点(founder 拍的)+ generic/design/prd/prototype 的唯一执行节点(隐含跟切)。这是 binding 语义的必然结果,也是 8-09 founder 自己切 binding 时的同一影响面;替代方案(菜单里写显式 `opus-4-6` 别名、不切 binding)会把模型配置散进菜单文件 = 制造第二个可写位置,违背本单根治方向,否决。

### 6.5 in-flight run 在切换时刻的表现(已核实)

`resolveNodeDispatchAtLaunch` 每节点启动时重算:in-flight v2 run **已启动节点保持旧值**(`workflow_execution_runtime` append-only + no_update/no_delete 触发器);**未启动节点跟新 revision 走**(live_template 出口)— 一条正在跑 design 的 run,切换重启后它的 qa 节点用 4.6。这是 FLY-1385 `workflow_vendor_at_dispatch` 的设计意图,非 bug,写进验收口径。

### 6.6 Lead 面安全(已核实)

生产 models.json **`bindings.opus1m` 未设置**(回落内建 opus-5[1m])。`~/.flywheel/projects.json`:7 个 Lead 用 `opus[1m]` 别名(→ bindings.opus1m,本单不动)、eng-lead 用 `fable`、其余 sonnet/codex — **无任何 Lead 用裸 `opus`**。切 bindings.opus 后裸 opus 别名指向无 lead 面的 4.6 条目,若有 Lead 用会被 `resolveLeadLaunchSelection` 替换成 Fable + 告警(可用性姿态,非 crash)。此依赖是隐式的 → 进实施预检与验收。

## 7. 设计裁决汇总(进 plan)

1. 删除边界三分法照 §5.1-5.3 执行;`reconcileTurnBelt` 迁移是 phase-orchestrator 整删的硬前置。
2. `phases` 段 + v1 `current_config` 分支 + DAG v1 entry 同批删除(§5.5)。
3. 菜单 effort 兼容走「对齐声明」:**5 个 YAML 的 opus 行**(§6.4)`allowedEfforts: [low, medium, high, max]`、`defaultEffort: xhigh → high`;`parseMenuModel` 校验保留。
4. **6 条 registry flag** 删进 tombstone + 1 条 allowlist 条目删除(§5.4);`pipeline.three_stage`/`three_stage_channels` schema+实值全清;推翻 FLY-1456 对 CODEX_DESIGN 的裁决(显式声明)。
5. 不改名不迁移的兼容面:label 字符串 `no-three-stage`、表名 `three_stage_turn`、alert kind 字符串 ×2 —— 全部保留字符串、改语义文案(诚实边界:命名残留,机制无残留)。
6. 切 binding 预检:无 Lead 用裸 `opus` 别名(§6.6,现状已核安全)+ `bindings.opus1m` 不动;5 模板 `seed_owner='system'`;v1/NULL 非终态 run 收敛(7 条);boot 阴性对照(重启一次不炸)。
7. **影响面披露(founder 必读)**:切 binding 使 5 个 shape 的 opus 节点(code.qa + generic/design/prd/prototype 唯一执行节点)全部变 4.6(§6.4)。
8. 生效链与验收:「热快照 + 冷 seed」(§6.3)⇒ 验收动作固定为「合入 → 编辑 models.json → 重启 Bridge(不炸 = 交付物 2 阴性对照)→ 派新 run → 查 run 快照 qa 节点 + `workflow_execution_runtime` 固化行 + spawn 进程 argv `--model claude-opus-4-6[1m]`」。

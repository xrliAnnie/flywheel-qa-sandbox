# FLY-1674 删三段式旧路径 + QA 节点真启用 Opus 4.6 — 实施计划

Issue: FLY-1674 (https://linear.app/geoforge3d/issue/FLY-1674/chore-删掉三段式旧路径founder-直令-真启用-opus-46-于-qa-节点-让模型配置只剩-dag-一条路径验收真实-run)
日期: 2026-08-12
基于: research.md

## 0. 目标与硬验收(照 issue 原文)

1. 全仓 grep 三段式路径 = 0 引用(真删干净;「引用」= 机制引用,§8 诚实边界列明保留的兼容字符串)。
2. 新 run 快照 qa 节点 model = `claude-opus-4-6[1m]`,且 QA session 进程实际加载 4.6(argv 证据,非配置文件)。
3. Bridge 重启一次成功(boot 炸弹阴性对照)。
4. `phases` 概念从 models.json 与代码消失 ⇒ 模型配置只剩 `bindings`(+`tiers`)一处可写。

**影响面披露(founder 必读,research §6.4)**:切 `bindings.opus` 后 **5 个 shape 的 opus 节点全部变 4.6** — code 的 qa 节点(founder 拍的)+ generic/design/prd/prototype 的唯一执行节点(binding 语义的必然跟切,与 8-09 founder 亲手切 binding 时的影响面一致)。替代方案(菜单写显式 4.6 别名、不切 binding)会制造第二个模型可写位置,违背根治方向,否决。

## 1. 实施前预检(Step 0,只读)

| # | 预检 | 通过标准 | 已核现状(08-12) |
|---|---|---|---|
| P1 | v1/NULL 非终态 run | 0 条;非零则先由 Lead 收敛(terminate/close) | 7 条(6 held v1 + 1 active NULL)→ 实施时重查并请 Lead 收敛 |
| P2 | 三段式 in-flight session(`session_role∈(design,implement,qa) AND workflow_node_id IS NULL AND status 非终态`) | 0 条 | 最后一跑 07-29~08-05,预期 0 |
| P3 | Lead 模型别名 | `~/.flywheel/projects.json` 无 Lead 用裸 `opus` | 已核:7×`opus[1m]`(binding.opus1m 不动)+ fable + sonnet/codex,安全 |
| P4 | 5 个 menu 模板 `seed_owner` | 全部 `system` | 待实施时查(founder-owned 会 refused,切换假不生效) |
| P5 | 生产 `.env` 三段式行 | 仅 :132/:145 两行 | 已核 |

## 2. 代码改动(单 PR,TDD;删除边界全量清单见 research §5)

### Step 1 — 共用符号迁移(先迁后删的硬前置)

1a. **phase-orchestrator 的全部活跃 DAG 符号迁出**(Codex R1#1:不止 reconcileTurnBelt):
  - `reconcileTurnBelt`(:2209-2351)→ 新家 `packages/teamlead/src/bridge/turn-belt-reconcile.ts`;4 个消费点(DirectEventSink:1433 / event-route:2810,3025 / actions:1856 / plugin:9344)改指新模块。
  - `PhaseSession` 类型 → 改名 `WorkflowActorSession` 迁中性模块(或以 `Pick<Session,...>` 表达);生产消费点 `phase-actor-reentry.ts` / `holder-wake-activation.ts` / `workflow-rework-coordinator.ts` / `workflow-ship-carrier-coordinator.ts` 跟改。
  - `TURN_GRANT_GRACE_MS`、`GHOST_PROBE_MAX_ROWS`、`TurnBeltRow` → 迁 turn/recovery 中性模块;`HeartbeatService.ts:33-35,1872,1925` 跟改。
  - **删除前置断言**:`grep -rn "from.*phase-orchestrator" packages --include='*.ts'` 除自身测试外零命中,才允许 Step 2a 整删。
  - **RED 锚**:现有 turn-belt / holder-wake / rework / ship-carrier / Heartbeat grace-probe 测试在迁移中保持绿;迁移前跑一次记录基线,相关测试随符号迁移搬家。
1b. **`NO_THREE_STAGE_LABEL`** 迁到 `packages/teamlead/src/work-kind.ts`(其 `ROUTING_OVERRIDES_ALLOWLIST` 已含该字符串);label 字符串不改名。runs-route 等消费点改 import。
1c. **`threeStageKeepAliveEnabled` 删除、行为固化 ON**(FLY-1466「不加新 flag」同款):读点 Blueprint:1301,1619 / run-dispatcher:1743 / plugin:7946,8958 改为无条件走 keep-alive 分支;死分支(close-and-respawn legacy)一并删。
1d. **`packages/config/src/three-stage-phases.ts` → `phase-roles.ts`**:保留并改名共用符号(`isThreeStagePhaseRole`→`isWorkflowPhaseRole`、`ThreeStagePhase`→`WorkflowPhaseRole`、`THREE_STAGE_PHASE_SEQUENCE`→`PHASE_ROLE_SEQUENCE`、`resolveCompletionSessionRole`、`DEFAULT_PHASE_TIER`、badge 族、`phaseMessageTag`、`PhaseDispatchVendor`/`DesignBackend` 族);全消费点(约 25 文件)跟改。旧符号不留 re-export(净删除;全仓一次性改完,build 兜底)。
1e. **`phaseMessageTag`/`issue-display-refresher` 的 pending-row 模型回退改契约**:不得再读 phases 表。行为合同:pending row 的显示模型取 run 快照节点 dispatch(有 run 上下文时,refresher 侧)或省略模型名(无上下文,`[QA] `);实现按此合同 TDD。
1f. **`three-stage-config-source.ts` → `pipeline-config-source.ts`**(纯改名,`loadWorkKindConfigStrict`/`loadPipelineConfigByProject` 是 DAG 必需)。

### Step 2 — 删三段式机制

2a. 整删 `phase-orchestrator.ts`(2376 行)+ `three-stage-policy.ts`(339 行,共用符号已于 Step 1 迁出)+ 三段式专属测试族(research §5.1;`three-stage-turn.test.ts` 中 DAG activation 断言挑出移入 turn 相关测试)。
2b. `runs-route.ts`:删三段式 entry 块(:2262-2331 及其 activePhase 撞车检查中三段式专属半区)、DAG v1 entry 块(:2214-2255)、`designBackend` body 校验与早期门(:1116-1139, :1253-1268)、`allowSchemaV1Dispatch` 的 `|| (role==="design" && shareParentBranch===true)` 半边(:2464)。schema-1 candidate 的终态 = generalized selection 返回 null → 单 session(fail-safe,现有行为)。
  - **QA 返工修订:`runs-route.dag-recovery.test.ts` 删除边界显式化。** 13 条中 11 条绑定 schema-v1 fresh entry / `tpl_eng_heavy`,随 2b 退役;仍有效的 `#12c DAG_RUN_STATE_CORRUPT`、`#14 ACTIVE_ENGINE_RUN_UNCLASSIFIED` 迁入 `runs-route.dag-entry.test.ts`;另以现行 `tpl_code` schema-2 测试接住路由层 `GENERALIZED_LAUNCH_HELD` 与租约过期 generation 2 收敛。禁止以整文件名归类代替逐断言诊断。
2c. `plugin.ts`:删 PhaseOrchestrator 全部 wiring(research §5.2 行号);orphan-parked 告警(:10057-10092)与 DAG TURN wake(:9176/9309)保留。
2d. `DirectEventSink.ts` / `run-infra.ts` / `merge-ship-gate.ts` / `crash-reaper.ts`:删 orchestrator 依赖与三段式 seam(research §5.2)。**恢复合同在此定案,不留实现期临场判断**(Codex R1#5):
  - qa 节点死亡恢复的 DAG 等价物 = `WorkflowEngineDispatcher.reconcileDeadExecutions()`(engine-owned running node 终态 + dead probe → `StateStore.rollbackDeadWorkflowNodeExecution()`)。**删除前置**:为「DAG qa 节点 session 死亡 → 节点回滚可重派」写定向测试(含 Bridge 重启路径),绿了才删 `onQaPhaseTerminated`/`reconcileQaLoss`。
  - ship 侧等价物 = **`runResumablePostShipFinalization()` → `issueCloseout`/`closeoutIssue` → 确认不 blocked 后才 `cleanWorktree(true)`**(post-ship-finalization.ts:850-879 的既有 generalized 顺序;Codex R2#2 纠正 — ship-carrier-coordinator 只做 claim delivery/TURN grant/wake,不是 closeout 等价物,仅作 actor 类型覆盖来源)。**删除前置**:定向测试覆盖 engine-owned qa/implement/ship-carrier actor 被 issue closeout 收尾后才删共享 worktree,绿了才删 `finalizeThreeStagePhases` seam。
  - **若任一验证暴露真缺口:停下、修订本计划再走**(不在删除单里临场扩新恢复逻辑)。
2e. `StateStore.ts`:删 5-6 个纯三段式方法 + 3 个事件类型(research §5.2);`phase_chat_threads` 表本单**不删**(FLY-892 后已停写,只剩 read-only/归档 sweep;删表另立小单,控制本单半径)。
2f. `workflow-dispatch-resolution.ts`:删 schema-1 `current_config` 分支(:97-122)。v1 run 节点走 live_template → snapshot_fallback。
2g. **`resolvePhaseDispatch` 其余生产消费点逐一定替代语义**(Codex R1#2,research「唯一 DAG 消费点」指 dispatch 交界,显示/retry 面另有 4 处):
  - `actions.ts:934-951`(phase row retry):DAG retry 只走 run snapshot / `workflow_execution_runtime` admission dispatch,不再现读 phases 表;三段式 retry 分支随 entry 删。
  - `runner-model-display.ts:31-38` / `issue-display-refresher.ts:322,823` / `phaseMessageTag`:显示层统一合同 `runner_model → dispatch_model/run 快照 dispatch → 省略模型名`(即 Step 1e,扩为三处同款)。
  - `rescue-runtime.ts:256-280`:legacy phase successor 分支在 P1/P2 零在飞门下整删。
2h. **`WorkflowShadowWriter` 整退**(Codex R1#2):`workflow-shadow-writer.ts` 的启动回放读 `three_stage_fix_round`/phase session/`three_stage_verdict`,是 v1 shadow-run 时代的 legacy→DAG 影子桥;legacy 删除后桥无对象。整删文件 + plugin/run-infra/DirectEventSink 的 wiring + 其测试。**删除前置**:grep 证明其产出(shadow 账本行)无 schema-2 运行时消费者;若有,停下修订计划。

### Step 3 — flags / config 键清理(founder「flag 都清理掉」)

3a. 6 条 registry flag 删除 + tombstone(FLY-1466 范式,`retiredBy:"FLY-1674"`):`FLYWHEEL_THREE_STAGE`、`FLYWHEEL_THREE_STAGE_KEEPALIVE`、`FLYWHEEL_THREE_STAGE_QA_RESPAWN`、`FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT`、`FLYWHEEL_THREE_STAGE_CODEX_DESIGN`、`FLYWHEEL_PARK_BIASED_HANDOFF`。顺序:先删 entry + 加 tombstone(drift 测试变红 = RED 锚)→ 删读点转绿 → `flag-truth.test.ts` 正向退休断言(表驱动一组)→ claim 级 grep 零残留。
3b. `FLYWHEEL_THREE_STAGE_MAX_FIX_ROUNDS`:删 `NON_FLAG_ALLOWLIST` 条目 + plugin.ts:8187 读点(不进 tombstone)。`FLYWHEEL_PARKED_PHASE_STALE_HOURS` 保留改文案。
3c. `PipelineConfig`:删 `three_stage`/`three_stage_channels` 字段 + ConfigLoader 校验(:416-420, :443-464);保留 `dag`/`work_kind`;改 :432-441 注释。同步删两处 `.flywheel/config.yaml`(本仓 + 生产主仓,后者属部署动作)的 :257-258 两行与相关注释块。
3d. **PR 描述显式声明:推翻 FLY-1456 对 `three_stage_codex_design_toggle` 的「保持关」裁决**(founder 08-10 直令覆盖)。

### Step 4 — 菜单 effort 兼容(boot 炸弹的结构性拆除,两半)

**4-i. `parseMenuModel` 校验从「逐字相等」减弱为「子集」**(`workflow-menu.ts:162-172`):`allowedEfforts ⊆ registry workflow 面`(声明模型不支持的档 → 仍 throw,原防线保留)+ `defaultEffort ∈ allowedEfforts`(既有,保留);删去「必须列全」的等式半边。这是「逻辑只减不加」的减:约束从 `=` 减到 `⊆`。
**为什么必须减(而非靠部署顺序)**:逐字相等下,菜单 4 档声明 vs opus-5(5 档面)同样不等 → 只合代码不切 binding,下一次重启照炸。而 PR 合入与部署窗之间,updater 自动车 / launchd KeepAlive / 任何后续单的重启都会拉到本单代码 — **窗口不可控,原子性靠 checklist 是赌运气**。子集化后:菜单 4 档对 opus-5(⊆ 5 档)与 4.6(= 4 档)双态合法,任意顺序都不炸;「不同窗」的故障模式从 Bridge crash 降级为过渡期 qa 节点 effort 降档(opus-5+high,见 4-iii)。

**4-ii. 5 个 YAML 的 opus 行对齐**:`allowedEfforts: [low, medium, high, max]`、`defaultEffort: high`(4.6 无 xhigh;不擅自升 max,要升走菜单 override):`menus/shapes/{code,generic,design,prd,prototype}.yaml`。fable/codex 行不动。

**4-iii. 过渡期行为披露**:代码合入后、binding 切换前的窗口内,新编译 seed 的 opus 节点 = `opus-5[1m] + high`(原 xhigh)— 推荐部署序列同窗完成使该窗口趋零;万一分离,降档是 graceful 而非 crash。

**TDD(RED 先行)**:① 注入 `bindings.opus=claude-opus-4-6[1m]` 下 `loadWorkflowMenuSeeds()` 成功且 qa 节点 dispatch=`{claude, claude-opus-4-6[1m], high}`(现逐字校验下红);② 默认 binding(opus-5)下同样编译绿且 qa dispatch=`{claude, claude-opus-5[1m], high}`(双态断言);③ 反向护栏:菜单声明含模型不支持档(如 4.6+xhigh)仍 throw(子集防线阳性对照);④ **override 行为层断言**(Codex R1#6:`allowedEfforts` 同时是 `resolveMenuOverrides` 的节点级 override allowlist):过渡态(binding=opus-5、菜单 4 档)下 override 请求 `xhigh` → `EFFORT_NOT_ALLOWED_FOR_MODEL` 400(即使模型本身支持 — 菜单收窄是**有意的产品策略**:opus 节点的档位面统一按 4.6 上限声明,不随 binding 回摆),声明内 effort 正常接受。

### Step 5 — `phases` 段删除

`model-config.ts`:删 `ModelConfigFile.phases`、`PHASE_NAMES`、`createSnapshot` phases 分支(:420-468)、`ModelConfigSnapshot.phases`;`model-builtins.ts`:删 `BUILTIN_PHASE_DISPATCH`、`ModelPhaseName`、`ModelPhaseDispatchSpec`、:338 注释;`phase-roles.ts`(原 three-stage-phases):删 `resolvePhaseDispatch`、`resolvePhaseModel`、`nextPhase`、`DEFAULT_PHASE_DISPATCH`、两个 env kill-switch 分支;`config/src/index.ts` 导出面同步;`fleet/example/models.json` 删 phases 段;`fleet/README.md:29,40-41` 改。
**models.json 校验姿态维持现状**(未知键忽略、坏值 warn+回落):不为已删除的 `phases` 键新增拒绝逻辑(「逻辑只减不加」);生产文件里的段在部署序列中删除。

### Step 6 — 文案清理

research §5.3 尾行的全部「仅改注释/文案」文件(claude-runner ×4、terminal-mcp ×2、core ×3、WorktreeManager、adapter-types、progress-schema/resume、designer-labels、flywheel-comm turn/complete/index、Blueprint 提示词措辞去「three-stage pipeline」、alert 显示文案、`workflow_vendor_at_dispatch` description、founder-ux-config 对比文案、gemini-agent loop.ts 改「three-gate」防误 grep)。

### Step 7 — 全仓门(FLY-224/248 教训)

`pnpm lint`(全仓)+ `pnpm -r build`(拓扑序)+ `pnpm test:packages:run` + 相关 `scripts/__tests__/*.test.sh`。宿主既有环境项(headless Terminal.app 等)如实报告,不伪报整门全绿。

## 3. 测试策略摘要

- **RED 锚三处**:tombstone drift(3a)、菜单编译注入 binding 测试(Step 4)、turn-belt 迁移基线(1a)。
- **回归护栏**:DAG 派发链测试(workflow-engine-dispatcher / dispatch-resolution / run-dispatcher)全量跑;`resolveCompletionSessionRole`/badge 族消费点测试随改名跑;`feature-flags-registry/drift/flag-truth` 三件套。
- **删除面反向断言**:全仓 grep 收敛测试(见 §6 verify 脚本),纳入 `scripts/__tests__/`。

### 3.1 2026-08-13 founder 验收返工:最后一公里真进程证据

隔离房启动链已由独立 QA 定位为 FLY-1752(`tmux-server-rescue ensure` 与常驻 watcher 争用),本单不绕 FLY-913、也不把失败的开房路径写成通过。验收改为两处证据拼接,边界必须如实披露:

1. 前半段由独立 QA 的生产实证覆盖:`models.json bindings.opus → workflow_run.snapshot qa.dispatch → workflow_execution_runtime.model`。
2. checked-in `packages/teamlead/src/__tests__/fly1674-opus46-real-tmux.test.ts` 覆盖最后一公里:测试写入 4.6 binding、真实编译 `code` menu 的 qa 节点,把该节点产出的 `model`/`effort` 原样交给 `TmuxAdapter.execute`;adapter 在测试自建的短路径私有 tmux socket 上真起进程,PATH 中的假 `claude` 只负责把实际 argv 落盘。断言 argv 逐字含 `--model claude-opus-4-6[1m]` 与 `--effort high`,且 generation callback 回报的 socket 必须规范化等于测试私有 socket。
3. 突变检验把同一 binding 改为 `claude-opus-5[1m]`,仍走真实 menu 编译 + 真实 tmux + 真实进程,同一 4.6 证明函数必须以 `wrong --model` 红;再删除 argv 的 model flag,必须以独立的 `missing --model` 红。两种阴性形态不可混淆。
4. `run-dispatcher.test.ts` 在 credential-backed generalized fresh launch 上另断言 `launchCommitPath === launchCommitPath(executionId)`,补齐 QA 指出的 dispatcher 层 durable launch fence 合同。

这组 checked-in 测试不是「隔离房 Bridge e2e」,也不替代 merge 后的 live config 切换、Bridge 重启阴性对照与真实 run 运维验收(§4);它证明的是 DAG 编译节点 dispatch 到真实 Runner 进程 argv 的最终 seam。

## 4. 部署与验收序列(merge 后;founder-gated ship 纪律,FLY-270)

1. PR 合入 main(founder `:cool:` + `verify-approval`;本单不自 merge)。
2. 部署窗(操作者:Tadashi/updater 统一重启车):
   **a0. 部署时硬门(非实施前预检,Codex R1#4 — 消 TOCTOU 窗)**:重跑 P1/P2/P4(v1/NULL 非终态 run=0、三段式 in-flight session=0、5 模板 seed_owner='system'),任一不过 **abort 本次部署窗**,SQL/seed-owner 输出存档为验收证据;
   a. 生产主仓 `git pull`(代码含菜单对齐);
   b. 编辑 `~/.flywheel/models.json`:删 `phases` 段 + `bindings.opus` → `claude-opus-4-6[1m]`(推荐与 a 同窗完成,消除 4-iii 的过渡降档窗;子集校验保证任意顺序都**不炸**,同窗只是行为整洁);
   c. `~/.flywheel/.env` 删 :132/:145 两行;生产 `.flywheel/config.yaml` 删 `three_stage`/`three_stage_channels` 行;
   d. **重启 Bridge 一次 = 验收 3**(不炸;`importWorkflowMenuSeeds` 用新 binding 重编译 5 seed → 新 revision);
   e. 若失败回滚:models.json 恢复 opus-5[1m](子集校验下单独回滚 binding 亦安全,不需与代码成对)± git revert 部署。
3. 真实 run 验证(= 验收 2,由 QA 节点/独立 QA 执行,不由实施者自证):
   - 派一条真实 code-shape run 至 qa 节点;
   - 证据 ①:`workflow_run.snapshot` qa 节点 `dispatch.model='claude-opus-4-6[1m]'`(SQL 已在 research §1);
   - 证据 ②:`workflow_execution_runtime` 该执行行 `model='claude-opus-4-6[1m]'`(append-only 审计);
   - 证据 ③:QA session 的 tmux pane 进程 argv 含 `--model claude-opus-4-6[1m]`(`ps`/`tmux display`),加 session 内自证(如 `/status`);
   - 证据 ④:全仓 grep 验收(§6 脚本)零机制残留。
4. in-flight run 口径:切换时已启动节点保持旧模型,未启动节点(含在飞 run 的 qa 节点)用 4.6 — 写进验收预期,不算异常。

## 5. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 大 diff(-4000 行级)撞在飞单(FLY-1693 模板退役等) | 合前 rebase;冲突热区 seed/dispatch/runs-route;FLY-1693 无硬依赖(§research 5.5) |
| PR 合入与部署窗之间的意外重启(updater 自动车 / KeepAlive) | Step 4-i 子集校验结构性拆弹:双态 binding 下菜单都编译过,任意顺序不炸;残余影响仅过渡期 effort 降档(4-iii) |
| keep-alive 固化 ON 失去逃生口 | FLY-1466 同款裁决;rollback = git revert;生产从未设 =0 |
| DAG qa 节点死亡恢复真空(删 reconcileQaLoss/onQaPhaseTerminated 实现) | Step 2d 的删除前置定向测试;**发现真缺口 = 停下修订计划**(不在删除单临场扩恢复逻辑) |
| 显示层 pending-row 回退行为变化 | Step 1e 行为合同 + TDD;founder 可见面(thread 消息前缀)变化极小(仅 pending 短窗) |
| 实施者自证偏差 | 真实 run 验证由 DAG qa 节点/独立 QA 做(feedback_code_change_needs_proactive_independent_qa) |

## 6. 残留守卫(验收 1 的可执行形态 — checked-in、fail-closed,Codex R1#3)

新增 `scripts/__tests__/fly1674-residue.test.sh`(接入 CI,模式仿 FLY-1631 仓库级残留守卫),**扫工作树全集**(`rg --hidden`,含未跟踪文件、`.github/`、`.lead/`、根文件、`*.yml/*.json`):

1. **历史文档排除表(显式,Codex R2#1)**:`engineering/doc/`、`doc/`、`product/doc/`(现有 43 个 tracked 历史 PRD/研究/HTML/JSON 命中 — 是历史记录不是机制,不删、不扫)、`dist/`。除此四类外全部纳入扫描。
2. 主扫描**大小写不敏感**:`grep -riE 'three[-_ ]?stage'`(等价覆盖 ThreeStage/THREE_STAGE/`Three-stage` — 已实证大小写敏感式漏报 `fly707-enablement.test.ts:146`);命中必须**恰好落在精确 `(path, token)` allowlist 内**,不用宽泛 `grep -v`。allowlist 四类(= §8 诚实边界的机器可读形态):
   - `packages/config/src/feature-flags/truth.ts` × 6 个 tombstone 行(审计元数据);
   - 表名 `three_stage_turn`(flywheel-comm/db.ts 等 DAG 共用表位点);
   - label 字符串 `no-three-stage`(work-kind.ts / runs-route.ts / StateStore CHECK / config.yaml 运维注释);
   - alert kinds `three_stage_stuck`/`three_stage_takeover_failed`(生产 5 文件 + scripts/lead-alert.sh;**测试引用优先改为引用 kind-contract 常量**,改不动的以 `(path, token)` 精确列入 — 现存 3 个测试文件字面量:founder-thread-notifier / infra-alert-wiring / infra-event-router 测试)。
3. **每个 allowlist 项带存在性断言**(项失踪 = 死豁免 = 红)+「无 allowlist 外命中」断言(新增残留 = 红)+ **混合大小写阳性对照**(临时 fixture 含 `Three-stage` 必须被抓红 — 证尺子)。
4. 符号级零断言:`resolvePhaseDispatch|BUILTIN_PHASE_DISPATCH|DEFAULT_PHASE_DISPATCH|PhaseOrchestrator|resolveThreeStageEntry|WorkflowShadowWriter` 在 tracked `*.ts`(非 dist)零命中。
5. 既有活引用一并清理(Step 6 范围扩入):`.github/workflows/ci.yml:543`、两个 `.lead/*/identity` 文件、`fly707-enablement.test.ts:146` 的三段式文案。
6. 部署后一次性检查(不进 CI,可真跑):`python3 -c "import json,pathlib;d=json.load(open(pathlib.Path.home()/'.flywheel/models.json'));assert 'phases' not in d;assert d['bindings']['opus']=='claude-opus-4-6[1m]'"`。

## 7. 与相邻单的关系

- **FLY-1650/1652**(已 merge):依赖其 registry 注册 + effort 收窄 + 四咽喉点,零重做。
- **FLY-1693**(**已合入 main,`4b47fe3c`** — Codex R1#4 核出,research 期的 pending 状态已过时):旧 template 已退役(含 4 条 v1 held run 的 tpl_eng_heavy);本单删 v1 dispatch 分支,方向一致。**实施基线以最新 main 为准,rebase 后在 FLY-1693 已落地的现实上复核 v1 fallback 行为**(retired template 下 live_template 查找 throw → catch → snapshot_fallback)。
- **FLY-1456**:CODEX_DESIGN「保持关」裁决被本单推翻(founder 直令),PR 显式声明。

## 8. 明确不做(诚实边界)

1. `three_stage_turn` **表名**不改(DAG 共用表;rename=migration + CLI/Bridge 双写者 build-skew 风险;TS 类型名与注释改)。
2. label 字符串 `no-three-stage` 不改名(Linear 存量 + CHECK 约束 + founder 肌肉记忆;语义注释改写为「单 session 直跑」)。
3. alert kind 字符串 `three_stage_stuck`/`three_stage_takeover_failed` 不改(FLY-1204 orphan-parked 活机制在用 + 跨 5 文件/shell/claims 历史兼容;显示文案改)。
4. `phase_chat_threads` 表不删(已停写只读;另立小单)。
5. `tiers` 不切 4.6(founder 只拍了 QA 节点/bindings.opus;tiers 维持 opus-5[1m])。
6. `bindings.opus1m` 不动(7 个 Lead 在用 opus[1m],founder 明确 Lead 这轮不换)。
7. Lead 面不给 4.6(FLY-1650 边界维持)。

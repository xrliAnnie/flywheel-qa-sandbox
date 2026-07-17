# FLY-1329 session 生命周期底座收口 — 实施计划

Issue: FLY-1329 (https://linear.app/geoforge3d/issue/FLY-1329/infra-session-生命周期底座收口-重启收尾路径不得杀-park-aliveexecutor-merge-必须)
日期: 2026-07-17
基于: research.md(+ 其 v2 勘误增补节;冲突处以本 plan 为准)

> brainstorm gate 已过。Codex design review:R1 9 条全采纳(v2);R2 6 BLOCKER + 2 HIGH + 1 MEDIUM 全采纳(v3):四输入裁决、compare-and-upsert、source-discriminated 证据、pending 闭环、D3 证据先行、FLY-1251 不变量、PR-D 收窄;R3 4 BLOCKER + 1 MEDIUM 全采纳(v4):恢复元数据 resolver、可重试 pending claim、legacy merge_block 迁移 + marker schema、D3 防误杀护栏、research §5 对齐;R4 2 BLOCKER + 1 MEDIUM 全采纳(本版):recovery identity 改 spawn 时 tmux window options 持久化(macOS SIP 下 ps eww 路线作废)、三专用 pending 候选查询 + 三 slot guarded-mutator 存储合同、版本标签统一。**本文件为最新基线(v5);与 research.md 冲突处以本文件为准。** R5 = **stopgap 轮(Claude reviewer,Tadashi 裁定的降级路径:school 配额穿墙至 7/22、personal Free 跑不了任何 codex 模型)对 R4 窄 delta 判 PASS**(三项全 CLOSED + 3 注记已折入下文);**正式 gpt-5.6-sol xhigh 补审记 pending,配额恢复即跑,不 waive**——补审若翻出问题在 implement 期折入。

## 0. 总览

| PR | 缺陷 | 一句话 | 主要文件 |
|---|---|---|---|
| PR-A | D1 | 四输入破坏性裁决 + 全角色 re-adopt(消费者+CommDB compare-and-upsert 修复)+ effect 拆分 | phase-orchestrator.ts, plugin.ts(effects), HeartbeatService.ts, StateStore.ts, tmux-lookup.ts, commdb-fsm-reconcile.ts, commdb-session-prune.ts, done-running-reconciler.ts, event-route.ts(FLY-324 live handler), flywheel-comm db.ts(新原语) |
| PR-B | D2+D3 | source-discriminated 证据契约 + verify-approval 级授权 + 五路合一 finalizer + pending-marker 闭环 + 两种收口拆分(D3 证据先行) | 新 external-merge-finalize.ts, external-merge-reconcile.ts, event-route.ts, DirectEventSink.ts, merge-ship-gate.ts, post-ship-finalization.ts, close-runner.ts, terminal-mcp(按重演结论) |
| PR-C | D4 | founder 放行只认 same-head PASS / exact-head docs-only snapshot;NULL 未决 fail-closed;qa_required 退出放行判定 | auto-qa-held.ts, gate-poller.ts, park-watch.ts, founder approval handlers |
| PR-D | D5 | terminal-commdb-sync 严格扩为 failed\|blocked\|completed + turn 看 CommDB 终态 | terminal-commdb-sync.ts, plugin.ts, DirectEventSink.ts, flywheel-comm turn.ts |

**顺序(确定性;R2-7 修订)**:默认 **#627(FLY-1314)先合**;**A/B/C/D 四个 PR 全部基于其合入后的 head**(#627 实改面含 DirectEventSink.ts / event-route.ts / external-merge-reconcile.ts / merge-ship-gate.ts / plugin.ts / HeartbeatService.ts / StateStore.ts —— 正是 PR-B 核心刀口)。rebase 后必跑:PR-A 的 R-1319 + absent 突变;**PR-B 的四入口 shared-finalizer、R-1283 三变体、merge-block 迁移、engine-precondition 回归**;PR-C 的 race + FLY-1251 钉子测试;PR-D 的 TURN 组。fallback:若 #627 停滞而本单 P0 先行,#627 必须 rebase 且其 merge gate 纳入 R-1319/absent 突变 + **PR-B 语义冲突审计**(四入口/merge-ship-gate 交叠),C/D 再基于合并后 main。

**kill-switch 清单**:A1/A2 `FLYWHEEL_PARK_BIASED_HANDOFF=0`;A3 `FLYWHEEL_READOPT_PARKED=0`;A4/A5 `FLYWHEEL_PRUNE_PARK_GUARD=0`;A6 无独立开关(纯 seam 重构,行为归 A1 开关;回滚=revert PR-A,byte-compat 由 legacy 测试钉住);PR-B `FLYWHEEL_EXTERNAL_MERGE_FINALIZE=0`(Fix D 原开关照旧);PR-C `FLYWHEEL_QA_FIRST_HOLD=0`;PR-D `FLYWHEEL_COMMDB_TERMINAL_SYNC_COMPLETED=0`。

## 1. PR-A — D1

### A1 破坏性裁决:四输入模型(R2-1 重写)

新纯模块 `destructive-verdict.ts`。裁决输入 = **(action, fresh lifecycle authority, declared state, liveness)**,不是单看 liveness:

**授权分支(允许破坏)**:
1. `dead_pin`(正向进程死亡证据)→ 授权 liveness-derived close(handoff close-clean / crash-reap 类);
2. **独立正向 authority**(与 liveness 无关,显式列举):post-ship finalization claim;founder/issue-terminal disposition(forcePreserved/审计路径);FSM 已 terminal(fresh re-read)且无未过期 parked 冲突 → 允许清理 CommDB residue(**A4 语境:absent 或 dead_pin 都可清**——正常 teardown 后窗必然 absent,terminal residue 必须可 prune,这是 R2-1 对 v2 绝对措辞的修正);合法 completed assertion(FLY-324 语境,见 A5)。

**否决规则**:`absent` 永不授权**非终态** session 的 close / finalize / spawn-replacement;`indeterminate` 同;未过期 `parked` 声明对 A4/A5 语境是 **veto**(命中 → skip + `prune_skipped_parked_conflict` 告警)。活动证据(A2)只影响告警措辞。

**probe API 事实(R2-1)**:三态 `probeTmuxWindowLiveness`(window-miss→dead,tmux-lookup.ts:283-313)是 A4 现用探针;四态 `dead_pin/absent` 只在 `probeRunnerProcessLiveness`。落点原则:**需要区分 dead_pin/absent 的消费者(handoff、wake/spawn)用四态探针;A4 的 terminal-residue 清理不需要区分**(authority 分支 2 已放行),只需加 parked veto——不强迫 A4 换探针。

落点:
- `handoff()` prev-phase:`alive`→park;`dead_pin`→close-clean;**`absent`→park + `park_liveness_downgrade` 审计 + 继续 dispatch 下一 phase**;`indeterminate`→现状 fail-closed(byte-compat)。
- `isWakeTargetProvenDead()`:仅 `dead_pin` 允许弃 wake 改 spawn;absent → wake 或 hold(防双开)。
- A4(`reconcileCommDbRunningAgainstFsm`/`pruneDeadTerminalCommDbSessions`):保留现探针与 terminal 前提,新增 parked-veto(fresh StateStore terminal + 无未过期 parked → 照常清;parked 冲突 → skip+告警)。
- A5(FLY-324):**boot sweep(done-running-reconciler.ts)与 live handler(event-route.ts:2091-2138)两处同改**——parked 声明 = veto;不要求 dead_pin(live `stage_changed` 到达时进程本来活着,completed assertion 本身是 authority 分支 2)。

**absent 尸体运营边界(不变)**:FLY-1204 alert-only;人工经 closeSessionResidue 收口;不新增自动收尸器(非目标)。

### A2 活动证据 = 告警注释(不变)

`liveness-evidence.ts`:absent 时采集 heartbeat_at + CommDB messages 最近时戳,仅写入告警正文(likely-alive/likely-dead);env `FLYWHEEL_LIVENESS_ACTIVITY_WINDOW_MS`(默认 600000)只影响措辞。

### A3 re-adopt 全角色 + CommDB compare-and-upsert(R2-2 修订)

1. 候选:新 `getReadoptCandidateSessions`(`running|awaiting_review|design_done|approved_to_ship`;不动既有查询语义)。
2. 消费者:legacy/V2(HeartbeatService.ts:946-957,1010-1021)park 态走 parked 分支——恢复监控/记账,不改 status;probe 失败 alert-only。
3. **CommDB 映射修复原语(R2-2)**:flywheel-comm db.ts 新增 **compare-and-upsert**:
   - stale-row 路径:`UPDATE sessions SET tmux_window=? WHERE execution_id=? AND tmux_window=?`(旧值匹配才更新,CAS);
   - missing-row 路径:仅当 fresh StateStore 仍处 parked/readopt 允许状态 **且** recovery identity 唯一匹配 **且** `NOT EXISTS` 时条件 INSERT。**恢复元数据 resolver(R3-1;R4-1 重写——`ps eww` 在 macOS SIP 下读不到他进程 env,仓库已有记录 qa-multilead.sh:377-382 / qa-fly-529-alert-smoke.sh:69-75,且 Claude/no-transport adapter 本就不注入 vendor env,该路线作废)**:改为 **spawn 时持久化不含秘密的 recovery identity** —— TmuxAdapter 家族在创建 runner window 时写 **window-scoped tmux user options**(`@flywheel_exec_id` / `@flywheel_lead_id` / `@flywheel_vendor`)并读回确认(选项随窗存活、rename 不丢);rediscovery = `tmux list-windows -F` 精确匹配 option → 取 immutable tmux target,再与 StateStore `adapter_type`→vendor canonical 映射交叉校验;project/issue/started_at 取自 StateStore。**旧窗口缺 marker、重复 marker、字段不一致 → 一律 fail-closed(放弃 + 告警),绝不写 NULL/猜默认值;绝不扫描或记录完整进程环境**(credentials 红线)。旧窗口(本次部署前 spawn)缺 marker 属已知边界:alert-only,人工处理。测试(macOS real-tmux):codex / claude-code / none / rename 注入 / 重复 identity / 旧窗无 marker,全部 fail-closed;
   - 写后 re-read 验证;任何并发变化 fail-closed(放弃 + 告警)。绝不用无条件 `registerSession` 覆盖竞争者。
   调用方 `rediscoverTmuxTarget(execId)`:按上述 window-option 精确匹配,唯一命中才修;审计 `commdb_tmux_mapping_repaired`。re-adopt parked 分支与 boot seed 各一次,无新 timer。**R5-stopgap 注记(实现必读)**:① [HIGH] cmux-sync 会为每个 runner 窗建 grouped linked session(flywheel-cmux-sync.sh:2766 link-window)——`list-windows -a` 会把同一窗按 linked session 数重复列出,「恰一行=唯一」的天真判定在生产每个窗上都会假失败 → **唯一性必须按 distinct `#{window_id}` 去重(或把枚举 scope 到 adapter 自己的 runner-* base session)**;real-tmux 测试清单加 linked-session fixture。② [MED] 「TmuxAdapter 家族」实为**两个写点**:base `TmuxAdapter.execute()` 的 new-window 后置写(FLY-1272 remain-on-exit 同型,claude/kimi/antigravity 继承)+ **CodexTmuxAdapter(implements IAdapter,不继承 TmuxAdapter)的 TUI-window 路径**(onThreadReady 懒建 + 每次 reopen 重写;窗从未建出 → 落 fail-closed alert-only 桶,已覆盖)。③ 佐证:window user option + `#{@option}` format 读取在本生产栈已有先例(flywheel-cmux-sync.sh:2672/2165 的 @flywheel_cmux_owner),option 附着窗实体、rename 不丢。
4. 测试:重启集成(park + row 缺失/窗名过时 + rename 注入 → 候选/监控/映射修复/status 未动);**三竞态**:stale-row CAS loser、missing-row 并发 insert、扫描期间被 terminalize —— 全部 fail-closed。

### A6 effect 拆分 + 调用图矩阵(维持 v2,R2 无新意见)

`closePhaseSession` / `removeSharedWorktree` 拆分 + 调用点 allow-matrix(handoff legacy ✓✓ / dead_pin ✓✗ / park 路径 ✗✗ / QA-FAIL cleanup 现状 / QA respawn 现状 / post-ship 不经此 effect);keep-alive ON 非 ship 语境断言 branchDeleted=false;dead_pin→下一 phase worktree 重建测试。

### PR-A 测试

- destructive-verdict 四输入矩阵(action×authority×parked×liveness);isWakeTargetProvenDead;A4 terminal-residue 照常可清(absent) + parked veto 两侧;A5 boot+live 两处 veto。
- R-1319 重演(park、FSM 不动、branch B 未删、下一 phase 照常 dispatch;突变必红)+ A3 重启集成 + 三竞态。

## 2. PR-B — D2+D3

### B1 证据契约:source-discriminated(R2-3 重写)

`finalizeObservedExternalMerge(deps, session, evidence)` 的 `evidence` 按来源判别:
- **local-completion**(DirectEventSink / event-route session_completed):要求 validated `evidence.headSha == authoritative head` + `landingStatus.status==="merged"`;无 actor → 记 `actor_pending`;
- **GH-verified**(Fix D / pending-reconciler):要求 `headRefOid == authoritative head`,携带 `mergedAt/mergedBy/mergeCommitOid`(actor 齐备);branch 推导要求唯一 PR 且 exact headRefOid 匹配;
- **W2**(payload 仅 prNumber/mergeCommitSha,**mergeCommitSha ≠ PR head,不可与 authoritative head 相等校验**):W2 **不直接 finalize**,写 `merge_evidence_pending` marker,由有预算的 GH reconciler 验证后走 GH-verified 路径收口(选择理由:不动 stage.ts producer 契约)。

### B2 授权 + 共享 finalizer(维持 v2 骨架)

`resolveMergeAuthorization` 只认:(a) 绑定 review question 的 gate response + trusted founder provenance + exact merged head(verifyApproval 同源);(b) `workflow_source_event(kind='founder_approval')` canonical claim(execution/issue/project/head/authority 校验)。排除 ship_approval_requests / founder_action_ledger(负样本测试)。engine precondition 保留;engine 不放行 → `external_merge_engine_gap` marker + completed 收敛。记账 `session_params.external_merge`(actor/merged_at/sha/authorized/source/actor_pending)+ `external_merge_finalized` 审计;authorized→finalize,未授权→finalize+violation 恰一次;dedupe 沿用。

### B4 pending-marker 消费闭环 + 五路合一(R2-4 新增;R3-2/R3-3 修订)

- **pending marker 存储合同(R3-3;R4-2 修订)**:`session_params.external_merge_pending` 下 **三个独立 slot**(`actor` / `evidence` / `engine`,同 exec 可共存互不覆盖——local-completion 可能同时产生 actor_pending 与 engine_gap),每 slot 字段 `{prNumber?, authoritative_head_at_mark, source_event_id, marked_at, merge_commit_sha?(仅注释,永不当 head 用), attempts, last_error?}`(缺 `pr_number` 时 W2 的 mergeCommitSha 是最强 GH 查询线索,必须保存)。**guarded mutator**(现 `patchSessionParams` 是 overwrite-only get→set,不可用):新 helper 返回 win/no-op,CAS 条件 ≥ execId + slot + expected kind/head/source_event_id/attempt,且保留所有无关 `session_params` 键。
- **三个专用候选查询(R4-2 恢复 v3 承诺并写死)**:独立于现有 parked/completed 过滤器(那两组要求 pr_number、跳过 merge_block、排除已 post-ship-claim 行,external-merge-reconcile.ts:432-469 —— pending 候选不受这些过滤):`getActorPendingSessions`(**必须包含 completed / 已 post-ship-claim 行**)、`getEvidencePendingSessions`、`getEngineGapSessions`;三类进入同一 per-project 预算与轮转。
- **可重试语义(R3-2 核心;不再用「跑前永久领取」的 once-claim)**:
  - `actor_pending`(enrichment-only,允许已 completed/已 post-ship claim 的行):**先取证**(gh mergedBy)→ **原子改写 marker** → 成功后写 success receipt(`external-merge-actor-${execId}`)。崩溃/GH 瞬时失败 → marker 原样保留 + attempts++,下一 pass 可重试;
  - `merge_evidence_pending`(W2 产 + legacy 迁移产):GH exact-head 验证成功 → 走完整 shared finalize(其自身的 post-ship claim 即最终 receipt);验证失败/瞬时错误 → marker 保留重试;
  - `external_merge_engine_gap`:**不预领永久 once-key** —— 每 pass fresh-check engine precondition;转绿 → 调用现有 post-ship arbiter(`runPostShipFinalization` 自己的 claim `post-ship-finalization-${execId}`,post-ship-finalization.ts:474-486,就是天然仲裁);仅在观察到该 claim 已建立或明确完成 receipt 后清 marker;pre-arbitration refused/throw → 保留重试。
- **`finalizeRecoveredMerge`(merge-ship-gate.ts:397-497)并轨(R3-3 修订)**:它只有 merge_block_head/reason,喂不进 B1 的两类 evidence union —— 不做「直接重定向」;改为**该入口只做 legacy `merge_block` → `merge_evidence_pending` 的原子迁移**,由预算化 GH reconciler 完成 exact-head 验证后再进 shared finalizer。第五条独立收口路就此消灭且不伪造字段。
- **测试**:R2-4 三 race + **claim 前/后崩溃恢复、transient GH failure 下一 tick 可重试**(R3-2)+ **legacy merge-block 迁移、无 pr_number 的 W2、head 演化、stale marker**(R3-3)+ **R4-2 组**:已 post-ship-claim 的 actor_pending 能入列;actor+engine 同 exec 共存互不覆盖;GH await 期间 marker/head 被替换 → CAS loser 放弃;三类候选共享预算不饥饿。

### B3 两种收口 + D3 证据先行(R2-5 重写)

- v2 的 tools.ts 候选放宽**作废**(tools.ts:352-399 是通用 /resolve-action,无 close_runner action;terminal-mcp 的 `DONE_STATUS_SET` 已含 running/awaiting_review/approved_to_ship/design_done)。
- **D3 第一步 = 在当前 head 重演那条精确的 "No session found"**(implement phase 的第一个 TDD 红灯),区分三形态并各自成测试:
  1. StateStore row 缺失 → 无 FSM row 可 applyTransition:`closeSessionResidue` 定义 **issue-level cleanup**,带防误杀护栏(R3-4;retry 后继与旧 residue 共享 issue id,这是硬约束):**优先要求显式 `execution_id`**;identifier-only 时先 fresh 解析 Linear UUID/identifier/project + 取 lifecycle mutex,再按 exact-project 精确枚举 CommDB,候选 0 或 >1 一律 fail-closed;**每项破坏动作前 fresh-check StateStore/launch claim,发现 active successor 立即停**;只用选定行的精确 tmux target,禁止名称模糊匹配;**runner/view/CommDB residue 清理与 thread archive 拆权威** —— 后者仅在 fresh issue-terminal/founder disposition 且无 active successor 时允许。测试四形态:旧 completed + 新 running retry;扫描中 successor 出现;同 identifier 跨 project;identifier-only 无 UUID 映射。绝不合成 shipped;
  2. StateStore row 在、仅 tmux/CommDB 缺失 → 先验证现有 done=true 是否已 best-effort 成功(可能无需改动,只补测试钉住);
  3. Terminal MCP scope/disambiguation 形态 → 修真实入口(terminal-mcp/src/index.ts:554-621 / plugin.ts:2200 链路,按重演结论定刀口)。
- `finalizeMergedSession`(exact merge 证据 + 授权 + engine guard → 可跑 post-ship DAG)与 `closeSessionResidue`(lifecycle close,绝不标 shipped;blocked 默认 preserve;强制收口走 forcePreserved/issue-terminal authority + 审计)维持 v2。founder-consent reserved-action 边界不变。

### PR-B 测试

R-1283 三变体(合法/无痕迹/merge-blocked 迁移)+ 授权负样本 + 四入口 finalizer 调用 + B1 三种 source 契约(W2 不直接 finalize、mergeCommitSha 不当 head 用 = 负向断言)+ B4 三 race + D3 三形态 + 突变验证。

## 3. PR-C — D4(R2-6 重写:qa_required 退出放行判定)

**FLY-1251 不变量保持**:founder 放行只有两条路——same-head `passed` auto_qa_record,或 server-classified exact-head fresh `ship_relevant===0` snapshot。`qa_required` **只控制 coordinator 是否 spawn QA,不作为 founder 放行豁免**(现 reviewHoldReason 本来就不读它;qa-fly-1251-ship-gate.test.ts:160-186 与 review-held.test.ts:96-105 钉死的「code PR 即使 qa_required=0 且无 record 必须 hold」全部保持绿)。

新决策表(仅 main awaiting_review;其余分支不动):

| 条件 | 结果 |
|---|---|
| `!hasReviewEvidence(session)` | 走旧逻辑,**含 FLY-1251 的 missing head/PR fail-closed 分支**(不是无条件 release) |
| same-head `passed` record | 放行(既有) |
| exact-head fresh snapshot `ship_relevant===0` | 放行(既有,docs-only authority,Tadashi 补充 b 由此满足) |
| snapshot 判定 stale / PR-mismatch / code-bearing / 缺失,且无 passed record | **hold**;其中「coordinator 未决策且 snapshot 未决」的窗口显式命名为 `qa_pending_decision`(新 reason,封 1319 race) |

- `qa_pending_decision` 消费者穷举:auto-qa-held ReviewHoldReason 类型 + deferrable 集合(:106-121)、park-watch、founder deferred-approval / approval handlers 及测试。
- GatePoller approve_to_ship:session 仍 `running` 或按上表 hold → 不 relay、不 fallback、不 evict。
- `hasReviewEvidence` 抽共享。
- 若未来要「policy-off 的 code PR 绕 QA」= 新产品/权限决策,单独立项获批,不属于本 P0(R2-6 结论,写死在此防 scope 蠕变)。

### PR-C 测试

决策表全矩阵 + FLY-1251 既有钉子测试保持绿(显式列入回归清单)+ head 演化回归(docs-only head → code head 必 hold,突变验证)+ R-1319-race + 老路径回归。

## 4. PR-D — D5(R2-9 收窄)

- terminal-commdb-sync 镜像集合**严格扩为 `failed|blocked|completed`**(CommDB CHECK 集合内;terminated/rejected/deferred/shelved 不映射不忽略地留在本单范围外——如需扩面另立映射表,非本单);DirectEventSink terminal 写路径 enqueue;条件更新不覆盖先落终态。
- `turn.ts`:holder 本人 CommDB row 已镜像终态 → `no-turn`;**同步更新 `TurnStatus`/`formatTurnStatus` 的稳定 CLI contract 测试**(输出文案变化走契约测试,不只改内部判断)。
- `reconcileOneTurn` completed-holder 放宽 + `deleteTurnIfCurrent` CAS(rebase 于 #627 复用)。
- 测试:fbe23871 形态;非终态 route 不镜像(负向+突变);failed 先落不被 completed 覆盖;CLI 契约。

## 5. 部署与 ship 注意(不变)

Bridge 侧 + turn.ts 读侧;生效 = merge + 生产 pull + Bridge 重启(合批;bridge-ship-discipline)。ship 前先拉平 main(生产落后 99 commits)。三段式:implement TDD;QA 独立真机段(529 Room / real-tmux:窗名漂移注入、park 存活、executor-merge 收敛)。merge founder-gated。

## 6. 验收核对

| issue 验收 | 落点 |
|---|---|
| 重启不杀活 park-alive / 不丢 CommDB row / re-adopt 全角色 | PR-A(A1 四输入裁决 + A3 消费者/compare-and-upsert + A4/A5 veto + A6 拆分)+ R-1319 + 重启集成 + 三竞态 |
| executor-merge → FSM finalize 同路 + merge_actor 记账 | PR-B(B1 证据契约 + B2 授权 + B4 闭环/五路合一)+ R-1283 三变体 |
| FSM-side finalize 工具(session-gone 僵尸) | PR-B(B3:D3 证据先行三形态 + finalizeMergedSession/closeSessionResidue) |
| QA-first 硬序 | PR-C(FLY-1251 不变量保持 + qa_pending_decision fail-closed)+ race + head 演化 |
| 回归重演 1319/1283 | R-1319 / R-1283(带突变验证) |
| complete/turn 滞后(低优) | PR-D(failed\|blocked\|completed 镜像 + turn 契约) |

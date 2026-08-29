# FLY-1185 统一生命周期收尾 — 实施计划

Issue: FLY-1185 (https://linear.app/geoforge3d/issue/FLY-1185/fix-统一生命周期收尾-issue-完结-分支worktreerunnercmuxthreadlinear-全现场归零一个机制一次修好)
日期: 2026-07-11(R8:SCOPE 重定为统一生命周期收尾,Annie 直令;此前 R1×12 + R2×8 + R3×5 + R4×3 + R5×2 + R6×2 → R7 APPROVED 的全部安全合同原样保留)
基于: research.md

## 0. 目标 / 非目标 / 合同性质

**目标(Annie 直令,一个机制一次修好)**:**issue 到达终态(Done / Canceled / parked-by-founder)⇒ 自动归零六项现场**:①已合并/废弃分支(远端+本地)②worktree(含 QA scratch `*-qa` 族)③runner session(含 husk finalize、异常退出认领)④cmux/tmux 窗口⑤Discord thread 归档⑥Linear 状态一致——外加 Tadashi gate 折入的 ⑦runner spawn 的 MCP server 子进程。异常路径由 sweep 兜底,同一套安全边界(open-PR / 3 天活跃 / founder 保留不动),全部动作留审计。**禁止拆票、禁止只修一角。**

### 0.5 统一生命周期合同(六项 × 终态入口矩阵)

**一张 checklist,五个入口,全部走同一个执行器 `lifecycle-closeout.ts`(新)**——每项 = 幂等删除器(不存在 → 审计 skip),失败只审计不中断,sweep 作 eventual repair:

| 入口(何时触发) | 现有骨架(去留) | 触发的 checklist 范围 |
|---|---|---|
| **A. ship 终态**(verify-approval 后 merge)| `post-ship-finalization.ts`(已上线编排:tmux close→Layer A→archive→`finalizeThreeStagePhases`)+ **FLY-799 纯 collector 扩展接线**(R9#7 统一口径:`fanout-finalization.ts` 只是 traversal,cleanupNode 未接线、生产无 caller——本单以 `collectIssueCloseoutNodes` 首次接线)| 全七项,issue 级 |
| **B. 显式终态**(close/terminate/reject/defer,Lead 或 founder 动作)| `close-runner.ts`(cmux+thread archive-once)——**折入**,补 MCP + QA-ephemeral 项;CRASH_PRESERVE 语义保留(blocked/failed 的 worktree 留 sweep) | session 级 |
| **C. crash**(进程死/OOM)| **FLY-720 crash-reaper** + FLY-817 husk reconcile——**折入**(异常退出现场认领入口),补 MCP reap;worktree/分支仍留 sweep(取证保留) | session 级(FSM+cmux+thread+MCP) |
| **D. issue 终态 reconcile**(补"Linear 侧先 Done/Canceled 而本地没收"的缺口)| **FLY-1165 `done-thread-reconcile.ts` 折入扩展**(R8#4:它已有 boot+periodic single-flight、candidate/archive cap、deadline、spacing、alias-aware 查询、per-issue fail-close、mutation 前 triple liveness veto——D 复用这套预算与调度合同,扩展其动作面从"只 archive thread"到完整 checklist),**cutover baseline 守卫**(§2.12,R8#1:只对 cutover 后观察到 nonterminal→terminal 迁移的 issue 自动收;首轮即已 terminal 的历史 residue 一律只进人工清单) | issue 级 |
| **E. periodic sweep**(boot + post-ship 搭车 + HeartbeatService N-tick)| FLY-603 Layer B——**折入扩展**(本 plan §2 全部内容) | repo 级兜底 |

**机制去留盘点(Tadashi 点名三件 + 全部相关件)**:FLY-369 archive cascade = **折入**(archive-once sink 不动,checklist 调它);FLY-603 Layer A/B = **折入扩展**(全部 fail-closed 契约保留);FLY-867 cmux sync = **保留不动**(cmux↔tmux 对账器,与收尾正交,checklist 用现有 killCmuxLinkedSession);FLY-720/FLY-817 = **折入**(crash/husk 入口);**FLY-799 = 纯 collector,待扩展接线**(R8#3 纠偏:`fanout-finalization.ts` 自注明 cleanupNode/retry store 留待 integration,生产无 caller;本单以它为底扩成 authoritative `collectIssueCloseoutNodes` 并首次接线;ship 路径现调的 `finalizeThreeStagePhases` 一并折入);**FLY-1165 done-thread-reconcile = 折入扩展**(D 入口引擎);LinearIssueFinalizer = **折入**(⑥执行器,加 state 前置检查,§2.12)。**无一替换/重写**——统一的是合同与入口矩阵。

**session 终态 ⇒ 现场零残留**(原 R7 目标)是本合同在 A/B/C 入口的子集,原样保留。

**合同性质**:跨系统无原子提交 → 收尾 = **幂等、可恢复的 saga**;"原子"仅指单对象内顺序(reap→kill;quarantine 校验→force;锁内 fresh 复核→CAS 删)。**每条自动删除都有恢复路径**:merged 分支 = 审计里的 tip sha(对象仍从 main 可达,`git branch <name> <sha>` 即复活);unmerged 分支/worktree = bundle/quarantine 归档。

**非目标**:不动 FLY-720 语义与各 call site 的 cmux 失败序列(primitive reap-only);不动 CRASH_PRESERVE_STATE;不做跨机;Lead launcher 不改;moved-head 不伪造 merge 证据(`unmerged_tip_archived`)。

**硬约束**:零新 env feature flag。一切新**删除**行为挂既有 `FLYWHEEL_WORKTREE_AUTOCLEAN`(=0 全关);只读 dry-run 不受总闸;新常量硬编码;保留清单走项目 config(默认空=不变)。

## 1. 交付物一览(单 PR,三段式共享分支)

| # | 文件 | 改动 |
|---|------|------|
| 0 | `packages/teamlead/src/bridge/lifecycle-closeout.ts`(**新**) | **统一执行器**:七项 **DAG checklist**(§2.12:前置边 + `blocked(prerequisite)` 状态),session 级与 issue 级(`collectIssueCloseoutNodes` = FLY-799 collector 扩展接线)两粒度;**IssueDisposition = shipped\|canceled\|founder_parked** 三种 FSM 语义(canceled 走 terminated edge,绝不 finalizeDone 伪造 completed);五入口(§0.5 A–E)全部调它 |
| 0b | `packages/teamlead/src/bridge/done-thread-reconcile.ts`(**FLY-1165 折入扩展**,D 入口引擎) | 复用其全部调度/安全合同(single-flight/caps/deadline/spacing/alias/per-issue fail-close/mutation 前 re-read,reopen 获胜),动作面扩为完整 DAG checklist;**episode 守卫**(任何轮 first-seen-terminal 零 mutator,只有 durable nonterminal→terminal 迁移授权);反向 Linear 一致收紧(exact ship-complete 证明 + fresh non-terminal;canceled/parked 永不改写) |
| 1 | `packages/teamlead/src/bridge/branch-cleanup.ts`(**新**) | branch-specific merge 证据 + CAS 删除原语(§2.4)+ protected/shape/稳定闸 |
| 2 | `packages/teamlead/src/bridge/repo-mutation-lock.ts`(**新**) | **per-main-repo mutation coordinator**(进程内 async mutex,key=canonical mainRepoPath):WorktreeManager create/remove*、sweep、branch pass 全部共用;锁内 fresh 复核(§2.11) |
| 3 | `packages/teamlead/src/bridge/runner-teardown.ts`(**新**) | reap-only primitive(不碰 cmux/window;六 call site 保留各自 kill 序列) |
| 4 | `packages/teamlead/src/bridge/mcp-descendant-reaper.ts`(**新**) | MCP 家族表 + 后代 kill(SIGTERM/SIGKILL 前各一次 identity 复核)+ ppid-1 孤儿 reap |
| 5 | `packages/teamlead/src/bridge/worktree-quarantine.ts`(**新**) | recovery-complete 归档(**含 ignored files**,§2.8)+ restore-smoke 校验 |
| 6 | `packages/teamlead/src/bridge/cleanup-policy.ts`(**新**) | `CleanupPolicyByProject`,boot reconcile 前构建,注入四入口 |
| 7 | `packages/teamlead/src/bridge/worktree-reconciler.ts` | sweep v2(provenance/多键保护/QA-ephemeral/稳定废弃/quarantine/分支 pass/dry-run 同引擎;全程走 mutation lock) |
| 8 | `packages/teamlead/src/bridge/worktree-cleanup.ts`(Layer A) | 结构化 **pre-delete attestation**(R6#2)`{removed, actualBranch, headSha, branchDeleted, bindingVerified, bindingBranch, bindingGeneration}`——锁内、删除前 fresh 验证 path/branch/generation 四方一致才 `bindingVerified:true`(`git worktree remove` 会即刻销毁 admin marker,post-ship 不可能事后重读)。**过渡语义钉死(R7 non-blocking)**:部署前"无 binding"session 保留现有 session-scoped clean/registered-branch removal 但 `bindingVerified:false`(→ 远端即时删 skip 交 sweep);"有 binding 但 generation mismatch"才是 no removal——两者各有命名单测。(3b) issue 家族放宽 |
| 9 | `packages/teamlead/src/bridge/event-route.ts` + `packages/teamlead/src/DirectEventSink.ts` + `packages/edge-worker/src/ExecutionEventEmitter.ts` + `packages/edge-worker/src/Blueprint.ts` | **authority 绑定 = 创建时原子绑定,通道唯一**(§2.1,R5#1 选 a):Blueprint 创建 worktree 后携完整 `WorktreeInfo {path, branch, generation}`,**仅 bridge-local DirectEventSink** 调 `bindWorktreeOnce`;HTTP `TeamLeadClient` 模式无 authority 通道(其对象 unowned/manual-only);HTTP `worktree_ready` 降级为非 authority 展示元数据,对已绑定 session 的写入拒绝 + 审计 `worktree_binding_rejected` |
| 10 | `packages/teamlead/src/bridge/post-ship-finalization.ts` | Layer A 结果 → 绑定校验 + CAS 删远端;orchestrator 末尾 fire-and-forget 项目 sweep |
| 11 | `packages/teamlead/src/bridge/post-merge.ts` / `close-runner.ts` / `crash-reaper.ts` / `actions.ts` / `plugin.ts`(close-tmux) / `stale-blocker-guard.ts` | kill 序列前插 reap-only primitive;kill 逻辑零改动 |
| 12 | `packages/teamlead/src/bridge/close-runner.ts` | auto-QA scratch 即时 teardown(四重证明) |
| 13 | `packages/teamlead/src/HeartbeatService.ts` + `plugin.ts` | **detached maintenance tick**(§2.5):不 await 进核心 check() 链;独立 single-flight(慢 pass 跨 tick 只 skip 不并发);boot 一次 + 每 tick 孤儿 reap + 每 N tick sweep;cleanup 异常自吞不影响 checkStuck/reapOrphans |
| 14 | `packages/edge-worker/src/WorktreeManager.ts` | `classifyWorktreePath` + force 变体(仅 quarantine 通过后);create/remove 接 mutation lock(依赖注入,edge-worker 不反向依赖 teamlead) |
| 15 | `packages/teamlead/src/StateStore.ts` | `cleanup_ref_observations` 表(连续 eligibility)+ **原子 `bindWorktreeOnce`**(独立 binding 列组 `worktree_binding_{path,branch,generation,locked_at}`;普通 `patchSessionMetadata`/`upsertSession` 永远碰不到 binding 列)+ **`linear_state_observations` 表**(episode 状态机,R9#1)+ **`issue_disposition_intents` ledger**(founder park,R9#2)+ `collectIssueCloseoutNodes` 所需 alias/phase/auto-QA 查询方法 |
| 16 | `packages/config/src/types.ts` + `ConfigLoader` | `cleanup.protected_branches`(存在但坏 → disabled(reason)) |
| 17 | `packages/config/src/runner-mcp-profile.ts` + `adapter-types.ts` + `Blueprint.ts` + `TmuxAdapter.ts` | playwright positive opt-in 全链路 |
| 18 | `scripts/cleanup-sweep-cli.mjs`(**新**) | `--dry-run`(只读)/`--apply` = **提交器**(R10#3):把 `{manifest, approvedHash}` 提交 Bridge `/api/lifecycle-apply`(执行在 Bridge 进程内,共享 issue mutex/repo lock/budget);`--include-unowned` 只扩 manifest 明列的 Git objects,不隐式扩 session graph;Bridge 不可用 → fail-closed |
| 18b | `packages/core/src/workflow-fsm.ts` + `packages/teamlead/src/bridge/founder-consent/reserved-endpoints.ts`/`actions.ts` + `plugin.ts` + `packages/teamlead/src/bridge/lifecycle-admission.ts`(**新**,decorator + launch claim)+ `lifecycle-root-key.ts`(**新**,`resolveLifecycleRootKey`) | FSM 补边(pending→terminated;terminate.fromStates + design_done);**founder park-close / unpark reserved actions**(issue-scoped);**admission decorator**(锁内 check + durable `starting` launch claim,§2.12);**`/api/lifecycle-apply` endpoint**(api-token/founder-admin,claim 绑 approvedHash 幂等);通用 Linear Canceled finalizer |
| 19 | `scripts/setup-mcp-on-demand.sh`(**新**)+ `scripts/provision-fleet-host.sh` | machine settings 合并(原子写/保 mode/拒 symlink/坏 JSON;变化才备份)+ provisioning 接线 + shell test |
| 20 | 单测/集成测 | §4 全清单 |

**Ops(§6 顺序)**:founder 批准后 `delete_branch_on_merge=true`;`setup-mcp-on-demand.sh`;存量首扫按 §6。

## 2. 模块设计

### 2.1 所有权 provenance(R1#1 + R2#1 + R3#1 + R4#1/#2)

**威胁模型(R3/R4 实证)**:`/events` ingest token 是 Runner 可见的共享凭据——HTTP `worktree_ready` 的"第一次写"也可被别的已运行 Runner 抢占(first-writer-wins ≠ 可信);生产还有第二个无锁写入口 `DirectEventSink.emitWorktreeReady()`;两个 start 路径都不持久化 branch;同 issue 的 deterministic path/branch 会被 `git worktree add -B` 原样重建 → 仅 path+branch+locked_at 仍有同家族 ABA。

**Authority 绑定 = 创建时由 orchestrator 原子写入,Runner 报告永远不是 authority**:
- `WorktreeManager.create` 成功后生成 **generation nonce**(randomUUID),写入主仓 admin 区 `flywheel.generation`(路径经 `git -C <wt> rev-parse --path-format=absolute --git-path flywheel.generation` 解析,不猜 `<id>`;创建方写,非候选 worktree 内容,porcelain 零污染);Blueprint 拿到完整 `WorktreeInfo {path, branch, generation}` 后调 StateStore **原子 `bindWorktreeOnce(executionId, {path, branch, generation})`**——已有 binding → 拒绝;binding 列组独立,`patchSessionMetadata`/`upsertSession` 在实现上**不可能**触碰。
- **Authority 通道只有 bridge-local DirectEventSink 一条**(R5#1 选 a,fail-closed):生产 Bridge 经 run-infra 注入的 DirectEventSink 直接调 StateStore.bindWorktreeOnce;**HTTP `TeamLeadClient` 模式没有 authority 通道**——其 worktree 对象一律 unowned/manual-only(共享 ingest token 从结构上写不了 authority)。HTTP `worktree_ready` 全面降级为非 authority 展示元数据(仅 UI/日志;对已绑定 session 拒绝 + 审计 `worktree_binding_rejected`)。删除授权只认 binding 列组。测试真实走 TeamLeadClient:共享 token 路径产生零 authority。
- classifier 的 `session_path` ownership 要求**四方一致**(sweep 锁内 fresh 读):canonicalize(binding.path)===canonicalize(wt.path) ∧ 候选 registered branch===binding.branch ∧ **admin 区 `flywheel.generation` 与 binding.generation 逐字相等**(同家族 ABA 的根治:重建的同 path 同 branch worktree generation 必不同)∧ binding 完整。任一缺失/不符 → 不算。
- **无 binding = 一律 unowned/manual-only,没有形状 fallback**(R6#1:canonical-sibling 无限期 fallback 会把 R6 后新建的 HTTP/TeamLeadClient sibling 对象仅凭形状绕回自动删除半径,与选项 a 冲突——故整个移除,"binding 缺失"永远不是 legacy 证明)。**过渡代价(接受并写明)**:部署前已存在的 sibling worktree 失去 Layer B 周期自动清理,由 rollout 首扫的人审 apply 一次性清干净(本来就要做);部署后生产对象全部带 binding,稳态零依赖形状。Layer A ship 路径不受影响(它有自己的 session 级 registered-branch 守卫,不走 classifier)。共享 ingest token 不可能创建任何 grant/binding。

测试(R3/R4 点名):共享 ingest token 抢占另一条 pathless session 的第一次 `worktree_ready` → 不产生 authority;伪造 overwrite → 拒绝审计;"旧 session + 同 path + 同 branch 重建、无 successor binding" → generation 不符 → 保留;人工 internal worktree 不获 ownership。

`WorktreeManager.classifyWorktreePath(mainRepoPath, projectName, wt, trustedBindings) → {ownership: "session_path"|"unowned", key}`(R7:canonical_sibling 档移除)。测试补:R6 后经真实 TeamLeadClient 新建的同形 sibling → unowned;部署前存量 sibling → unowned(进首扫清单)。

### 2.2 保护判定(R1#2,不变)

三层任一命中保留:canonical 精确路径集;pathKey/branchKey/issue 家族根多键集;config pattern。qa-slot reserved namespace 全路径保留。dead-tmux parked/awaiting_review/design_done phase 测试。

### 2.3 稳定闸 — 连续 eligibility(R1#4 + R2#2,不变)

`cleanup_ref_observations(project, kind, ref_name, fingerprint, first_seen_eligible_at, last_seen_sweep_at)`;fingerprint:branch=tip sha,worktree=HEAD sha+sha256(porcelain v1 -z **--untracked-files=all** 全文);对象缺失或任一闸不满足 → 删 observation;fingerprint 变 → 重置;满 3d 才可删;删除成功清 observation。活动探针(porcelain 现存路径 mtime、index/HEAD/logs mtime <3d → ineligible;probe 失败 fail-close)。四回归测试保留。

### 2.4 branch-cleanup.ts(R1#3/#9 + R2#3 + R3#2)

**本地删除原语(锁内三步;仅限"Flywheel 拥有生命周期"的调用点——Layer A ship 收尾、QA teardown、manual apply)**:
1. 持 repo mutation lock(§2.11);
2. fresh 复核:`git worktree list --porcelain` **occupancy check**(该 branch 被任何 worktree checkout → skip + 审计 `branch_occupied`;R3 实证 `update-ref -d` 会删 checked-out branch 且退出 0,故 occupancy 必须显式)+ `git rev-parse refs/heads/<b>` === expectedSha;
3. `git update-ref -d refs/heads/<b> <expectedSha>`(CAS;不符 → `cas_mismatch` + 重置 observation)。

**周期性本地孤儿分支:不自动删(R4#3 降级)**。periodic sweep 对"无注册 worktree 的本地 orphan branch"只做:稳定闸满足 → `git bundle create`+verify(含 expected SHA)→ 写入 manual manifest(含 occupancy/SHA 快照)。删除只发生在 `cleanup-sweep-cli.mjs --apply --approved-hash`(锁内 fresh 复算 occupancy/SHA,漂移即拒)。外部人工 `git worktree add` 竞态由此从周期路径彻底移除;恢复兜底(merged=audit sha 复活,unmerged=bundle)仅是纵深,不再作为自动删除的 authority。真 Git 测试:checked-out branch → 保留。未来若要恢复周期自动删,需先有 Git 层跨进程占用/删除事务(明确 out of scope)。

**远端删除原语**:fresh `ls-remote --heads` === expected → `git push --force-with-lease=refs/heads/<b>:<sha> origin :refs/heads/<b>`;lease 拒 → 审计 + 重置 observation。真 Git 集成测:remote 前进 → `stale info` 拒。

**ship 即时删远端**(R5#2 + R6#2:消费 Layer A 的 **pre-delete attestation**,绝不事后重读已随 remove 销毁的 admin marker):`layerA.removed ∧ layerA.bindingVerified ∧ layerA.actualBranch===持久化 binding.branch ∧ (merged PR headRefOid===layerA.headSha ∨ 祖先) ∧ ¬protected ∧ ¬main` → CAS 删。否则 `remote_delete_skipped` 交 sweep。测试:真 Git 顺序测(remove 后 marker 确实消失,但匹配的 attestation 仍放行 lease CAS;generation mismatch → Layer A 不删、无 attestation、remote 不执行);production-shape 测(`session.branch` 为空而 binding 完整 → 执行;binding.branch 不同 → skip)。

**sweep 分支 pass**(锁内):枚举 origin/本地 `<slug>-*` → managed ∧ ¬protected ∧ ¬reserved ∧ ¬open PR ∧ 无 worktree 占用 ∧ 稳定闸 ∧ (merged / `-qa` ephemeral / 稳定废弃)。**远端** ref 满足条件 → lease CAS 自动删(稳定废弃类先 bundle,审计 `unmerged_tip_archived`);**本地** orphan ref 一律只产 bundle+manual manifest(见上,R4#3)。main/default 排除;dry-run 结构化清单。

### 2.5 reap primitive + maintenance tick(R1#7 + R2#4/#8b + R3#3)

`reapRunnerMcp`(reap-only,六 call site kill 前插入,kill 序列零改动)与 `reapMcpDescendants`/`reapMcpOrphans` 同 R3 稿(双 identity 复核)。

**Maintenance tick(R3#3)**:composition root 注入 HeartbeatService 一个 `onMaintenanceTick` 回调——**不 await 进 check() 链**(fire-and-forget + 自身 catch/audit);模块级 single-flight guard:上一 pass 未完 → 本 tick skip(不并发第二次);boot 跑一次;每 tick 孤儿 reap、每 N tick(≥6h 等效)全项目 sweep(N-tick counter 只在 guard 空闲时触发一次 detached pass)。fake-timer 测试:挂起 pass 跨多 tick 调用数=1 且核心 heartbeat checks 照常执行;cleanup throw 不影响 checkStuck/reapOrphans。

### 2.6 auto-QA scratch 即时 teardown(R1#6,不变)

四重证明 + quarantine + CAS 删分支;不满足交 aged sweep;三段式 QA close 不删共享 base 测试。

### 2.7 playwright positive opt-in(R1#11 + R2#8a,不变)

**独立条目 · Prevention vs Cleanup 分工(Tadashi 指令 eeadd37b,四 Lead 共识 2026-07-11)**:机上 27 对 playwright-mcp 全部挂活 session,零孤儿 —— **绝不按孤儿 reap 处理**。Prevention = 本节(machine 默认关 + opt-in),源头不让生;Cleanup = ⑦(终态 reap 自己 pane 子树 + ppid-1-only 兜底),终态清自己。两者独立,互不替代。

`enabledPluginsExtra`(QA ∨ `playwright` ∨ `full-mcp` label)非空不退化 null;disabled 先 extra 后;Blueprint start+retry;`SLIM_MCP=0` 下 label 无效(文档化 + 组合测试);三无 byte-compat。

### 2.8 worktree-quarantine.ts(R1#5 + R2#7 + R3#4)

归档 = manifest(+sha256)+ `git diff --binary` + `git diff --cached --binary` + NUL-safe untracked payload + **ignored inventory**(R3#4):`git ls-files --others --ignored --exclude-standard -z` 全清单;ignored payload 一并归档并纳入 hash/restore 比对,除**精确、审计可见的可再生 allowlist**(`node_modules/`、`dist/`、`.venv/`、`__pycache__/`、`.next/`、`target/`——目录级前缀,skip 记录进 manifest.skipped);归档总量 > `QUARANTINE_MAX_BYTES(2GiB)` → 整体 fail 保留。symlink 存 link 本体;submodule 变更 → fail 保留。
**restore-smoke**(定死算法):read-tree HEAD → apply --cached staged.diff → checkout-index → tmp workdir 上 apply --check + 真重放 tracked.diff → 恢复 untracked+ignored payload → porcelain/每文件 sha256/symlink target+mode 与 manifest 全比对。通过才 force;失败审计保留。测试:mixed fixture 真恢复;ignored `.env`、嵌套 ignored 二进制、超限 fail。

### 2.9 sweep v2 编排(不变;全程持锁见 §2.11)

classify → 保护 → reserved → live tri-state → 深度降序 → 规则族(clean+merged 现状 / QA-ephemeral / dirty-aged / 稳定废弃)→ 分支 pass。gh 不可用/无 origin 的降级同 R3 稿。dry-run 同引擎。

### 2.10 CleanupPolicyByProject(R1#10 + R2#6,不变)

run-infra 把 per-project ConfigLoader 读取上提到 pruneOrphans/reconcile 之前;`enabled(protectedBranches) | disabled(reason)`;四入口注入;boot-order 集成测(首个 reconcile 可见 protected;config 坏 → 删除器 0 调用)。

### 2.11 repo mutation coordinator(R3#2)

`repo-mutation-lock.ts`:进程内 async mutex,key = canonical(mainRepoPath)。**所有** Flywheel 侧 repo 结构变更共用:`WorktreeManager.create/removeIfExists/removeRegisteredWorktree/safeRerunCleanup`(经依赖注入的 `withRepoLock` 包装,edge-worker 不 import teamlead)、sweep 整轮、branch pass、QA teardown、Layer A 删除段。**锁内合同**:执行任何删除前 fresh 复核最新 sessions/protection/liveness、`git worktree list`、registered branch/HEAD、clean/activity、open-PR 缓存时效、expected SHA、**binding generation 与 admin 区 `flywheel.generation` 逐字相等**(§2.1)——检查与删除同锁,消 Flywheel 内部 TOCTOU(sweep vs retry 在同 path 重建的交错)与同家族 ABA。锁只序列化本 Bridge 进程(多 Bridge 不共存于同一 projectRoot;QA slot bridge 用各自 worktree repo)。

### 2.12 lifecycle-closeout.ts + issue-terminal reconcile(R8 全修订版,吸收 R8#1/2/3/5/6/7)

**IssueDisposition 合同(R8#2 + R9#2/#3)** — 三种终态处置,FSM 语义各自钉死:
- `shipped`:仅 exact ship gate 成立(现 post-ship 路径);eligible husk 用既有 finalizeDone 语义 finalize 为 completed(现状保留)。
- `canceled`:**穷举 disposition 状态表**(R9#3——对 StateStore 全部持久化 status 逐一定义:transition→terminated / 保留 outcome 但 teardown live target / blocked;实施时该表落在 lifecycle-closeout.ts 顶部并有全矩阵单测)。现 FSM 缺口(R10#5 事实校正):`pending`→terminated **边不存在**;`design_done`→terminated 边已存在但 **`ACTION_DEFINITIONS.terminate.fromStates` 不含 design_done**;legacy `approved` 不在 closeRunner 的 eligible sets——**`packages/core/src/workflow-fsm.ts` 进交付物**补 `pending`→terminated 边 + terminate.fromStates 扩 design_done;**禁止 forceStatus 绕过**。绝不调 finalizeDone。failed/blocked 取证保留在 issue canceled 后由 issue-terminal authority 显式 override(审计 `forensics_released_by_issue_terminal`;worktree 仍必须过 quarantine/bundle)。
- `founder_parked`(R9#2 + R10#1:**tombstone + 执行状态两维分离**):新增 founder-consent 保护的 **issue-scoped park-close action**(reserved endpoint)+ StateStore **`issue_disposition_intents` ledger**(`issue_uuid, disposition, founder_decision_id, expected_project, created_at, closeout_status ∈ pending|partial|complete|needs_operator, last_report`)。`disposition=founder_parked` 是**持续生效的 issue tombstone**(不随 closeout 完成而失效);`closeout_status` 只是执行状态。**Admission gate(挡"刚归零又重生")**:`assertIssueNotLifecycleClosed(root 或 trusted auto-QA child)` 以 **decorator 包住 `IStartDispatcher`/`IRetryDispatcher`**(单点,四类 spawn 面——HTTP start / retry / phase handoff / auto-QA / rescue——全部经过,不逐 caller 漂移);每次 spawn 前 fresh re-read tombstone。新增 founder-consent 的 **explicit unpark/supersede action** 解除。retryable 的 `blocked`/`failed` 保持 `partial` 由 maintenance 重放;`blocked_open_pr`/`blocked_linear_child` → `needs_operator`(持续可见,绝不静默标 complete)。**普通 session 级 close/defer/reject 永不创建 intent**。parked 的 Linear 一致项 = 零 Linear mutation;D 仍只认 completed/canceled。测试:park 后 HTTP start/retry/phase/auto-QA 全拒 + Bridge 重启仍拒 + unpark 恢复。
**DAG per-node 硬序修正(R9#3,对齐 FLY-228 transition-first)**:`fresh authority/status re-read → 合法 FSM transition → MCP reap → cmux/tmux kill → confirmed gone`;transition 因并发状态变化失败 ⇒ MCP 与窗口**零信号**、后续项全 blocked。并发时序单测钉死。

**collectIssueCloseoutNodes(R8#3,authoritative collector)**:纠偏——FLY-799 `collectRelatedNodes` 是纯 collector(cleanupNode/retry store 未接线,生产无 caller,且只含 root+auto-QA、只放行 PASS QA)。新 collector 在 fresh 的 Linear UUID↔identifier alias 集下,union:`getSessionsForIssueAliases` ∪ phase sessions(`finalizeThreeStagePhases` 的枚举源)∪ auto-QA parent/child,按 executionId 去重。disposition 决定处置:`shipped` → PASS QA finalize、non-PASS QA 按 canceled 语义 terminate(不再静默留给 sweep);`canceled` → 全部 active node terminate。**residue 判定**(D 入口触发条件)扩为:non-terminal session ∪ terminal-status 但 target 仍 live 的 husk ∪ 未归档 thread ∪ binding-owned worktree/分支残留 ∪ Linear 状态不一致——单有 thread-only 或 terminal-live residue 也算。

**Issue 级互斥与 disposition 仲裁(R10#2 + R11#1/#2)**:锁键 = **canonical lifecycle-root**:`resolveLifecycleRootKey(project, anyIssueId)`——可信 auto-QA child(`auto_qa_record.qa_issue_id`)归并到 parent root UUID;identifier/UUID alias 归一到同一 immutable UUID;**admission tombstone、residue dedupe、A–E、manual manifest/apply、durable epoch 全部用同一 root key**。映射缺失/冲突/Linear lookup 不确定 → 涉删路径 fail-closed;root 无法唯一时对完整 related UUID 集按稳定排序取多锁,禁止单 child 锁。manifest 绑定审批时的 root mapping,apply 时 mapping drift → 整 issue 拒。`lifecycle-closeout.ts` 持该 keyed 进程内 **issue mutex**——A/B/C/D/E、park intent replay、manual apply、**admission decorator(spawn 面)** 全部先进锁;锁内 fresh 重建 node graph、Linear state、active intent、bindings。**Park-vs-start 原子化(R11#1)**:admission decorator 在**锁内** fresh tombstone/active-claim check 通过后、**释放锁前**写 durable `starting` launch claim(executionId/root UUID/role;**claim 状态机**(R12 nit):`starting` → `active`(session row+binding durable 可见后由 emitStarted 路径推进)/ `closed`(被 closeout 收掉或 spawn 失败清理);孤儿 `starting` 超时由 maintenance 按 liveness 收敛,不无限滞留),该 claim 被 `collectIssueCloseoutNodes`/residue 枚举可见——start 先获锁 ⇒ 随后的 park 必能看见并收掉该 launch;park 先获锁 ⇒ start 必拒;unpark/supersede 同锁,不与 in-flight closeout 交叉;tombstone/alias/child relation 读取失败 → admission fail-closed。StateStore 持久化 **closeout epoch/claim**(当前 disposition + authority provenance + report;manual apply 的 claim 显式绑定 approvedHash,同 hash 的 HTTP 重试幂等返回既有 claim),crash 后按 claim 重放。**冲突仲裁规则(钉死,不靠先到先得)**:active founder park intent 最高;其余若同时出现 exact shipped proof 与 fresh Linear canceled → **fail-closed `disposition_conflict`**(审计 + needs_operator,不执行任何 mutation);单一 authority 时按其 disposition 执行。并发测试四组:A-vs-D、ship-vs-park、crash-vs-canceled、manual-vs-maintenance——断言每个 node 只接受一个 disposition,archive/Linear/PR mutation 零交叉。

**Observation 单调原子合同(R10#4)**:单一 StateStore 事务 `observeLinearStateAndClaimCloseout()`:响应 `updatedAt` 早于已存值 → 忽略(乱序响应不得回退);同 `updatedAt` 而 stateType 不同 → fail-closed + 审计;仅当事务内看到 durable prior nonterminal 才把当前 episode 标 `terminal_authorized`;该 authority(legacy=false)在 residue 未归零期间持续可重放(不因 observation 写入与首个 mutator 之间 crash 而丢);trusted local terminal events 走同一 claim seam,不直改 observation。测试:乱序响应 / 同时间戳冲突态 / terminal 观察后首 mutator 前 crash 三例。

**checklist = 带前置边的 DAG,不是平面列表(R8#5;per-node 内序见上 R9#3 修正)**:`ClosureReport` 状态 = `done|skipped(reason)|failed(err)|blocked(prerequisite)`。硬前置边:
1. per-node:fresh re-read → 合法 FSM transition → MCP reap → kill → **confirmed gone**(fresh liveness,不是 status 集)→ 才允许 owned worktree/本地分支清理;transition/kill 失败 ⇒ 后续项全 `blocked`,绝不掩盖活 runner;
2. issue 级:**全部 related node confirmed closed/already-gone** → fresh liveness veto(FLY-1165 的 triple-veto 合同,不是查 status 集——status 全 terminal 而窗口还活 = veto)→ archive-once;
3. 远端分支只消费 Layer A/QA 的 pre-delete attestation;
4. disposition 对应的 Linear 一致项**最后**执行。
无依赖项可在他项失败时继续;依赖边绝不跨越。

**D 入口 = FLY-1165 折入扩展(R8#4 + R9#4)**:复用 `done-thread-reconcile.ts` 已上线的调度与安全合同——boot+periodic single-flight、candidate cap(200)/archive cap(25)/120s deadline/500ms spacing/cooperative abort、alias-aware 查询、per-issue fail-close、每个慢 await 后与每次 mutation 前 re-read Linear state(**reopen 必须获胜**)、429/timeout/truncated → 只 skip 该 issue。**R9#4 预算加固**:统一 `listIssueLifecycleResidues()` 合并全部 residue 来源(unarchived threads ∪ non-terminal sessions ∪ `starting` launch claims ∪ terminal-live husk ∪ binding-owned worktree/分支 ∪ Linear mismatch)按 **(project, canonical lifecycle-root UUID)**(`resolveLifecycleRootKey`,R12 nit 统一措辞)去重;新增**硬编码 per-run caps**(issue-closeout ≤5/run、mutator 调用 ≤40/run,非 env);deadline/abort 检查粒度细化到**每个 node、每个外部 await、每次 mutation 前**(不只 candidate 间);concurrency 保持 1。**逃生口双层合同**:`FLYWHEEL_WORKTREE_AUTOCLEAN=0` ⇒ 本单全部**新增** mutation(live kill/MCP/PR close/worktree/ref/Linear backfill)为 0;FLY-1165 原有 dead-husk/archive 行为仍由其既有 `FLYWHEEL_DONE_THREAD_RECONCILE` 决定(两开关互不越权,双向 byte-compat 集成测)。

**Cutover = episode 状态机(R8#1 + R9#1,durable 数据,非 flag)**:`legacy_terminal_baseline` 升级为 **`linear_state_observations`** 表,键 `(project, Linear UUID)`:`{last_state_type, last_linear_updated_at, observed_at, legacy_terminal_episode}`。规则:**任何 first-seen-terminal(不限首次 boot)→ 只进人工清单,永不自动**;自动收尾 authority 仅当**已有 durable nonterminal observation 之后**观察到 terminal(真迁移证明);fresh nonterminal 结束 legacy episode(之后的 terminal 迁移可正常自动处理——reopen→再 Cancel 语义无冲突);observation 写入先于任何 mutator,覆盖 partial boot/crash 重启。"可信本地 terminal event" = **精确 allowlist**:exact ship-complete 证明、founder issue-close intent(§上 ledger)两种;**绝不接受** runner 可见的 `/events session_completed`。**legacy 收敛路径**(R9#1 + R10#3:**apply 在 Bridge 内执行,CLI 只是提交器**):CLI `--dry-run` 保持只读;`--apply` **不在独立进程执行任何 mutation**——它把 `{manifest, approvedHash}` 提交给本机 Bridge 的 api-token/founder-admin **`/api/lifecycle-apply` endpoint**(新,reserved),真正执行在 Bridge 进程内走同一 issue mutex/repo lock/budget/`closeoutIssue`(独立进程绕锁的 TOCTOU 从结构上消除)。**full-DAG manifest 绑定精确 node snapshot**:每 issue 绑定 immutable Linear UUID、明确 disposition、Linear state type+updatedAt、exact related executionId+status 集、binding generations、PR number/head、thread id、repo/project;apply 锁内重算,任何新增/缺失 node(审批后 spawn 的 retry/phase/QA)、reopen、generation/head/status 漂移 → **拒绝整个 issue**(重新 dry-run/审批,绝不动态扩大批准集);`--include-unowned` 只扩大 manifest 明确列出的 Git objects,不隐式扩大 session graph。Bridge 不可用/api-token 缺失 → apply fail-closed。测试:审批后新增 successor/QA 节点拒、Bridge 与 apply 并发同 issue 串行、同 root 但 node set 变化拒、Bridge 不可用 fail-closed。legacy 对象因此有真实收敛出口而非永久隔离。merge-enable 集成测:预置 legacy terminal issue + live runner + 未归档 thread + cmux 窗,首个 boot 全部 mutator 调用数为 0;之后制造 post-cutover nonterminal→terminal 迁移 → closeout 执行;补测:首启中途 crash、首启 Linear 查询失败后恢复、legacy reopen→Cancel、terminal-first 永不自动、lifecycle manual apply。

**反向 Linear 一致(R8#6,收紧)**:补打 Done 仅当:持久化的 **exact ship-complete 证明**(merged landing + approval/route 齐 + `shipEligible` 未被否决——即 `isPostApproveShipComplete` 等价谓词)∧ **fresh re-read 的 Linear 状态是 non-terminal**。`canceled`/founder-parked **永不改写**;update 前再 re-read 一次,reopen/Cancel 获胜。测试三例:canceled+merged 不动、merged+shipEligible=false 不动、query→update 间被 reopen/Cancel 不动。

**Canceled/parked issue 的 open-PR(R8#7 + R9#5 机械绑定收紧)**:采用**精确绑定自动关 PR**,绑定证据全部机械、不含 body 文本:完整 current binding(path/branch/generation)∧ session 持久化 `pr_number`/`pr_head_sha` ∧ fresh GitHub object 全一致——expected repo、state=open、**唯一 PR number/node id**、expected default base、**非 fork head repo**、`headRefName===binding.branch`、`headRefOid===fresh tip===expected SHA`、issue UUID/identifier 经 trusted session relation 一致。mutation 前再 re-read Linear disposition + binding generation + PR object;执行固定 `gh pr close <number> -R <owner/repo>`,**明确禁止 `--delete-branch`**(分支删除只走后续 stability/CAS)。任一不符(缺失/多 PR/fork/base mismatch/generation mismatch/head 漂移/已 reopen)→ 不关,记 **`blocked_open_pr`** 进人工清单。GitHub close 无 lease CAS 的残余外部竞态 = 显式 accepted risk(close 可 reopen 可逆);测试:head advance、同 branch 多 candidate、fork PR、close 后 reopen 四例。

**QA 子 issue 的 Linear 一致(R9#6)**:collector 输出保留每个 distinct Linear issue(root + auto_qa_record 的独立 `qa_issue_id`)的 trusted relation 与 disposition policy:`shipped`+PASS QA → QA issue Done(现 finalizer 语义);root `canceled` → **Bridge 创建的** linked QA issue 走显式 Canceled(fresh state re-read + team state resolution);relation/authority 不足 → 报 **`blocked_linear_child`**(非 zero)。founder_parked → 子 issue 同样零 Linear mutation。全部 child Linear mutation 在对应 node confirmed closed 之后、fresh re-read 下执行并计入 ClosureReport。

## 3. 实施顺序(TDD)

0. `lifecycle-closeout.ts` 骨架(ClosureReport/两粒度编排;先以既有件的注入桩过单测)。
1. `worktree-quarantine.ts`(含 ignored + restore-smoke)。
2. `repo-mutation-lock.ts` + WorktreeManager 注入接线。
3. `branch-cleanup.ts`(CAS + occupancy + 真 Git 集成测)+ StateStore(observations 表 + binding 列)。
4. `event-route.ts` 绑定锁 + 伪造 overwrite 测试。
5. `mcp-descendant-reaper.ts` + `runner-teardown.ts`。
6. `classifyWorktreePath` + force 变体。
7. `cleanup-policy.ts` + run-infra 上提 + boot-order 测。
8. sweep v2 编排(持锁)。
9. Layer A 结构化 + post-ship CAS 删远端 + 末尾 sweep。
10. 六 call site reap 接线 + QA teardown。
11. **五入口接 lifecycle-closeout**(A:post-ship + collectIssueCloseoutNodes 接线;B:close-runner/actions + issue 级 park-close action/intent ledger;C:crash-reaper;D:**FLY-1165 coordinator 扩展**(episode 状态机 + residue union + per-run caps + 双层逃生口);E:sweep 编排)+ 每入口时序/幂等测 + Linear 反向一致三反例测 + disposition 全状态矩阵测。
12. playwright 全链路。
13. HeartbeatService maintenance tick + CLI(approved-hash/include-unowned)+ 两脚本 + provisioning。
14. 全仓 lint + 全测 → PR。

## 4. 反误伤钉子(逐条单测;R1–R3 累积)

R3 稿 1–21 全保留,新增:
22. 伪造 `worktree_ready` overwrite(真 ingest token)→ 无 authority 效果 + 审计;共享 token 抢占另一 pathless session 的首写 → 不产生 authority;internal worktree 不获 ownership。
23. ABA:同 path 新 worktree 但 branch 与 binding 不符 → 不算;**同 path 同 branch 重建但 generation 不符(无 successor binding)→ 保留**(R4#2 点名)。
24. legacy 无 binding 行:非 canonical sibling 形 → unowned;`bindWorktreeOnce` 二次绑定拒绝;`patchSessionMetadata` 无法触碰 binding 列。
25. checked-out branch(真 Git)→ occupancy skip 保留;**周期路径对本地 orphan ref 零删除调用(只 bundle+manifest)**。
26. sweep 与 create/retry 并发(同 path):锁序列化,后到方 fresh 复核(含 generation)后正确让路(集成测)。
27. maintenance tick:挂起 pass 跨 tick 只跑 1 次;cleanup throw 不影响核心 heartbeat 步。
28. quarantine:ignored `.env` 归档可恢复;allowlist skip 记录于 manifest;超限 fail 保留。
29. apply:manifest 审后被改(内部 hash 重算)→ 旧 `--approved-hash` 整体拒;缺 `--include-unowned` 时 unowned 对象不执行。

R8/R9 新增(统一生命周期):
30. cutover episode:legacy terminal + live runner + 未归档 thread + cmux 窗 → 首启零 mutator;post-cutover 迁移 → closeout;first-seen-terminal(任意轮)永不自动;legacy reopen→Cancel 正常处理;首启中途 crash / Linear 查询失败后恢复不产生假 authority。
31. disposition 全状态矩阵(全部持久化 status × shipped/canceled/founder_parked);canceled 绝不产生 completed 伪造;pending/design_done 新 FSM 边合法;forceStatus 零调用。
32. DAG:transition 失败 ⇒ MCP/窗口零信号;status 全 terminal 而窗口活 → archive veto(triple liveness);Linear 一致项最后。
33. 反向补打三反例:canceled+merged 不动、merged+shipEligible=false 不动、query→update 间 reopen/Cancel 不动。
34. PR close 四例:head advance / 同 branch 多 candidate / fork PR / close 后 reopen → 全部 blocked_open_pr 不误关;`--delete-branch` 零出现。
35. D 预算:单 issue 超大 fan-out 撞 per-run cap/deadline 正确截断;shutdown mid-node 不留半删;`FLYWHEEL_WORKTREE_AUTOCLEAN=0` ⇒ 新增 mutation 全零而 FLY-1165 旧行为不受影响(双向)。
36. park intent ledger:intent 写入 → crash → 重启重放收敛;session 级 close 不创建 intent。
37. QA 子 issue:root canceled → Bridge-created QA issue 显式 Canceled;relation 不足 → blocked_linear_child;parked → 子 issue 零 Linear mutation。

R10/R11 新增(仲裁/准入/apply 边界):
38. admission barrier:Blueprint 暂停在 emitStarted 前 + 并发 park → 无 late runner/worktree;park 先 → start 零调用;Bridge 重启后 tombstone 仍拒;unpark 与 in-flight closeout 不交叉。
39. 并发仲裁四组(A-vs-D / ship-vs-park / crash-vs-canceled / manual-vs-maintenance):每 node 恰一 disposition,archive/Linear/PR mutation 零交叉;shipped-proof 与 fresh canceled 同现 → disposition_conflict 零 mutation。
40. lifecycle-root 键:parent-A vs child-D、parent park vs child QA spawn、identifier-key A vs UUID-key D → 共享同一 lock/claim;root mapping 失败 → 涉删 fail-closed。
41. Bridge-local apply:审批后新增 successor/QA 节点拒;Bridge 与 apply 并发同 issue 串行;node set 漂移拒;Bridge/api-token 不可用 fail-closed;同 approvedHash 重试幂等返回既有 claim。
42. observation 原子:乱序 updatedAt 忽略;同 updatedAt 冲突态 fail-closed;terminal-authorized 后 crash-before-first-mutator 不丢 authority。

## 5. QA(真机,独立 QA session)

R3 稿 5 项 + 首扫演练含 manifest 漂移拒绝 + `--approved-hash` 全流程;孤儿 reap 在 `FLYWHEEL_CHROME_REAPER=0` 环境仍工作。**R8 新增**:①真机一个 runner 完整生命周期(onboard→PR→merge→ship)后**七项全零**(分支远端+本地/worktree/session husk/cmux 窗/thread archived/Linear Done/MCP 进程);②issue-terminal reconcile(经 FLY-1165 扩展 coordinator):对一个**先被 D 观察为 nonterminal** 的测试 issue 手动 Cancel(= 真 post-cutover 迁移)→ 六项收敛;历史已 terminal 的对照 issue 保持零 mutator;③sweep 对存量安全空跑(dry-run 清单人审)。

## 6. Rollout(R8:**merge 即 enable**,Annie 直令;取代 R2#5 的 gate-off 部署窗)

1. merge → 生产 build → batched Tier-3 窗正常重启,**默认全开**(零新 flag;既有 `FLYWHEEL_WORKTREE_AUTOCLEAN` 保持默认 on,仅作既有逃生口,rollout 不动它)。
   **直接开的安全论证(结构性挡板,等价且强于 gate-off 窗;R8#1 修正后重新成立)**:(a) A/B/C 入口的 ③④⑤⑥ 项全是既有 shipped 行为的折入调用,无新删除半径;(b) **D 入口受 episode 守卫**(§2.12:**任何轮** first-seen-terminal 的 residue 都只进人工清单、零 mutator——集成测钉死;自动收尾只对"durable nonterminal 观察之后的 terminal 迁移"生效);(c) 新删除类(远端分支/QA-worktree/dirty-aged/稳定废弃)受 binding provenance(无 binding=unowned=manual-only)+ 稳定闸从空表起算(首触发≥3 天)+ clean+merged 维持今日 Layer B 同强度——**merge 后第一时间的自动行为 = 今天的行为**,新行为随新 session/新迁移/稳定闸自然生效,期间足够观察审计流。
2. founder 步骤(随 ship):`delete_branch_on_merge=true`;`setup-mcp-on-demand.sh`。
3. 存量清理(与 1 解耦,任意时点):`cleanup-sweep-cli.mjs --dry-run` 产 manifest + canonical hash → Lead/founder 审 hash → `node scripts/cleanup-sweep-cli.mjs --apply --manifest <file> --approved-hash <sha256> --include-unowned`(首轮必带 `--include-unowned`——存量核心正是 unowned 对象;后续常规 apply 按 manifest 范围决定。apply 校验总闸有效 on + 重算 canonical serialization 逐字比对,漂移对象拒)→ 复扫 dry-run 确认收敛。
4. 观察 48h:审计分布 + 六项计数趋势(worktree/branch/husk/thread/Linear 不一致数)→ 报 Lead。

## 7. 风险与已知取舍

- 远端删除:ship 绑定 + CAS、sweep 稳定闸 + bundle + CAS、首扫 approved-hash——全部 leased/conditional + 可恢复。
- 本地 ref:周期路径零自动删(bundle+manual apply,R4#3);Flywheel 自有生命周期路径(ship/QA/apply)在锁内 occupancy+CAS;Flywheel 内部并发被 mutation lock 消除。恢复兜底(merged=audit sha;unmerged=bundle)只是纵深。
- `--force` 只在 restore-smoke 后;ignored 纳入归档(allowlist 例外显式审计)。
- `SLIM_MCP=0` 下 playwright label 无效(byte-compat 取舍,已文档化)。
- maintenance tick 挂 HeartbeatService:停摆时兜底同停(接受——同宿主 crash-reaper 停摆已是 P1)。
- personal-assistant 无 origin:本地清理生效,gh/远端跳过审计可见。
- FLY-720/766/369 语义零改动;cmux 双失败语义由 call site 保留。

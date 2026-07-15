# FLY-1264 重连标题自动恢复 — QA 报告
Issue: FLY-1264 (https://linear.app/geoforge3d/issue/FLY-1264)
日期: 2026-07-14
基于: plan.md, exploration.md, research.md

## Verdict: PASS

三段式流水线的 QA 阶段。实现已在本 branch 提交（PR #601，head `8d9a3f4b9`）。本报告独立验证恢复路径 + 补一条缺失的单测 + 真机 Discord E2E。**未重实现功能。**

## 被验缺陷

Bridge-only 重启期间活跃 issue thread 标题被标 `⚠️重连中 [FLY-XX] …`；Bridge 恢复后标题不会自动改回阶段前缀（🎨设计/🔨实现/🧪QA），一直卡在 ⚠️重连中，需人工 PATCH（今日 [FLY-1253] 复发两轮）。

## 修复设计核对（与 plan.md 一致，含实现偏离）

在 `HeartbeatService` 内把内部 `reconnecting`（heartbeat refresh + stuck/orphan/idle 抑制）与 title-only `reconnectTitleActive`（只控 FLY-907 Face A 是否可覆盖 ⚠️）拆成两个 set。boot `seedReconnecting()` 返回本次新进入 title episode 的 exec IDs；`plugin.ts` 在 FLY-907 refresher wiring 完成后调 `settleReconnectTitlesAndRefresh` 只 settle title set 并按 issue 去重 enqueue canonical refresh；Face A guard 从 `isReconnecting` 改读 `isReconnectTitleActive`。

**实现相对 plan 的偏离（均合理，已核）**：
1. helper 命名 `settleBootReconnectTitles` → `settleReconnectTitlesAndRefresh`，`settleReconnectTitles(ids?)` 参数变可选（无参 = drain 全部活跃 title episode）。
2. 新增 `markReconnectTitleRefresherReady()` 运行时开关：refresher 就绪后的 runtime 重连 re-entry 不再 stamp ⚠️、不进 `reconnectTitleActive`（保留已正确的阶段标题，省下 Discord rename 预算），只发 advisory。plugin.ts 先 `markReady()` → `restoreReconnectTitles(bootIds)` → `restoreReconnectTitles()`（无参兜底 seed 之后 markReady 之前经 heartbeat tick 进入的 episode）。

## 6 条行为不变量（人工核 diff，全部满足）

| # | 不变量 | 结论 |
|---|---|---|
| 1 | title settle 不调用 `reconnecting.delete()` | ✅ `settleReconnectTitles` 只删 `reconnectTitleActive` |
| 2 | idle/stuck/orphan guard 仍读 `isReconnecting()` | ✅ 未改这些 caller |
| 3 | canonical Face A guard 只读 `isReconnectTitleActive()` | ✅ issue-display-refresher.ts:700 |
| 4 | plugin 先 publish refresher 再 settle/enqueue | ✅ `issueDisplayRefreshHolder.current = …` 早于 restore 调用 |
| 5 | 50083 archived 不写 success fingerprint、不每轮 warn | ✅ deferred 分类 quiet |
| 6 | FLY-1225 映射函数（deriveIssueTitleBadge/derivePhaseDisplayState）无 diff | ✅ 未触碰，邻单边界清晰 |

**kill-switch 边界**：`markReady` + restore 调用全在 `if (issueDisplayRefreshEnabled && chatThreadCreator)` 块内。`FLYWHEEL_ISSUE_DISPLAY_REFRESH=0` / chat-threads off → 不 settle title-active、保留 FLY-623 legacy clear，无 canonical writer 却清 title 的风险不存在。

## 测试证据

### 单测回归（跑将 ship 的 head 8d9a3f4b9）
```
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/HeartbeatService.monitor-loss.test.ts \
  src/__tests__/HeartbeatService.test.ts \
  src/__tests__/event-route.stage-emoji.test.ts \
  src/__tests__/ChatThreadCreator.test.ts \
  src/bridge/__tests__/issue-display.test.ts \
  src/bridge/__tests__/issue-display-refresher.test.ts \
  src/bridge/__tests__/reconnect-title-restore.test.ts
→ 7 files, 190 passed (含本 QA 新增 1 条)
```
`pnpm --filter flywheel-teamlead typecheck` → exit 0。`pnpm biome check`（新增两文件）→ clean。

### QA 补测（覆盖缺口）
`HeartbeatService.monitor-loss.test.ts` 新增 `FLY-1264: no-arg settle drains an episode the explicit boot ids never captured (early heartbeat-tick safety net)`。

缺口：生产 plugin.ts 的第二次 `restoreReconnectTitles()`（**无参**）负责排空「seed 之后、`markReady()` 之前经 heartbeat tick 进入 reconnecting、因而不在 `bootReconnectExecutionIds` 里」的 title episode。原测试全部用显式 `seeded` ids 调 `settleReconnectTitles(seeded)`，真 HeartbeatService 的**无参 drain-all** 从未被断言。若该路径坏，那个 episode 的标题会永久卡 ⚠️ —— 正是 FLY-1264 要修的 bug 的边缘变体。helper 测试只 mock 验了「无参被调用」，没验真实排空。

**突变验证**：把源码 `const selected = executionIds ?? [...this.reconnectTitleActive];` 改成 `?? []`，该测试立即变红（1 failed）；revert 后重新变绿。证明测试真能抓这个 bug，不是空绿测。

### 真机 Discord E2E（founder 直视验收，恢复路径）
`scripts/qa-fly-1264-reconnect-title-restore-e2e.mjs` —— module-driven 驱动**编译后的生产 `ChatThreadCreator`** 打 529 QA Room（slot-1 cos-test，隔离环境），ground truth = 从 Discord API `GET /channels/<id>` 读回线程名（不信 writer 自报）。三个隔离线程，各走 ⚠️重连中 enter → Face A 的**精确恢复调用** `stampStageEmojiResult`（issue-display-refresher.ts:711-731 原样方法+参数，无 runner stage_changed 事件）：

| 场景 | Face A 分支 | ⚠️ enter 后（读回） | 恢复后（读回） | writer |
|---|---|---|---|---|
| A implement 单 main | `badge.stage` | `⚠️重连中 [FLY-1264QA-…-A] …` | `🔨实现中 [FLY-1264QA-…-A] …` | changed |
| B QA 三段式 | `badge.phase` | `⚠️重连中 [FLY-1264QA-…-B] …` | `🧪QA [FLY-1264QA-…-B] …` | changed |
| C design 三段式 | `badge.phase` | `⚠️重连中 [FLY-1264QA-…-C] …` | `🎨设计 [FLY-1264QA-…-C] …` | changed |

每场景断言：① ⚠️重连中 前缀已上；②a 恢复 writer 返回 `changed`（真 PATCH）；②b ⚠️重连中 已被替换为正确阶段 badge 且标题内**不再含** ⚠️/重连中；②c 人工基名（含 issue 号）保留；③ 重复恢复 = `noop` 不改名（无 rename 风暴，命中 FLY-907 fingerprint 关切）。**全部 PASS**（15 断言）。三线程未归档，保留供人工核查。

## 未在真机做 Bridge-only 重启（说明边界）

plan.md Task 5 写的「真做一次 `restart-services.sh --bridge-only`」我**没有执行**，原因两条：① 本修复代码尚在 branch 未部署到 main，重启生产 Bridge 跑的是旧代码，验不到本 fix；② 生产 Bridge 重启是全 fleet 破坏性动作，memory 明确要求 Annie 许可 + 重启协调，不该 QA 自行触发。改以「module-driven 驱动编译后生产写路径 + 从 Discord 读回」的既有配方（reference_qa_thread_title_real_discord_recipe）覆盖真机段 —— 它精确复现 Face A 恢复调用，是本修复唯一有真 Discord 不确定性的环节（PATCH 能否真的剥掉 ⚠️ 前缀、保住基名）。settle→enqueue 编排是纯内存逻辑，单测 + 突变已锁死。**部署上线后**（下一次自然/协调 Bridge 重启）可用一个真活跃线程做端到端的最终确认。

## 结论

修复设计正确，6 条不变量满足，kill-switch 边界安全，FLY-1225 邻单未触碰。恢复路径在真 Discord 上三个阶段前缀全部验证通过、幂等不刷屏。补的单测填了无参 drain-all 缺口并经突变确认有效。**PASS。**

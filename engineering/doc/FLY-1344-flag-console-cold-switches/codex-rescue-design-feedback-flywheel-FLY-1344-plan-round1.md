# Design Review — plan.md (Round 1)

Date: 2026-07-17
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向可行：复用 FLY-709 的 registry、stage/apply、审计与现有 console 骨架，可以交付 founder 可见、可操作且成功 apply 后双源一致的热切换。但当前计划对 `claims_write` 的存在性契约、`FORCE_LEGACY` 的真实作用域、双源状态语义和两套 console DTO 均有阻塞性遗漏；按 S1-S6 原样实现会破坏 FLY-1232 OFF 字节兼容，并让部分 UI 状态/命令与真实 DAG 谓词不一致，因此本轮请求修改。

## What's Good (Keep)

- 继续复用 FLY-709 的 loopback + same-origin + confirmToken + audit 写入口，而不新造第二套状态面，架构方向正确。
- `applyFlagToggle` 的“先原子持久化 `.env`，再突变 Bridge `process.env`”正好覆盖 `dotenv_live` 与 Bridge `call_time` 两类 reader；默认值、极性与生产 `.env` 不随 PR 翻转的 reverse-compat 红线应保留。
- 四根 enable lever 从 `governance_gate` 重分类为 mechanism `feature` 的授权论证基本成立：当前生产代码中 category 的 load-bearing 使用只落在 direct-toggle policy 与两套渲染/管理写面，没有 DAG runtime 按 category 分支；同时保留真正授权门的 readonly sentinel 是必要护栏。
- TDD、逐杆真实 consumer proof、分歧显式呈现、半批次可见、独立真机 QA 与“必须先于统一重启窗合入”的时序意识都值得保留。
- 24 个未注册 key 本 PR 只交处置清单、执行另建 follow-up，边界清楚；本评审不要求把该 follow-up 提前塞回本 PR。

## Issues & Recommendations

1. **[阻塞] S2 把 writer 改成常驻对象会让 OFF 路径发生真实行为，不是仅把 no-op 检查点从构造期搬到 hook。** `RunDispatcher.start` 以 `this.workflowShadow` 的存在性生成 `shadowContext`、触发 QA claims admission，并给所有 fresh launch 生成 `launchCommitPath`（`packages/teamlead/src/bridge/run-dispatcher.ts:1152-1187,1196-1205`）；`setupRunInfrastructure` 也只凭 writer 存在就构造 admission，且找不到 active run 会抛错（`packages/teamlead/src/bridge/run-infra.ts:1003-1036`）。因此 flag OFF 时，hook 内短路仍会留下 commit-marker 路径，并可能让 shared-branch QA 因“active workflow run not found”直接启动失败。`PhaseOrchestrator` 还在多处凭依赖存在性附加 `shadowContext`/调用 `currentAttempt`（例如 `phase-orchestrator.ts:626-628,1077-1083,1405-1407,1887-1892`）；现有 sentinel 则明确要求无 writer 时 `launchCommitPath` 为 undefined、无 `shadowContext`、零 shadow run（`workflow-shadow-wiring.test.ts:106-119,428-438`）。建议把 S2 改成显式的 hot runtime/facade（至少暴露 `enabled()`），在一次 `RunDispatcher.start` 开头锁存 enable 状态，并用同一锁存值统一控制 shadowContext、onSpawn、admission、launchCommitPath 与 failure hook；orchestrator 每个 transition 也必须按当前 enable 状态决定是否携带 shadow context。hook 内可继续二次 fail-safe 短路。测试必须穿过真实 `setupRunInfrastructure`/`RunDispatcher` 做 OFF→ON→OFF，证明 OFF 时上述所有存在性副作用均为零，而不只逐个测 writer 方法。

2. **[阻塞] `claims_write` 还有第二个 boot capture，计划/研究把它漏掉后不能宣称 readSites 全为 call-time。** `createBridgeApp` 仅在启动时 `FLYWHEEL_WORKFLOW_CLAIMS_WRITE === "1"` 才注入 `reQa`（`packages/teamlead/src/bridge/plugin.ts:1235-1256`）；未注入时 `/api/workflow/re-qa/stage` 与 `/re-qa` 永久返回 503（`workflow-decision-routes.ts:481-515`）。所以 Bridge 以 OFF 启动后，即使 console 热翻 ON，FLY-1244 的 re-QA recovery surface 仍需重启。建议把 `reQa` 能力在基础依赖齐全时常驻接线，但在 stage 和 apply 两个 USE-time 点都重新检查同一个 live env；OFF 保留现有 503/零 token/零 respawn，stage 后再翻 OFF 时 apply 必须 fail-closed。补 route 级 OFF→ON→OFF 与 stage/apply 间翻转测试，随后才能删除该 `bridge_boot` readSite。

3. **[阻塞] DAG 总状态与 `FORCE_LEGACY` 的语义不符，五命令的“任意前缀保守”不变量也不成立。** 真正的统一派发谓词只看 template_dispatch、claims_write、claims_read，v2 再看 generalized；它完全不读 force_legacy（`packages/teamlead/src/workflow-template-dispatch.ts:24-36`，FLY-1307 plan §4.1 同样明确 v1 三杆/v2 四杆）。force_legacy 只让 enrolled QA ship gate 回到 legacy reader（`packages/flywheel-comm/src/ship-eligibility.ts:276-327`），不会“压制 DAG”或停止下一次模板派发。当前 `off|on|suppressed|partial` 会同时误报 v1/v2 与 ship-reader 状态；如果从 force 已 OFF 的 partial 状态执行“开”，或者先开 template_dispatch 再补前置杆，中断前缀还会让候选 run 命中 fail-closed 缺杆拒绝。建议把面板拆成至少三条派生事实：v1 dispatch readiness、v2 dispatch readiness、ship reader（claims/forced legacy），并把一条 force 命令准确命名为“ship gate 应急回退”，不要称为“DAG 已压制”。安全开序列应先显式 `force_legacy on`，再开 claims_write/claims_read/generalized，`template_dispatch on` 最后开，确认四杆齐后才 `force_legacy off`；彻底关则先 force on、紧接着 template_dispatch off、再关其余杆。测试应断言“任何前缀都不会让 dispatch predicate 看到 template ON 但 prerequisite 缺失，且全部就绪前 ship reader 保持 legacy”，而不是当前无法成立的抽象“更保守”。

4. **[阻塞] S4 没有定义一个可供显示、单杆控制、DAG 派生共同使用的双源状态合同。** 现有 `FlagView.effective` 是 process-env 值（`packages/config/src/feature-flags/resolve.ts:94-159`），手机卡片的 badge 与 `data-ff-to` 都继续从它计算（`feature-flag-render.ts:153-169`），localhost management mapper 也把它作为 `ManagedValue.current`（`management-existing-writers.ts:306-323`）。计划只说 dotenv_live 的“主显示取 fileVal”，却未规定这些既有 consumer 该读哪个字段；分脑时会出现画面显示 ON、按钮仍生成“切 ON”，或 DAG aggregate 与实际 Bridge dispatch 相反。建议明确并命名 `bridgeEffective`、`fileEffective`、`operator/displayEffective`，保留旧 `effective` 的兼容语义也可以，但所有 UI target 与 DAG 派生必须有唯一、测试化的选择规则。任何五杆分歧都不得汇总为确定的 ON/OFF，必须进入 degraded/unknown 并同时展示两侧值；对同时含 `call_time + dotenv_live` 的杆，要承认两个 reader 都是权威 consumer，而不是把 fileVal 当成唯一系统真值。覆盖 row badge、individual target、preset target、DAG aggregate 和 apply 后自愈五组 split-brain 测试。

5. **[阻塞] S5 目前只覆盖 legacy/手机 snapshot，达不到“手机报告页 / localhost console 都有顶部 DAG 面板”。** `/api/fleet/flag-report.html` 使用 `FleetConsole.buildSnapshot()` 的 `ConsoleSnapshot.featureFlags`（`packages/teamlead/src/bridge/plugin.ts:1604-1622`；`fleet-console-model.ts:124-144`），但 localhost `/api/fleet/snapshot` 返回的是独立的 `ManagementSnapshotV1`（`plugin.ts:1587-1599`），其 `ManagementFlagView`/snapshot 都没有 dagPanel 或分歧字段（`management-console-contract.ts:232-272`），并由 `fleet-console-html.ts:350-362` 自己渲染。仅在 `fleet-console-model.ts` 加 `dagPanel` 和改 `feature-flag-report-html.ts` 不会触达 localhost。另一个漏点是手机面的 `isFlagViewDirectToggleable` 仍硬编码“所有 timing 都是 call_time”（`feature-flag-render.ts:101-114`）；只改 server `isDirectToggleable` 后，dotenv_live 杆仍不会出现 checkbox。建议建立一个共享纯 DAG view model，再分别投影到 `ConsoleSnapshot` 和 `ManagementSnapshotV1`；扩展 management provider/contract/HTML，或显式设计两套等价投影。把 client/server direct predicate 集中到同一 helper 或同步放行 `{call_time, dotenv_live}`。验收测试必须分别打真实 `/api/fleet/flag-report.html?interactive=1` 与 `/api/fleet/snapshot` + `fleet-console-html`，不能只做 renderer snapshot。

6. **[阻塞] S3 对 live-dotenv reader 的登记仍不精确，现有 drift green 也证明不了“所有真实读取路径”。** `resolveDefaultOn/OffGate` 的实际优先级是“显式 `args.env` 含 key 时 process env 赢；否则文件赢；文件不可读才 fallback”（`ship-eligibility.ts:56-100`）；Bridge `computeShipDecision` 明确传入 `process.env`（`merge-ship-gate.ts:35-68`）。因此 merge_approval_gate / qa_done_gate 不能只改成一个 `dotenv_live` readSite：Bridge 路径是 call_time，CLI/缺-key 路径才是 dotenv_live，并可能形成真实分脑。claims_read 还在 `packages/flywheel-comm/src/commands/verify-approval.ts:122-142` 另有一条 live-file reader，当前 S3 未登记。现有 drift reverse check 只要求“至少一个声明文件包含 envVar”（`feature-flags-drift.test.ts:313-331`），不能证明 readSites 完整。建议为这些具名杆列出每个真实 consumer/timing，给 mixed-source direct proof 同时验证成功 apply 后 Bridge 与 CLI 下一次调用都变化，并增加这几杆的 exact readSite sentinel；计划里的测试文件名也应改成实际的 `packages/config/src/__tests__/feature-flags-registry.test.ts`。`readEnvValueFromContent` 应抽到下层共享模块并让 ship-eligibility、verify-approval、resolver 共用，而不是复制一份“byte-same”实现。

7. **[重要] 在 hard deadline 下仍需把暴露 direct 权限放在最后一个可验证的依赖门之后。** 单 PR 可以接受，但实现/提交顺序应明确为：先完成共享 parsing + 双源/两套 DTO 合同，再完成 S2 全部 presence-sensitive hot wiring 与 re-QA gate，跑完 OFF/ON proofs 后才把四杆改为 `feature/direct`，最后接 preset 和 inventory。否则中间提交或临时降级很容易出现“UI 已可点、某 consumer 仍 boot-stale”的危险窗口。PR 的硬验收应新增一个枚举五杆所有登记 readSites 的端到端 proof 表，并把“无 runner-inherited stale reader”作为逐 consumer 结论，而不是从 `pnpm -r test`/drift green 推断。

## Verdict

CHANGES REQUESTED — address items above

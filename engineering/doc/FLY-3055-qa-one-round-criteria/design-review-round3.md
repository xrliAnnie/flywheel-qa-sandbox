# Design Review — plan.md (Round 3)
Date: 2026-09-29
Author: Codex
Status: CHANGES REQUESTED

## Summary

v3 已把 R2 的原子提交、共享恢复 decoder、event/ref 映射、O5 参数传递和 O9 QA retry 出口落实到明确的函数与测试场景。方案总体可行，剩余问题集中在接受操作的分支顺序、legacy 首次消费、回执重放语义和回滚集合，仍需修改后再实施。

本轮完整重读 285 行 v3，并复核相关 StateStore 事务、两条 ingest、phase/auto-QA consumer 与启动恢复、CLI 重试、retry/Blueprint 及回滚查询。审查固定在 QA SANDBOX HEAD `00b21060b72b5986cde2d489feabcfe3adb99d92`，plan blob 为 `94839d7795be58a66c467c51b55d856e119b4df7`。相对 R2，只有 plan 和归档反馈两份文档变化，源码未变。以下 `plan.md` 均指 `engineering/doc/FLY-3055-qa-one-round-criteria/plan.md`。

共 **4 项阻塞修改：HIGH 1、MEDIUM 3**；另有 **LOW 1** 项文档接线澄清。未运行测试、build、lint 或真房验证；未修改源码，仅写本反馈文件。工作区干净，`git diff --check` 无输出。继续接受 O2 既有 best-effort 缺口及 O9 implement 按最新 scope 取上下文的已声明范围，不要求额外状态机。

## What's Good (Keep)

- 三个窄 StateStore 事务将接受状态与 ledger 一起提交，并对首次接受复核当前 prior，解决 R2 的半写与延迟消费校验窗口。
- decoder 明确覆盖在线两路及 `reconcileQaVerdicts`，区分缺键与坏清单；新增恢复测试检查账本、通知和下一轮覆盖同源。
- `{eventId}` 入口、intent 的 `ledger_ref`、O5 的 `qaCriteriaSection` 以及 O6 两处 spawn 均已明确，关闭 R2 的精确引用接线缺口。
- 回执从 ledger 读取真实 ref，重放比较完整 envelope；CLI 对旧服务端无 outcome 的响应保留兼容。
- O9 QA retry 已定位到独立的 RetryRequest/BlueprintContext 路径，且要求验证最终 prompt。O2 的截断后追加、O8 founder feedback 和更新后的 golden 保持完整。

## Issues & Recommendations

1. **[HIGH][BLOCKING] P1 镜像进入 phase 接受事务时，必须先识别已经入账的 verdict，再做动态 prior 校验。**

   **问题与证据：** `plan.md:109` 要求“每个事务先”对最新 prior 执行 evaluator；`:112` 又要求 P1 先在 claim 事务写账本，再由 orchestrator 的 `acceptVerdict` 幂等写 intent。现有调用确实是 submit 成功后 insertEvent，再调用 `onQaResult`，且精确 credential 重放也必须重驱后续副作用（`packages/teamlead/src/bridge/workflow-decision-routes.ts:220-273`）。原有 consumed credential 的早返回只在 claim 方法内，不能保护新增的 phase 接受事务（`packages/teamlead/src/StateStore.ts:10526-10545`）。

   **触发场景：** A 已接受；替换/下一 QA execution 提交 B，其中 AC1 为 `carried(A)`。P1 事务按 A 校验通过，提交 claim B 和 ledger B。随后同一请求进入 phase 的首次 intent 写入点（`packages/teamlead/src/bridge/phase-orchestrator.ts:1161-1175`）；若照 `:109` 先校验，最新 prior 已是 B，`carried(A)` 被拒 `not_latest_prior`。这不是并发：正常顺序就会出现。claim 已消费，phase intent 未落，FAIL 修复流程无法启动；claim 提交后、intent 前崩溃的恢复也有相同问题。

   **建议：** 明确接受事务顺序：先按 event_id/ref 查既有 accepted 行并核对同一规范提交；命中则复用该 ref、完成尚未写入的 intent，跳过动态 prior 校验；只有尚未接受的事件才执行最新 prior 校验和新插入。现有 intent 的恢复/忽略 guard 仍保留。幂等比较至少覆盖身份、head、status 和规范 criteria，不能只比 scope/status（`:108`）。同步补齐 DDL 的 `UNIQUE(event_id)`：`:93` 当前仅为 `TEXT NOT NULL`，与 `:108` 所依赖的唯一冲突不符。增加 P1 B carried(A) 的整条 route→claim/ledger→phase intent 用例及中间崩溃恢复，断言只一条 ledger、无错误 stale-prior 告警。

2. **[MEDIUM][BLOCKING] legacy 已落库、尚未写 intent 的事件仍会撞上事务内“清单必填”，兼容分支只覆盖了已有 intent。**

   **问题与证据：** `plan.md:113,120` 明确将缺少 qa_criteria 键的持久事件解码成 `qaCriteria:null`；但 `:109` 对每个首次接受事务无条件调用 evaluator，而 evaluator 仍包含 QA 家族的必填规则（`:69`）。`:149,177,183` 的 legacy 宽容处理发生在已有 intent 的上下文读取阶段，覆盖不了“旧 event 已落库、intent 尚未写”的状态。该状态是本仓库现有的正式恢复路径：holder 未接线时先存事件（`packages/teamlead/src/bridge/event-route.ts:590-595`），启动 sweep 再直接调用 `onQaResult`（`packages/teamlead/src/bridge/phase-orchestrator.ts:892-928`）。

   **影响：** 部署前收到的合法 FAIL，在新版本第一次消费时没有清单，被 evaluator 拒为 `qa_criteria_required`，到不了 legacy intent/fixer 兜底。计划一方面允许 ledger 中的 legacy NULL，另一方面没有任何能通过必填规则到达该落点的接受分支。已有的“legacy intent 无 ledger_ref 不 refuse”测试不能证明这种升级状态。

   **建议：** 明确持久 legacy event 的首次消费政策。若保留原有恢复能力，在可信恢复入口根据持久事件的 legacy 标识进入受限分支，保留原 consumer guards、summary 和规则块；新 HTTP 提交仍强制清单，带键但损坏的事件仍拒绝。若决定这类旧事件必须重新交卷，则应明确列为升级行为并写出可执行的重交/告警结果，不再称其会按 legacy 自动恢复。补“升级前原始 event 有记录、无清单、无 intent、无 ledger → 升级后 sweep”的用例；同时说明旧事件在 scope 已出现新协议清单时如何处理，不能静默覆盖掉新的覆盖义务。

3. **[MEDIUM][BLOCKING] 无 accepted 行不等于待消费：ignored 的精确重试会变成 stored 成功，并承诺不存在的恢复。**

   **问题与证据：** `plan.md:137` 对 consumer 丢弃/抛错返回 ignored，但 `:134` 对同一事件的精确重试只查 ledger，有行 accepted、无行一律 stored。CLI 对 ignored exit 2，对 stored exit 0 并提示启动消费及下次 wake 获得 ref（`:78`）。现有 CLI 在网络超时后会重发同一个 body/event_id（`packages/flywheel-comm/src/commands/qa-result.ts:161-190`），所以这不是手工构造的重放场景。

   **触发场景：** B 被 intent guard 忽略，或 auto-QA 的 record 非 running 而丢弃，首次 ignored 响应丢失；同一次 CLI 重试得到 stored、exit 0，尽管没有任何接受或重新排队发生。对应真实 ignore 分支见 `packages/teamlead/src/bridge/phase-orchestrator.ts:1092-1125`、`packages/teamlead/src/bridge/auto-qa-coordinator.ts:1257-1266`。此外，auto-QA 的启动恢复遍历 record 状态，对 alive running QA 只等待，对 dead QA 标 stuck，并不重放原始 qa_result（同文件 `1795-1844`）；不能把三阶段的 raw-event sweep 承诺推广给所有无账本事件。

   **建议：** 统一首次响应与重放的 outcome 判定，明确区分“已知待消费”与“未接受/已忽略”。可以持久化窄的消费结果，也可以简化无 ledger 行的回执为不承诺恢复的 not_accepted；不要仅凭缺行返回具有自动恢复含义的 stored/exit 0。只有确有恢复 consumer 的 pending 事件才能承诺启动处理。增加 ignored 响应丢失后精确重试、auto-QA holder 缺失、consumer 抛错后三种路线的回执/CLI 测试。顺带修正 `:278`：在线 route 是 await consumer 后才响应，await 期间 prior 变化时 CLI 并非“早已返回”；该结果可以同步返回真实 reason/detail。无需扩大为修复 O2 的投递缺口。

4. **[MEDIUM][BLOCKING] 回滚按部署后创建时间筛选，会漏掉部署前启动、部署后收到新协议的 QA。**

   **问题与证据：** `plan.md:254` 将 StateStore 集合限定为 `created_at >= 部署时间`，但计划本身要求 O1/O4/O8 向已存活的旧 QA 注入新规则（`:167,173,176,181,250`）。真实 wake 也复用原 execution，不会创建新 session（`packages/teamlead/src/bridge/auto-qa-effects.ts:629-677`、`packages/teamlead/src/bridge/plugin.ts:6799-6840`）。此外，此 checkout 的 sessions DDL 和 Session 类型有 `started_at`，没有 `created_at`（`packages/teamlead/src/StateStore.ts:1143-1169,518-525`；sessions 后续迁移亦未添加该列）。

   **影响：** QA Q 在部署前启动，部署后通过 retest wake 学到 criteria-file，回滚时仍 park 等下一次复验；它已有 StateStore 行，因此也不会进入“仅 CommDB pending”补集。按计划冻结集合会漏掉 Q，过早撤 C2a 后，Q 的旧上下文仍调用新参数，而旧 CLI 严格 parseArgs 不认识该参数（`packages/flywheel-comm/src/index.ts:928-938`）。单纯把 created_at 改成 started_at 仍修不好这个遗漏。

   **建议：** 最简单的保守集合是停止新协议 producer 后的全部非终态 QA 加 pending launches，不按创建时间排除；或者使用明确的 prompt/wake 接收证据，但不必为本任务新增追踪系统。保留已写明的“FAIL park 不算退出”条件，补部署前启动、部署后收到 O1/O4/O8 的案例。最后一步同时明确撤回 C2b 的时点：`:256` 只写撤 C2a+C1，而 C2b 依赖 C2a/C1 的 parser、拒收常量和计数逻辑（`:265-266`）；容忍旧 server 响应只解决过渡期，不等于可以在依赖模块已撤后继续保留 C2b。

5. **[LOW][NON-BLOCKING] O9 implement 的 qaFixerBlock 需要补一个明确的 Blueprint 渲染位置。**

   **问题与证据：** `plan.md:180` 新增顶层 `BlueprintContext.qaFixerBlock`，但 `:185` 仍说仅新增 qaCriteriaBlock，`:205` 只说明在 `phaseFixContext` 的 QA Fix Round 块追加。实际 implement 分支仅在 `ctx.phaseFixContext` 存在时渲染该块（`packages/edge-worker/src/Blueprint.ts:1137-1147`），通用 retry 的 Context 没有 phaseFixContext（`packages/teamlead/src/bridge/run-dispatcher.ts:583-638`）。

   **建议：** 明写顶层 qaFixerBlock 在 implement prompt 的拼接位置，或在 retry adapter 映射到统一的 fix context，消除两套字段之间的悬空关系。保留 `plan.md:233` 对最终 prompt 的测试，不只断言 dispatch 传参。O9 QA 路径本身已补齐，此项属于实现前的文档一致性修正。

## Verdict

CHANGES REQUESTED

Blocking findings: HIGH=1, MEDIUM=3. Non-blocking findings: LOW=1.

保留 v3 的事务、decoder、精确上下文和九出口结构。修订重点是事务中的“已接受/首次接受/legacy”分流、重放回执的真实语义，以及覆盖旧 wake 接收者的回滚集合；无需重新设计整个 QA 状态机。

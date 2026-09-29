# Design Review — plan.md (Round 1)
Date: 2026-09-29
Author: Codex
Status: CHANGES REQUESTED

## Summary

方案方向可行，但 v1 不能直接实施：默认 auto-QA 路径在 retarget 后读不到上一轮 verdict；实现体收到的清单会被现有消息包装层截断；新增强制校验与下游使用的 QA 身份不一致。此外，事件重放、三阶段恢复、同 attempt 重起和 founder-feedback 的上下文边界尚未闭合。

审查基于当前 QA SANDBOX checkout，origin 为 `xrliAnnie/flywheel-qa-sandbox`，HEAD 为 `8248fa96be88037ebdd32b71b7aa3341ec1280e2`，plan blob 为 `5afa494385eeacc80a6d5635679cba23cd22faf0`。已读取两份 CLAUDE.md、产品体验文档、exploration/research/plan，以及指定源码和相邻调用/恢复路径。以下 `plan.md` 均指 `engineering/doc/FLY-3055-qa-one-round-criteria/plan.md`。

这是静态 DESIGN review：未运行测试、build、lint 或真房验证；仅执行文件读取、源码检索和只读 Git 检查。开始审查时工作区干净，`git diff --check` 无输出。源码事实补正：此 checkout 的 StateStore 已使用 better-sqlite3/WAL，只保留 sql.js 形状的兼容 API（`packages/teamlead/src/StateStore.ts:30-48,96-143`），事务设计应按实际同步事务核对。

共 9 项阻塞修改：HIGH 4、MEDIUM 5；另有 LOW 1 项非阻塞修正。无需因此引入完整的新状态机或协议加载器；先修正权威来源、已有传输和恢复边界，再落实共享 schema。

## What's Good (Keep)

- 将 schema、判决及引用规则放在 `flywheel-config`，复用 `review-family.ts` 的共享规则模式；CLI 预检与服务端权威校验职责清楚。
- 同时覆盖 credential、三阶段 `/events`、legacy auto-QA `/events`，符合当前默认 `qa.auto: true` 的沙箱，而不是照搬生产架构。
- 清单与 verdict 存入现有 claim evidence/event payload，P1 事务内复核放在任何写入之前，保留已消费 credential 的精确重放优先级，这些约束应保留。
- 明确 `not_run` 原因、覆盖义务、carried 链和 merged 的未解决义务，且诚实承认服务端不判断 diff 是否触及判据。
- 改 Blueprint 的有效 prompt 字节及实际加载的 role 文件、保留 Codex/Claude 生命周期差异，范围选择合理。七类出口大体存在，但其内部调用分支和额外 feedback 入口需要下述补齐。

## Issues & Recommendations

1. **[HIGH][BLOCKING] P3 的 prior 指针在复验前已被清空，核心验收路径必然退化为首轮。**

   **问题与证据：** `plan.md:86,115,140-142` 只沿 `auto_qa_record.verdict_event_id` 查 prior，并把空值解释成首轮。但 `driveRetest` 先执行 retarget，再 wake 或 spawn（`packages/teamlead/src/bridge/auto-qa-coordinator.ts:951-978,1005-1011`）；retarget 明确执行 `verdict_event_id = NULL`（`packages/teamlead/src/StateStore.ts:5269-5273,5307-5316`）。同 head reopen 也会清空该指针及 QA execution（同文件 `5351-5363`）。此外，`getAutoQaRecordByQaExec` 无排序，源码明确说明同 exec 可对应多条历史记录，返回任意首条（同文件 `5040-5058`）。research R2 所称“落点稳定”与源码不符。

   **影响：** 第一轮 FAIL → 实现体 push → O1/O3 时查不到上一轮，无法注入清单；第二轮 carried 被判 `no_prior`，重新提交则可跳过旧 id 的覆盖义务。重启后 retest-wake sweep 同样失败（`auto-qa-coordinator.ts:1755-1791`）。这直接否定 §9 的 529 房验收，不是罕见边界。

   **建议：** 为“已接受的上一轮 verdict”定义跨 retarget/reopen/respawn 持久可恢复的引用，以 parent/record 的确定性 ownership 查询；不要把当前 head 的接收回执字段直接当历史链。可复用现有持久事件承载轮次引用，无需立即新建表，但不能只在 `driveRetest` 内存中保存旧 record，也不能只删掉清空语句而破坏当前 head 的 verdict 语义。测试需经过真实 FAIL 接收→retarget→O1/O3→提交，而不是手工给 resolver 填一个保留指针的 record；补 crash-after-retarget、同 head reopen、多历史 record。

2. **[HIGH][BLOCKING] O2 拼接位置位于 1,500 字符截断之前，完整 fixer 清单无法送达。**

   **问题与证据：** `plan.md:141` 把 rulesFixer/fixerBlock 加在 `feedbackText` 末尾。`feedbackWakeMain` 将该字段传入 `sendRunnerWake`（`packages/teamlead/src/bridge/auto-qa-effects.ts:403-421`）；真正出站前，`wakeText` 对整个 feedbackText 执行 `slice(0,1500)`（`packages/teamlead/src/bridge/runner-wake.ts:58,78-86,165-169`）。research R1 只检查 mailbox 原语没有长度限制，遗漏了上层包装。

   **影响：** summary 稍长就完全挤掉新增规则和全部判据；即使 summary 短，多条合法 fail/not_run 也只能送到一部分。实现体继续只修收到的少数问题，与“一次修全”直接冲突。消息中的 `check <questionId>` 指向原 review response，也不等于新增 QA criteria 的持久副本。

   **建议：** 给结构化 QA context 独立的有界追加通道，在原 feedback 摘要截断之后拼入完整 block，保持普通 feedback 的旧长度策略。将 `runner-wake.ts` 纳入 C4；用最大合法清单和长 summary 断言最终 mailbox content 包含所有待修 id，不能只断言 effects 层传参。

3. **[HIGH][BLOCKING] `/events` 新校验与 auto-QA 的实际 reporter 身份不一致，可绕过清单必填和 prior 覆盖。**

   **问题与证据：** `plan.md:103-105` 按 `event.execution_id` 查 session；非 QA 就跳过，认为下游会拒。实际 coordinator 用 `payload.qaExecutionId ?? event.execution_id`（`packages/teamlead/src/bridge/auto-qa-coordinator.ts:1142-1146`），其角色检查及 record ownership 都针对这个 payload 身份（同文件 `1182-1190,1242-1254`）。路由对未知/非三阶段 reporter 会落到 auto-QA（`packages/teamlead/src/bridge/event-route.ts:565-599`）。

   **影响：** outer execution_id 指向 main/未知 session，payload.qaExecutionId 指向当前合法 QA，target/head/status 均合法且不带清单：新增前置会跳过，而 coordinator 仍可接受并释放 PASS。outer 指向另一 QA 时，还可能校验错误 record 的 prior。这里指出的是新增“所有 QA verdict 强制清单”的可达绕过，不是要求重做整个 ingest 鉴权。

   **建议：** ingest 与 consumer 共用 canonical QA submission context。拒绝 envelope/payload reporter 不一致，或按下游实际接受的同一身份解析并强制校验；issue/project/parent/record 也从持久关联确定，不能让请求字段选择一个无历史的 prior。增加上述不一致身份负控，断言零 verdict 写入、零下游 PASS 副作用。

4. **[MEDIUM][BLOCKING] `/events` 把动态 prior 校验放在幂等回执之前，会拒绝已经成功写入的精确重试。**

   **问题与证据：** `plan.md:99-106` 在 `insertEvent` 去重前重新取 prior。现有路由对重复 event_id 返回 200 duplicate（`packages/teamlead/src/bridge/event-route.ts:533-546`）；CLI 四次发送复用同一个 body/event_id（`packages/flywheel-comm/src/commands/qa-result.ts:131-169`）。P3 接受 B 后马上把 record.verdict_event_id 更新为 B（`auto-qa-coordinator.ts:1270-1272,1300-1307`）。

   **影响：** B 中 carried 引用 A，B 已落库但 HTTP 响应丢失；重试时 prior 变成 B，原样的 carried(A) 被拒 `not_latest_prior`，到不了原有 duplicate 分支，CLI 还会按新规则停止重试且不留 marker。P2 即使排除了当前 event_id，在更晚事件已进入后仍有同类问题。此时“被拒=什么都没写”的提示也不再真实。

   **建议：** 先查询已持久化 event 的回执，对同一身份与规范 payload 的精确重放返回原接收结果；同 id 改内容应明确冲突。只对未接收的新事件按当前 prior 校验。保留首次拒收后修正同 id 的能力；补 P3 carried verdict 响应丢失、后续轮次后重放、部署前无清单事件重放的用例。

5. **[HIGH][BLOCKING] P2 “最新原始 qa_result”不是恢复流程认定的 verdict，O5/O6 会给修复轮次注入错误清单。**

   **问题与证据：** `plan.md:85,144-145` 按 issue 的最大 event row id 取上下文。现有 `/events` 先存事件再交 orchestrator；后者明确以 `three_stage_verdict` 为 authority：如果 A 的 FAIL 尚未完成，收到另一条 B 也必须恢复 A，而不是采用 B（`packages/teamlead/src/bridge/phase-orchestrator.ts:1073-1099`）。旧 PASS、关闭的生命周期等分支也可能忽略新事件（同文件 `1101-1125`）。恢复 sweep 读取最新事件只是触发恢复，随后仍遵循 intent（同文件 `914-928`）；fix summary 本身读的是 intent（同文件 `1330-1333,1368-1375,1418`）。

   **影响：** A=FAIL 已记录 intent、wake 前失败；之后 B=PASS 带一份形状/覆盖均合法的新清单入库，orchestrator 仍恢复 A。按计划 O5 查到 B=PASS，fixerBlock 直接不渲染；查到另一个 FAIL 则发送另一轮的失败项。下一 QA 也可能被迫覆盖或沿用一个实际被忽略的事件。本问题发生在同一 QA 生命周期内，不是 R-b 已接受的旧 run 边界。

   **建议：** 修复上下文必须按当前 intent.event_id 精确读取 claim/event；下一轮 prior 需定义“已接受的 verdict”及其顺序，而非任意原始 ingest 事件。无需把清单复制进 session_params，已有 event_id 足够作为精确读取入口。补 A 未完成→B 到达→重启恢复，以及已 PASS 后被忽略事件的负控；Lead 计数也必须从同一权威事件读，保证启动恢复路径不丢计数。

6. **[MEDIUM][BLOCKING] O2 没有所称的 `{ok:false}` / 自动重试消费路径，新 resolver 失败会使修复唤醒永久丢失。**

   **问题与证据：** `plan.md:115,192` 承诺所有 wake 出口查询失败走现有 fail-loud/重试。O2 的接口和实现均是 void（`packages/teamlead/src/bridge/auto-qa-coordinator.ts:122-126`、`auto-qa-effects.ts:403-406`）；caller 先持久化 awaiting_retest，再 await feedbackWakeMain，完全不检查结果（`auto-qa-coordinator.ts:1300-1314`）。`sendRunnerWake` 本身也是 best-effort void（`runner-wake.ts:100-112`）。启动恢复对 alive+parked 的 awaiting_retest 只等待新 head，不重发实现体反馈（`auto-qa-coordinator.ts:1847-1895`）。

   **影响：** resolver 抛错，route 只记日志并回 200（`event-route.ts:597-606`）；若改成返回 `{ok:false}`，caller 仍忽略。record 已 awaiting_retest，main 没收到要修什么，QA 又在等 main push，形成停滞。

   **建议：** 明确 O2 的错误契约与 caller 分支，保存可恢复的反馈待投递意图或采用已有 durable action 机制，成功后再标记送达；失败时 Lead 可见，重启能重驱。若选择人工恢复，也须把计划的“自动重试”改为真实的持久告警/恢复步骤。增加 context 查询失败发生在 verdict 接收之后的集成用例。

7. **[MEDIUM][BLOCKING] Founder-feedback kickback 是遗漏的上下文入口，QA 拿不到刚刚 PASS 的引用；示例自身还缺必填 title。**

   **问题与证据：** `plan.md:163` 要求 kickback 对未触及项 carried，但这种 wake 来自 founder feedback，不经过 O1/O4。现有路径包括 `packages/teamlead/src/bridge/founder-consent/wiring.ts:205-217` 的 sendRunnerWake，以及 `founder-action-drain.ts:218-239` 的直接 feedback wake；二者都没有 prior 清单注入。PASS 后 `/events` 仅返回 `{ok:true}`（`event-route.ts:606`），CLI 也不输出本次 event_id/ref（`qa-result.ts:173-177`）。plan 的 founder-feedback 条目缺少 §2 要求的非 merged `title`（`plan.md:46,163`）。

   **影响：** 首轮 PASS A 后 founder 要改动，QA 只持有更早的注入引用，或根本没有引用；照协议提交 carried 会被拒。不能把“修复提交被拒后再从错误 detail 猜 ref”作为成功路径。满 30 项时再直接添加 founder-feedback 也需要明确合并策略。

   **建议：** 通过同一个 resolver 在 QA 的 founder-feedback 消费路径注入最新已接受 PASS 的 ref/清单，或提供可靠的接收回执/读取流程并写进协议；覆盖 direct 与 durable-drain 两条入口。修正示例 title，补 PASS→founder feedback→kickback 的完整路线和满容量清单案例。同步遗漏的实际命令模板：`Blueprint.ts:1762-1763`、`auto-qa-effects.ts:666,781`，避免旧命令与新增规则同时出现在上下文里。

8. **[MEDIUM][BLOCKING] P1 把“上一轮”限定为 attempt 严格更小，漏掉同 attempt 替换，并且 O4 的 binding 不是当前逻辑轮次。**

   **问题与证据：** `plan.md:62,84,143,146` 对 prior 和 carry 链均要求 attempt 严格递减。此 checkout 明确支持 same-attempt replacement（`packages/teamlead/src/bridge/workflow-shadow-writer.ts:23,29-36`）；FLY-1050 重走 implement→QA handoff，spawn 使用 currentAttempt，注释明确其可能是同 attempt 新 exec（`phase-orchestrator.ts:718-730,1806-1815`）。执行 binding 则是 immutable（`StateStore.ts:9627-9644`），wake 只更新 shadow run-node，不更新 binding（同文件 `12092-12109`），且 onWake 在实际消息发送之后才调用（`phase-orchestrator.ts:1696-1711`）。

   **影响：** attempt 1 的 QA 已 PASS 后死亡，替换 QA 仍是 attempt 1；O7 查 `<1` 得到无 prior，丢掉已测项及覆盖义务。活体跨轮 wake 若从出生 binding 取 attempt，也会选错上一轮。P1 的现有 one-shot credential 限制不能被当作本计划已解决的跨轮能力。

   **建议：** 明确逻辑轮次、物理 execution 与已接受 verdict 的顺序，区分 submit 的上界和 wake/respawn 的上下文；同 attempt 历史可用严格更早的 server_seq/ref 排序，配合 run/node/owner 校验。O4 必须取得即将执行的逻辑轮次，而非直接复用出生 binding。若现有 credential 生命周期使某种 keep-alive 组合不可用，应明列前置条件并选择已有支持路径，不能宣称七出口均已覆盖。补同 attempt PASS 后替换和同 exec 第二轮的源到出口用例。

9. **[MEDIUM][BLOCKING] 回滚只考虑存量 JSON，未处理仍持有新命令的活体 QA。**

   **问题与证据：** `plan.md:207-209` 以 revert 作为完整回滚，称影响仅为丢响应重试的 digest。新 prompt/wake 强制使用 `--criteria-file`，且计划自己承认活体系统 prompt 不能更新（`plan.md:134`）。旧 `runQaResult` 使用严格 parseArgs，未声明 criteria-file（`packages/flywheel-comm/src/index.ts:928-938`）；prompt 的命令指向 Blueprint 安装目录下固定 CLI 路径（`packages/edge-worker/src/Blueprint.ts:1063-1070`）。

   **影响：** 回滚并重建该 CLI 后，活体 QA 仍按已收到的协议运行带 criteria-file 的命令，会在发送任何 HTTP 前因未知参数失败。保留旧 event JSON 对这一失败没有帮助。仅重启 Bridge 不会清除已存活或待启动 runner 的协议。

   **建议：** 写明回滚顺序和受影响执行集合：撤掉 CLI 支持之前，处理所有已收到新 prompt/wake 的 live/queued QA，确认已终止或能使用兼容 CLI；或者保留一个仅做语法兼容的过渡入口。无需新增 feature flag，但不能把 revert 描述成无条件即时兼容。验收覆盖“已载入新协议、尚未第一次提交”的 QA。

10. **[LOW][NON-BLOCKING] 字节兼容断言与必改协议相互矛盾，需冻结正确的验证基线。**

    **问题与证据：** `plan.md:148,193` 要求不传 qaCriteriaBlock 时所有 prompt 与改动前逐字相同；§7 又无条件增加 ONE-ROUND 规则和 criteria-file 命令（同文件 `154-168`）。同一 QA prompt 不可能同时满足两条。`plan.md:192` 的无 prior wake 字节不变，也需明确是否仍给旧 body 注入新规则。

    **建议：** 分别定义协议更新后的 golden、可选 context 缺省不引入额外字节、与任务无关角色维持旧字节。把 `vitest related ... src/index.ts`（`plan.md:187`）改成先枚举具体相关文件的实施验证清单，避免 barrel export 扩散为包级选择；本轮仍不执行任何测试。C4/C5 应在同一完整协议版本下验收，不能以旧 golden 遮掉强制规则。

## Verdict

CHANGES REQUESTED

Blocking findings: HIGH=4, MEDIUM=5. Non-blocking findings: LOW=1.

先修订 P3 持久 prior、O2 实际传输、统一 ingest 身份，以及接收回执/恢复上下文的权威边界，再补对应完整路线的测试设计。保持共享 schema、现有 evidence/payload 落点和当前 scope；上述问题关闭前，不应进入按 v1 逐块实现阶段。

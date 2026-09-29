# Design Review — plan.md (Round 2)
Date: 2026-09-29
Author: Codex
Status: CHANGES REQUESTED

## Summary

v2 修正了 R1 的主要方向：稳定的 accepted ledger、O2 截断后的追加通道、统一 reporter 身份、重放前置、O8 founder-feedback、按接受顺序取 prior，以及新的 golden 基线均应保留。但“事件已收到”“消费者已接受”“账本已提交”之间仍有未闭合的边界，恢复时还存在清单字段丢失和精确引用无法命中的问题，暂不能批准实施。

本轮完整重读 v2、exploration.md、research.md（含 R8）及已提交的 R1 反馈，并核对实际 CLI、两条路由、StateStore、consumer、wake/spawn/retry 和启动恢复调用。审查固定在 QA SANDBOX HEAD `48bd6c928c4c01779002fad6af0ee030a8f31edb`；plan blob 为 `28db6f02ab8d3288f37ef10bfbf9c6f0b16f3f41`。相对 R1 HEAD，仅三份设计文档变化，源码未变。以下 `plan.md` 均指 `engineering/doc/FLY-3055-qa-one-round-criteria/plan.md`。

共 **6 项阻塞修改：HIGH 2、MEDIUM 4**。R1 #2/#3/#6/#7/#8/#10 的主要设计问题已关闭；#1/#4/#5/#9 尚有下述残余或由新账本引入的缺口。接受 §12 R-c 对 O2 既有 best-effort 缺口的范围裁定，本轮不要求新增反馈投递状态机。

这是静态 DESIGN review：未运行测试、build、lint、真房验证；仅写本反馈文件，未修改源码。只读 Git 检查显示工作区干净，`git diff --check` 无输出。

## What's Good (Keep)

- 新账本按 parent/issue scope 和 seq 保存历史，能避开 auto-QA retarget/reopen 清空当前 verdict 指针以及 same-attempt replacement 的问题。为 accepted 历史新增窄表是可行选择，无需扩展 AutoQaRecord FSM。
- O2 从刚接受的 verdict 就地渲染，并在 `runner-wake.ts` 的 1,500 字符截断后追加独立字段；最大清单测试检查最终 mailbox content，覆盖了真正的传输边界。
- `/events` reporter 一致性与持久关联检查，关闭了 R1 指出的外层身份跳过校验而内层身份仍被接受的路径。
- O8 覆盖 direct wake 和 durable founder-action drain；补齐反馈命令、title、容量合并策略和 ref 回执，方向正确。
- 共享规则沿用 `review-family.ts` 模式；协议更新后的 golden、可选块缺省兼容与非 QA 角色字节兼容已分开。逐文件验证策略符合本轮禁止运行测试的约束。

## Issues & Recommendations

1. **[HIGH][BLOCKING] 新权威账本必须和接受状态一起提交；P1/P2 当前设计仍允许永久半写，接受顺序也缺少最终校验边界。**

   **问题与证据：** `plan.md:109` 只明确 auto-QA 的两句写操作在同一事务；`:111,124` 明确 P1 在 claim 提交返回后才登记账本，`:110` 只说在 `patchIntent` 处登记，没有把二者定义成原子操作。实际 claim 与 credential 消费在 `packages/teamlead/src/StateStore.ts:10517,10638-10705` 的事务中完成；路由拿到结果后才继续（`packages/teamlead/src/bridge/workflow-decision-routes.ts:220-248`）。phase 的 `patchIntent` 则通过另一个 session_params 写入闭包持久化（`packages/teamlead/src/bridge/plugin.ts:6425-6438`）。better-sqlite3 每个独立写入都会持久化，`save()` 不是提交屏障（`StateStore.ts:1107-1113`）。

   **影响：** P1 claim/credential 已提交后进程退出，账本没有该 verdict；新 prior 查询会把已接受的清单当不存在，覆盖义务丢失，且计划没有从 claim 修复账本的 sweep。P2 若先写 intent 再写账本，中间退出后，同 event 的恢复直接走 `runFailFlow` 或 return，不再经过首写登记点（`phase-orchestrator.ts:1079-1090`）；反向顺序则可能把未采纳的 verdict 暴露成 prior。不能依赖客户端必然重试来完成账本。

   **另外，事务应覆盖“检查最新 prior → 接受”的边界。** `plan.md:133` 的校验发生在 ingress，P2/P3 接受时不复核。实际事件可以等到启动 sweep 才被接受（`event-route.ts:590-595`），auto-QA 接受前也有 await（`auto-qa-coordinator.ts:1210-1231`）。例如同 issue 两个 QA execution 的待处理事件都按 prior A 校验；恢复先接受 B（新增失败项 X），随后接受仍按 A 校验、没有 X 的 C。两个 session 各自的 intent guard 不会执行 scope 级覆盖检查，最终账本 C 不满足“紧邻上一条已接受 B”的规则。§12 R-b 允许同 issue 历史 execution 同 scope，因此不能假定这种来源永远只有一个。

   **建议：** 在 StateStore 内定义窄的原子接受操作：P1 将账本写入放进现有 claim/credential 事务；P2 将初次 intent 与账本一并提交；P3 保留状态与账本同事务。对首次接受统一做最新 prior/seq 的事务内复核，或明确等价的 scope 串行化方案；已接受的精确重放先返回原结果。对延迟消费的事件说明“已持久化、尚未接受”的结果，不能继续泛称零写入拒收。`recordAcceptedQaVerdict` 应返回并核验实际行，只忽略预期的 ref 唯一冲突，避免 `INSERT OR IGNORE` 连 NOT NULL/CHECK 失败也吞掉后仍推进状态。新增 claim/intent 与 ledger 两次写之间的故障注入，以及两个待处理事件首次接受时 prior 已变化的用例。

2. **[HIGH][BLOCKING] 三阶段启动恢复 decoder 未列入修改，会把新事件里的清单丢掉后再登记为 accepted。**

   **问题与证据：** `plan.md:124,134,139` 覆盖在线转发和“恢复计数同源”，但没有修改 `reconcileQaVerdicts` 的独立 payload 解码。当前 `packages/teamlead/src/bridge/phase-orchestrator.ts:914-928` 从原始 event 重建一个新 verdict 对象，只传 eventId/status/summary/prHeadSha/targetExecutionId；类型 `PhaseQaVerdict` 也仅有这些字段（同文件 `84-95`）。这不是重新经过 `/events`：启动 sweep 直接调用 `onQaResult`。该路径明确承担 insert 后尚未消费以及 holder 未接线时的恢复（同文件 `892-900`；`event-route.ts:590-595`）。

   **影响：** 新协议 FAIL A 的原始 event 已有完整 `qa_criteria`，Bridge 在首写 intent 前退出。重启后按当前计划接线，A 到达新增接受点时清单已丢失：若允许 NULL，append-only ledger 将永久记录一个假的“legacy 无清单” verdict，O5/O6 和后续覆盖校验失效；若禁止 NULL，则合法的恢复被拒而无法继续。仅从 ledger 算通知计数无法补回尚未入账的数据。

   **建议：** 把 `PhaseQaVerdict`、在线 event/credential 转发和 `reconcileQaVerdicts` 的 decoder 明确列入 C3；可共用一个从持久事件构建 verdict 的函数，或在首次接受点按 event_id 精确读取规范 payload。区分真正部署前的旧事件与新事件解码丢字段，不能统一降级为 legacy。增加真实 store 的“带清单事件已入库、intent/ledger 未写 → 新 orchestrator 启动 → ledger、fix wake/spawn、Lead 计数、下一轮覆盖均保留同一清单”用例，并保留 A intent 已存在、最新原始事件是被忽略 B 的恢复负控。

3. **[MEDIUM][BLOCKING] O5/O6 把 event_id 当 accepted ref，且把精确引用缺失与合法首轮混为一谈。**

   **问题与证据：** `plan.md:89` 的 ref 是 `qv:<event_id>` 或 `claim:<claim_id>`，`:143` 的 resolver 只接收 `{scope}` 或 `{ref}`，但 O5/O6 写成 `ref = intent.event_id`（`:170-171`）。实际 intent 存的是未加前缀的原始 event ID（`phase-orchestrator.ts:106-109,1161-1164`）；P1 镜像事件 ID 甚至是 `workflow-decision:<credential-id>:<request-id>`（`workflow-decision-routes.ts:247`），不能据此推算 claim ref。计划已有 `getAcceptedQaVerdictByEvent`，但这里没有明确调用它或扩展 resolver 输入。`:143` 又把所有未命中都解释为首轮 undefined，与 `:175` 精确读取失败须 refuse 不一致。

   **影响：** 按出口表直接接线，正常 FAIL 的精确查找就不命中，导致 fixer 清单静默消失或进入 terminal refuse。后者会设置 `alertedAt` 并停止自动恢复（`phase-orchestrator.ts:1198-1205,1084-1086`）。另一个必须区分的情况是部署前已有未完成 FAIL intent：`:113,241` 明确不回填账本，故它必然没有 ledger 行，不能把这类合法升级状态当账本损坏拒绝。

   **建议：** 为 resolver 增加明确的 `{eventId}` 精确入口，内部用 `getAcceptedQaVerdictByEvent` 得到真正的 ref；或在 orchestrator 解析为 accepted ref 后传入，且把该参数沿 O5 的 wake 调用传递下去（当前调用只传目标 implement、head、round、summary，`phase-orchestrator.ts:1451-1457`）。定义三种不同结果：scope 无历史、已声明新协议的精确行丢失、部署前 legacy intent。legacy 可按该 intent/event 的既有 summary 恢复并附规则，不应自动终止；新协议缺行则 fail-closed。测试使用真实 `qv:`/`claim:` ref，覆盖两类 O6 spawn（同文件 `1330-1333,1529`）及升级时未完成的旧 FAIL。

4. **[MEDIUM][BLOCKING] `/events` 回执仍根据原始 event 猜造 accepted ref，精确重放也没有核对持久身份。**

   **问题与证据：** `plan.md:131,134` 无论 consumer 是否接受，都返回 `qv:<event_id>`；CLI 会打印 `accepted ref=`（`:77`）。当前 consumer 有正常 ignore 分支，例如 incomplete FAIL A 时收到 B 必须继续 A（`phase-orchestrator.ts:1092-1099`），auto-QA 非 running record 直接忽略（`auto-qa-coordinator.ts:1257-1266`）；路由捕获 consumer 异常/holder 缺失后也回 200（`event-route.ts:585-606`）。而 `getEventPayloadById` 已是现成方法，确实只返回 payload，不返回 event_type/execution/issue/project（`StateStore.ts:3503-3522`）。比较 payload 不能证明是同一持久事件身份；例如省略 qaExecutionId 的旧 payload，在另一 QA reporter 的 envelope 下也可能相同。

   **影响：** 计划自己的 A=FAIL、B=PASS 被忽略用例会给 B 一个不存在于账本的“accepted”引用；部署前无账本事件重放也会如此。随后 QA 记住该 ref，按协议 carried 时必然失败。若重放的是 P1 镜像 event，实际 ledger ref 是 `claim:<id>`，拼出的 `qv:` 仍错误。日志由“delivered”改成“accepted”扩大了成功承诺，不能直接沿用旧 200 语义。

   **建议：** 读取完整持久 event envelope，比较 canonical 身份和 payload；成功接受或重放时返回 `getAcceptedQaVerdictByEvent(eventId).ref`，不要拼 ref。明确区分 accepted、stored/pending、ignored/legacy receipt；CLI 只在确有 accepted ledger 行时输出可引用回执，其余结果按明确协议展示/处理。无需为此重做 O2 的既有投递恢复，但不能让“已入库但未接受”伪装成 accepted。补被忽略 B、holder 缺失/consumer 抛错、旧事件、P1 镜像重放，以及同 ID 同 payload 异 envelope 的反例。

5. **[MEDIUM][BLOCKING] 八出口仍漏掉通用 actions retry 的三阶段 QA 新起路径。**

   **问题与证据：** O7 只覆盖 `RunStartRequest → start()`（`plan.md:172`）。仓库还有 `handleRetry → retryDispatcher.dispatch()`：它从持久 chat_thread_role 恢复 phase role，并显式保留 shared-branch 身份（`packages/teamlead/src/bridge/actions.ts:830-844,857-884`）。该方法接收的是另一种 `RetryRequest`（`packages/teamlead/src/bridge/retry-dispatcher.ts:16-31,83-95`），在 `run-dispatcher.ts:583-638` 独立构建 BlueprintContext，再运行 Blueprint（`:657-658`），不经过 O7 列出的任何 start 调用。既有 phase retry 测试也锁定了该路径确实会重起 phase（`packages/teamlead/src/bridge/__tests__/actions-retry-route.test.ts:225-260`）。

   **影响：** 三阶段 QA 在已有 accepted 清单后死亡/失败，走 actions retry 重起，新 QA 会收到 §7 的强制清单协议，却没有 prior ref、旧 id 或 MUST-REVERIFY 信息。它只能重新测全或在提交时撞覆盖/引用拒收；“下一轮开局全部出口注入”的目标没有完成。

   **建议：** 将三阶段 QA 的通用 retry 纳入出口清单，由 Bridge 按持久 issue scope 调用同一 resolver，扩展 RetryRequest 并传到此处 BlueprintContext，或把 start/retry 共用的 context 构造集中到一处。不要接受 HTTP 自带的任意清单 block。补“已有 accepted A → phase QA failed → /actions/retry → 最终新 QA prompt 含 A ref 和所有 id”的测试；同时核查 QA-fix implement 的 retry 是否需要携带对应精确 fixer context，明确支持边界，避免只给 start 路径补类型。

6. **[MEDIUM][BLOCKING] 回滚步骤的实际数据库和退出条件仍不足以安全撤掉 C2a。**

   **问题与证据：** `plan.md:242` 查询 `~/.flywheel/state.db`；本 checkout 的 Bridge 使用 `TEAMLEAD_DB_PATH`，默认是 `~/.flywheel/teamlead.db`（`packages/teamlead/src/config.ts:130-132`），沙箱部署还会覆盖为 slot 的 teamlead.db（`scripts/test-deploy.sh:1400,1427`）。仅查 sessions 的 running/awaiting_review 加“最近 accepted 行”也无法覆盖尚未注册到 StateStore 的启动执行：dispatcher 先在 CommDB 注册 pending，再异步运行 Blueprint 并返回 execution ID（`run-dispatcher.ts:570-582,657-658,703,706-730`）。

   **影响：** 对错误数据库查询不能证明受影响集合为空；尚未第一次提交的 QA 也不会出现在 accepted ledger。“等它们交完卷或关闭”还不是安全退出条件：auto-QA 的 FAIL 交卷后仍活着等待 retest（`auto-qa-coordinator.ts:1294-1307`），继续持有新语法。此时撤 C2a，它下次执行带 criteria-file 的旧 prompt 仍会在 CLI parseArgs 阶段失败，R1 #9 尚未真正关闭。

   **建议：** 用运行实例实际的 dbPath，以只读方式核对，不硬编码另一个文件。明确停止新协议 producer 后冻结全部已收到/已生成新 prompt 或 wake 的执行集合，纳入 pending launch/CommDB 注册；只有这些执行不再可能调用该 CLI（已终止，或仍有兼容 CLI）才撤语法支持，单次 FAIL/账本有行不算退出。回滚保留集合也要明确包括 C2a 所依赖的 C1；说明 C2b 的新 ref 回执处理在旧服务端期间是先撤回还是兼容旧响应。增加“新 prompt 已加载、尚无 accepted 行”和“FAIL 后仍等复验”两种回滚用例即可，无需新增 feature flag。

## Verdict

CHANGES REQUESTED

Blocking findings: HIGH=2, MEDIUM=4. Non-blocking findings: LOW=0.

保留 v2 的 accepted ledger、共享规则、独立 wake 追加位和 O8。先把账本接受事务与恢复 decoder、精确 event/ref 查询及真实回执语义写完整，再补通用 retry 和可执行的回滚退出条件；这些边界修订后再进入实现。

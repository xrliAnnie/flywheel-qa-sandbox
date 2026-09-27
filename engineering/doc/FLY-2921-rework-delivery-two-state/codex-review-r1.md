# Design Review — plan.md (Round 1)

Date: 2026-09-26 / Author: Codex / Status: CHANGES REQUESTED

## Summary

方向可行，但当前计划尚未闭合：仍有返工启动失败冻结 run 的入口，启动中谓词能遮住已死替身，resume fallback 没有生成调度器要求的完整替身身份；新增 wake 路由版本也尚未贯穿签收和两库退役合同。另有交卷降级分支不可达的问题。共 **1 BLOCKER、6 MAJOR、3 MINOR**；前七项阻止批准。

审阅的是当前文档提交 `885174ede5bb5081484529eae596b64c30dc64c8`；源码与指定基线 `d52df7841cb7f7844ee83e37159987840a4c50ac` 一致。已阅读项目约定、exploration/research、K05 及指定七张票的 triage 记录，并通过 `git show` 阅读兄弟设计：2922=`af2178f244392a59ba19569792e8da0d867a36bd`，2919=`e678d874bc5520c0056a97e7147877b810be7274`。不重新讨论 Lead 已认可的职责划分；以下指出该划分下尚未落实的行为合同。

证据以源码阅读为主。额外执行了一个不写文件的内存 SQLite 验证：直接提取两个退役表的现有 DDL，分别插入同一 execution/activation/epoch、不同 wakeId 的两行，两表均复现 UNIQUE constraint failed，验证进程退出码 0。未运行测试套件、访问生产数据或修改源码；迁移和回滚脚本尚属设计，未宣称其往返测试已通过。

下文 `plan.md` 指 `engineering/doc/FLY-2921-rework-delivery-two-state/plan.md`；`StateStore.ts` 指 `packages/teamlead/src/StateStore.ts`；`dispatcher.ts` 指 `packages/teamlead/src/bridge/workflow-engine-dispatcher.ts`。所有源码行号均来自上述基线。

## What's Good (Keep)

- 五个数据库状态承载两种投递结局是合理简化；保留 `wake_delivered` 字面值、删除 run 级失败结算和目标节点 supersede，也符合本单 mandate。
- delivery 作用域的 hold 确实可用于 active run：`StateStore.ts:58160` 的可恢复判断与 `StateStore.ts:59553` 的 run 状态恢复都区分 runLevel。现有 stage/confirm/apply 门可以复用，不需要新增 API；仍须修复下列替身重投语义。
- 旧迁移的列级跳过条件必须保留；现有 `StateStore.ts:7403` 的状态字面值判断会与新 CHECK 冲突。held run 不额外补 delivery 门、不自动解冻、保留历史 hold 解码，也避免了双门互相失效。
- ACK 可在 `turn_granted` 投影、投递时钟同事务写入、换体回执按版本去重、告警正文带事件 UID，以及取消操作必须落入 applied/failed，都是有实际故障依据的改动。
- 不扩展 TURN 主键、不新增中间状态，以及限定相关测试的范围应保持。下面的修正可以围绕既有事务、证据和调度机制完成。

## Issues & Recommendations

### 1. BLOCKER — C2 仍把逻辑终态和驻留到期当成物理死亡，违反 2919 的换体前置条件

**问题：** C2 第 4 步将“会话不可逆终态”“resident hold expired/closed”列为任一即可换体的条件；新事务只接收 reason/observedAt 和投递认领，没有明确要求已核验的当前物理代次死亡证据。§6.2 又称只消费会话终态，使实现者可以保留现有直接换体短路。

**证据：** `plan.md:77`、`plan.md:106`；现有 `packages/teamlead/src/bridge/workflow-rework-coordinator.ts:621` 在探测前按终态分流，`:1168` 按 resident_hold_expired 分流；`StateStore.ts:44691` 在物化事务内终结旧会话。兄弟 `origin/flywheel-FLY-2919:engineering/doc/FLY-2919-process-liveness/plan.md:140` 要求 exact generation/owner 等证据在提交前复核，`:144` 要求旧 writer 死亡及旧启动所有权被 fence，`:149` 明确“终态标签不能充当死亡证据”，`:151` 也禁止将到期直接当成死亡。

**影响：** session 已 failed 或 resident 已 expired，但 Codex controller/worker 仍活或正重启时，2921 可先重绑节点、铸出后继。投递 owner/generation 的 CAS 保护不了进程代次，因而可能破坏单 writer 不变式。C4.4 已要求先退出再证死，同样要求必须覆盖这里。

**建议：** 将终态/到期定义为“需要收体或核验”的原因；真正换体必须消费 2919 的受信死亡/排他收据，并在事务提交时核对 execution、物理 generation/owner、节点与路由身份。精确的未启动回滚证明可作为另一条已排除外部启动的依据；alive/unknown 不得绕过。写明 2919 尚未合入时的可部署前置条件或 fail-closed 行为。增加 terminal-but-alive、expired-but-alive、controller restart 和采样后代次变化的负控，断言零后继。

### 2. MAJOR — C4 漏掉 `escalateUnlaunchedWorkflowStall`，替身仍能把 run 冻结

**问题：** 计划只修改成功回滚的 `rollbackUnlaunchedWorkflowAdmission`，没有处理无法安全回滚时的通用升级分支。

**证据：** `dispatcher.ts:1884` 超过硬阈值后，marker 存在（`:1886`）、精确窗口身份不完整（`:1897`）、外部启动证据非 absent（`:1913`）及部分取消失败（`:1934`）均调用 hold 升级。`StateStore.ts:41408` 接受 admitted 节点，`:41425` 接受 intent_recorded，`:41430` 直接 `UPDATE workflow_run SET status = 'held'`，不排除 replacement。计划只覆盖 `plan.md:171` 的回滚，以及 `plan.md:319` 中 2922 的准入前失败生产端。

**影响：** 返工替身 admitted 后卡住、启动证据不明确，协调器尚未累积五次失败，通用扫描已将 run 置 held。此后 C2 第 1 步只释放，投递再次搁浅。这是当前基线已有的独立写点，不能由未来 2922 的准入前排除规则代替。

**建议：** 在调用方与升级事务内均识别返工拥有的目标/替身，禁止该路径写 run held 或生成 run 级 hold；把诊断交给返工的重试/交还 Lead 结算。保留“证据未知时不能回滚或猜死”的保护。加入真实 dispatcher tick 回归：admitted replacement + intent_recorded + incomplete/unknown evidence 越过硬阈值，run 始终 active，最终只有 delivery 作用域的失败门。

### 3. MAJOR — “替身启动中”既存在无限等待，也会在 Lead 重投后丢失替身身份

**问题：** C2 第 3 步先于死亡和内容缺失处理，超时只覆盖 intent_recorded；其来源判断又只接受最新路由的两种 interpreted_by。它不是完整的替身启动判定。

**证据：** `plan.md:98` 至 `plan.md:105`；`dispatcher.ts:2615` 在替身缺少 launch delivery 时不 markStarted，`StateStore.ts:45208` 要求 committed owner 和 delivered 内容，`:86979` 明确 launch_committed 不能退回 abandoned。因此 pending delivery + admitted node + launch_committed 是实际存在的组合。另一方面，兼容收敛写 `engine:writer_replacement_convergence`（`StateStore.ts:44498`），Lead 重投写 `engine:hold_resume`（`:58674`），均不在计划的谓词中。wake 准入使用另一 activation（coordinator `:896`），已有 replacement 绑定会在 `StateStore.ts:47177` 拒绝；launch 内容摘要还绑定路由版本（`:45240`）。

**影响：**

- 替身在 launch_committed 后、内容送达/markStarted 前死亡，永远先命中 defer，既不进入死亡分支，也不计超时；C6 又让通用死体扫描跳过它。C4.4 的内容缺失事实若也排在该出口之后，同样无法得到处理。
- 已准入替身交还 Lead 后重投，最新解释者变成 hold_resume；协调器可能错误走 wake 准入并反复 activation_conflict。对已经准备或提交的旧版本 launch envelope，还必须解释重投后的新版本如何与其内容证明衔接。仅把 delivery 改回 pending 不能保证门后确实能继续。

**建议：** 用现有 binding、精确 launch ledger/owner 和当前目标身份识别替身，不只看最新路由的解释者。列出 intent_recorded、launch_committed、started、abandoned，以及内容缺失和 Lead 重投后的动作表；先处理受信死亡/明确内容失败，再判断是否应等待。未知启动不能靠超时猜死，但必须有可见且有界的交还路径。明确重投沿用还是重新投递 launch envelope，保持 activation 和内容版本合同。C4.4 若复用 closeActorForReworkSupersession，还需适配其当前只允许 pending/turn_granted 投递及 pending/admitted 节点的授权条件（`StateStore.ts:44242`），不能绕过该保护。

**补测：** commit 后、内容回执前死亡；commit 后长期未知；内容缺失事实优先于 defer；兼容收敛后的启动；已 admitted 替身耗尽→Lead 重投→实际完成内容投递，而非只断言 resume API 成功。

### 4. MAJOR — resume fallback 只改状态不能成为同形替身，也没有接入统一预算/认领

**问题：** C6.3 只要求 `allocateWorkflowResumeFallback` 改写 pending + 新路由，但现有函数没有执行完整的返工物化动作。

**证据：** `plan.md:205`；`StateStore.ts:48798` 调用 launch ordinal 分配器，后者 `:86949` 的 INSERT 不写 reason；fallback 在 `:48850` 追加路由、`:48871` 改投递、`:48882` 重铸 attempt，随后直接写 process_resume_fallback 事件。该函数没有类似正常物化 `:44751` 的 `rework_replacement:<req>` reason，也没有 `:44825` 的 verification path 换版本及后续恢复 lineage/附件动作。`dispatcher.ts:2814`（计划保留此约束）明确要求该 reason。fallback 入参 `StateStore.ts:48709` 也没有投递 owner/generation，其认领清理不受新协调器的 CAS 合同约束。

**影响：** fallback 生成的节点会被自己的返工启动围栏永久挡住；即使补 reason，验证路径仍可能停在旧 revision。该独立铸造入口还可以在协调器持有认领时清掉 owner，并绕过只在 replaceWorkflowReworkActor 中检查的三次预算。与 §6.1 不变式 4 不一致。

**建议：** 让 fallback 的返工分支复用同一受控物化事务或其共同事务核心，完整产生 dispatch reason、验证路径、投递 attempt、恢复 lineage/附件及退役义务；保留 resume_fallback 的 purpose/source_demand_id 语义。同时明确与协调器争用时的 CAS 和统一预算检查，不能只在预算统计查询中“数到”它。增加经真实 dispatcher 消费的 fallback 测试、认领竞争测试和第三次预算后拒绝继续铸体的测试。

### 5. MAJOR — wakeId 按版本拆分后，两库退役模型和物化 UID 消费者不再成立

**问题：** 计划把修复范围定为 wakeId 格式、解析器与 proof 格式兼容，但现有退役身份是一 activation/epoch 一个 wake。新增每次 Lead 重投一个 wake 后，这个基数已经改变；同时物化事件 UID 改名没有覆盖证明读取端。

**证据：** `StateStore.ts:35164` 的 workflow_rework_wake_retirement 与 `packages/flywheel-comm/src/db.ts:364` 的 runner_rework_wake_retirement 都有 `UNIQUE(execution_id, activation_id, epoch)`；两库查询分别在 `StateStore.ts:43592`、`db.ts:6020` 按该三元组判幂等冲突。`StateStore.ts:43562` 从 binding/turn 合成一个 wakeId，而非枚举该执行体各次投递。证明解析 `:43381` 只查相邻路由，`:43405` 仍读取不带版本的 `rework_replacement_materialized:<req>`。物化事务 `:44890` 调用退役记录，证明未找到会在 `:43578` 抛异常。

**影响：** 例如 A 收过 rev1 wake，Lead 重投产生同 activation/epoch 的 rev2 wake，之后 rev2→rev3 换成 B。用 proof.oldRouteRevision 只能计算 rev2 wake；rev1→rev2 没换 actor，不能为 rev1 生成现有相邻换体证明。即便生成两份证明，也会撞两个数据库的三元组唯一键。本次内存 SQLite 验证已复现约束冲突。更直接地，仅改物化 UID 的生产者、不改证明读取端，会使含旧 wake 的换体事务抛错并回滚。

**建议：** 在计划中明确退役单位及完整兼容策略：每个 wake 的投递版本与实际换体边的版本要分开表达，或采用能覆盖全部受信 wake 的 activation 级证明。同步覆盖两个表的必要迁移、唯一键/幂等查询、retirementId、证明生成与读取、projected wake 身份、backfill 和物化事件新旧 UID。不能用放松证明校验代替身份闭合。将这些变化纳入 §5 回滚/旧代码兼容说明，修正“除此之外不需要改其他数据”的承诺。

**补测：** 同一 actor 连续 Lead 重投后再换体；部署前旧格式 wake 与部署后新格式 wake 共存；每个 parent wake 及其 phase 子投递都退役；事务重放幂等；第二次换体仍成功。保持 TURN 不变的方向可保留。

### 6. MAJOR — 旧版本 ACK 的拒绝必须在 StateStore 写入前完成，单改 classifier 太晚

**问题：** C8 要让旧 routeRevision 的 ACK 返回 not_applicable，但当前调用链先做有副作用的投影，再调用带结果的 classifier。C1 改宽源状态后，旧 ACK 更容易提前推进新投递。

**证据：** `plan.md:68`、`plan.md:244`；`packages/teamlead/src/bridge/plugin.ts:13524` 调用 recordWorkflowReworkWakeReceipt 时只传 activationId/executionId/epoch/ackedAt，没有 wakeId 或 receipt 路由版本；`:13539` 才将投影结果交 classifier。`StateStore.ts:43864` 的事务接口也没有 receipt 版本；`:43900` 只比较数据库内当前 delivery 和最新 route 是否相等，`:43959` 随后更新 wake_delivered。`packages/teamlead/src/bridge/turn-wake-receipt-classifier.ts:71` 对已成功投影直接返回 projected。

**影响：** rev1 的 ACK 延迟到 Lead 已重投 rev2 后到达；因为同 actor、同 activation、同 epoch，事务接受它，将 rev2 置送达并激活验证路径，即使新 wake 尚未推出。之后 classifier 即便判旧，也无法撤销已提交的事实。现有测试只覆盖“换成不同 actor 后旧签收”不足以发现此问题。

**建议：** 将受信 wake 身份及其 routeRevision 从 CommDB receipt 传到 StateStore，投影事务在任何写入前严格比较该次投递身份。completion-implied 单独保留其服务端绑定证明。无版本旧 wake 要有明确、保守的归属规则。加入同 actor/epoch 的 rev1 ACK 在 rev2 turn_granted 且 wake_sent_at 为空时到达的回归，断言投递、节点和验证路径都不被推进。

### 7. MAJOR — C7 的证据形状使降级放行不可达，所述 TOCTOU 比较也没有新观测

**问题：** event-route 在 diff 失败时只传 `{unavailable:true}`，事务却先要求 reworkDelta.head 存在，再检查 baseRevision；后面的“diff 不可用但 head 不同则放行”和历史非 SHA base 放行无法按此顺序执行。

**证据：** `plan.md:220`、`:222`、`:225`、`:226`、`:228`。当前服务端权威 head 在 `packages/teamlead/src/bridge/event-route.ts:1742` 捕获，`:1962` 将同一个 completionHead 传作 subjectDigest；StateStore 在未提供它时还有会话 head 回落（`StateStore.ts:65626`），因此不能靠放开这个字段来修复降级。

**影响：** base 对象缺失或 diff 超时会长期得到 rework_head_unavailable，重新 complete 也没有办法改变，恰好产生计划声称要避免的新卡点。与此同时，reworkDelta.head 和 subjectDigest 若都来自同一次 completionHead 捕获，即使之后工作树 HEAD 已变，两者仍相等；这只能证明输入自洽，不能实现 §8.2 所承诺的“算完 diff 后提交新 head 会被拒绝”。

**建议：** 定义明确的服务端证据类型：权威 head/base/请求版本独立于 diff 的 verified/unavailable 状态。先核对请求身份及服务端 head 来源，再分别处理无有效历史 base、head 相同、diff 不可用、有效差异为空；head 解析失败与 diff 失败必须是不同分支。对 TOCTOU 明确选择：通过既有写入围栏保护新的服务端观测并校验，或将交卷定义为绑定不可变的已捕获 commit，确保下游使用它，并修改当前不成立的竞态承诺。不要将两份相同捕获值的比较当成文件系统刷新。

**补测：** 从真实 event-route 进入事务，覆盖可信新 head + 缺失 base 对象、可信新 head + diff 超时、历史 unavailable base、head 本身解析失败，以及 diff 后 HEAD 变化；不能只手工构造包含 head 的 unavailable DTO 来证明计划中的调用方正确。

### 8. MINOR — 两列事实的迁移和重置合同应一起写全

**证据/问题：** `plan.md:47` 定义两列，但 `:55` 的建表/type 改动与 `:57` 的新迁移跳过条件只列 wake_sent_at；`:86` 的换体清理及 `:159` 的 Lead 重投也没有明确清 liveness_unknown_since，尽管 `:118` 称它按请求、路由版本计时。

**影响：** 不完整 schema 可能被跳过；旧路由未知时钟可能让新体立即触发 30 分钟/2 小时告警。

**建议：** 将两列都纳入基础 schema、DTO、迁移完成条件和每次路由更新的清理清单，并写清两档告警不同的去重身份。加缺第二列的迁移 fixture 及新路由重置时钟断言。此项为 advisory。

### 9. MINOR — 拒绝审计事件不能与需要回滚的顺带签收放在同一 savepoint 内

**证据/问题：** `plan.md:229` 要求拒绝时回滚顺带签收，`:230` 又要求持久化拒绝事件；`StateStore.ts:69238` 在 impliedApplied 且失败时抛 WorkflowTransitionRollback，回滚整个内部事务。

**影响：** 如果实现时把 rework_completion_refused 写在 C7 拒绝分支内，这些最需要观察的拒绝事件会随签收一并消失。

**建议：** 明确在回滚完成后，通过既有拒绝记录机制按 request/head/reason 幂等记录；测试既无投递/节点推进，又确有且仅有一条审计事件。此项为 advisory。

### 10. MINOR — 先截前 200 条再排除 progress，会误判有效改动为空

**证据/问题：** `plan.md:217` 先“只取前 200 条”，`:218` 再排除 progress，`:227` 用 changedPaths === 0 拒收。若前 200 条全为进度文件，真实产品改动位于其后，结果会是假零。

**影响：** 该 head 确实有产品变化，却会反复得到 rework_no_product_change；同时路径转义、换行文件名不应影响计数。

**建议：** 在 Git pathspec/可靠解析层先排除进度路径，使用 NUL 分隔；这里只需证明至少一个合格路径，无须收集 200 条。若因输出预算截断而不能确定零，应进入既定 unavailable 分支。用“200 个 progress + 1 个产品路径”及转义路径覆盖边界。此项为 advisory。

## Verdict

**CHANGES REQUESTED**

请先修订第 1–7 项的规范与验收用例，再进入实现。第 8–10 项为非阻塞建议。本轮不要求恢复被删中间态、扩大成统一恢复项目或重新审批已认可的兄弟单分工；需要的是让现有五态、单一替身入口和既有 Lead 门在上述实际路径中成立。

# FLY-1686 progress 记账 × land-head 闸互斥 — 探索

Issue: FLY-1686 (https://linear.app/geoforge3d/issue/FLY-1686/bug阻塞级-流水线强制-progress-记账-1655-land-head-闸互斥-所有-schema-v2-code-run-的-qa)
日期: 2026-08-11
基于: 无

> ⛔ **第三代裁决(2026-08-11,founder 亲自打回,最高约束)**:本文 §4 的候选方案①(reconcile/diff 对比路线,gen-2,PR #807 已实现)被 founder **整体否决**;§0 为第三代方向,governing plan 见同文件夹 `plan.md`(gen-3)。§1-§3 的机制审计与场景枚举仍为有效事实基础;§4-§6 保留为历史审计记录。

## 0. 第三代方向(founder 原话,逐字入档)

**原话一(流程)**:

> 「我们能不能做成这样:最后要 ship 的这个节点(比如说是 QA 节点)做完之后再去绑定账本…1. 代码进入 commit 1,代表 implement 完成;2. QA 介入进行测试;3. 测试通过后,代码提交到 commit 2,并向我发送 report;4. 我确认可以上线后,直接以 commit 2 为版本进行绑定并上线。…不管是 implement 还是 QA,都不要把绑定账本的动作卡在这些中间节点上。我们就认准 ship 节点——也就是 ship 前面的最后一个节点。这个节点做完了,对应的 commit 确认成功了,然后直接绑定上线。…没必要搞出什么 commit 1、commit 2,最后还要把 commit 2 和 commit 1 去做对比,这不就等于打了一堆非常复杂的补丁进去吗?」

**原话二(通用性)**:

> 「要做的时候,要考虑到把这个东西做得 generic(通用),而不是绑在 implement(实现)或者 QA 上面」

**裁决的含义**:病根不是「刷新机制不够好」,是**绑定时机放错了**。在 implement 完成时冻结 head,就注定了后面每一个合法的文档 commit 都要靠「commit1 vs commit2 对比 + 白名单 + 祖先证明」这堆补丁去赦免——补丁越修越复杂(gen-2 八轮 review + 4 条 QA FAIL + 修正案两轮就是证据)。把绑定移到 **terminal(ship/land)节点的直接前驱完成那一刻**,以该次完成的服务端 attested head 一次性绑定,对比机器整族失去存在理由,**净删除**。

**结构性佐证(gen-3 审计新发现)**:generic/menu 单节点形态与 runner_ship 兼容形态**今天就是这么工作的**——execute/carrier 的 completion 直接进 approval gate,PR 证据随 `complete` 携带,引擎在同一事务里先写 binding 再 transition,land 闸查询自然命中。撞墙的只有「PR 创建者(implement)≠ 进 gate 者(qa)」的多节点 DAG。gen-3 = 把既有健康形态提升为通用规则,而不是给病态形态打补丁。

流水线**强制** QA 记 progress 账(commit progress.md)+ QA 报告 commit,必然把 QA worktree 的 HEAD 推离 implement 完成时绑定的 head;而 FLY-1655 的 land-head 闸**强制**要求服务端自派 head 在 `workflow_node_pr_binding` 精确命中 —— 两条"必须"互斥,所有 schema-v2 code run 的 QA 节点提交 PASS verdict 必然 409 `transition_refused`。

## 2. 机制链(代码审计确认,非推测)

1. QA 提交 verdict → Bridge `/workflow/decision`(`workflow-decision-routes.ts:404`)。
2. engine-owned run → `resolveEngineDecisionCanonical`(同文件 :72):family=`qa_verdict` 时 serverHead = `resolveWorkflowHeadAuthority` = 对 QA worktree 跑 `git rev-parse HEAD`(`head-authority.ts:18-43`)。客户端输入永不提权。
3. → `StateStore.submitWorkflowDecisionByCredential`:写 claim 后走 `commitWorkflowTransitionTx`(`StateStore.ts:27578`),`subjectDigest` = serverHead。
4. 转移目标是 gate 且 manifest 为 land 模式时(`StateStore.ts:28069-28079`):head 必须在 `getCurrentWorkflowNodePrBindingForHead(runId, head)`(:32597,按 head_sha 全等匹配各 node 最新 attempt 的 binding)命中,否则 `land_head_unavailable` → 外层统一吐 409 `transition_refused`(:27588-27602)。**事务回滚,凭据未消费**——所以 FLY-1672 的 QA 重发只会确定性再撞。
5. binding 只在 implement 完成那一刻写入(`recordWorkflowNodePrBindingTx`,`StateStore.ts:26591`),同 (run,node,attempt) 拒绝改写 head。
6. 漂移来源:`flywheel-comm progress`(path-limited 本地 commit,从不 push,`progress.ts`)+ QA 报告 commit,都落在同一 PR 分支的 QA worktree 上 ⇒ QA HEAD = 绑定值 + 纯文档 commit。

**结构性锁死**:过闸后下一步就是 gate holder 物化 + `bindWorkflowShipTargetForGateTx`(`StateStore.ts:28654`)—— 它按 holder head(=T)查 binding 冻结 ship-target,**binding 不等于 T 时直接 throw**。所以"闸内放行但不动 binding"根本走不通:binding 必须在过闸那一刻已经等于新 tip。

## 3. 场景枚举(设计前提,按 issue 要求先枚举)

| # | 场景 | 期望行为 |
|---|------|---------|
| S1 | QA PASS + 纯文档漂移(progress.md + QA 报告;FLY-1672 实况,今后每个 code run) | **引擎自动 reconcile binding 到新 tip,过闸** |
| S2 | QA PASS + 零漂移(T==B) | 字节等价今日行为,不触发 reconcile |
| S3 | QA PASS + 漂移含**非文档路径**(代码被 QA 改动) | 拒绝(精确 reason + Lead 告警),回工是正解 —— 与 Lead 手术判据一致 |
| S4 | QA PASS + 历史分叉(B 不是 T 的祖先,如 rebase/force) | 拒绝(ancestry fail-closed) |
| S5 | QA PASS + 远端 push 被拒(远端已超前/分叉) | 拒绝(不落库,幽灵 SHA 零窗口) |
| S6 | QA FAIL | 不 reconcile;kickback loop;下一个 implement attempt 重新绑定 |
| S7 | 响应丢失重发 | 拒绝时凭据未消费可重发;成功后同 clientRequestId 幂等重放 |
| S8 | 并发 binding 变化 | 事务内 CAS,miss 即拒,重发重derive |
| S9 | verdict 之后的继续漂移(holder 已冻 T) | progress 从不 push ⇒ 远端停在 T,land 正常;若有人把 T 之后的 commit push 上去 → land executor `pr_head_mismatch` 拦下(FLY-1667 不变量原样保留,非本单范围) |
| S10 | legacy / 无 binding 的 run(FLY-1650 家族) | 不变:精确报因,不补行(FLY-1655 既有裁定) |
| S11 | runner_ship 模式 engine run 漂移 | 今日退化为 carrier unbound(不 throw),软化变体,**v1 不动**(边界处注明) |
| S12 | 已 seal 的 PR manifest 冻着旧 head | CAS 拒绝(今日生产无 verdict 前 seal 的调用方) |
| S13 | 幽灵 SHA(FLY-1667 同族) | "GitHub 实测 PR head==T" 是 DB 变更硬前置(终点取证),不靠人记得;S15-S24 扩展场景见 plan.md §4 |
| S14 | 文档路径下塞 symlink/submodule/可执行位 | raw-mode 守卫拒绝(只放行普通 blob) |

## 4. 候选方案

### ① QA verdict 时引擎自动 reconcile binding(**采纳**)

把 Lead 已两次执行的手术语义机械化,守卫逻辑与手术完全一致;手术坑②(幽灵 SHA,FLY-1667)的机制化形态 = **服务端授权的精确 SHA push 握手**:引擎只读验证全过后才下发 push 指令,客户端证明目的仓库归属后只推被授权的那个 SHA,DB 变更以 GitHub 实测 PR head==T 为硬前置(R1/R2/R3 逐轮收敛的终稿协议):

- 引擎侧只读守卫链(先于任何 git 读的 admission preflight → tri-state 分流 → 祖先证明 `merge-base --is-ancestor` → 纯文档 diff(`--raw --no-renames -z`,白名单收紧到本 issue 的 `<dept>/doc/<ISSUE>-<slug>/`)→ `gh pr view` 实测 PR headRefOid==T);守卫全过但 PR 未在 T 时,服务端下发**精确 SHA push 指令**,`flywheel-comm qa-result` 只推被授权的那个 SHA(绝不推 HEAD,单次额度)后重发——未通过守卫的 tip 永远不会被发布(R2 修订:无预推);
- StateStore 事务内 CAS 应用:binding 仍为旧值才改,追加 `binding_head_reconciled` 审计事件(producer session 镜像为非致命投影维护),然后 land 闸以新 tip 命中,holder + ship-target 一致冻结新 tip。引擎零外部变更 ⇒ 无 push-成功-事务-拒绝孤儿窗口。

**为何它是结构性正解而不只是偏好**:§2 的锁死点说明 ship-target 冻结要求 binding==T,任何"闸侧放行"方案最终都得改 binding;那不如让 binding 是唯一权威、在一个事务里改。且 legacy 路径早有同类先例——FLY-945 Fix B(`auto-qa-coordinator.ts:1607` `tryShipGateRebind`):PASS-only / 闸未答 / 祖先证明 / CAS 改 head + 审计,生产验证过。本单是把同款语义带进 engine land 闸,外加手术特有的两道守卫(纯文档 diff + push 前置)。

### ② progress 记账改走不动 HEAD 的通道(git notes / 独立 ref)(**否决**)

- QA 报告 commit 依然动 HEAD ⇒ 单治 progress 治不好;
- 违背 doc-flow 模型"docs travel with your branch and merge to main in your PR"(FLY-205 定案);
- 改动面横跨 flywheel-comm progress writer(FLY-795 单写者契约)、restart-resume(`$FLYWHEEL_PROGRESS_PATH`)、Lead 工具链 —— 大动干戈治标。

### ③ land 闸放行"绑定 head 为祖先 + 白名单差异"的 tip,不动 binding(**否决**)

- §2 锁死点:过闸后 `bindWorkflowShipTargetForGateTx` 按 T 查 binding,miss 即 throw —— 该方案必须把"双 head"穿透 ship-target 冻结、land executor 授权、carrier 比对全链,权威源从一个变两个;
- 与"修结构别加报警器、删的比加的多"方向相反。

### ④ 把 binding 写入点从 implement 完成挪到 gate 进入(**否决**)

丢掉"implement 交付那一刻的 reviewed head"锚点,弱化"过了 review 的代码 == 合入的代码"的守卫;FLY-1655 的出生地不变量被改写而非补全。

### ⑤ 免除 QA 节点的 progress/报告 commit 义务(**否决**)

progress ledger 是 restart-resume 的生命线(FLY-795);QA 报告 commit 是"收工前 git status 必须为空"的交接契约。两者都是刚需,砍掉是把互斥换成新伤。

## 5. 红线(不动摇)

- **不放松「批准 head == merge tip」**:reconcile 发生在 founder 看到任何东西之前;founder 批的、land 合的,都是同一个 T。land executor 的 GitHub 实测 head 全等检查(`land-executor.ts:329`)原样保留。
- **白名单不给 runner 写**:diff 白名单是引擎内常量规则(issue 级收紧:`^[a-z0-9-]+/doc/<ISSUE>-[a-z0-9-]+/.+`,`<ISSUE>` 出自 `sessions.issue_identifier` → identifier 形态 `run.issue_id` 的信任链),不进 run 参数、不进 env,防滥用。
- **非文档差异 = 拒绝 + Lead 告警**,绝不静默放行 —— 与手术判据逐字一致("非文档差异=不适用本手术,回工是正解")。
- **不加新 feature flag**(Annie 既有铁律,FLY-1466):这是 bug 修复,把"今天确定性 409 的那条路"修成机械化手术;健康路径(S2)字节等价。

## 6. 结论

采纳方案①,v1 范围收敛为:engine-owned + land 授权模式 + qa_verdict PASS 这一个边;runner_ship 软化变体(S11)、verdict 后再 push 的场景(S9)明确出界。

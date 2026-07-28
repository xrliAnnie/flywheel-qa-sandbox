# Design Review — plan.md (FLY-1498) (Round 1)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

总体方向正确：评审义务下沉到节点完成合同、ship 保持恰三条通用前置、dispatcher 只读 DAG，均直接回应 founder 指令，也能干净复用 FLY-1497 的 17 表 kernel 基础。但当前设计尚未证明三条 ship 条件充分：完成事务没有把 task 置为 `done`，manifest/evidence 的可信来源未闭合，rework replay 可产生多个 lineage 现任，且 B5 并行分支与单 worktree 假设互相冲突；这些都是实现前必须在设计中收口的 correctness gaps。

## What's Good (Keep)

- F0 逐句复述并映射了四条 founder 指令；`product_code` 评审属于节点完成合同而非 ship gate，这个责任边界是对的。
- 三档分类、混合 diff 取最严、test-only/docs-only 免跨族代码评审，忠实执行了 research §10 的 binding rulings，且没有引入 scenario-specific 分支。
- `github_merge` 被建模为 action，CI 红由 merge executor/branch protection 拒绝而不成为第四个流程门；该表述保持现有行为并避免重新耦合 review history。
- 设计复用了现有 `tasks/task_dependencies/gates/events/attempts/meta`、`Kernel.write`、CAS、generation fence 与 outbox；分类放事务外、事务内只做短谓词校验的方向符合 1s transaction budget。
- 返工不建图上 loop edge，terminal task 使用 `rework_of` successor、非 terminal task 使用新 attempt 的总方向与 FINAL §1.1、B2/B3 一致；不设 `max_iterations` 也符合 Lead 裁定。
- design-only / batch 3+ wiring 的切分合理，v1 的 `isReviewableRole`、`node_id='qa'`、`nextPhase` 等退役面也列得清楚。

## Issues & Recommendations

1. **[HIGH] “完成”没有在一个事务里完成 task/attempt/activation 的完整状态转移。**

   `plan.md:74-82` 只 CAS `attempts` 到 terminal、写 `node_completed`、推进 `span_tip`，没有把 `tasks.state` CAS 到 `done`，也没有 terminalize 当前 activation/释放 worktree writer。可是 dispatcher 只派 `state='ready'`（`:110-111`），ship 又要求 lineage 现任 task `state='done'`（`:99-102`）；按现文成功完成后 task 会留在 running/review，既不能再派也永远不能 ship。现有 schema 还明确有 task state/version/terminal_at（`0001-base-schema.ts:2-14`）和 activation active→terminal FENCE（`fence.ts:189-193`）。

   **建议修复**：把完成事务定义为同一 `Kernel.write` 内的单一状态机提交：验证 current task/attempt/activation identity 与 contract → CAS activation active→terminal → CAS attempt active→terminal(completed) → CAS task 当前 state/version→`done` 并写 `terminal_at` → append `node_completed` → CAS `span_tip` base→head → revoke/close writer authority；任一步失败整体回滚。明确 raw evidence 可先存在，但“合同满足清单+证据 refs+task/attempt/activation 完成+tip”必须同事务落账，才满足 requirement ①。

2. **[HIGH] manifest 与 evidence 目前由完成方自报，product-code review 可以被自我授权绕过。**

   `plan.md:49-65` 接受 proposal 中的 `files[{path,class}]`、`effective_tier`、digest；`:67-71` 又从 event payload 读取 `reviewer_family`。C4 只查询这些行并比 head/kind/family，没有规定谁有权产生它们、kernel 如何证明 file list 是 `base..head` 的完整真实 diff、或 reviewer family 如何由已认证 reviewer 身份派生。一个 runner（或普通 bug）可以漏报 product 文件、把它标成 test，或提交 `reviewer_family='other'` 的 approved event；随后三 ship 条件与 expected-sha 都可在同一真实 head 上通过。这直接违反“contract derived from ACTUAL outputs”和“cross-family hard gate”。

   **建议修复**：完成 API 不信任 caller 提供的 classes/families。由可信 Git observer/kernel-side classifier 对不可变 `{repo/worktree, base_sha, head_sha, classifier_version}` 计算完整 manifest，并落带 authority/provenance 的幂等 receipt/event；完成事务只消费该 trusted digest。`node_verdict` 必须用 `events.task_id/attempt_id` 绑定当前 task/attempt/activation；`review_verdict` 必须绑定 review request、reviewed span/head 与已认证 reviewer execution，`author_family`/`reviewer_family` 都从权威 attempt/reviewer identity 派生而非 payload 自称。未知 source、缺 identity、NULL/未知 vendor 全部 fail closed。

3. **[HIGH] 三档 classifier 尚不是完整、fail-closed 的 Git diff 规范。**

   `plan.md:49-55` 的 manifest 只有 path/class，没有 status、old path、mode 或完整性计数。rename `src/x.ts → docs/x.ts` 若只看新路径会被判 docs；symlink/submodule、mode-only change、删除、大小写/非规范路径和 duplicate/missing entries 也未裁定。当前 v1 classifier 反而会同时检查 rename 的新旧路径（`ship-relevant-diff.ts:126-129`）并要求 docs 是 regular blob（`:159-165`）。另外 `artifact(artifact_kind)` 只有语义名字，没有数据化 path selector/blob digest 规则，引擎无法在“零 per-kind 分支”前提下验证“artifact 在自己的 span 内”。

   **建议修复**：钉死 canonical input，例如 `git diff --name-status -z base head` 的完整结果；manifest 至少含 status、old/new path、old/new mode/blob identity，rename 两端取最严，未知 status/mode、symlink、submodule、路径规范化失败、Git 输出与 file_count/digest 不一致一律 `product_code` 或拒绝。declared artifact 改为数据描述符（exact path/glob、允许 file type、blob digest policy），不要只给 `artifact_kind` 后再让引擎硬编码解释。

4. **[HIGH] ship 的 target/head/gate authority 未闭合，且条件 1 与条件 3 当前实质重复。**

   S3 的条件 1 已要求 approved gate digest==tip，条件 3 又只比较 tip==同一 digest，真正的 PR head 直到外部 merge expected-sha 才观察（`plan.md:99-105`）。因此“admission+claim 双校验”并未成立；C4 所称“head 已变则步 3 断”（`:82`）也不成立，因为步 3 只检查 `manifest.base==tip`。同时 `gates.task_id` 在已合入 DDL 中是 NOT NULL（`0001-base-schema.ts:116-126`），但 S2 又说没有 task 拥有 ship；设计没有给 gate 一个稳定 association，也没有把 repo/PR/worktree 绑定进 gate/command。当前 v1 land authority 会显式核 PR binding、PR number 和 repo identity（`land-executor.ts:143-165`），新模型不能丢掉这条 authority boundary。

   gate lifecycle 也缺失：多个同 head gate 中“任一 approved 即通过”会让较新的 rejection/撤回失效；DAG/contract revision 在不改 head 时可以剪掉未完成节点，却继续复用旧 founder approval（`plan.md:106,113-116`）。

   **建议修复**：定义 canonical ship target `{project/issue, repo_identity, pr_number, worktree_id, head}` 及其稳定 authority binding；说明现有 `gates.task_id` 只是哪个 immutable anchor 的关联，若 17 表无法无歧义表达 multi-target，就诚实安排最小 migration，不要用任意 task。第三条件必须是 fresh authoritative PR head==target tip，并在 executor 以同一个 SHA 做原子 compare-and-merge；`tip==gate.digest` 留在条件 1。定义每 target/head 的 gate supersession/current-row 规则、rejection/revocation 语义；任何 DAG/contract revision 必须同事务 expire 旧 approval，之后 founder 即使 head 不变也要重新批准。以上属于 target/authority construction，不是第四个 review gate。

5. **[HIGH] rework cascade、lineage 现任与证据失效在 crash/replay 下不成立。**

   D3 只说“级联 successor、按需终止、幂等重放”（`plan.md:118-122`），但 schema 只有 self-rework trigger，`rework_of` 没有 UNIQUE（`0001-base-schema.ts:11,16-21`）。事务 commit 后响应前崩溃，再放同一 rework request 会为同一 predecessor 再建一套 successor；“无 successor 指向它的最新 task”便出现多个 leaf/current，依赖与 ship 无确定对象。对未完成下游，仅“终止 active attempt”也没有把 task 重置成 blocked/ready 或说明何时开同-task新 attempt。

   “新 head ⇒ 旧证据自动过期”也不是总成立：空 span rework 可保持同一 head；`node_verdict` 有 `emitter_task_id` 字段，但 C3 有效性谓词没有要求它等于当前 successor/attempt，所以旧 QA PASS 可直接满足新 QA successor。

   **建议修复**：给 rework request 稳定 idempotency key/event_uid，并在一个事务内以 incumbent task `state_version` CAS；重放同 key 返回同一 successor set，payload 不同则 conflict。每 lineage 必须 fail-closed 断言恰一 incumbent，并禁止同 predecessor 多 successor/rework cycle/跨 lineage_root。明确求 transitive downstream closure，平行无关分支不动；terminal current→successor，non-terminal current→terminalize旧 attempt并在同 task 新 attempt，所有受影响 task 的 ready/blocked/running 转移与 attempt terminal_reason 都列成表。declared verdict/artifact evidence 绑定当前 task+attempt；哪些 head-scoped review evidence允许复用必须显式列政策，不能由“head 相同”隐式决定。

6. **[HIGH] B5 并行分支没有可执行语义，且与 H 的 single-worktree 假设矛盾。**

   scenarios B5 要求无依赖 task 可并行，唯一限制是同 worktree 单 writer。D1 却对所有 eligible task 都要求“worktree writer 空闲”（`plan.md:110-111`），没有区分 read-only/verdict task 与 writer；H 又称 v2 现实是每 issue 单 worktree 单 PR，同时把 multi-worktree 推到“每链各自 ship”（`:153`）。前者会序列化同 issue 的所有 writer，后者又与 S3 的单一 tip/gate、issue 全 DAG done 语义没有对接。

   **建议修复**：把 task 的 writer capability 与 worktree/ship-target assignment 数据化。read-only/empty-span nodes 不占 writer lease；同 worktree writers 串行，不同 worktree writers 可并行。随后明确 multi-worktree 的 per-target span tip、PR binding、founder gate 和 ship command，以及 cross-worktree join 如何把产出纳入某条受合同覆盖的 chain。若 batch 3 首版只支持单 target，就必须在场景/验收中诚实写 B5 仅支持哪些并行，而不能同时声称完整覆盖 B5。

7. **[MEDIUM] completion/rework/ship 的 idempotent replay 与 1s budget 只有结论，没有 predicate/key/crash contract。**

   V4/V8 要测 replay，但 C4 没有 stable completion request key；commit 后丢响应的 replay只会撞 attempt CAS。rework 问题见上；ship 也没有钉死 `commands.effect_key`、已 merge 后的 inspect-and-adopt、或 crash 在外部 merge 成功/receipt 落库前的 reconcile。D1 可继承 FINAL §2.2 的 stable execution id，但仍应逐项写出 key、same-key same-payload replay 结果、same-key different-payload 冲突、以及 external effect unknown 的收敛路径。

   原子 rework cascade 对任意 N 节点还可能超过 `Kernel.write` 的 1s budget；当前没有 admission 上限或 worst-case 验收。

   **建议修复**：为 completion、rework、ship 分别定义 canonical key 和唯一落点（可复用 events.event_uid / commands.effect_key），列 commit-before-response、effect-before-receipt 等 crash 点及重放结果；ship key 至少绑定 repo/PR/head，重放先 inspect PR，只有 exact head 已 merged 才 adopt。对 rework 用 set-based SQL，并给 supported DAG 最大规模/性能验收，保证最坏级联在 1s 内；超规格在 admission fail closed，不能运行中永久超时。

8. **[MEDIUM] 反 over-reaction 台账、验收矩阵和压缩并稿文本尚不足以守住上述不变量。**

   exploration §6 只覆盖五个机制，且多处引用 incident 或模糊“D 类”，没有把 gate supersession、DAG revision、lineage incumbent、rework cascade、graph validation、multi-worktree、replay 等机制逐项映射到明确的 B/C/D scenario；这不满足 issue 要求的“每个机制答哪个 enumerated scenario 需要它”。现有 V 也缺 B5 并行、admission/revision cycle、rename/classifier completeness、伪造 evidence、task+attempt+activation 原子完成、同 rework 双提交、post-approval DAG revision、duplicate/rejected gate、以及 merge-success-before-receipt。

   压缩文本还会固化三个不实推论：`head 已变则 C4 步3断`、绕节点 push 会在 ship 的“链校验”失败、以及 rework 一定产生新 head 使旧 evidence 过期（`plan.md:82,87,121,177`）。

   **建议修复**：在详细 §1 增加完整 mechanism→scenario ledger，至少精确映射 B1/B2/B3/B4/B5/B7/C4/C8/D1/D2/D5 与两个 mandated acceptance cases（FLY-1497、PRD-only）；扩充 V 为上述对抗/并发/crash tests。修完详细设计后再重新生成 §2 压缩文本，把所有 safety-critical predicates、target scope 与 honest boundary 同步进去，避免 main authority 与 design-chain 再次分叉。

## Verdict

CHANGES REQUESTED — address items above

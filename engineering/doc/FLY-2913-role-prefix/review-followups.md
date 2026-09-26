# FLY-2913 逐角色精简固定前缀 — 评审处置
Issue: FLY-2913 (https://linear.app/geoforge3d/issue/FLY-2913)
日期: 2026-09-25
基于: plan.md

R1 gate `c2bc9590-4a99-4032-97fd-aad2ddc17fb5`; request `82f72478-f361-485a-be8c-4d1affa2035f`; effective/raw verdict CHANGES_REQUESTED. Server policy: medium_low_findings_are_non_blocking_v1. No Lead governance ruling claimed.

| findingKey | 级别 | 处置 |
|---|---|---|
| task-declared-capability-undefined | HIGH | 修复：新 prefixTaskSet 有限 ID 协议、受审 registry、实际两个 scheduler payload、pinned snapshot/重试链、所有无声明触发器 legacy、会议纪要真任务和负控；等待新门确认 |
| forbidden-plugin-new-vectors | MEDIUM | Follow-up：compiler 在 plugin-dir/MCP 入口按源插件/manifest/server 身份拒绝 Discord，不只检查 enabledPlugins；runner/reviewer 双路径负控 |
| rollback-flag-registry | MEDIUM | Follow-up：给专用 enum 开关注册 feature-flags registry 的 readSites/timing/toggleable/retireWhen，并以实际控制写入和新 launch 证明回退 |
| cli-version-drift-policy | MEDIUM | Follow-up：确定受支持版本/self-probe 策略，显式 legacy fallback 通知，澄清 resume 版本不匹配处置 |
| mcp-credential-materialization | MEDIUM | Follow-up：禁止复制 literal secrets；reviewer 禁 credential-bearing MCP，私有配置只保留引用；落盘/清理与 secret scan |
| scope-complexity | MEDIUM | Follow-up：Lead 决定是否将混合 plugin 组件副本/规则片段延后；当前未擅自删掉原目标或宣称整包保留已达到精简 |
| hook-context-bucket | MEDIUM | Follow-up：hook 注入的 additionalContext 单列来源、token、keep/remove 决定，避免长期落残差桶 |
| reviewer-stamp-dir-nonexistent | LOW | Follow-up：reviewer 目前没有所称现成产物目录；实现需明确 request/session 目录与终态清理 owner，不能把计划措辞当现成能力 |
| tests-incomplete | LOW | 记录限制：docs-only worktree 无 node_modules，reviewer 未跑到 vitest；本轮不补跑整包。实际代码实现时安装依赖并跑相关具体文件，零测试不算通过 |

这些项已保留供 Lead 作后续安排；无一在本设计阶段被描述为运行验证通过。新 review 只验证 HIGH 修复及其引入的回归，非阻断意见不当成暗含批准或伪造完成。

## R2 — 有效 APPROVED

Gate `5aec411f-dcf1-4ecf-93ba-71fb9d401763`; request `eff3a170-6ae9-45b4-ad6f-766806747a19`; effective/raw APPROVED。R1 HIGH 已经此新门验过；批准证据见 `evidence/design-review-approved.json`。以下建议保持非阻断 Follow-ups，不修改获批 plan blob：

| findingKey | 级别 | 后续处置 |
|---|---|---|
| downstream-dispatch-propagation | MEDIUM | 实现者覆盖 workflow-engine-dispatcher.ts:3092、actions.ts:1222、DirectEventSink.ts:681/1403，或在 dispatcher 按 runId 统一读 pinned snapshot；existing-run 缺 prefixTaskSet 应继承旧值，不能误判切换/降级；补 entry+后续节点/replay 用例 |
| engineering-producer-vs-lead-unchanged | MEDIUM | Lead 在实现前明确普通工程声明写入点：typed CLI/runner-actions 或限定 Lead-authenticated start 的 Bridge 映射，并明确这是否触及“只不改 Lead 配置”的边界；未确定前不能声称默认启用可交付 |
| snapshot-field-rollback-compat | LOW | 文档注明新 snapshot 的 exact-key parser 不向旧 Bridge 兼容；legacy 开关回退与代码版本回滚不同，后者影响进行中的新格式 run |
| reviewer-taskset-source | LOW | 实现明确 reviewer/land 的 taskSetId 来源（被审 execution snapshot 或固定评审集合），缺失值的 legacy 行为须显式 |
| tests-incomplete | LOW | 延续 R1 限制；docs-only static review，不是实现测试已过 |

R1 中未修的八项继续有效。工程声明入口、后续节点传递是实现前的具体注意事项；批准设计不代表这些实现问题已验证解决。


## 2026-09-26 DAG revision correction — APPROVED advisories

Gate 53e1859b-f323-4509-abca-a44e6661b3d3 / request 045179e7-c350-4880-b86f-da28ffda1d38. Effective and raw APPROVED; all findings non-blocking. Sent to Lead in report c90ce703-bb15-47a6-8dd6-e399797019b4; durable queue retained despite doorbell timeout. Current disposition for every item: retained Follow-up, not claimed fixed; Lead decides implementation treatment. Approved plan and appendix preserved.

### binary-revert-strands-prefix-snapshots — MEDIUM

已发布 role-v1 修订后回滚二进制会让工程流水线停摆，但计划没有给出安全的操作顺序

在 workflow-template.ts 中，v1 校验器（约第 459 行）和 v2/v3 校验器（约第 1015 行）都用 exactKeys 拒绝未知的节点键。parseWorkflowRunSnapshot、materialization、land-executor、merge-ship-gate、workflow-engine-dispatcher 等调用方都经过这两套校验器。所以，只要带 prefix_profile/review_prefix_profile 的修订发布到 tpl_code/tpl_simple_code，回退 FLY-2913 的构建就会出问题：旧 binary 读不了当前修订，新 run 无法起跑；已钉到新修订的在跑 run 在派发、land 或门禁时解析快照会直接抛错。计划只写了“不属于此一步回退保证”。建议在操作配方里写明顺序：先把两个模板的指针回退到不含这两个字段的修订，再确认已钉到新修订的活跃/held run 数为 0，然后才允许回滚二进制。C6 里也可以加一条只读检查。

Disposition: non-blocking Follow-up; no change to approved design in this closeout.

### in-flight-regression-escape-unspecified — MEDIUM

去掉全局开关后，在跑 run 遇到 role-v1 回归时的补救路径没有写明

新语义让已起跑的 run 一直用 role-v1。一旦精简配置导致缺工具，这类 run 的 retry、rework 和评审会反复失败，指针回退也管不到它们。计划在 C2 保留了 full-mcp guard，而 runs-route.ts 约第 1917–1949 行在每次 start 时会读取实时 issue label，所以这个 label 实际上是针对单个 issue 的在跑逃生口。但它和“run 钉版本”的承诺并存却没有交代：计划既没把它定为官方补救路径，也没把它列进 C5 的 selectionSource，C6 也没有对应验证。建议二选一写明：要么把 full-mcp 定为逐 issue 回退手段并记录可观测的 fallbackReason，要么明确在跑 run 只能终止后重开。

Disposition: non-blocking Follow-up; no change to approved design in this closeout.

### rollback-semantics-change-is-global — LOW

“其他模板保持原样”与 C4 对所有模板改变 rollback 语义相互矛盾

C4 把所有模板的 workflow-template rollback 从“复制成新修订”改成“移动指针”。现有测试 workflow-template-publication-service.test.ts 约第 129 行断言 published_revision=3，engineering/doc/FLY-2606-live-config/operator.md 第 27 行写的也是现有语义。第 70 行虽然要求更新文档和测试，但第 16 行说其他模板不变。建议明确写出这是一项面向所有模板、操作方可感知的变更，并点名要更新 operator.md。

Disposition: non-blocking Follow-up; no change to approved design in this closeout.

### historical-flagstore-session-path-unneeded — LOW

历史 FlagStore role-v1 会话的兼容路径在生产里走不到

FlagStore 版实现从未进入 main：PR #1361 仍是 OPEN，origin/main 的 feature-flags registry 里也没有 runner_prefix_profile。所以“升级前已以 role-v1 启动”的会话只可能出现在 529 隔离房里。为它新增 historical-session selectionSource 和 resume 时复用磁盘 settings 的逻辑，会引入一条绕过快照选择、生产又测不到的分支。建议改为声明：房外不存在 pre-contract 的 role-v1 会话，房内会话随拆房结束，不实现这条迁移路径。

Disposition: non-blocking Follow-up; no change to approved design in this closeout.

### stale-switch-done-criteria — LOW

plan.md 里仍有被取代的开关类验收条目

§九声明取代 §二的开关、§七 FlagStore 和 T6 默认启用，但以下条目没有明确标为作废，容易把 QA 引向已删除的机制：完成定义第 4 条“可用一个 runner/reviewer 专用开关恢复旧配置”，T5 第 174 行“legacy 开关新会话恢复原 inventory”，以及第 172 行关于 meeting-notes 声明正控的内容（§六 已取消）。建议在 §九 列出被替换的具体条目，或加删除线。

Disposition: non-blocking Follow-up; no change to approved design in this closeout.

### qa-review-prefix-ambiguous — LOW

候选模板里 qa 节点是否声明 review_prefix_profile 没有定下来

“qa 如可触发既有 code review 也声明该值”把候选 manifest 的内容留给实现者自己判断。建议查清 QA 节点会不会成为跨家族 Claude 评审的作者 execution，然后给出确定值，并写进候选生成器的 fixture 断言。

Disposition: non-blocking Follow-up; no change to approved design in this closeout.

### pointer-rollback-digest-idempotency — LOW

指针回退要求重新校验后的 digest 等于历史 manifest_digest，但没写不相等时怎么办

workflow-template-publication.ts 的 stage 会用 validateManifestForPersistence 重新校验历史 manifest，再计算 sourceDigest。新的事务要求这个值等于该修订存下的 manifest_digest。如果持久化规范化规则在那个修订创建之后变过（例如 FLY-2775 的别名处理），回退到它会被拒绝，而且没有替代路径。这是 fail-closed，不算不安全，但建议写明错误码，以及替代路径（例如以 file 方式发布等价的 legacy manifest）。

Disposition: non-blocking Follow-up; no change to approved design in this closeout.

### legacy-metadata-nonblocking — LOW

legacy 启动的身份元数据写失败时，是否仍须照常启动没有写明

C5 要求所有有效 legacy 启动（缺字段、full-mcp、编译错误）都要记录身份，但没说元数据写失败时启动怎么办。建议明确：写失败只输出可观测日志，不得阻塞 legacy 启动，也不得改变它的 argv/settings 字节；C6 加一个负控验证这一点。

Disposition: non-blocking Follow-up; no change to approved design in this closeout.

### tests-not-run-doc-only — LOW

本轮没有执行任何测试

被审的 84e68c66b 只改了文档。worktree 没有安装依赖（没有 node_modules，也没有 packages/*/dist），所以没有跑任何 vitest 套件。本次结论完全基于静态核对代码：workflow-template.ts 的校验器、workflow-run-snapshot.ts、workflow-template-publication.ts、StateStore 的 createAndPublish/publishWorkflowTemplate 及其表结构（下一个修订号取 MAX+1，回退指针后再发布也不会撞号）、flywheel-comm 的 workflow-template CLI、run-dispatcher、review-prefix-profile、land-executor 的 implementationExecutionId。C6 列出的测试文件和 package 名均已核实存在。

Disposition: non-blocking Follow-up; no change to approved design in this closeout.

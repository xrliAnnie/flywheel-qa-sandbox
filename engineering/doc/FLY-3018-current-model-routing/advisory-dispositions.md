# FLY-3018 评审建议处置 — 实施计划补充
Issue: FLY-3018 (https://linear.app/geoforge3d/issue/FLY-3018/引擎路由-派单不带覆盖时老单的实现节点opus被解析成-codex-模型gpt-6-astra-gpt-56-sol回执仍写-opus)
日期: 2026-09-28
基于: plan.md

## 权威与阅读顺序

有效评审 `e59792b3-aa92-491f-b77d-1483e8c3c4d3` / request `8bb78710-f6dc-4c3f-a34b-df6382a5c069` / round 1：`reviewVerdict=APPROVED`，0 HIGH、3 MEDIUM、5 LOW。持久 approval proof 的 expected_blob_sha 为 `472d33cbc3331dda5f4ef0cde505e43aa7f51278`，对应提交 `2b770e6a2e2dd5adc50c5d1b561f5845d4493c1f`；该 plan blob 保持不变。

Lead 对报告 question `112ba390-4121-4c91-a101-94e927373bf9` 的回复明确要求本附录，并授权按以下处置直接完成设计交接，不重开设计评审。本附录对下列细节优先于 plan 原文；不改变“新 run 当前配置、同 run 冻结”的已批准主方案。

## 本次实现必须处理

### 1. receipt-no-assignment-drops-follow-latest-alias

保留 FLY-2775 的 alias 契约，不能把合法的历史 `opus (= claude-opus-5)` 改为 `claude-opus-5 (= claude-opus-5)`。保留并扩展 `packages/teamlead/src/__tests__/workflow-dispatch-resolution.test.ts:703-713` 的 binding 升代用例。

本 run 有有效 assignment 时，alias 与 exact 均取自它并核对 snapshot；没有 assignment 时，保持既有 follow-latest alias 的同模型家族兼容投影。校验沿用现有 registry/模型身份定义，不新增镜像别名表，不把“同 vendor”当成“同家族”，也不使用今天的 binding 抹掉历史合法 exact。跨家族或跨 vendor 的标签不得保留；没有可证 alias 来源时才显示 full ID。这样保留 Opus 旧代标签，但阻止 opus + Astra/Sol 拼接。

测试同时证明：Opus 5.5 菜单与 Opus 5 frozen exact 保留 opus；frozen Astra assignment 输出 astra；无 assignment 且不属于原 alias 家族时不冒充 opus；effort 随实际冻结/准入规则投影。

### 2. post-admission-receipt-conflict-retry-risk

模型/assignment 一致性和成功回执所需的结构校验在 admission/launch **之前**完成。effort 采用 snapshot dispatch 加现有确定性 `narrowEffort` 规则，不为显示目的另写一套 effort 合法性规则。实际会话一致性在准入后用于验收与诊断，不把已接受且可能已启动的请求重新变为“start 失败”。

明确两个边界：

- materialization 前可拒绝的输入错误应在冻结 run/reservation 前拒绝，零启动副作用。
- 若发现的是已经 materialize 的 run 自身损坏：在 admission 前明确拒绝并保留原 run/reservation 及诊断事实，不自动删除、终止、释放、换 key 或制造替身。相同 key 重试必须在共同的 launch 前验证路径重复得到相同拒绝，不能因为 `menuResolution` 不存在绕过检查。只有既有受监督恢复路径可以处置该 run。

同 key 的成功缓存响应仍原样返回；未缓存的 replay/engineRecovery 可以做内部一致性校验，但保持原响应形状，不增加 nodeModels。准入/launch 已持久化之后的异常仅通过现有诊断/日志机制显式记录，沿用已有 accepted/pending 响应和重试身份；禁止改为诱导新派单的失败响应，也不伪造会话与回执相等。

必须加测试：预准入损坏零启动、run/reservation 不被删除、同 key 重试无绕过/无新身份、准入后异常不会把已接受请求改为失败、已有正常缓存重放不变。真实 runtime/session 的不一致仍是 QA FAIL，不能把“响应保持 accepted”解释为模型已经正确。

### 3. retained-tests-missing-dag-entry

显式保留 `packages/teamlead/src/bridge/__tests__/runs-route.dag-entry.test.ts`，它已有带菜单 start 的 nodeModels 断言。新 `fly3018-current-model-routing.test.ts` 以该文件为主要菜单/start 夹具参考；generalized-pending 仅用于 pending/accepted 行为参考，不能替代菜单回执覆盖。

```sh
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/runs-route.dag-entry.test.ts
```

### 4. fly2891-rerun-test-semantics

更新 `packages/teamlead/src/__tests__/fly2891-split-arm-effort.test.ts:524` 附近的 re-run 测试名称、注释和输入：两次 fresh run 之间修改临时配置中的 arm effort，新 run 必须采用新 effort；同一个原 run 的 replay/recovery 仍采用冻结 effort。使用同 issue UUID、不同新 key，与同 key 对照，不能用“不改配置也通过”声称证明了新规则。

```sh
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/fly2891-split-arm-effort.test.ts
```

### 5. replay-receipt-scope

保持现有 replay/engineRecovery 响应面。撤销 plan §3.2 对“旧 reservation 首次生成响应”新增 nodeModels 的隐含扩展；只有既有会返回 nodeModels 的 fresh start 分支修正投影。cached response 原样重放；没有 nodeModels 的原 replay 响应保持不带此字段。内部 frozen-assignment 校验与 API 字段投影分离，不能通过不生成字段而绕过启动安全检查。

## PR Follow-ups：本单不扩大实现

| findingKey | 处置与需披露的影响 |
|---|---|
| scorecard-mixed-group-impact | 不改 `workflow-scorecard-report.ts`。同 issue 跨 run 出现多个 arm/policy 后，现有统计会标为 mixed 并退出按 arm 分组。这是新语义的已知结果；PR 披露样本数可能下降，统计增强另作 follow-up。 |
| related-on-hub-files | 不做测试系统优化。运行前先预览 related 选择并核对具体文件；如果会覆盖整包，禁止执行，记录冲突与消费者发现证据交 Lead 处置。plan 中 related 命令有此强制前置条件，不能直接复制执行。全文本匹配测试仍逐个具体文件运行。 |
| stale-line-refs | 不改已评审 blob；本附录校正：`resolveAutomaticModelSplit` 在 workflow-template-selection.ts:99；prior/frozen 分支约 :477/:494。下游以实际 head 的符号定位为准。 |

## 交接边界

所有实现要求在下游持有 TURN 后落实；本次仅文档。8 条建议已逐条处置，不把 MEDIUM/LOW 升成新的审批等待。HTML 图按 Lead 回复保留本地渲染失败占位及同源 Mermaid，由 Lead 在宿主渲染嵌入后再向 founder 发送。设计节点仍完成静默发布、托管核对、URL/repo 报告与 phase_design_complete。

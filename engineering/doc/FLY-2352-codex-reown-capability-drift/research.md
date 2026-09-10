# FLY-2352 Codex 体重启恢复结构性必败 — 调研
Issue: FLY-2352 (https://linear.app/geoforge3d/issue/FLY-2352/病根-bridge-重启后-codex-体的引擎恢复结构性必败buildcodexrecoverycontext-撞-launch)
日期: 2026-09-08
基于: exploration.md

## 1. 调研目标

exploration.md 已把病根定位到 `prepareCodexRecoveryCapabilities` 用了单-activation 老钥匙。本文回答实施前必须确定的五件事:

1. 精确 API `resolveCurrentWorkflowActivation` 的确切语义与抛错面,能否直接替换。
2. 换钥匙后凭据轮换挂到 rework activation 上,runner `complete` → Bridge 校验这条链是否仍一致。
3. reown 协调器对 `prepareCodexRecoveryCapabilities` 各类 `ok:false` 的处理,新 reason 落到哪条既有分支。
4. 回归测试用什么 fixture 才能复现生产的「spawn + wake」形状,且改动前必红。
5. 老钥匙的其他消费者是否与本单相关(明确不动的边界)。

## 2. 精确 API:`resolveCurrentWorkflowActivation`

`packages/teamlead/src/StateStore.ts:35162`

```ts
resolveCurrentWorkflowActivation(executionId):
  | { kind: "none" }
  | { kind: "current"; binding; run; node; snapshot }
  | { kind: "ambiguous"; activationIds: string[] }
```

- 语义(源码注释):「Current 按逻辑节点定义:binding 必须在该节点的最新 attempt、run 为 active、且仍拥有投影的 `workflow_run_node` 行;历史 binding 不是 legacy;零个或多个候选都 fail-closed 为 ambiguous」。
- 返回的 `{binding, run, node, snapshot}` 与 `generalizedExecutionContext` 的返回形状**完全相同**(它内部就是调 `generalizedExecutionContextForBinding`),因此 `prepareCodexRecoveryCapabilities` 后半段(`context.node.capabilities.produces_output`、`context.binding.activation_id/attempt/run_id/node_id`、`nodeRequiresFounderReview(context.snapshot, context.node.id)`)一行不用改。
- 抛错面:`generalizedExecutionContextForActivation` → `generalizedExecutionContextForBinding` 在 run 有 `selection_source` 但无 snapshot、snapshot JSON 损坏、schema 非法、node 不在 snapshot 里时抛 `WorkflowAdmissionClassificationError`。`prepareCodexRecoveryCapabilities` 目前在 `this.db.raw.transaction(...)` 内直接调用,不捕获;`codex-session-reown.ts:659` 调用处也无 try。异常会一路炸到 `runPassOwned` 的 `for` 循环,当轮 pass 中止,后续候选体不再检查,claim 留到 60s TTL。
- 生产核验:两例 revive 都先经过 `plugin.ts:7861` 的 `resolveCurrentWorkflowActivation`(ambiguous 会在 build 之前抛 `current workflow activation is ambiguous`),实际抛的是 drift ⇒ 当时该 API 返回 `current`。

结论:可以直接替换;需要把 `ambiguous` 与 `WorkflowAdmissionClassificationError` 各映射为一个 `ok:false` reason,保持 fail-closed 且不炸 pass。

## 3. 凭据链路在 rework activation 下是否一致

### 3.1 恢复侧发什么

`prepareCodexRecoveryCapabilities`(`StateStore.ts:8743-8960`)在 enrolled 分支:
- `UPDATE workflow_output_credential SET revoked=1, revoked_reason='codex_recovery_rotation' WHERE execution_id=? AND consumed_at IS NULL AND revoked=0`(按 execution 全撤,与 activation 无关)。
- 新凭据 `INSERT ... (activation_id, run_id, node_id, execution_id, attempt, ...)` 取自 `context.binding` ⇒ 换钥匙后即 current activation(rework 时为 `activation:rework:<id>`,attempt 为最新)。
- submission 凭据同理,且 `decision` 由 `resolveWorkflowDecisionContract(snapshot, node.id)` 决定(implement 节点无 decision ⇒ 不发 submission;qa 节点发)。
- 幂等键 `codex_recovery_capabilities_prepared:<exec>:<episode>:<attempts>` 不含 activation,一个 episode attempt 只发一次,不受本改动影响。

### 3.2 runner 侧报什么

- `flywheel-comm complete`(`complete.ts:367`)用 `currentWorkflowCompletionActivationFromEnv(execId)` 从 CommDB `runner_workflow_activation` 取**当前** activation(`workflow-activation.ts:25`),随 payload 上报 `workflowActivation.{activationId, attempt, turnEpoch}`。
- rework wake 时 CommDB 已被 `recordWorkflowActivationTurn` 写成 rework activation(`workflow_run_event` 里 `activation_turn_granted activationId=activation:rework:…`),所以 runner 上报的就是 rework activation。
- 恢复后的 daemon 从 `AdapterExecutionContext.workflowActivationId` 拿到的也是 `plugin.ts:7861` 精确 API 给的同一个 rework activation。

### 3.3 Bridge 校验按什么查

- `rotateGeneralizedWorkflowSubmissionCredential` / `Output` 与 delivery-repair 变体(`StateStore.ts:30719-31100`)都是「有 `activationId` 走 `generalizedExecutionContextForActivation`,否则才落老钥匙」;bridge 侧四个调用点(`actions.ts:1144/1161`、`runs-route.ts:3341/3360`、`workflow-engine-dispatcher.ts:2725/2739`)均传 activationId。
- 凭据消费按 `credential_hash` 查行再核 `activation_id/attempt`;恢复侧把新凭据挂在 current activation 上,与 runner 上报、Bridge 校验三方一致。

结论:换钥匙后 **activation 身份链路**一致(`complete` 上报的 activation/attempt/epoch 与 Bridge `commitEnrolledCompletion` 的逐项核对,`event-route.ts:781-795`、`StateStore.ts:49850-49882`)。

**更正(Codex R1,2026-09-08,已核实):凭据 token 链路不一致,且是 FLY-2211 既有缺口。** `currentWorkflowCredentialFromEnv`(`workflow-activation.ts:48-68`)在有 current activation 时只读 CommDB `runner_workflow_activation` 行里的 token(TURN grant 时写入,`db.ts:6175-6196`),不读 env;恢复轮换出的新 token 只进了 daemon env(`CodexTmuxAdapter.ts:2385-2391`)。带 output/submission 凭据的体恢复后会提交旧 token,被 `credential_revoked` 拒(`StateStore.ts:47250-47330`)。生产暴露面为零(314 条 prepared 事件无一带凭据;Codex vendor 节点仅 implement/eng_design,无 output/decision)。本单不修,列为 plan §7 L1。

### 3.4 wake 准入是否给 rework activation 发过凭据

`admitGeneralizedWorkflowExecution`(`StateStore.ts:34598+`)对 `activationMode:"wake"` 同样按节点 capability 发凭据;生产 `execution_admitted` 事件里 implement 节点 `output:false, decision:false` ⇒ implement 体本来就无凭据可发,恢复侧轮换在 implement 上是空操作;qa 体会真的轮换 submission 凭据,行为与 spawn 体一致。

## 4. reown 协调器对 `ok:false` 的处理

`codex-session-reown.ts:659-668`:

```ts
const capabilities = this.deps.store.prepareCodexRecoveryCapabilities(...);
if (!capabilities.ok) {
  abort("reown_revive_failed", `capabilities_${capabilities.reason}`);   // 不退还 attempt
  return;
}
```

- `abort` 不带 `releaseAttempt` ⇒ 消耗一次 attempt,两次后 exhausted。这与「真漂移/真损坏 ⇒ 换体」的既有取舍一致(exploration §6 C),新 reason 不改这条策略。
- 记录事件 `reown_revive_failed reason=capabilities_activation_ambiguous|capabilities_activation_invalid`,巡检可按前缀区分「凭据准备阶段」与「context 重建阶段」的失败。
- 此处**在 reap 之后**:alive+gateHeld 的体会先被 reap。本单不改顺序(exploration §6 C)。

现有 `reason` 词表(`CodexRecoveryCapabilitiesResult`,`StateStore.ts:1408-1428`):`session_missing | claim_lost | lease_expired | stale_revision | superseded | capabilities_already_prepared | invalid_expiry`。新增两个词进同一联合类型,类型检查会强制所有 switch/toEqual 覆盖。

## 5. 回归测试 fixture

### 5.1 现有 fixture

`packages/teamlead/src/__tests__/StateStore.codex-recovery.test.ts`
- `fixture()`:内存 StateStore + `upsertSession({execution_id:"exec-reown", adapter_type:"codex-tmux", status:"running"})`。
- `enrollOutputExecution(store)`:`buildWorkflowRunSnapshotV2` 造一个 `execute`(generic, produces_output) → `founder_gate` 的 run,`createWorkflowRun` + `admitGeneralizedWorkflowExecution({attempt:1})`(默认 `activationMode:"spawn"`,activationId 自动生成)。
- 既有用例 `reissues generalized workflow capabilities only to the live recovery claim` 验证单 activation 下 enrolled:true 与凭据轮换。

### 5.2 复现生产形状需要什么

生产两例:`workflow_run_node` 上 implement@1(done, exec A)→ implement@2(done, exec B)→ implement@3(exec B, running);`workflow_execution_binding` 上 exec B 有 `replacement`(attempt 2)+ `wake`(attempt 3)两行。最小复现:

1. `enrollOutputExecution` 得到 attempt 1 的 spawn binding。
2. `upsertWorkflowRunNode({nodeId:"execute", attempt:1, state:"done", executionId:"exec-reown", endedAt})`,再 `upsertWorkflowRunNode({attempt:2, state:"running", executionId:"exec-reown"})`(`StateStore.workflow-rework.test.ts:878-885` 同款写法)。
3. `admitGeneralizedWorkflowExecution({nodeId:"execute", executionId:"exec-reown", attempt:2, activationId:"activation:rework:test", activationMode:"wake", ...})`(`reworkRequestId` 可选;`workflow-rework.test.ts:1001-1012` 是带 request 的完整版,本单只需 binding 形状,不需要 rework request 表)。
4. 断言前置:`store.getWorkflowExecutionBinding("exec-reown") === undefined`(两行)且 `resolveCurrentWorkflowActivation` 返回 `current` 且 `binding.attempt === 2`。
5. `claimCodexRecovery` → `prepareCodexRecoveryCapabilities` ⇒ 期望 `{ok:true, enrolled:true, workflowSubmissionExpected:true}`,新 output 凭据行 `activation_id='activation:rework:test'`,`attempt=2`。
6. 改动前跑:返回 `{ok:true, enrolled:false, workflowSubmissionExpected:false}` ⇒ 红。

ambiguous 用例:在 5.2 基础上把 attempt 2 的 `workflow_run_node.execution_id` 改成别的 exec(模拟 replacement 已铸)⇒ 期望 `{ok:false, reason:"activation_ambiguous"}`,且无凭据轮换、无事件。

### 5.3 context 层与协调器层

- `codex-recovery-context.test.ts:332` 已有 drift 抛错用例,改文案后断言 `/workflow capability drift .* snapshot=submission:true,founderReview:false current=submission:false,founderReview:false/`。
- `codex-session-reown.test.ts` 用 mock deps;新增一例:`prepareCodexRecoveryCapabilities` 返回 `{ok:false, reason:"activation_ambiguous"}` ⇒ 记录 `reown_revive_failed reason=capabilities_activation_ambiguous`、不调 `revive`、`abortCodexRecovery` 被调且无 `releaseAttempt`。现有 `refuses spawn when an audited recycle cannot prove the daemon absent` 是同构模板。

### 5.4 运行方式

- 包名 `flywheel-teamlead`,`pnpm --filter flywheel-teamlead test -- <files>`;worktree 首次需 `pnpm install` 与依赖包 build(`flywheel-claude-runner` 等以 dist 为入口,未 build 时 vitest 报 `Failed to resolve entry for package "flywheel-claude-runner"`,本次调研实测)。
- 🔴 不要跑 `**/tmux-viewer.macos.test.ts`(会开 Terminal.app,memory 红线);聚焦文件跑即可。

## 6. 老钥匙的其他消费者(不动)

| 调用点 | 方法 | 与本单关系 |
|---|---|---|
| `StateStore.ts:28405` | `invalidateWorkflowResumeAttachment` | resume 附件失效,非 Codex 恢复路径 |
| `29028 / 29201 / 29266` | `prepareWorkflowIssueDelivery` 及其 Tx | issue 投递 |
| `30739 / 30849 / 30984 / 31092` | `rotateGeneralizedWorkflow*Credential*` | 已是「有 activationId 优先精确 API」 |
| `33101` | `markWorkflowReworkReplacementLaunched` | rework 换体登记 |
| `35131` | `getGeneralizedWorkflowNodeForExecution` | 8 个 bridge 调用点(DirectEventSink、event-route、gate-poller、actions、complete-marker-reconciler) |

它们各有自己的「多 activation 时怎么办」合同(部分本就期望 undefined 做 fail-closed),不在本单验证范围;改它们要另开单。

## 7. 引擎侧「换体」语义确认(不改)

`execution_dead_rolled_back` → `rework_replacement_materialized` → `rework_replacement_launched`(`workflow_run_event` seq 188-190)由 `workflow-rework-coordinator` 在 session 终态后触发;本单修好恢复后,session 不再进 failed,这条链自然不触发。已换体的 14 个 session 无需回填。

## 8. 与近期变更的交叉检查

- `main` 头 `ee113cab9`(2026-09-08)之后无人改 `codex-session-reown.ts` / `prepareCodexRecoveryCapabilities`(`git log` 该函数仅 FLY-2211 一次提交)。
- FLY-2442(Mufasa outbound)、FLY-2443(mailbox ingest)与本单文件无交集。
- 生产 Bridge `buildSha=ee113cab9`,与本 worktree 基线一致。

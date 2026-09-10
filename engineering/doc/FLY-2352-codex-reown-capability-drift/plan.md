# FLY-2352 Codex 体重启恢复结构性必败 — 实施计划
Issue: FLY-2352 (https://linear.app/geoforge3d/issue/FLY-2352/病根-bridge-重启后-codex-体的引擎恢复结构性必败buildcodexrecoverycontext-撞-launch)
日期: 2026-09-08
基于: research.md

**Status**: codex-approved(Codex design review 2 轮,2026-09-08;R1 CHANGES REQUESTED → §7 L1 + §3 三处修正;R2 APPROVED)
**分支**: `flywheel-FLY-2352`(共享分支,实现节点在同一分支上做)

## 0. 一句话

把 `prepareCodexRecoveryCapabilities` 的 activation 解析从 FLY-1423 的单-activation 老钥匙(`getWorkflowExecutionBinding`)换成精确 API(`resolveCurrentWorkflowActivation`),让被 rework 唤醒过的 Codex 体在 Bridge 重启后能按原 execution/thread/socket 恢复,而不是两次 drift 后被判死换体。

## 1. 已验证的前提(不再重复调查)

| 事实 | 证据 |
|---|---|
| 15 个 drift 体 100% 在 drift 时有 ≥2 条 `workflow_execution_binding`;54 个成功恢复 100% 发生在单 binding 时 | exploration §3.2(生产库只读查询) |
| 两个登记实例的快照都是 `submission:true / founderReview:false`,drift 来自现算侧返回 `false/false`,且无 `codex_recovery_capabilities_prepared` 事件 | exploration §3.1 |
| 内存库复现:spawn(attempt 1)+ wake(attempt 2)两条 binding ⇒ `getWorkflowExecutionBinding` = undefined,`resolveCurrentWorkflowActivation` = current(attempt 2),`prepareCodexRecoveryCapabilities` = `{enrolled:false, workflowSubmissionExpected:false}` | 2026-09-08 设计期一次性探针(未提交),research §5.2 |
| 同一次 revive 里 `plugin.ts:7861` 已用精确 API 且未报 ambiguous | exploration §4 |
| 三份相关测试文件基线绿:54/54 | `npx vitest run` 于 worktree `ee113cab9` |

## 2. 改动清单(最小交付)

### 2.1 `packages/teamlead/src/StateStore.ts` — `prepareCodexRecoveryCapabilities`

1. 类型 `CodexRecoveryCapabilitiesResult`(约 1408 行)的 `ok:false` reason 联合新增两个词:
   - `"activation_ambiguous"` — 精确 API 返回 `kind:"ambiguous"`(零个或多个候选)。
   - `"activation_invalid"` — 精确 API 抛 `WorkflowAdmissionClassificationError`(快照损坏/节点缺失等)。
2. 事务内(约 8808 行)把
   ```ts
   const context = this.generalizedExecutionContext(executionId);
   if (!context) { result = { ok:true, enrolled:false, workflowSubmissionExpected:false, founderReviewRequired:false }; return; }
   ```
   改为
   ```ts
   let resolved: ReturnType<StateStore["resolveCurrentWorkflowActivation"]>;
   try {
     resolved = this.resolveCurrentWorkflowActivation(executionId);
   } catch (error) {
     if (error instanceof WorkflowAdmissionClassificationError) {
       result = { ok: false, reason: "activation_invalid" };
       return;
     }
     throw error;
   }
   if (resolved.kind === "ambiguous") { result = { ok: false, reason: "activation_ambiguous" }; return; }
   if (resolved.kind === "none") { result = { ok:true, enrolled:false, workflowSubmissionExpected:false, founderReviewRequired:false }; return; }
   const context = resolved; // { binding, run, node, snapshot } — 后续代码不变
   ```
3. 后续 enrolled 分支(凭据轮换、事件、两个布尔)**一行不改**;`context.binding` 现在是 current activation(rework 时为 wake activation,attempt 最新)。
4. 说明注释:写明为什么不用老钥匙(FLY-1423 注释原话 + 本单 issue 号),让下一个人不要改回去。

### 2.2 `packages/teamlead/src/bridge/codex-session-reown.ts` — `buildCodexRecoveryContext`

- 守卫逻辑不变(仍抛),错误文案改为带值:
  ```
  workflow capability drift for <exec>: snapshot=submission:<b>,founderReview:<b> current=submission:<b>,founderReview:<b>
  ```
  使巡检不必猜是哪个布尔、哪一侧。

### 2.3 reown 协调器

- 不改代码。`ok:false` 已统一走 `abort("reown_revive_failed", \`capabilities_${reason}\`)`;新 reason 自动落为 `capabilities_activation_ambiguous` / `capabilities_activation_invalid`(消耗 attempt,两次后 exhausted ⇒ 换体;这是「真的不一致」该有的终态,见 exploration §6 C)。

### 2.4 不改

- `getWorkflowExecutionBinding` 与其他 9 处消费者(research §6)。
- reown 的 reap/claim 顺序、`maxAttempts:2`、`onRecoveryExhausted` / `failExhausted`。
- 快照结构、`rehydrationContext`、launch 侧两个布尔的计算。
- 已被换体的 14 个 session。

## 3. 测试(先红后绿)

### 3.1 `packages/teamlead/src/__tests__/StateStore.codex-recovery.test.ts`(真实 sqlite 内存库)

新增三例,fixture 沿用 `fixture()` + `enrollOutputExecution()`(research §5.1):

| 用例 | 步骤 | 期望(改后) | 改前 |
|---|---|---|---|
| `FLY-2352 reissues capabilities to the current rework activation after re-entry` | attempt 1 spawn 准入 → `upsertWorkflowRunNode` attempt 1 done / attempt 2 running(同 exec)→ `wake = admitGeneralizedWorkflowExecution({attempt:2, activationId:"activation:rework:test", activationMode:"wake"})`,**保留 `wake.outputCredential`**(attempt 1 的 token 在 attempt 2 准入时已被标 `superseded_by_retry`,`StateStore.ts:34877-34884`,不能拿它断言轮换)→ 断言 `getWorkflowExecutionBinding` 为 undefined 且 `resolveCurrentWorkflowActivation.kind==="current"` 且 `binding.attempt===2` → claim → prepare | `{ok:true, enrolled:true, workflowSubmissionExpected:true, founderReviewRequired:false}`;新 `workflow_output_credential` 行 `activation_id='activation:rework:test'`、`attempt=2`、`revoked=0`;`wake.outputCredential` 对应行 `revoked=1, revoked_reason='codex_recovery_rotation'`;`workflow_run_event` 有 `codex_recovery_capabilities_prepared` 且 `payload.attempt===2` | 返回 `enrolled:false` ⇒ **红** |
| `FLY-2352 fails closed as activation_ambiguous when no binding is current` | 同上,但把 attempt 2 的 `workflow_run_node.execution_id` 改成 `"exec-other"`(模拟替身已铸) | `{ok:false, reason:"activation_ambiguous"}`;无新凭据行、旧凭据未撤销、无事件 | 返回 `enrolled:false`(ok:true)⇒ **红** |
| `FLY-2352 fails closed as activation_invalid when the bound snapshot is corrupt` | 单 binding,`UPDATE workflow_run SET snapshot='{not json'` | `{ok:false, reason:"activation_invalid"}`,不抛 | 抛 `WorkflowAdmissionClassificationError` ⇒ **红** |

既有 8 例保持绿(单 activation 路径行为不变)。

### 3.2 `packages/teamlead/src/bridge/__tests__/codex-recovery-context.test.ts`

- 现有 `refuses workflow authority that does not match the immutable launch`(fixture:execution `exec-1`,snapshot `submission:true / founderReview:false`,传入 current `false / false`):断言改为匹配带值文案
  `/workflow capability drift for exec-1: snapshot=submission:true,founderReview:false current=submission:false,founderReview:false/`。

### 3.3 `packages/teamlead/src/bridge/__tests__/codex-session-reown.test.ts`(mock deps)

- 新增 `FLY-2352 aborts without spawn when capabilities resolve to an ambiguous activation`:`prepareCodexRecoveryCapabilities` mock 返回 `{ok:false, reason:"activation_ambiguous"}` ⇒ `record` 收到 `reown_revive_failed reason="capabilities_activation_ambiguous"`,`revive` 未被调,`abortCodexRecovery` 被调一次且无 `releaseAttempt`。模板:`refuses spawn when an audited recycle cannot prove the daemon absent`。

### 3.4 运行命令

```
cd packages/teamlead
npx vitest run src/__tests__/StateStore.codex-recovery.test.ts \
  src/bridge/__tests__/codex-recovery-context.test.ts \
  src/bridge/__tests__/codex-session-reown.test.ts
pnpm --filter flywheel-teamlead typecheck   # 若有;否则 tsc -p packages/teamlead --noEmit
```
worktree 首次需 `pnpm install --frozen-lockfile` 与 `pnpm -r --filter '!flywheel-teamlead' build`(research §5.4)。🔴 不跑 `**/tmux-viewer.macos.test.ts`。

### 3.4b 明确不写的测试

- 不写「恢复后 runner 用新 token 提交成功」的跨 StateStore + CommDB 测试:那正是 §7 L1 描述的缺口,本单不修它,写一个必红的测试再跳过没有意义;L1 的后续 issue 应带这个测试。

### 3.5 PR 里要贴的证据

- 3.1 三例在改动前的红输出(截 `expected … received …` 各一行)与改动后的绿输出。
- 三份文件全量通过行(`Tests N passed`)。
- CI 在 PR head 的结论(不是本地绿)。

## 4. 验收 / QA 设计(给 QA 节点)

1. **单元证据**:§3 全部绿,且能演示 3.1 第一例在 `main` 上红(scratch 包复制法见 memory `reference_scratch_package_copy_for_red_green_regression_proof`)。
2. **形状对照**:QA 只读查询生产库,确认修复前后 `session_events` 中 `reown_revive_failed … capability drift` 的最后一条时间戳不晚于部署时间;部署后第一次 Bridge 重启窗口内,若有多 activation 的 `codex-tmux` 在飞体,期望出现 `reown_revive_succeeded` 而非 drift。若窗口内没有这类体,QA 明确写「未观测到目标形状,单元证据为唯一证据」,不得写「已验证生产恢复」。
3. **阴性对照**:`capabilities_activation_ambiguous` 只在「替身已铸/run 非 active」形状出现;QA 在 529 房或内存库构造一例并确认事件文案。
4. **L1 零暴露前提在 ship 前仍成立**(Codex R2 非阻塞项):生产计数是带查询时刻的快照(2026-09-08 19:5x Z:prepared 事件 314→315 自然漂移,带凭据者仍为 0)。PR body / QA 证据记录查询时间,并在 ship 前重跑一次:active run 快照与 current published templates(`tpl_code`、`tpl_simple_code`)里的 Codex vendor 节点仍无 `produces_output`、无 decision loop。若出现,先落 L1 后续单再 ship 本单。
5. **不改的东西没变**:审 diff——`StateStore.ts` 里唯一被改的函数是 `prepareCodexRecoveryCapabilities`(其函数体不再出现 `generalizedExecutionContext(`),`getWorkflowExecutionBinding` 与 `generalizedExecutionContext` 本身零改动(`git diff main -- packages/teamlead/src/StateStore.ts` 的 hunk 全部落在 prepare 与类型声明内)。

## 5. 回滚

- 纯代码改动,无 schema 变更、无数据迁移、无 flag。回滚 = revert PR。
- 回滚后行为回到「多 activation 体重启必败」,不会更差。
- 新 reason 词进入事件 payload(`capabilities_activation_*`)是追加,不影响既有消费者(它们按前缀 `capabilities_` 或按 `reown_revive_failed` 分类)。

## 6. 稳定标识 / 展示文案

| 东西 | 值 | 备注 |
|---|---|---|
| 新 reason | `activation_ambiguous`、`activation_invalid` | 进 `CodexRecoveryCapabilitiesResult` 联合类型;事件里以 `capabilities_` 前缀出现 |
| drift 文案 | `workflow capability drift for <exec>: snapshot=submission:<b>,founderReview:<b> current=submission:<b>,founderReview:<b>` | 前缀 `workflow capability drift for ` 不变,巡检 class_key 的 ERROR_CODE 仍匹配 |
| 事件类型 | 不新增 | 沿用 `reown_revive_failed` |

## 7. 风险与已知限制

**L1(本版不做,已知限制,建议另开单)— 恢复轮换出的新凭据没有投影到 CommDB 的 current activation 行。**
- 事实(Codex R1 指出,已核实):`prepareCodexRecoveryCapabilities` 撤旧发新后,新 token 只进 daemon env(`CodexTmuxAdapter.ts:2385-2391`);而 runner 侧 `currentWorkflowCredentialFromEnv`(`packages/flywheel-comm/src/commands/workflow-activation.ts:48-68`)在存在 current activation 时**无条件读 CommDB `runner_workflow_activation.output_credential/submission_credential`**(该行在 TURN grant 时写入旧 token,`db.ts:6175-6196`),只有无 activation 才回退到 env。所以一个「带 output/submission 凭据」的 Codex 体恢复后,`workflow-output` / `qa-result` / `evidence-run` 会提交旧 token,被 Bridge 以 `credential_revoked` 拒绝。
- 这是 FLY-2211 上线即存在的缺口,与本单的 re-entry 修复正交:单 activation 体今天同样如此,本单既不引入也不扩大它。
- 生产暴露面(2026-09-08 只读核查):314 条 `codex_recovery_capabilities_prepared` 事件里 `hasOutputCredential:true` 0 条、`hasSubmissionCredential:true` 0 条;54 个成功恢复的体 100% 是 implement;所有 active run 快照里 Codex vendor 节点只有 `implement`(10)与 `eng_design`(4),均无 `produces_output`、无 verdict loop(decision);`qa` 节点全部是 claude vendor,不在 Codex reown 范围。⇒ 当前模板下**没有任何 Codex 体会拿到凭据**,该缺口零触发。
- 为什么不在本单做:修法需要新增一个 CommDB 侧按 `(execution_id, epoch, activation_id, run_id, node_id, attempt)` CAS 的写入 API,在 `prepare` 之后、`runtime.resume` 之前刷新同一 current 行并读回,失败则 fail-closed 不 spawn;还要证明后续 rework wake 的新行仍胜出。这是跨两个包的新机制,不是「re-entry 体能恢复」的必要条件(exploration §6 减法原则)。
- 触发条件与后续:一旦任何 Codex vendor 节点被赋予 `produces_output` 或成为 decision 节点,恢复后的体会在提交时以 `credential_revoked` 失败。建议 Lead 另开 issue「Codex 恢复凭据投影到 CommDB current activation」,并在其落地前把「Codex 节点不得 produces_output / 不得作 decision」写进 workflow 模板准入检查。本单 PR body 引用本条。

1. **reap 在 context 重建之前**:alive+gateHeld 的体仍会先被 reap;若重建因「真不一致」失败,daemon 已死。修好本单后合法 re-entry 不再触发;真不一致本来就该换体。不在本单改顺序。
2. **`activation_ambiguous` 的语义包含「零个候选」**:run 已非 active 或替身已铸时也会走到这里并消耗 attempt。这类体在 `isCurrentBinding` 通常已被拦(`reown_skipped_superseded`),真正到 prepare 的概率低;若出现,两次后 exhausted ⇒ 与今天行为一致。
3. **另一种 exhausted**(`recovery owner failed before commit`,FLY-2403 `737f81ba`)不是 drift,本单不覆盖,巡检若再见应另开 class。
4. **规模更正**:issue 登记 ×2,实测 15 体 / 10 issue(2026-09-03 起);实现 PR body 应引用 exploration §3.2 让 Lead 与巡检对齐。

## 8. 交付物

- 代码:§2.1、§2.2。
- 测试:§3.1–3.3。
- 文档:本文件夹三份 + `founder-design.html`(设计节点产出)。
- 里程碑:实现 ship 时新建 `engineering/doc/milestones/FLY-2352.md`(单写者合同,不回写 CLAUDE.md 表格)。

# Design Review — plan.md (Round 4)

Date: 2026-09-25 / Author: Codex / Status: APPROVED

## Summary

本轮严格按 Engineering Lead `a043a9cb` 的确认范围，只复核 R3 的 B1–B5、H6、H7。v4 已关闭七项：规范改动与现有 same-exec relaunch 调用图、quota OFF 合同、共享 readings 刷新层及既有 `thread/read(includeTurns:true)` 对账能力相容，并为关键交错窗口补了明确的 RED 测试义务。未发现任何一项仍未闭环，也未发现 v4 修复自身引入 blocker。

这是设计与源码静态确认；实现尚不存在，因此本轮未运行实现测试，也未修改仓库文件。

## Status of the 7 R3 items (closed / not closed + why)

1. **B1 — CLOSED：授权现在沿真实 same-exec 启动链显式传递。**

   v4 删除了不在该路径上的 `codex_quota_resume_launch`，并把 `CodexQuotaResumeAuthorization {executionId, claimId, entrySeq, resumeAttempt}` 放入真实 `StartRequest.processLifecycle.quotaResume`，贯穿 `buildStandbyResumeStartRequest → RunDispatcher.codexQuotaAdmission → Blueprint → CodexTmuxAdapter → beforeCodexDaemonStart`。源码确认 `buildStandbyResumeStartRequest` 使用 `successorExecutionId`、`previousSession` 与 `processLifecycle`，不带 `generalizedExecution`；v4 因此不再错误依赖 generalized admission。计划还要求 C5 先用真实 request shape 列出并打通所有 quota 判定点、每次 `await` 后重验，且禁止 ambient DB inference，关闭了 R3 指出的不可达 writer/二次 gate 问题。

2. **B2 — CLOSED：claim 资格与 active authorization 的预算语义已分离。**

   `eligibleToClaim` 只在 claim 前检查 `mechanical_failures < 2`；claim 后 `validateActiveAuthorization` 校验精确 claim、entry、`resumeAttempt ∈ {1,2}`、lease 与 permit 序号 fence，不再重套 pre-claim budget。attempt 进入持久行和授权对象，C5 明确覆盖“attempt 1 失败后 attempt 2 穿过每个 gate 并成功”，所以第二次合法拉起不会再被自己的 `<2` 条件挡住。

3. **B3 — CLOSED：continue 已有 durable、可对账的 crash/乱序协议。**

   `continue_attempt_id` 与 owner claim 解耦并跨 Bridge 重启保留；同一 UUID 同时进入固定文本标记和 `clientUserMessageId`。新进程先收旧 orphan，再用已有的 `thread/read(includeTurns:true)` 能力区分 proven、首输出前失败、absent 与不可解析：仅 absent 重发同一 id，不确定时不盲发且不消耗机械失败预算。runner 从 `startTurn` 前缓冲 started/item/completed，先同步持久化 `continuing` 再 drain；首个相关模型输出仍是唯一成功证据。v4 同时为 RPC 接受但未回包、onStarted 前崩溃、首 item 后 CAS 前崩溃及 item 早于 RPC response 四个窗口规定了 RED 测试，关闭了重复 continue 和丢失早到输出的问题。

4. **B4 — CLOSED：reading permit 的覆盖边界来自证据请求顺序。**

   `reading_confirmed.covers_signal_seq` 只取 `< reading.requestSeq` 的最大相关信号，并在发证事务拒绝任何 `signal_seq >= requestSeq` 的相关信号；后续资格检查仍拒绝 `> covers_signal_seq` 的相关信号。相关信号明确定义为同 root 且 generation 不旧于 permit，或 unbound。计划也加入“request 分配 → 新 bound/unbound signal → response → permit evaluation”交错拒发测试，因此旧读数不能再吞掉请求发出后的新墙信号。

5. **B5 — CLOSED：auto-switch OFF 的普通启动合同已恢复。**

   v4 明确撤回 v3 的通用 binder/reconcile：OFF 时普通 Codex launch 对 quota 为零调用、零 fence；OFF 冷启动产生的 unbound wall 仍可进入 standby，并由 identity-matched 的 `reading_confirmed` 恢复。新代 binding 只在独立 standby resume 的 claim 事务登记，授权判断也只服务该显式 resume flow。C4/C5/B2 均有 OFF 冷启动、普通启动 quota 调用数为 0、unbound 恢复及续跑后新代归因的回归断言，符合 FLY-2465 design-correction。

6. **H6 — CLOSED：requestSeq 已下沉到所有入口共享的每账号真实读取层。**

   v4 在 `observeCodexAccounts` 循环中、每次 `readInUseQuota` 或 `readSlot` 之前分配序号；只有成功新读数取得新 `requestSeq`，`carried()` 保留旧序号。源码确认 scheduler、额度页与其他刷新入口共享 `refreshCodexReadings → observeCodexAccounts`，因此不会再出现只给 scheduler 打号或把 carried 旧值盖上新号的情况。standby 等待时的按需补读复用既有 single-flight、60 秒节流，不新增读法或 token-refresh 入口；C4 覆盖三个入口、部分失败、carried 与 canonical idle。

7. **H7 — CLOSED：capacity rejection 与机械失败、target 结算已拆清。**

   resuming 中再次 usageLimited 现在原子更新 `trigger_signal_seq`、记 `capacity_rejected` 并使旧 permit 失效，回 standby 等新证据；它不增加 `mechanical_failures`，也不触发 Codex fallback。成功时按 `old_execution_id` 结算该 execution 名下跨 incident 的全部未结算 FLY-2465 runner targets。C5/B2 明确断言 attempt 2 再撞墙时 fallback launch 为 0，以及多个 incident target 全部结算。

## Blockers (only if any)

无。

## Follow-ups (non-blocking)

无新增。实现阶段按计划执行 C4/C5 的真实调用图、因果交错和 crash-window RED 测试，并在 §10 的真 Codex 演练中验证已列出的 A 侧加密 reasoning replay 残余即可；这些均已在 v4 内作为既定验证项，不影响本轮批准。

## Verdict

**APPROVED**

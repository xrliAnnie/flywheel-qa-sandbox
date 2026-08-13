# FLY-1731 活着的 runner 被判终态·gate 永不投递 — 调研

Issue: FLY-1731 (https://linear.app/geoforge3d/issue/FLY-1731/session-被提前判-terminal活着的-runner-双向失联-ship-gate-无限重试永不投递)
日期: 2026-08-12
基于: exploration.md

本文档把 exploration 的四个修理面落到确切的代码机制上,并回答 exploration §6 的四个开放问题。所有行号基于本 worktree(branch `flywheel-FLY-1731`,base = main `4f246f52`)。

## 1. Fix A(第一交付)— admission 尊重 holder authority

### 1.1 现状机制

`packages/teamlead/src/bridge/question-admission.ts` `eligibility()`(:171-212)顺序:

1. `superseded_at` → `revoked_superseded`
2. `getSession(question.from_agent)` 缺行 → `revoked_orphan`
3. `store.workflowGatePresentationDisposition({executionId, checkpoint, questionId})` → not allow → `revoked_workflow_gate_<reason>`
4. `checkpoint != null` 时:
   a. `ACTIVE_GATE_SESSION_STATUSES.has(session.status)` 否 → **`revoked_terminal_session`** ← 卡死点
   b. `matchesLead` 否/抛 → `revoked_lead_scope`
   c. `approve_to_ship` 且 `reviewHoldReason(...) !== null` → `revoked_qa_hold`

`workflowGatePresentationDisposition`(StateStore.ts:22355-22403)对 engine gate 的校验已经足够强:activation 唯一解析、`gate_carrier_epoch===1`、`run.current_node_id === gate.node`、holder 存在、`holder.source_execution_id === executionId`、`holder.question_id === questionId` → 返回 `holder_authoritative`。它不允许的所有情形(ambiguous/before_gate/holder_missing/holder_mismatch)都已被独立拒绝。

### 1.2 同一 predicate 的另一个消费者已经是目标语义

gate-poller `founderReactionApprovalPass`(gate-poller.ts:2842-2855):`getSession` 只用于取 issue_id/thread(不检查 status),守门就是 `workflowGatePresentationDisposition`,allow 即继续。写入侧 `writeGateResponseAndRunPostWrite`(write-gate-response.ts:333-352):engineAuthority 存在时检查 **holder state**(awaiting_review/approved),完全不看 session status。

⇒ Fix A 形状:`eligibility()` 在第 3 步拿到 `allow===true && reason==="holder_authoritative"` 时,**跳过 4a(活性)与 4c(qa_hold)**,保留 4b(matchesLead,misroute 防御;completed session 行的 project/labels 仍在,谓词可用)。4c 跳过的理由:engine run 的 QA 证据在 gate holder evidence 冻结(`workflow_gate_holder_evidence`,gate 开门即已验),`reviewHoldReason` 是 legacy auto-QA 机制,FLY-1425 已把 engine-owned execution 的 qa_result 拒于 legacy 路径,两界不相交。

### 1.3 现场解堵动力学(零手术)

lead-inbox-loop.ts:326-352:`revalidateModel` verdict `deliver:false + retry:true` → `releaseClaimForRetry(nextRetryAt=+30s)`(`retry_count` 不增——与现场 `retry_count` 恒 0、~30s 节奏两处观测完全吻合);`deliver:true` → materialize + 投递。Fix A 部署(Bridge 重启)后,seq 71271 下一次 30s 重试自然通过 → `materialize()`(question-admission.ts:108-169)写 lead_event + 投递 PM Lead。唯一时间约束:`expires_at = 2026-08-15T14:33:46Z`。

`materialize()` 使用 session 行的 `execution_id/issue_id/issue_identifier/project_name/session_role` 构造 payload——completed 行这些列全部健在,无需改动。

### 1.4 次生行为变化(runner_ship / legacy 的影响面)

- **legacy(非 engine)gate**:`workflowGatePresentationDisposition` 返回 `legacy`/`legacy_epoch`(≠ holder_authoritative)→ 4a/4c 照旧执行。**零行为变化。**
- **runner_ship engine gate**:正路上 gate 开门时 session 已被 `createWorkflowGateHolderTx` 翻到 `awaiting_review`(active),4a 本来就过——跳过它无差别。异常路(session 提前终态)下,原行为=永卡,新行为=gate 照样投递给 Lead/founder;批准后 runner 侧 wake 由 FLY-1448 park/wake + FLY-1505 ship-attempt 告警一族兜底。「门可见但 carrier 需要人工唤醒」严格优于「门不可见」。
- **ship_parked 间隙**:runner_ship 投影先落 `ship_parked`(不在 ACTIVE 集合!),gate 开门事务内才翻 awaiting_review。同一事务内完成,admission 不会观察到中间态;但若 gate 开门 UPDATE 未命中(carrier unbound),materializer 本来就拒 `workflow_gate_carrier_unbound` 且已有专用告警(StateStore.ts:30768-30811),不走本路径。

## 2. Fix B — 永久性拒绝的出口(disposition permanence 分类)

### 2.1 机制:一行改动的位置

`revalidate()`(question-admission.ts:95-102)现状 `retry: row.source_ref === null`。retry:false → 消费方 `markDead(id, now, disposition)`(lead-inbox-loop.ts:344-348)→ mailbox 行 DEAD(`dead_reason = disposition`)。

### 2.2 permanence 分类清单(回答 exploration §6.1)

| disposition | 判定 | 理由 |
|---|---|---|
| `revoked_missing` | 永久 | question 行已不存在,现状已含部分永久处理(`source_kind !== "question_orphan"` 分支) |
| `revoked_superseded` | 永久(现状已无 retry 字段=false) | supersede 不可逆 |
| `revoked_answered` | 永久(现状已 false) | 已答 |
| `revoked_orphan` | 永久 | session 行不存在;不会凭空出现 |
| **`revoked_terminal_session`** | **按 session 事实分类** | 仅 `isNoOutEdgeTerminalStatus(status)`(`approved/completed/shelved/terminated`)永久;`pending/ship_parked/design_done/failed/rejected/deferred` 仍可能推进,保持瞬时并交 24h horizon 兜底 |
| `revoked_lead_scope` | 永久 | scope 由 session labels + 项目 config 决定;等 config 变更来救一行 mailbox 不是机制,处置后重新触发才是 |
| `revoked_qa_hold` | **瞬时** | QA hold 会解除(deferrable) |
| `revoked_workflow_gate_before_gate` | **瞬时** | run 尚未推进到 gate 节点,推进后放行 |
| `revoked_workflow_gate_holder_missing` | **瞬时** | gate 开门与 admission 的竞态窗 |
| `revoked_workflow_gate_holder_mismatch` | 永久 | holder 换代(新 attempt/新 head)后旧 question 永不匹配 |
| `revoked_workflow_gate_activation_ambiguous` | 瞬时(保守) | 多 activation 并存通常是过渡态;误判永久的代价(丢门)大于误判瞬时的代价(多试几轮) |

实现形态:`eligibility()` 返回值带显式 `permanent: boolean`(默认 false=瞬时,保守),`revalidate()` 用它决定 retry;所有 retryable verdict 在 `expires_at - now ≤ 24h` 时强制 DEAD,因此误归瞬时也有有限出口。NULL/非法 expiry 以 `expiry_integrity` fail-closed。**修后不变式:Bridge 正常 tick 时,任何能产生 admission verdict 的 QUEUED question 行,要么最终投递,要么最迟在进入 24h horizon 后的下一次处置时 DEAD,不存在静默过期。**

### 2.2.1 LEASED 孪生积压的范围边界

Cass 普查的 230 行终态 runner `LEASED` 存量属于同一事故族,但它需要独立验证过期 lease 扫描机制。Lead 已拆为 FLY-1736;本单不修改该路径,避免把未经本设计 review 的机制修复滚入急单。

### 2.3 DEAD 后的可见性(与 Fix D 共用一条告警管道)

gate question 的 mailbox 行 `recipient_kind='lead'` → DEAD 后落入 `listUncoveredLeadDeadLetters` 的 `lead_unacked` 扫描域(mailbox-queue.ts:1747-1748),经 `reconcileDeadLetterAlertIntents`(lead-inbox-runtime.ts:453-487)→ FLY-1573 死信通知投递给收件 Lead。**通道已存在,Fix B 无需新告警机制**——把行从「QUEUED 空转」改判 DEAD 即自动进入可见域。唯一需要 implement 核实的:`QUARANTINE_DEAD_REASONS`(mailbox-queue.ts:61)不含新 disposition(否则会被归档语义吞掉)。

## 3. Fix C — runner 收工信号(回答 exploration §6.3)

### 3.1 现状

- Bridge:event-route.ts:953-958,generalized completion 成功响应 `res.json({ ok:true, generalized:true, duplicate })`。
- CLI:complete.ts:373-378,`response.ok` 时打印固定文本直接 return,**不读 body**。

### 3.2 形状(实施校正:receipt-based,不用静态 mode)

Bridge 在该 res.json 增加 `completionDisposition: "engine_gate_handoff" | "runner_ship_park" | "terminal_no_gate"`。分类先看本次 immutable transition receipt 是否真的 `gateOpened`;只有开门且 engine-owned epoch=1 时,才用 pinned snapshot authority 判断 completer 是否 carrier。无 gate 的 no_code、non-engine 与 epoch=0 均为 terminal,避免静态 `gateAuthorityMode` 把「模板具备 carrier」误读成「本次真的开了 runner ship gate」。

首次 completion 在同一事务写 `completion_disposition` workflow event;duplicate/replay 从该 immutable receipt 返回同一结果。升级前 legacy completion 只从 completion row、transition receipt、pinned snapshot 与 activation binding 重建并 backfill,禁止读会漂移的 current holder/session。checked UID 冲突只省略字段;SQLite/I/O/未知错误 rethrow 并回滚核心 completion。

- `engine_gate_handoff` → 打印明确收工指引:「run 已进入 engine-owned gate;本节点已终结,不会有 approve/ship 环节找你;不要等待、不要跑 verify-approval,立即收尾退出。」
- `runner_ship_park` → 打印 park 指引(等 wake,与现行 needs_review 正路一致)。
- `terminal_no_gate` / 字段缺失(旧 Bridge)/body 非 JSON → 行为与今天逐字节一致(只打印现有 delivered 行)。

### 3.3 为什么这属于本单而不是提示词单

runner 的行为脚本(bootstrap 提示词)是模板资产,但「complete 的机器响应告诉 runner 它的生命周期已到哪」是协议事实——提示词只能写「按 complete 输出的指引行动」。把事实放进响应,提示词侧永不过期。症状 2 的窗口(活 runner 在 terminal session 上继续通信)由此收敛到 complete 返回前的毫秒级。

## 4. Fix D — 有主 runner 的死信通道核实(implement review 校正 exploration §6.2)

### 4.1 现状机制(静默的准确位置)

`listUncoveredLeadDeadLetters`(mailbox-queue.ts:1749-1754):

```ts
if (row.recipient_kind === "runner" && input.resolveOwningLead(row.to_agent)) {
    continue;   // ← 只跳过统一 alert 通道;runner mailbox lane 另有 owner 通知
}
```

sourceKind 只有 `lead_unacked`(Lead 自己的死信→通知该 Lead)与 `runner_unroutable`(无主 runner→通知项目 primary Lead)。最初把现场 71284/71317/71321 命中此 continue 读成「零通知」,但 code review 找到并验证了另一条既有通道:`RunnerMailboxLane` 每 tick 调 `scanAndInsertDeadLetterNotices()`,同样解析 owner,把聚合后的 `dead_letter_notice` 写给 owner Lead。

### 4.2 形状

因此最小正确实现是**不写新代码**:保留统一 alert scanner 的 owned-runner skip,避免与 `dead_letter_notice` 双报;把既有 runner mailbox lane 作为 founder 层级原则的 runner→owner Lead 实现。Lead 自身的 `lead_unacked` 继续通过 `LeadAlertNotifier` 进入 founder 可见的 #flywheel-alerts。sender 只出现在通知摘要,不参与 destination authority。

**明确不做**:send CLI 同步拒绝(需要 CLI 跨库读 teamlead.db 判 recipient 状态——引入跨进程读耦合,且状态在 send 与投递之间本就可变;告警通道语义足够且已有基建)。

## 5. founder ✅ 通路验证剧本(回答 exploration §6.4)

代码结论(gate-authority-view.ts + write-gate-response.ts + founder-reaction-approval-handler.ts + gate-poller.ts:2768-2891):✅ 通路对 engine gate 端到端以 holder 为 authority,session 终态不阻断。**未经真机验证,QA 节点必须重放**:

1. 529 隔离房起 land 模式 run,推进到 gate 开门、卡片发出;
2. 人工把 source session 置 completed(隔离房内走正规完成路径,即天然如此——land 模式本来就投影 completed);
3. 在卡片上以 founder 身份点 ✅;
4. 断言:holder → approved、land operation 激活、PR merge(或 dry-run 等价断言)。

同一剧本顺带验证 Fix A(admission 放行 → PM Lead model-lane 收到 gate_question)。

## 6. 测试面(供 plan 引用)

- **unit(admission)**:holder_authoritative × {completed, ship_parked, blocked, missing-status} → deliver:true;legacy(无 holder)× completed → 仍 revoked_terminal_session 且 `permanent:true`;可推进 status 与 24h horizon 边界逐一断言。
- **unit(mailbox)**:permanent question verdict → markDead → DEAD 行进入 `listUncoveredLeadDeadLetters` lead_unacked 聚合;有主 runner 的 DEAD 行由既有 `scanAndInsertDeadLetterNotices` 投 owner Lead,统一 alert scanner 保持 skip 以防双报。LEASED 路径留给 FLY-1736。
- **integration**:真 StateStore + CommDB 重放 FLY-1704 时序(complete → completed 投影 → gate holder → mailbox question → admission)断言投递发生;对照组(legacy gate + terminal session)断言 DEAD + 告警,证明不是全放行。
- **byte-compat 哨兵**:complete.ts 对无 `gateAuthorityMode` 响应的输出逐字节不变;`FLYWHEEL_*` 无新 env。
- **真机 QA**:§5 剧本 + 现场 71271 解堵观察(部署即验收,deadline 08-15)。

## 7. 风险与边界

- Fix A 扩大了「terminal session 的 gate 可投递」面——严格限定在 `holder_authoritative`(engine-owned + epoch 1 + current_node=gate + holder 精确匹配),legacy 面零变化。
- Fix B 的 permanence 误判:永久误标瞬时=回到今天(空转到期),瞬时误标永久=丢门+告警(可见、可人工重触发)。分类表按此不对称原则取保守侧。
- Fix C 只改「成功响应的信息量」,不改任何状态机;旧 Bridge/新 CLI、新 Bridge/旧 CLI 两个交叉组合都逐字节兼容。
- Fix D 双报风险:owner 已有 mailbox 通知;不得再让统一 alert scanner 对同组 DEAD 生成第二条告警。

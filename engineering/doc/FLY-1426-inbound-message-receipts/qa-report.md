# FLY-1426 入站消息 generic 收据 — QA 验证报告
Issue: FLY-1426 (https://linear.app/geoforge3d/issue/FLY-1426/infrabug3-founderlead-discord-chat-零-durable-收据-入站消息-generic-收据)
日期: 2026-07-22
基于: plan.md

**QA 节点**: runner-ef75ba3e (DAG qa 节点，run 39075f6b，design→implement→qa)
**被测**: PR-1（本仓，S1+S2+S4+S5），HEAD `4d118732`
**Verdict**: **PASS**

## 1. 范围（诚实划界）

- 本次判定的是 **PR-1（本仓）**：`flywheel-comm chat-receipt` 子命令 + lane 选择器 + 升级链补丁（patrol quarantine + founder-page chat-venue）+ Lead 规则 + launcher env allowlist。
- **PR-2（fork `xrliAnnie/claude-plugins-official` 的插件 accept 边界 producer，S3）不在本分支**——即「真 founder Discord 消息 → queue 行」的入口在 PR-2，不由本 PR 承运。这是 plan §7 的既定合入顺序，非缺陷。
- plan 显式剩余 gap（companion/external 隔离角色无 comm.db → 无 chat 收据）为文档化的 follow-up，非本单交付。

## 2. 独立代码审查（要点）

- `chat-receipt` CLI（begin/complete/settle/pending/quarantine）：输入校验齐全；`carrier=external`、`refMessageId=NULL`（避开 `idx_lead_inbox_ref` 全局 UNIQUE 与 founder lane 双投递撞车）；v1 信封可 round-trip；同 id 重放幂等、异字段抛错。
- `listExternalPendingForLane`：lane 前缀 + `delivered/disposed/processed IS NULL` + seq cursor + `createdBefore`/`excludeQuarantined` 谓词**全下沉 SQL**，不被他 Lead/xdept 行遮蔽。
- **关键跨-lane 隔离修复**（commit 4d118732，`ExternalReceiptSaga`）：Codex 外部 saga reconciler 从 `listExternalDeliveryPending`（全 external 行）改为 `listExternalPendingForLane` 限定自己的 `xdept:` lane。若无此修，Codex saga 会用 `journal_absent` 假证据把 `chat:` 行 `markExternalAborted` 处置掉——这是真实且重要的正确性修复。
- patrol quarantine：per-Lead cursor + per-Lead cap（公平性，深页跨 pass 必达）；quarantine 非终态（仍可重投补 complete）。
- 升级链：`normalizeUnprocessedReceiptAlertProject` 为 ref-less external 行（projectName=unknown）用 patrol 供值回填 project 权威；`createFounderPager` chat-venue fallback **严格 lane 限定**（仅 `receipt_unprocessed` + `chat:` fingerprint + 无 thread）→ 发 Lead chat channel @founder；失败回落 `onUndeliverable` ticket lane（**从不静默**）。非 chat kind 行为字节不变。
- launcher：`FLYWHEEL_CHAT_RECEIPTS` + 4 个窗口变量补进 tmux `-e` allowlist（防 SLA 漂移）。
- Lead 规则（`discord-reply-contract.md`）：收据公式 + 三条关账路径（reply_to auto-settle / handle-receipt ack / relay·respond 限既有 Runner question）。

## 3. 测试证据

| 套件 | 结果 |
|---|---|
| flywheel-comm chat-receipt + lead-inbox-queue（含真 built-CLI 集成） | **22/22 PASS** |
| teamlead discord-chat-receipt-contract / lead-receipt-patrol / detection-escalation-sinks / automated-message-inventory / ExternalReceiptSaga | **全 PASS**（1 条 login-shell+CLI-spawn 在 47 测并发下撞 5s 超时 flake，隔离单跑 1.7s 通过——非代码缺陷；`bash -lc` login shell 冷启动本身即 1.7s） |
| launcher env allowlist（lead-env-propagation.test.sh，含真 tmux -e barrier） | **12/12 PASS** |
| 完整 flywheel-comm 回归 | **1218/1220** |

**1220 中的 2 红——证伪为环境/pre-existing，非 FLY-1426 回归**：两条均在 `src/commands/__tests__/qa-result.test.ts`（属 FLY-1425，`git diff --name-only main...HEAD` 证本 PR 未改一字节）。根因：本 QA-runner 会话被 Bridge 注入 `FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL`，污染了「no scoped credential exists」分支的测试子进程——CLI 因此走 credential decision 路径（→ exit 1）而非 legacy /events。字节相同代码 + 相同环境 ⇒ 在 main 上同样失败，故属环境性，非回归。

## 4. 真机 E2E（module-driven，隔离，built dist）

harness：`scratchpad/qa-fly1426-e2e.mjs`（跑完即删，不 commit）。**10/10 PASS**。

- **Part A（真 built CLI，临时 comm.db）**：begin→创建 pending external 行 / 同 id 幂等 / pending 选择器 round-trip v1 信封 / complete→delivered + arm SLA 窗 / delivered 离开 pending lane / settle→`discord_explicit_reply` 证据关账 / quarantine 非终态（delivered_at·disposed_at 仍 NULL）/ quarantine 后仍可 complete（可重投证）。
- **Part B（真 `createFounderPager`，built teamlead dist → 真 Discord）**：合成 `receipt_unprocessed` + `chat:` fingerprint + 无 thread → chat-venue fallback → **真 Discord 消息落隔离测试频道**（cos-test `1493080991290626079`，msg_id `1529566777108070521`）。
  - 消息原文：`🤖[自动] <@…> 🚨 qa-fly1426-… [Watchdog] 应处理的消息重发后仍没有处理收据(target=flywheel:qa-lead-1426)。owner Lead(…)已在 31 分钟前收到通知,至今无处置 → 升级给你。`
  - 这就是「真的检测到 + 真的通知到（真 Discord 消息为证）」的升级腿证据。

> handle-receipt ack 关账路径需 validated Lead lease（本 harness 未配），已由 `discord-chat-receipt-contract.test.ts`（真 built-CLI + LeadLeaseStore）覆盖并隔离通过。

## 5. Follow-up（非阻塞）

1. `discord-chat-receipt-contract.test.ts` 的 5s testTimeout 对「login shell + 真 CLI spawn」在并发负载下偏紧——建议提高该文件 testTimeout（测试卫生 nit）。
2. PR-2（fork 插件 producer）+ companion/external gap 为文档化的下游/延后范围。

## 6. 结论

代码正确、结构清晰、契合已批准 plan；关键跨-lane 隔离修复到位；单测 + launcher 契约 + 真机 E2E（含真 Discord 升级通知）全绿。唯一红为未触及文件里由本会话注入凭据造成的环境 flake。**无阻塞缺陷 → PASS**。

（codex code-review 是独立门，由 Bridge 在 merge 时经 codex_hard_gate 独立 enforce，非本 qa 节点重跑或据以卡 verdict。）

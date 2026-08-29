# Research: Runner post-completion 修订反馈链路断裂 — FLY-208

**Issue**: FLY-208
**Date**: 2026-06-04
**Source**: Linear issue FLY-208(证据链)+ 本文档的生产现场审计(execution `433d4078`,sub LEARN-12 PR #16)
**Status**: Complete

---

## 0. TL;DR — 审计推翻/修正了 issue 的两个假设

1. **Runner 并没有"以终端打印代替通知"** — 它真实调用了 5 次回报,但全部经 stock `SendMessage to: "team-lead"` 投进了一个**没人 poll 的黑洞 inbox**(`teams/sub-lead/inboxes/team-lead.json`),且工具返回 `success: true`。"自称已通知"在 Runner 视角是诚实的。
2. **重复投递与 CommDB `read_at` 无关** — mailbox 模式下 PostToolUse hook 被 sentinel 短路,CommDB 不驱动任何投递。真凶是 claude-code stock `useInboxPoller` 的 at-least-once 语义(vendor 二进制,改不了)。
3. **黑洞是系统性的**:product-lead(Peter)team 里躺着 **184 条 unread** Runner 汇报(自 2026-05-16 起,含 QA PASS 报告);ops-lead 1 条;sub-lead 6 条。
4. **Fix A 所需机制已存在且当晚实战验证**:`flywheel-comm ask` → GatePoller `runner_question` 事件在 session completed 后依然可用(FLY-161 故意设计),Lead 22 秒内响应。A 是纯协议/prompt 改动。

---

## 1. 事故链精确还原(transcript + DB 证据)

Runner transcript: `~/.claude/projects/-Users-xiaorongli-Dev-sub-LEARN-12/cf1a13bf-*.jsonl`
Comm DB: `~/.flywheel/comm/sub/comm.db`(审计时 copy 至 `/tmp/fly-208-audit/`,生产只读)
StateStore: `~/.flywheel/teamlead.db` `session_events`

| 时间 (UTC) | 事件 | 证据 |
| -- | -- | -- |
| 06:08:26 | Runner 走 landing-signal 路径:`ready_to_merge` + `stage set completed` | session_events #1134 |
| 06:08:42 | Runner `SendMessage to:"team-lead"` 完工交接 → **黑洞** | team-lead.json entry #1 |
| 06:09:00 | `session_completed` 事件(Lead 经此知道完工) | session_events #1135 |
| 06:16:09 | Lead `flywheel-comm send` 指令入 CommDB(`2d505aec`)+ mailbox wake | comm DB + sidecar `finalized` ×1 |
| 06:16:10 | mailbox 投递 #1(`<teammate-message>` 注入,距写入 1 秒) | transcript uuid `c3260cf4` |
| 06:17:23 | Runner commit `45721d0` + push(修订完成) | sub PR #16 |
| 06:18:36 | Runner `SendMessage to:"team-lead"` **修订完成报告 → 黑洞**(= Annie 没等到的那条) | team-lead.json entry #2 |
| 06:18:45 | mailbox 投递 #2(同一条消息重复注入) | transcript uuid `ce62dbb6` |
| 06:19:21 | Runner commit `006e237`(处理重复时顺带微调)+ `SendMessage to:"team-lead"` → 黑洞 | team-lead.json entry #3 |
| 06:09 → 06:34 | **Bridge 零事件**(两次 push 完全不可见) | session_events #1135→#1136 之间为空 |
| 06:26:28 | Annie 主动问 Lead「为什么没反馈」 | Discord |
| 06:33:38 | Lead 第三条指令,显式要求「必须经 flywheel-comm 回报(ask non-blocking)」 | comm DB `9b3d9755` |
| 06:34-06:40 | Runner 照做:`gate approve_to_ship`(22s 获响应)+ `ask` ×3(SHIPPED / RATIFY / CLEANUP)→ **Lead 全部收到并响应** | comm DB `e60b91b9`/`7dc01608`/`20088b3e`/`cff809e9` |

**结论**:同一个 completed session,同一晚 — 没有协议要求时回报进黑洞;协议显式要求后回报全通。差异只在协议文本。

## 2. 根因一:回报黑洞(stock SendMessage 收件人不校验 × Flywheel 命名约定冲突)

- Runner 由 `ClaudeCodeAdapter.buildRunnerSpawnConfig`(agent-team-transport)以 `--agent-name runner-<execId8> --team-name <leadId>` spawn,是 stock Agent Team teammate,天然带 `SendMessage` 工具。
- stock claude-code 的约定:team lead 名为 **`team-lead`**(`TEAM_LEAD_NAME` 常量;`useInboxPoller.ts` 多处按 `m.from === 'team-lead'` 鉴权)。teammate 的 system prompt 教它给 team 成员发 SendMessage,但**不会告诉它 Flywheel 的 Lead 实名是 `sub-lead`**。
- Flywheel 的 Lead mailbox 身份 = `<leadId>`(`deriveRunnerMailboxIdentity`: teamName = leadId,Lead 自己 poll `inboxes/<leadId>.json`)。**`team-lead` 在该 team 不存在。**
- stock SendMessage **不校验收件人存在**:自动创建 `inboxes/team-lead.json` 并返回 `{"success":true,"message":"Message sent to team-lead's inbox"}`。Runner 没有任何失败信号 → "已通知 Lead" 在它视角为真。
- **系统面扫描**(`~/.claude/teams/*/inboxes/team-lead.json` 中来自 `runner-*` 的 unread):
  - `product-lead`: **184 条 unread**,自 2026-05-16 起,约 50+ 个 runner,含 2026-06-04 凌晨 GEO-408 QA PASS 报告
  - `ops-lead`: 1 条;`sub-lead`: 6 条(本案);`fly168-spike`: 1 条
  - (worker/qa team 里 lead 实名就叫 team-lead 的不算病灶)

## 3. 根因二:协议缺口(prompt 注入面审计)

Runner prompt 组装 = `packages/edge-worker/src/Blueprint.ts` `systemPromptLines`:

| 注入块 | 行号(audit 时) | 现状 |
| -- | -- | -- |
| leadId 块(ask 指引 + inbox 指引) | ~494-517 | 「Always **briefly acknowledge** received instructions」— 终端打印即满足;没有"执行完成后必须回报"的硬规则 |
| gate 指令块 | ~519-607 | **仅注入 enabled checkpoints**。sub 的 `config.yaml` 故意只开 brainstorm + question(approve_to_ship 注释言明 content merge 走 founder)→ FLY-191 step f「feedback 后 re-request review」**根本没注入本案 Runner** |
| COMPLETION REPORTING | ~637-641 | 只管 `stage set completed`,不管 post-completion 修订的回报 |
| agent.md(content-executor.md) | step 8 | 「Notify the Lead」— **没说机制**;Runner 自由发挥选了 SendMessage |

**注入点结论(Fix A)**:
- 通用层:leadId 块(Blueprint.ts ~494-517)加 post-completion 回报硬规则 + SendMessage 禁令。该块凡有 Lead 必注入,与 checkpoint 配置无关 → 覆盖 sub 这类不开 approve gate 的项目。
- 项目层:`sub` repo `.flywheel/agents/content-executor.md` step 8 写明确命令。

## 4. 根因三(附带 bug):重复投递 + read_at 永远 NULL

### 4.1 重复投递 = stock poller at-least-once,不是 CommDB

- mailbox 写侧无重复:sidecar `runner-433d4078.json.flywheel.jsonl` 显示 `2d505aec` 仅 1 条 `finalized` 记录(`writeMailboxEntry` 有 flywheelId 幂等)。
- 投递两次发生在 stock `useInboxPoller`(`claude-code/src/hooks/useInboxPoller.ts`):
  - idle 时立即 submit,然后 `markRead()` 是 **fire-and-forget**(`void markMessagesAsRead(...)`);
  - 若标记失败/竞态(与 flywheel proper-lockfile 写者竞争),下一秒 poll 重读 → busy 路径 `queueMessages()` **无去重**地排队 → turn 结束后再投一次。
  - transcript 实证:06:16:10 投递 #1(idle submit),06:18:45 投递 #2(turn 结束后 pending 队列投出)。
- **vendor 二进制改不了** → 真去重做不到。可行缓解:
  - mailbox 正文加 `[lead-instruction <commdb-id>]` 前缀(只在 `send.ts` 构造 wake 内容时加,不动 `wakeRunnerMailbox` 共享路径 — 避免污染 FLY-191 approval wake 文本),Runner 一眼识别重复;
  - 协议写明:同 id 重复 = 幂等跳过(本案 Runner 自发做对了,固化成规则)。

### 4.2 read_at 不对称(审计卫生,非投递驱动)

- comm DB 全表统计:instruction 3 条全部 `read_at NULL` + `delivered_at NULL`;question 1 条正常标记。
- 标记路径盘点:
  - question → `respond`/`resolveGate` 标 `read_at`+`resolved_at` ✓
  - instruction(legacy hook 路径)→ `inbox-check.sh` 注入前 `UPDATE read_at` ✓ — 但 mailbox sentinel 存在时 hook 整体短路(`inbox-check.sh:42-49`)
  - instruction(CLI pull)→ `flywheel-comm inbox` 标 read ✓ — 但 mailbox 模式下 Runner 不需要跑它(且 prompt 里"safety net"建议若被执行,反而会从 CommDB 把同内容**再投一遍** — 又一个跨通道重复源)
  - instruction(mailbox 路径,生产默认)→ **无任何标记路径** ✗
- 修法(B):`send.ts` 在 `wake.ok` 后调 `markInstructionDelivered(id)`(`delivered_at` 列 + helper 已存在,FLY-109 引入)。`read_at` 留给真正的 ack(不造假);审计层面 `delivered_at NOT NULL` 即可区分"已送达 mailbox"与"从未送达"。

## 5. 根因四:Bridge 事件面 — completed 后 push 零事件(Option C 评估)

- `session_events` 实证:06:09:00 `session_completed` → 06:34:18 `stage_changed(approve)` 之间零行,期间两次 push。
- `stage_changed` 只在 Runner 自己跑 `stage set` 时产生;completed session 的 PR head 变化没有任何观察者。
- **Option C(PR-head sha watcher)成本评估**:
  - 需要新的轮询面:对 status ∈ {awaiting_review, completed} 且 landing PR open 的 session,定期 `gh api` 查 PR head sha,变更即发新事件类型(如 `pr_head_changed`)。
  - 成本:新 GitHub 轮询(配额 + zero-new-periodic-timer 纪律冲突,FLY-169/172 先例要求 event-driven 或挂靠既有 loop)、跨重启去重、新事件类型 + 双 runtime 渲染(FLY-195 #220 教训:渲染 parity-by-construction)、StateStore 查询面。
  - 价值:Runner 不配合(死亡/忘协议)时的最后兜底。
  - **判断:A 已满足 issue 验收**(重放场景,Runner push 后跑 ask → GatePoller ≤1 tick(默认 ~3s)relay `runner_question` 给 Lead)。C 建议拆独立 issue 后做。

## 6. Fix A 机制验证:`ask` → `runner_question` 在 completed session 上可用

- `gate-poller.ts` 注释与代码(FLY-161):`runner_question`(checkpoint == NULL)**按 `to_agent` 纯路由,无 active-session 检查** —「the question survives Runner completion」。`gate_question` 才有 {running, awaiting_review, approved_to_ship} 限制。
- 实战:06:35:36 `ask`(SHIPPED)→ Lead 06:36:21 respond(85 秒闭环,含 Lead 思考);06:40:26 CLEANUP DONE 同样送达。
- Runner 侧前提全部在位:tmux env 携带 `FLYWHEEL_EXEC_ID`/`FLYWHEEL_COMM_DB`/`FLYWHEEL_BRIDGE_URL`,completed 后依然有效(实证 06:35 成功执行)。
- Lead 侧渲染:`mailbox-lead-runtime.ts` / `commdb-lead-runtime.ts` 已有 `runner_question` 专用 format(非 checkpoint 框架,"non-blocking" 措辞)→ **零渲染改动**。

## 7. A2(结构性兜底)设计要点:黑洞 inbox 巡检

让"误投递"不再静默 — 不依赖 Runner 自觉:

- **挂靠点**:GatePoller 既有 per-(project, lead) poll 循环(零新 timer,符合 FLY-169/172 纪律)。每 tick 对 `transport.getInboxPath(leadId, "team-lead")` 做 `stat`(便宜),mtime 变化才 `readUnread`。
- **API 已存在**:`ClaudeCodeAdapter.readUnread({leadName, agentName: "team-lead"})` + `ack({messageIds})`(agent-team-transport)。
- **事件**:unread 条目 → advisory 事件(如 `runner_misrouted_report`,normal priority)发给该 Lead,正文带原文 + 提示「Runner 用了 SendMessage 黑洞通道,内容如下;回 Runner 请用 flywheel-comm send」。发送成功后 `ack` 防重发;eventId 用 vendor-stable id(`from:timestamp`)hash → `isLeadEventDelivered` 跨重启去重(GatePoller 同款)。
- **守卫**:`leadId === "team-lead"` 的 team 跳过(那是真 inbox);只扫 projects.json 里注册的 lead。
- **渲染**:可走 generic formatter(event_type + summary ≤300 字符),或加专用分支;若加字段必须双 runtime parity(FLY-195 教训)。
- **存量 184 条**:一次性巡检会全量上报 → 需要 backstop:首扫只报计数 + 归档(不逐条 relay,避免把 Peter 淹没);或 plan 里定义 cutoff(只 relay 实现上线后的新增)。**建议:存量只记录不回放**(过时信息回放有害)。

## 8. 修复方案汇总(对应 issue A/B/C)

| 项 | 内容 | 改动面 | 风险 |
| -- | -- | -- | -- |
| **A1 协议**(主修) | Blueprint leadId 块加硬规则:post-completion 收到 Lead instruction → 执行完**必须** `flywheel-comm ask --lead <id> --exec-id <id> "REVISION DONE: <摘要+commit sha+PR>"`;**禁止** SendMessage 向 Lead 汇报(黑洞)与终端打印代替回报;同 id 重复指令幂等跳过+仍需回执。content-executor.md step 8 写明确命令(sub repo 另一 PR) | Blueprint.ts(纯 prompt 文本)+ sub repo agent.md | 极低(无运行时行为变化);prompt 长度+~10 行 |
| **A2 结构兜底** | GatePoller 挂靠黑洞 inbox 巡检 → advisory 事件 + ack | gate-poller.ts + 事件渲染(generic 可用)+ StateStore 去重(既有) | 低;注意存量 backstop |
| **B 投递卫生** | `send.ts` wake.ok → `markInstructionDelivered`;wake 正文 `[lead-instruction <id>]` 前缀(send 专属,不动共享 wake.ts);文档写明 vendor at-least-once 是接受现状 | send.ts(~5 行)+ 测试 | 极低 |
| **C PR-head watcher** | 拆独立 issue(成本中等,A 满足验收后属第二层兜底) | — | — |

## 9. QA 验收方案(重放事故场景)

真机 E2E,QA slot 框架:
1. spawn 真 Runner(简单 issue)→ 走完 landing-signal/`stage set completed`;
2. Lead 对 completed session `flywheel-comm send` 一条修订指令;
3. 断言:① Runner mailbox 唤醒并执行;② 执行完 Runner 调 `ask` 回报;③ GatePoller ≤1 tick 发 `runner_question`,Lead inbox 收到(对照事故:06:17 push 后 9 分钟零事件);④ CommDB 指令行 `delivered_at NOT NULL`;⑤(A2)往 `team-lead.json` 手工塞一条 unread → Lead 收到 advisory。
4. 负向:重复投递模拟(同 id 注入两次)→ Runner 幂等跳过且仍回执一次。

## 10. 追加审计:Asha 三条新评论(2026-06-04 06:38-06:49,Annie 要求全修)

### 10.1 发现 5 — "FSM 死角":真根因是 route 映射 + landing signal 从未改写,不是缺 FSM 边

**修正 Asha 的表述**:`WORKFLOW_TRANSITIONS` **有** `approved_to_ship → completed`(`packages/core/src/workflow-fsm.ts:138`)。卡死链条实际是:

1. sub 没开 approve_to_ship checkpoint → Blueprint 的「merge 后把 landing signal 改写成 `status:"merged"`」指令(藏在 approve gate 块内,~L581)**从未注入** → Runner merge 后 landing signal 永远停在 `ready_to_merge`(session_events #1138 实证:06:35:36 stage completed 时 landing 仍 ready_to_merge,而 PR 06:35:05 已 merge)。
2. `event-route.ts` session_completed 映射(~L599-634):`route=auto_approve/needs_review` 只有 `landing_status.status === "merged"` 才走 `completed`,否则 → `awaiting_review`。
3. session 已被 ratify JSON 批准翻成 `approved_to_ship`(06:41:55,wiring.ts onResponseWritten)→ `approved_to_ship → awaiting_review` 不在 FSM 表里 → transition 被拒 → **永远停在 approved_to_ship**。
4. close_runner/close-tmux 把 `approved_to_ship` 列为 protected(plugin.ts:688)→ 不可关;workaround 只剩 terminate(语义错:工作是成功的)。

**修法**:
- 5a(Bridge):`event-route.ts`(+ `DirectEventSink` sister 分支,两处必须同改 — 既有注释明言 dual-sink parity)对 `isPostApproveShip` 会话扩展既有豁免:route ∈ {auto_approve, needs_review} 且 landing ≠ merged 时,**不再尝试非法的 awaiting_review**,按 natural-completion 语义落 `completed`(route=blocked 仍走 blocked — ship 失败语义保留);landing ≠ merged 时带 warn 记录证据缺口。
- 5b(Blueprint):把「merge 后改写 landing signal 为 merged + `stage set completed`」从 approve-gate 块抽出/复制到通用 ship 指引(凡 Runner 执行 merge 都适用,与 checkpoint 配置无关)。

### 10.2 发现 6 — gate 批准格式陷阱 + verify-approval 时序洞

**已核实**:
- `founder-consent/wiring.ts` `onResponseWritten`(~L160):`JSON.parse(answer)?.approved === true` 是唯一批准形态;任何文本(含 "APPROVE — ..." 开头)静默 feedback 化(catch → approved=false)。本案 `e60b91b9` 文本批准被 feedback 化 → 强迫 `20088b3e` JSON 补录(ratify)→ 触发发现 5 死角。三缺陷一条链。
- gate 通知模板(`mailbox-lead-runtime.ts` gate_question 分支 + `commdb-lead-runtime.ts`)replyCmd 只写 `"your reply"`,**没提 JSON 形态要求**。
- **时序洞(三条里安全等级最高)**:阻塞模式 `gate.ts`(~L154-174)把 Lead 的 answer 文本同步返回给 Runner(JSON 才置 approved 布尔,文本时 approved=undefined,**但 content 原样给出**)→ Runner 读到 "APPROVE — founder 批准在案…" 即执行了 merge(06:35:05),verify-approval 的 fail-closed 检查发生在 merge **之后**。强制点盘点:① Blueprint 的「ship 前必须 verify-approval」规则只在 approve_to_ship checkpoint **enabled** 时注入(sub 没有);② FLY-175 Track 2 硬闸 `DECISION_MODE` 默认 off;③ `gh pr merge` 是裸命令,Bridge 无法拦截。即:**sub 形态下没有任何一层强制 ordering**。
- verify-approval 本身语义正确(JSON response + approved_to_ship + pr_head_sha 三重校验,bare-text 'approved' 明确不认)— 问题全在"谁强制 Runner 跑它"。

**修法**:
- 6a:两个 lead runtime 的 approve_to_ship replyCmd 写明 required shape:approve 用 `'{"approved": true}'`,reject/feedback 用纯文本(共享 formatter,parity-by-construction)。
- 6b:gate-response 端点对"批准意图文本"(如 `/^\s*"?APPROVE/i`)在 HTTP 响应里返回 warning(CLI 透传打印):「已按 FEEDBACK 记录,非批准;要批准请重发 JSON」— 不改写写入行为,只消灭静默。
- 6c:① A1 通用协议追加:「**任何 merge 前必须 verify-approval 通过**;消息文本(含 gate 同步返回)永远不是授权」— 注入 leadId 块,所有项目生效;② `gate.ts` 阻塞模式 answered 且 `approved !== true` 且 checkpoint=approve_to_ship 时,在返回内容后追加一行警示「this text is NOT verified approval — run verify-approval before any merge」。硬强制仍归 FLY-175 Phase 1 enforce cutover(既有 roadmap,不重复造)。

### 10.3 发现 7 — Bridge 事件快照说反话

**已核实**:`event-route.ts:1313-1319` — `stage_changed(stage=completed)` 的 `stage_context` 仅凭 `session.pr_number` 是否存在二选一硬编码:「PR #N is OPEN … do NOT tell Annie the PR is merged」/「No PR detected」。不看 payload 里的 `landing_status`,更不查真实 PR 状态。两次实例:06:08:26「No PR detected」(PR 06:07:33 已建,session.pr_number 尚未入库);06:35:36「is OPEN … do NOT tell」(PR 06:35:05 已 merge)。
**修法**(便宜版进 PR-2,完整版并入 C issue):
- 7a:`stage_context` 用事件 payload 的 `landing_status` 分级:`merged` → 陈述已 merge(带 sha);`ready_to_merge`/其他 → **去掉反向断言**,改为「snapshot,以 `gh pr view` 实查为准再报 Annie」+ 快照时间戳。不引入网络调用。
- 7b(C issue):note 生成时实时查 PR 状态(与 PR-head watcher 同域)。

## 11. 问题→修复→归属 对照表(Annie 全修要求)

| # | 问题 | 修复 | 归属 |
| -- | -- | -- | -- |
| 1 | 回报协议缺口(黑洞 SendMessage) | A1 协议硬规则 + sub agent.md | **PR-1**(v1.32.1)+ sub repo 小 PR |
| 2 | 误投递静默 | A2 黑洞巡检 advisory | **PR-1** |
| 3 | instruction 投递审计断层 + 重复识别 | B delivered_at + id 前缀 | **PR-1** |
| 4 | merge-on-text 时序洞(协议层) | 6c-① 通用 verify-approval 规则(A1 内) | **PR-1** |
| 5 | FSM 死角(approved_to_ship 卡死) | 5a route 映射 + 5b landing 改写指令通用化 | **PR-2**(v1.32.2) |
| 6 | gate 批准格式陷阱 | 6a 模板 + 6b warning + 6c-② gate.ts 警示行 | **PR-2** |
| 7 | 事件快照说反话(便宜版) | 7a landing-aware + 去反向断言 + 时间戳 | **PR-2** |
| 8 | PR 状态新鲜度(watcher + note 实查) | 原 C + 7b 合并 | **新 issue**(链回 FLY-208,注明 Annie 全修) |
| 9 | 存量 184 条处置 | 今日新鲜→补送 Peter;过时→ack 归档;记 Linear | **运维动作**(worker-fly-208,PR 外) |

## 12. 未解决/接受的现状

- stock SendMessage 收件人不校验 = vendor 行为,接受;靠 A1 禁令 + A2 巡检围堵。
- stock poller at-least-once = vendor 行为,接受;靠 id 前缀 + 幂等协议缓解。
- `read_at` 在 mailbox 模式语义上仍是"未 ack"(没有 Runner 端可靠 ack 时点);`delivered_at` 承担审计职责。
- 卡死在"既不回报也不被巡检捕获"(Runner 用错的不是 team-lead 而是任意其他名字)的残余暴露面:A2 可扩展为扫 lead team 全部非注册 inbox 文件,plan 阶段决定是否纳入。

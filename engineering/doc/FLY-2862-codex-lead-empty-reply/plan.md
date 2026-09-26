# FLY-2862 Codex 载体 Lead 空回答 — 实施计划
Issue: FLY-2862 (https://linear.app/geoforge3d/issue/FLY-2862/529语音房-codex-载体的测试房-lead-对每条信箱消息都交空回答-语音房里-lead-永远回不了话founder-9-24-在)
日期: 2026-09-24
基于: 无(Lead 裁定 plan_only:一页 plan,写完直接实现)

## 根因(实现体复核,两层)

**① 规则:Codex 载体拿到 Claude 专用回话指令。** Codex 载体回话 = 本轮 final answer
由 runtime 发到来源频道/thread;它没有 `mcp__plugin_discord_discord__reply`。但
`lead-rules-bundle.sh` 只给「v2 + dept」追加 `codex-discord-reply-contract.md`,
v2 选择器 `rule-sources.ts` 也只给 dept 挂 Codex 适配。cos 与 v1 dept 的 Codex Lead
只看到 `cos-lead-rules.md`(`N==0 → mcp__plugin_discord_discord__reply`)/
`department-lead-rules.md`(`N=0 use discord.reply`),模型 ack 完 batch 就交空答案。

**② router 不设防。** `LeadInputRouter` 把空 `output` 照样 enqueue+deliver →
direct 模式 Discord 400 / bridge 模式 `text_required` 400 → `ambiguous`。
语音侧只有「lead bot 在语音 thread 发非空消息」才会 `speak()` 关等待音,于是永远不停。

**生产同样中招**(`sqlite3 -readonly` 查 journal):Raya(生产 Codex cos)76 条、
Mufasa 21 条、infra bot 2 条 `output=''` → 400 → `ambiguous`。Raya 启动日志装的就是
`cos-lead-rules.md`。

## 改法

### A. 规则:一份 Codex 回话合同,对全部 Codex 载体生效(Claude 字节不动)

- 扩写已有 `lead-rules-base/codex-discord-reply-contract.md`(不新增文件、不复制 cos/dept 规则):
  把 Claude 回话工具翻译成 Codex 真实通路 —— 回应当前入站 = final answer(`[voice]` 必须是
  非空 final answer,会被念给说话人);ack batch 是传输不是回复;空 final answer 什么都不发,
  只在不欠回复时用;主动发 = runtime 广告的 send 工具;issue thread = `lead_operation
  discord.thread.reply`(若广告)否则按角色规则走 Bridge `/send`。
- `lead-rules-bundle.sh`:`compute_lead_rule_bundle` 加可选第 5 参 `carrier`;
  `codex-app-server` 且角色为 cos/dept 时追加该合同(v2 dept 原有行为保留)。
  `assemble_full_access_governance`(只被 Codex 启动器调用)传 `codex-app-server`。
  Claude 侧(`claude-lead.sh` 内联装配、parity/字节预算用例)不受影响。
- `rule-sources.ts`(v2):Discord 适配从「codex+dept」扩到「codex+dept|cos」;
  小红书记忆适配仍只 dept。

### B. router:空 final answer 分两类收口,绝不发空串

- 新模块 `reply-obligation.ts`:纯函数判定入站是否欠回复 —— mailbox 条目且
  (payload 含 Bridge 渲染的 `<channel source="voice"` 语音标签,或 batch 头为 `from founder`)。
  用户正文里的 `<` 已被转义,伪造不了标签。
- `LeadJournal`:允许 `model_completed → completed`(带 `reason`)。
- `LeadInputRouter`:`output.trim()===""` 时不 enqueue/deliver;
  - 不欠回复 → `completed`,`reason=silent_no_reply`(不记 ambiguous、不发失败事件);
  - 欠回复 → `dead_letter`,`reason=empty_final_answer`,并调注入的 `onReplyFailed`。
  正常、reconcile、resend_output 三条交付路径都走同一守卫。
- 两个 runtime(headless + TUI)把 `onReplyFailed` 接到 Bridge 上报(fire-and-forget,
  失败只记日志;Bridge 地址/令牌取 config,缺省回落 `BRIDGE_URL`/`TEAMLEAD_API_TOKEN`)。

### C. Bridge:失败事件 → 语音侧停等待音(不发 Discord)

- 新路由 `POST /api/lead-outbound/reply-failed`(与 `/send` 同一 token 鉴权),
  体 `{projectName, leadId, channelId, idempotencyKey, reason}`,严格校验。
- `StateStore.recordVoiceLeadReplyFailure`:按 (project, lead, thread) 找进行中的语音会话,
  幂等插入一条 `voice_outbound`(`message_id = lead-reply-failed:<key>`,固定短句
  「这次 Lead 没有给出回复（回话失败），请再说一遍。」)。语音 daemon 现有循环会念它并关等待音,
  voice-codex 零改动。无匹配会话 → 只记一行可诊断日志。

## Raya 现网影响点(PR 里照抄)

1. 规则:Raya 下次启动起多装 `codex-discord-reply-contract.md`;cos 规则字节不变。
2. router:bridge tick / 同伴确认的空回答改记 `completed/silent_no_reply`(不再 400、不再 ambiguous);
   founder 消息的空回答改记 `dead_letter/empty_final_answer` 并上报 Bridge。
3. Bridge 新路由;Raya 开 rg 语音,她语音房里空回答会被念「回话失败」而不是一直放等待音。
4. 走班车上线,不要求任何重启;dist 与规则在 Bridge/Raya 的下一次自然重启生效。

## 验收

- 单测:router 两类空输出 + 三条交付路径;分类器用真渲染器(`renderDiscordChatContent`)
  与真 batch 头;Bridge 路由 + StateStore 插入/幂等/无会话/校验;bundle cos/dept v1 含合同、
  Claude 视图不含;v2 选择器 cos 挂适配。
- 本机跑 lint、`teamlead` 构建、受影响测试;全量交 PR CI。
- 529 真房(Lead 开房):Codex 载体 slot Lead 对一句口述回复非空、送达会话 thread、被念回;
  空 final answer 不再产生 Discord 400。

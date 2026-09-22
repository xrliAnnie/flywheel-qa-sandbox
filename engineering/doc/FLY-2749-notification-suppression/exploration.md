# FLY-2749 纯通知停止唤醒 — 探索
Issue: FLY-2749 (https://linear.app/geoforge3d/issue/FLY-2749/额度lead-成本-lead-会话占-fable-额度-92percent每个小事件都唤醒-lead每轮重读-50-60-万-token)
日期: 2026-09-18
基于: 无

## 当前授权与范围
最新 Lead 指令优先于派发时的旧标题和 description：
- [lead-instruction a9911258-39ea-4e97-a38c-94861b76199f] 21:32:01Z：先逐类查明 FLY-2567/#1204 的 audit_only 为何未生效；查生产 flag、lead_events、绕过 event-route 的路径。在原框架修复，不另起机制。
- [lead-instruction 1d79783f-ea5d-4b6b-af3f-90106bf04546] 21:32:37Z：founder 21:31Z「we do not need this」；本单仅让 lead_token_savings 拦住纯通知。删除上下文压缩、1M 窗口改动、规则/记忆瘦身、用量页面；保留统计脚本前后比较。
- 问题 3560d679-fb47-4000-8c2e-8179e49e2d1f 的 Lead 回答：默认复用 audit_only；除非单独证明必须延期但不丢，否则不造 deferred delivery。

## 选择
保留原始事件及业务副作用，在现有持久投递分类中把机器可确认无待办的通知设为 audit_only（仅保留审计，不调用模型）；真实问题、审批、失败和不明来源仍立即投递。不是把所有 DONE 文本丢弃，也不要求 Lead 用另一轮回复 ACK。

## 要回答的根因问题
1. lead_token_savings 当前有效值是否 ON，运行版本是否包含 #1204？
2. stage_changed 的六个普通阶段为何仍 model：stageRecord、status 和其他 guard 字段逐一验证。
3. REVIEW gate 和 runner report 是否通过另一 producer 路径默认 model？
4. 报告里哪些含 Lead 必须执行的动作？如何靠持久类型和已验证来源区分？
5. classifier、持久队列、direct runtime 和重投四层是否一致？

## 不变的责任
所有 Lead / Claude 与 Codex 共用桥接策略。保留 founder、ASK、非 REVIEW gate、session_failed、replacement、告警的即时链路；保留原 mailbox ACK、问题回答和审核所有权。设计阶段不改运行代码，不上线，不代替上线后24小时验证。

## 验收继承
原目标为同口径24h轮数及总token下降至少60%；缩窄后仍报告真实差值，不暗中下调门槛或承诺仅这些事件就能达标。原“合批逐条注入”已被上面的 audit_only 决策替换为逐条审计可查、不可误删待办。需要立即唤醒的四类事件真机各验证时间戳。任何进一步验收调整必须显式记录 Lead 决策。

## 验收与替换预告的后续裁定
Lead回答 ae5477ac-dea7-4401-86c7-aa256908270a 已明确把60%改为监测目标；硬门为已证纯通知model=0、紧急延迟不变与ACK不变。d6989f8f-baa2-4340-9e89-56dc78ae5fe0 已批准仅 replacement_candidate 且有引擎timer/current-attempt无待办证据的预告audit-only；实际换体、hold与escalation仍即时。

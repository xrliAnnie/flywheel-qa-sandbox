# FLY-1392 单层办结语义 — 设计修正
Issue: FLY-1392 (URL 不可得,只写 issue 号)
日期: 2026-07-21
基于: plan.md

## 裁定

本附录覆盖本目录 exploration/research/plan/qa-report 中旧的 founder 入站与
“收据分层”叙事。FLY-1392 对外只有一个概念:

> 每条 founder 消息都有一个“Lead 办了没有”标记;没办超时自动顶回 Lead,
> 再超时进入升级链。

用户只和 Lead 说话。Bridge 是原文搬运器:它不归因、不分类、不附候选 hint,
也不把 founder 原话直接写给 runner。只有 Lead 的 relay/respond/no-route 动作
才能把该标记置为“已办”;需要送 runner 时,Lead 的动作同时创建持久 wake intent。

## 为什么修正

Annie 对控制面拓扑的原话:

> 「为什么中间会出现把我的话直接传给 teammate 这么一条处理线呢……
> 我们需要的是完全照抄他们的模型。」

Annie 对可靠性地基的原话:

> 「所以通用解法是收据机制……把凭据这一部分做好之后是我们的根基,
> 必须是先来做清楚,然后我们之后的 issue 才可以去做。」

因此本单不再把 Bridge 的确定性归因描述成 Lead 的代理决策,也不把内部存储
字段包装成用户需要理解的多层协议。超出 claude-code agent-team 的唯一增量是:
Lead 没办时,系统会持久标记、重发并升级。

## 被废除的概念

- “已送达 / 已处理”作为两个对外收据层级;
- 按消息类型向用户解释的 evidence 合同表;
- founder F-2/F-3/F-5 的协议层归因、ship classifier、question hint 与
  `bridge-protocol` 自动响应;
- “歧义才交 Lead”或“协议层就是 Lead 枢纽”的表述。

本目录旧 design-review 文件是当时评审的冻结审计记录,不代表最终产品模型。
FLY-1391 `architecture-target.md` 中与本附录冲突的 founder 路由与收据分层内容,
在 FLY-1392 实现与验收中也以本附录为准。

## 保留的器官

- `lead_inbox` 每条消息一行。`delivered_at` 只是“已持久到 Lead 域”的内部时间戳;
  `processed_at` 只是“Lead 已办”的内部时间戳。对外查询只回答后者是否为空。
- `processed_evidence`、actor、epoch/fence 保留为内部防误写、防跨 owner 误认的
  数据卫生,不构成产品概念或按类型承诺的凭据合同。
- `processed_at IS NULL` 的 founder root 到期后仍执行标记、重发给 Lead、唤醒 Lead;
  再到期进入 durable escalation。已终态关闭的 question 先做 revalidation,
  不再被催。
- runner wake 台账、T1/T2/T3、唤醒失败可观察、纯遥测不参与办结巡检、
  lane-2(runner→Lead)与 lane-3(Lead instruction→runner)全部保留。
- `FLYWHEEL_RECEIPT_FOUNDATION=0` 仅作临时事故逃生阀。开启旧直转拓扑时,
  Bridge 启动即发 severe 告警并每小时重复,直到恢复默认开启并重启。

## 唯一状态流

```text
founder 原文 -> Bridge 持久写入 Lead 收件账本 -> 通知 Lead
                                             |
                                             +-- Lead relay/respond/no-route
                                             |      -> processed_at 写入(已办)
                                             |      -> 需要时投递 runner + wake intent
                                             |
                                             +-- 超时仍未办
                                                    -> 第 N 次重发 + 唤醒 Lead
                                                    -> 再超时 durable escalation
```

## 修正后的验收口径

1. Annie 发一条真实回复后,系统能查到唯一 founder root,并回答“Lead 办了没有”。
   `delivered_at` / `processed_at` 可作为内部诊断时间戳展示,但不再称为两张收据。
2. F-2/F-3/F-5 不产生 `bridge-protocol` response、归因 hint 或 runner wake;
   Lead relay 后才出现 response、办结时间与 runner wake。
3. 故意不 relay 时,同一 root 被重发给并唤醒 Lead;仍未办时升级可见。
4. 已关闭 gate 零重发零升级;纯遥测不生成“Lead 办了没有”待办。
5. 事故回退必须持续告警,不得成为静默常态。

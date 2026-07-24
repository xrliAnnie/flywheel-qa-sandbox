# FLY-1448 批准断路 — design-correction(founder 设计反馈,增量约束)

Issue: FLY-1448 (https://linear.app/geoforge3d/issue/FLY-1448/p1批准断路-founder-批准被静默丢弃-session-卡-running-无-durable-park-wake-拒投)
日期: 2026-07-24
基于: plan.md(R9 Codex APPROVED 版)+ Tadashi 转达的 founder 反馈([lead-instruction e944630f])

## Annie 原话(verbatim)

> 「我想确定一下看门狗这边到底是不是有必要。主要是我不想让我们搞太多看门狗的东西,然每天在那疯狂报警」
> 「如果能确定现在这个机制可以 work 的话,就没必要再搞看门狗了呀」

## 落成的设计约束(Lead 明细)

① 主交付 = **机制正确性**(durable park + 送达回执 + 终态清算),非监控;
② 现有 wake 看门狗 = **驯服而非扩建**(终态 session 禁止铸新 episode,目标告警量 28/晚 → ≈0);
③ 兜底检测仅保留一条:「**机制被证明丢件时 fail-loud**」,预期触发率零;
④ 设计中任何超出③的轮询式新看门狗组件一律砍除。

## 废除(概念级)

| 废除项 | 原设计位置 | 处置 |
|---|---|---|
| **warning 级观察告警 `founder_reply_unbound_gate_pending`**(unclear/none 分类的 founder 回复在门禁 pending 时超时即报) | plan.md C2 两级告警的第二级 | **不再作为告警投递** —— 普通对话/含糊回复在门禁开着时触发观察级告警,正是「每天疯狂报警」的形态。收敛账本行(C1)保留为纯审计(不投 Discord、不 page 任何人),排查时人查 |
| 超出③的任何新增周期式看门狗组件 | — | 逐项核对后确认:除 C 外设计中无其他新增检测组件(C 挂既有 GatePoller cadence,零新 timer);C 按下行收敛后无需再砍 |

## 保留(器官级,逐条对约束)

| 保留项 | 对应约束 | 说明 |
|---|---|---|
| Chunk A(text 批准绑定重接)+ B(park/wake 记账)+ E(终态清算) | ① 机制正确性 | 主交付本体,不动 |
| Chunk D(episode 代际 + 终态处置 + backfill) | ② 驯服 | **不是新看门狗** —— 是给既有 wake_failed 看门狗上笼头:终态 session 不再铸新 episode,告警量 28/晚 → ≈0 |
| Chunk C 收敛为**唯一③兜底**:只剩 severe 级 `founder_decision_dropped` | ③ | 触发条件 = founder 的 **definite 批准/拒绝决定**(classification 已 durable 落盘)在 deadline 内未绑定 —— 即「机制被证明丢了 founder 决定」。机制正确时预期触发率**零**;挂既有 cadence,零新 timer,恰一次告警(episode latch) |
| B3(founder-origin wake 永不静默 dispose → escalate) | ③ 同族 | 同样是「被证明丢件才响」,非周期新组件(在既有 patrol 分支内) |

## 验收调整(§6 ④ 行)

原 ④ 的「kill-switch 关 A → warning 级告警」形态**作废**(kill-switch off = founder 明确的运维选择,不该报警)。④ 改为:**classification 已落盘后人为切断绑定链**(如注入 writer 失败)→ deadline 内 `founder_decision_dropped` 送达 Lead。仍满足 issue 原验收「人为造投递失败 → fail-loud,绝不静默」。

## 对已批设计的影响边界

- 不回滚 R1-R9 已批的其余部分;本 correction 只做**收窄**(删一个告警级别、改一行验收形态),不新增机制;
- plan.md C2/§6 已按本文件同步修订(见 plan 头部修订链 R10);
- implement 节点以 plan.md(R10)+ 本文件为准。

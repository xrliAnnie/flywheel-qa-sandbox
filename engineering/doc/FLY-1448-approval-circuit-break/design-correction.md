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

## 附加输入二(msg 1530111445583527967):盯进程真话,别盯屏幕

### Annie 方向(Lead 转述)

卡死检测的结构性盲区:截帧比对会漏掉「活着但文字不变」态(长静默命令 / 纯 spinner 动画 —— spinner 恰好是会变的文字字符属侥幸非设计)。根治原则 = **别盯屏幕,盯进程真话**。信号优先级:

① **runner 进程/harness 心跳**(CLI 干活时定期写心跳,最准;基座已有 FLY-172 heartbeat markers)
② **停在空提示符**(idle-at-prompt)
③ **截帧比对** —— 仅人工取证工具,**不作自动判据**

与输入一「少养狗、机制对了不需要狗」合并为同一约束:检测层收缩为「心跳缺失 + 提示符空等」两个硬信号。

### 落进本单 Fix 设计

| 位置 | 落法 |
|---|---|
| B1/B2 wake-pointer admission | 主判据 = **durable park(进程/引擎真话:`ship_parked` FSM 态 / engine-park 凭证 / runner 自声明 park)**;第二信号 = idle-at-prompt(既有 `detectInputBoxPresent`);既有截帧 fingerprint 比对**降级为防御性末道校验**(防止往正在输出的 pane 打字),不新增任何以截帧差分为自动判据的用途 |
| D episode 开闭 | 全部由进程真话驱动(started receipt / terminal lifecycle transition / durable claim),零截帧依赖 —— 已天然对齐 |
| A/C/E | 不接触屏幕信号 —— 已天然对齐 |
| 本单红线 | 本单新增的任何判定逻辑,**不得**把截帧差分当自动判据;若发现依赖,改 heartbeat 缺失 + idle-at-prompt 两硬信号 |

(存量 stuck/liveness 检测器族(FLY-92/FLY-1048/FLY-1234)的全面改造不在本单 scope,此原则作为 fleet 方向记录,由检测族 own。)

## 附加:implement 阶段现场输入(Lead 答复 6a91aea1,2026-07-24)

给 implement 后继节点的两条一线情报(非设计变更,执行时注意):

1. **codex 全局 config 陷阱**:今晚 Codex CLI 0.145 曾自写 `shell_environment_policy` 进全局 config,导致 implement 节点 boot-fail(已修)。若 implement 后继撞 config 类错误,**先查这个**。
2. **boot-fail attempt 也要被必达/清算兜底覆盖**:失败节点无自动补派是活案例(FLY-1150 正卡着)。实现 Chunk C/D/E 时确认:boot-fail 的 attempt session 同样进入 terminal lifecycle 铸造与终态清算(D1/E2),其名下的 wake/receipt debt 不得 strand;C 的收敛账本对「决定已落盘但目标 attempt boot-fail」的形态照常 fail-loud。节点级自动补派本身归 FLY-1150,不并入本单。

## 对已批设计的影响边界

- 不回滚 R1-R9 已批的其余部分;本 correction 只做**收窄**(删一个告警级别、改一行验收形态),不新增机制;
- plan.md C2/§6 已按本文件同步修订(见 plan 头部修订链 R10);
- implement 节点以 plan.md(R10)+ 本文件为准。

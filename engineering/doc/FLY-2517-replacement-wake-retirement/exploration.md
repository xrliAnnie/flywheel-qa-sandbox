# FLY-2517 换体后旧唤醒退役 — 探索
Issue: FLY-2517 (https://linear.app/geoforge3d/issue/FLY-2517/病根-引擎-proven-dead-replacement-换体后仍向旧体投-phase-wakerework-wake20-分钟后判)
日期: 2026-09-11
基于: 无

## 问题与目标

引擎已把返工交给替身，旧执行体的阶段唤醒信仍被当作未完成义务；旧体失联后，这封信能把整条工作流暂停。目标是让换体事实同时终止旧信的投递义务，并给历史遗留 hold 提供有证据的关闭路径。

activation 指一次阶段任务的身份；execution 指承担它的一次执行体。换 execution 不能让旧通知继续拥有暂停整条 run（工作流运行）的权力，也不能把未送达通知伪装成已读。

## 证据与时效

- 用户注入的 issue 记录：FLY-2399，run `5a291283…`，旧体 `eae6b863…`，替身 `5c52a4f5…`；14:58:53Z QA FAIL，15:41:42Z 换体，15:43:37Z 替身完成，15:49:43Z 旧 wake 导致 held。
- 该时间线是 issue 提供的历史证据；本设计节点未读取或修改生产数据库，未复现生产事件。
- 当前审计基线 `ca869ad6d`，已含 FLY-2504 `bece7de15`。`recordWorkflowDeliveryRerouteOperatorRequired` 当前强制 `runHeld:false`；真实 run hold 在 `holdUndeliverableTx → finalizeUndeliverableHoldTx`。不能直接按历史函数名修。
- `materializeWorkflowReworkReplacement` 与 `convergeWorkflowReworkWriterReplacement` 写新返工路由、重铸 rework 投递 attempt，但 phase_wake 是另一 family（通知种类），源在 comm.db。
- `runner_phase_wakes` 的源状态和 teamlead.db 的投递 attempt 是两个数据库中的不同事实，不能假装一个 SQLite 事务覆盖二者。
- 当前 `phase_wake` cancel 硬拒绝仍存在；仅清理源状态不足以关闭投递合同，必须一起设计。

## 方案比较

| 方案 | 收益 | 缺口 / 代价 | 决定 |
|---|---|---|---|
| 只把所有 phase_wake 设为不 holding | 消除误暂停 | 真正没有执行的任务也失去保护 | 拒绝 |
| 只在替身完成时忽略旧信 | 覆盖事故结尾 | 替身完成前仍可被旧信打 held，且源继续重发 | 拒绝作为唯一修复 |
| 换体提交时记录精确退役事实，投递端据此收敛；hold 写入前再查同一证据 | 覆盖事务间隙、重启、历史旧信 | 需要 StateStore 和 comm 源的幂等衔接 | 采用 |
| 给 phase_wake 无条件 cancel | 操作方便 | 可能吞掉仍必须执行的阶段任务 | 拒绝；只允许有精确退役证据的关闭 |
| 把旧 wake 直接转投替身 | 少一封新信 | 替身已有启动信封，旧 activation/epoch/凭证不可沿用 | 拒绝 |

## 设计边界

1. 仅返工引擎的 proven-dead replacement 和 writer-replacement convergence；不泛化 mailbox 继承。
2. 保持新路由、替身启动内容回执、QA / founder gate、TURN 身份围栏。
3. 旧信退役不等于替身任务完成；替身投递失败仍按现有保护告警 / 暂停。
4. 用不可变路由及换体事件证明“旧义务已由新路由接替”，不用 heartbeat、文案、role 或 issue 相同作证明。
5. 给已 held 的本类遗留项提供受限 `cancel` 关闭；不直接全局 `UPDATE workflow_run`。
6. 设计节点只提交文档和 HTML；实现、测试行为验证、PR 和独立 QA 由后续节点完成。

## 调研问题

- wake 源里有哪些可用的 request / activation / epoch / recipient 身份字段？旧行如何精确回填？
- 源状态可否使用既有 finished + 单独退役原因，保留 started_at 为空？所有消费者是否拒绝迟到退役信？
- 投递投影在换体前未创建、换体后才补建时，怎样防止重新激活旧合同？
- 旧 hold 的关闭如何处理其他 hold 并存，以及源已退役 / attempt 已 settled 的幂等请求？

## 工作流说明

按本任务 full DOC-FLOW 与 design 专属授权推进，不增加 brainstorm 或 founder 审批。应用结构化 research / write-plan 的证据和拆分方法；review 只走本任务 `gate review_design` + `request-review`。无 Linear / Context7 callable 工具，issue 内容以本轮注入及 `.claude/skills/linear-issue-context/SKILL.md` 为输入；内部实现调研使用本地源码。

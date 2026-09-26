# FLY-2912 纯通知只记账 — 探索
Issue: FLY-2912 (https://linear.app/geoforge3d/issue/FLY-2912/token5-纯通知不叫醒扩面stage-changed-session-started-监控恢复-换体预告只记账不叫醒)
日期: 2026-09-25
基于: 无

## 目标与新旧决策
只让四类已证明无待办的状态播报停止单独唤醒 Lead；账、固定查询页和下次真实唤醒时的汇总必须保留。需要回复的问题、founder 消息、失败、卡住、真实交接动作维持即时路径。沿用项目开关 `lead_token_savings`，关闭后新事件恢复原投递。

本单是 design 节点，不实现、不派后继、不申请 ship。用户明确 founder 9-25 已选“做”；不重开 brainstorm 审批。FLY-2749 validation.md 记录 session_started 因同轮新 execution 交接保持 immediate；本单的新授权只替换纯开工播报约定，绝不把需要 Lead 接手的 replacement 吞掉。

## 已观察的基线
源码 HEAD `801ac86cb33e5ce5e11761817e8c341e07f5423a`。9-25 18:00–20:45 PT 的只读初查共 239 条工程 Lead 账目：stage_changed 61 audit_only / 18 model；session_started 20 model；监控恢复 2 audit_only；该窗口没有换体预告。这是账目分类，不是 239 次实际唤醒，也不是改后收益。详见 evidence/evening-inventory.json。

## 方案比较
| 方案 | 结果 | 取舍 |
|---|---|---|
| 按事件名一刀切 | 简单但会吞真实待办 | 拒绝 |
| 继续让模型判断是否回“收到” | 每次仍消耗一次唤醒 | 拒绝 |
| 经 producer 验证的无待办证据 + 原账 audit_only + 真唤醒附带汇总 | 可回滚，保留问题与审计 | 采用 |
| 新增定时摘要唤醒或队列 | 会重新制造噪音并扩大 scope | 拒绝 |

## 边界
不改模型窗口、规则压缩、token 用量页；不扩大普通 runner report 静默；不改变 REVIEW 工作流、ACK、审批、重试/换体调度和告警结案。仅有“running”、低优先级、文案“no action”均不足以证明无待办。事件 payload 和权限证明必须来自不同的校验层。

## 待确认（非阻塞）
已问 Lead `5fbba693-8282-4690-9a9c-0020b7aff927`：9-25 晚冻结窗口/时区或 FLY-2904 原始证据位置。默认窗口为上述 PT 段，回放需补 producer 原始输入与当时状态；不能用今天的 running 推断过去无待办。若窗口更新，保留旧 manifest 并生成新版本，不悄悄缩样本。

## 工作流与工具
onboard 已完成，TURN design epoch=1 / activation:0986142c-320f-4371-a143-ce47384f68dd:f4c0a90e-0888-4e52-b2a9-2c5957e23154:eng_design:1。
采用 research/write-plan 的代码链路审计与任务拆分形状；当前注入角色已授权完成全设计，覆盖通用 skill 的重复人审与版本目录要求。brainstorm/codex-design-review 独立 skill 未找到，按 Runner 环境翻译及项目 spin fallback 手工执行，审查仍走显式 gate+request-review。图遵照 diagram-design 的清晰层次与 Apple-light，使用用户明确要求的本地 Mermaid 渲染。

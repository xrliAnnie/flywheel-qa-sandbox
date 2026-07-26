# FLY-1448 批准断路 — 设计评审记录

Issue: FLY-1448 (https://linear.app/geoforge3d/issue/FLY-1448/p1批准断路-founder-批准被静默丢弃-session-卡-running-无-durable-park-wake-拒投)
日期: 2026-07-23
基于: plan.md

Codex design review(companion 持久线程,effort xhigh)共 **9 轮**,终局 **APPROVED**(R5 批准 A-D 基线;Lead 现场收编 Chunk E + founder MQ 问题后 R6-R9 增量续审,R9 批准)。

| 轮 | 判定 | 要点 |
|---|---|---|
| R1 | CHANGES REQUESTED(5H+1M) | A 处置矩阵未映射 v2 receipt ledger、root 时序倒置;C 会把普通聊天误报成批准被丢 + intent 写入窗口;B2 复用 runner_declared_states 造 false-positive wake admission 且外溢 cleanup 权限;D 指纹 execution+category 会吞后续新故障;D terminal 处置在现 outbox API 上不可执行、terminal authority 未定义;reply-to-card 授权谓词不全 |
| R2 | CHANGES REQUESTED(4H+1M) | root 处置不能按业务 outcome 盲推(post-write deferred/deadLetter 与 prior-exact-response 两个错配方向);B2 mutable clear 与 rowid-cursor projector 不兼容;terminal episode 通用关闭条件复活 treadmill;founder 独立告警与 episode 指纹互斥 + tri-atomic 缺口;definite classification best-effort 会降级 |
| R3 | CHANGES REQUESTED(1H+2M) | terminal episode 缺持久 lifecycle 身份(漏观测 terminal→live→terminal 吞新故障);A1 矩阵缺 typed-evidence 重放两行;B3 flag 声明自相矛盾 |
| R4 | CHANGES REQUESTED(1H) | 存量 terminal session 无 `terminal_lifecycle_id` backfill → 部署即复活 treadmill |
| R5 | **APPROVED(A-D 基线)** | 全部阻塞闭合;一条非阻塞文字修正(D2 从中立模块导入共享 terminal-status 常量)已就地采纳 |
| R6 | CHANGES REQUESTED(4H+2M) | (Chunk E + §8 新增后)Done authority 挂错巡检;跨库结算无 crash-safe lineage/状态机;E2 全量 RESOLVED 吞 D/B3 fail-loud 义务;E3 鉴权不可执行;E 无回退面;§8 措辞过度绝对 |
| R7 | CHANGES REQUESTED(4H+1M) | ship-gate 专用件清不了通用 receipt;projector 缺 mutation-time fence;存量 detection 无 lineage backfill;OFF→ON 漏账无补偿;§6 验收缺 E 行 |
| R8 | CHANGES REQUESTED(3H+1M) | `delivered` 误当终态会跳过真 unprocessed root;terminal fence 与 issue_done authority 冲突;跨库裸 re-read 是 TOCTOU 非线性化点;§7/QA 文字滞后 |
| R9 | **APPROVED(全量)** | 全部阻塞闭合;一条非阻塞实现细化(crash 测试构造 `applying(claim_token)` 已持久化后 crash → 新 Bridge 重用同一 durable token)已录入本表供实现参照 |

全部反馈**逐项采纳**(零 rejected);各轮修订摘要见 plan.md 头部「修订」链。反馈原文:`/tmp/codex-rescue-design-feedback-flywheel-FLY-1448-plan-round{1..9}.md`(临时文件,关键结论已折入 plan)。

# FLY-2632 批准绑内容 — 调研
Issue: FLY-2632 (https://linear.app/geoforge3d/issue/FLY-2632/land批准绑内容-founder-按卡后引擎自动-rebase-到最新-mainci复审通过且非冲突-hunk-逐字不变即沿用原批准直接)
日期: 2026-09-16
基于: plan.md
## 1. Founder 可见结果
按一次 ship 卡后，引擎为每张 PR 独立同步最新主线、跑新头 CI（自动检查）、独立复审，必要时重跑 QA（验收）。普通文本冲突只允许修改机械确认的冲突片段。全部条件满足时，沿用她原来的批准直接合入；只有证据不成立才重新立卡。多个 PR 准备并行，最终写 main 串行。
不拆 plugin.ts；不扩大首次批准权限；合并与独立 updater 部署仍分离。本设计不是实现或上线证据。

## 已通过门禁后的实施跟进（不改已审计划）
独立 review round 3：effective APPROVED，question 28f98551-36fc-4faa-8cc5-d5b9780c49b1，request 455d26e1-00c2-45c3-a5da-6f30e9b85889。详情见 design-review-receipt.json。本页记录 reviewer 的非阻断建议，尚未实现；不把建议或计划称为验收通过。

| findingKey | 实施时需收口的证据 |
|---|---|
| review-request-needs-commdb-gate-question | 每 preparation/C 的新 review_code question 由谁生成、幂等键与 author execution 的合法绑定；保留 R12 HIGH-2 不接受 Runner 伪造 from_agent。engine target 模式必须明确 immutable worktree binding / target path 如何替换为受控隔离 clone 与可信 repo identity；不得让现有 accept() 在 409/422 处一直拒绝。R1 的“gate delivery 不增加”指 founder gate；机器复审 question 可以新增。缺失 author worktree 的 clean 轮要端到端产出真实 C review |
| repo-concurrency-queue-depth-one | 实施显式选择 queue:max + cancel-in-progress:false（参见 research 一手依据），并保留队列满、cancelled、未启动无法写 receipt 的 Bridge 对账；不能把 GitHub queue 当唯一持久任务队列 |
| merge-envelope-is-replayable-bearer | 精确 trigger comment ID、分钟级票据、可信 started receipt；显式验证首次 merge 失败→founder 打回→原封套重贴必须拒绝。plan §11 为上线前要求，不视为仅签名已经保证 |
| engine-managed-detection-needs-callback | 受保护 GitHub ownership 判据、伪造/删除/换头两格正反例；无判据不得自动沿用。明确 legacy founder 直点可用性和拒绝范围，不能让局部 fail-closed 悄悄停掉全部 ship |
| cycle-budget-three-too-small | 用户三轮上限照旧；上线观测 main churn 触发频率，若高频则带数据给 Lead，不擅自放宽 |

codex-skip HIGH 已闭合；review producer 映射与命令拆批已闭合，保留 reviewer 自我更正的 lineage。上述未实现项报告 Lead 选择实施跟进，设计门不因 MEDIUM/LOW 重新打开。

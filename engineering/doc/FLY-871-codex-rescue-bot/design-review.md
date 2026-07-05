# FLY-871 Codex Infra Bot — Codex design review 记录

Issue: FLY-871 (https://linear.app/geoforge3d/issue/FLY-871/infraresilience-codex-救援-bot-账号体系外的看切救696-交叉自愈架构的-codex-半边token)
日期: 2026-07-04
基于: plan.md

**结论:4 轮 APPROVED**(codex-companion 持久 session,effort xhigh,findings 收敛 6→3→2→0 blocker)。

| 轮 | verdict | 要点(全采纳,零 reject) |
|---|---|---|
| R1 | CHANGES REQUESTED ×6 | ① static-ok 放行不成立(事故类别 = refresh family 失效,非 access 过期)→ 非 active 目标切前一律 probe-refresh ② helper 缺失 fail-open 违红线 → 退出 31 fail-closed + 显式 bypass env ③ Alerts 当 chat channel 会绕 mention-gate(runtime 会把 base chat 从 cross-dept 剥离)→ 私有 chat + Alerts=cross-dept ④ 现有 retry action 拒 running session → 专用 rescue-retry 路径 ⑤ runner 复用 lead login_expired 会被错误 pane 误 resolve → 新 `runner_login_expired` 事件 ⑥ lead kickstart 纯 prompt 约束不够 → `flywheel-rescue-lead` 审计 wrapper 验 alert row |
| R2 | CHANGES REQUESTED ×3 | ① HIGH:自动路径从 `process.env` **继承** bypass(claude-profile-cli 展开整 env)→ scrub + delegated 模式 bash 拒认(双层,皆测试断言)② HIGH:keep-fresh 对非 active 账号 probe-refresh 会在滞留 live session 脚下轮转 family("非 active ≠ 无人在用",shipped 模型)→ C4 拆两半,C4b 独立开关默认 off、R3 上线后才启用 ③ 顶层 scope/mermaid 与修正后的 C6/C8/C9 不一致 → 对齐 |
| R3 | CHANGES REQUESTED ×2 | ① HIGH:§4/§6/§11 契约与测试文字仍留旧语义(KEEPFRESH 写成跟随 SELF_HEAL 等)→ 与 C2/C4 逐字对齐 ② MED:`claimPending(botId)` 签名不符现有 API → `pendingKey(sourceAlertId, observedAccount, observedGeneration)` + `claimPending(key, actorBotId)` 持锁 |
| R4 | **APPROVED** | 两处非阻塞措辞清理(C9 触发词、§10 bypass 摘要 + research 两处旧简写)—— 已顺手修掉 |

反馈原文:`/tmp/codex-rescue-design-feedback-flywheel-FLY-871-plan-round{1..4}.md`(临时文件,要点已全部折进 plan.md 正文,以 plan.md 为准)。

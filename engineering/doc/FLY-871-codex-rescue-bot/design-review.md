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

---

## Re-plan 附加评审:§12 windowed-TUI 显示(2026-07-05,task-115 回炉)

**结论:2 轮 APPROVED**(codex-companion 持久 session,effort xhigh,只评 §12;R1 5 项全采纳、零 reject)。

| 轮 | verdict | 要点 |
|---|---|---|
| R1 | CHANGES REQUESTED ×5 | ① W2 episode signature 用 YYYYMMDD 会在 claims.db(sha1(project\|lead\|kind\|signature))吞掉同日第二个真实 episode → 改 episode 级:state-dir 原子写 tui-window-lost-episode.json{startedAt},signature=tui-window-lost:<startedAt>,恢复删文件 ② W1 两个假红探针:layer-2 按 launcher 路径 pgrep 不成立(launcher 末尾 exec node 替换 argv)→ 改 launchctl PID + runtime JS argv 断言;layer-6 「近期 real-TUI-up 日志」不成立(健康 liveness 20s tick 不打日志)→ 降级为诊断层不计退出码 ③ kind 契约写实:lead-alert.sh 硬拒未知 kind → shell 校验表 + LeadAlertNotifier.ts TS 联合类型两侧同加;砍掉不存在的 --help/dry 测试口 → hermetic 真脚本模式 ④ dist runtime 拿不到 repo-root 脚本路径 → wrapper/launcher export FLYWHEEL_ROOT(claude-lead.sh 先例)+ FLYWHEEL_LEAD_ALERT_SH 覆盖口 + fail-soft ⑤ 共享 runtime 默认开会波及未来 Mufasa bootstrap → 默认 OFF、run-codex-infra-bot-tui.sh 显式 =1(InfraBot-only opt-in) |
| R2 | **APPROVED** | 零 blocking;实现注记:TS kind 加类型后让 typecheck 逼出 exhaustive switch(LeadWatchdog title/body helper);episode 文件写原子 + 只在真转绿后删 |

反馈原文:/tmp/codex-rescue-design-feedback-flywheel-FLY-871-plan-round{1,2}.md(临时文件,要点已折进 plan.md §12,以 plan.md 为准)。thread 归档:companion threadId 未从输出捕获,归档跳过(best-effort;下轮 companion 起新 thread 无影响)。

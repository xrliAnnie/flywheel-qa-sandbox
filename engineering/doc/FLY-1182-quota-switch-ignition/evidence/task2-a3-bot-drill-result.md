# 轨A 收尾 · 2.9 bot 交叉互救真路径 — 演练结果(诚实边界)

日期: 2026-07-11 · setup: scripts/qa-fly-1182-track-a3-setup.sh · Tadashi 裁定: 05103e27

## 世界(真 slot Bridge + 真绑定账本 + 真牺牲 pane)

setup 脚本(全用本 worktree dist,Bridge 起前种)搭出 watchdog-won 全集成态:
- StateStore: 牺牲 runner session `exec-victim`(status=running)+ 绑定态 usage_limit alert row `ck-victim`(observedAccount=alpha, observedGeneration=1);
- CommDB: `exec-victim` → tmux 窗口 `fly1182-victim` 注册;
- 真 tmux session 显示 usage-limit-real fixture(真 5h 100% gauge);
- due pending → boot 后 watchdog 一个 tick 内真切换 alpha→beta;
- **绑定账本铁证**(切换后读回):`ck-victim | usage_limit | observed=alpha | observed_gen=1 | switched_gen=2` —— onSwitchCommitted → bindQuotaSwitch 在活 Bridge 真切换流程里 stamped(switched=observed+1),alert row 未被 account_switch resolve。

## 结果分两块诚实记录

### 块① 真 Codex LLM 决策纪律 — VERIFIED(真 LLM,codex-rescue)

派了真 Codex LLM(codex:codex-rescue subagent),喂 persona「救」节逐字 + assignment。
它自主调 `POST /api/account-switch` claim,遇传输失败(见块③)后:
- **正确 fail-closed**:判定「000 是传输失败,不是手册要的 409;不能声称切换已发生 → 不读账本、不进 rescue」,有界重试一次后停手报告,**绝不伪造 claim 成功、绝不盲救**。

这正是手册最关键的守卫(「409 不当失败,但账本看不到相邻切换也绝不盲救」)的反面——真 LLM 在无法确认切换时的**判断纪律**被真实验证。

### 块② 完整 HTTP 决策链 — VERIFIED(operator-driven,活 Bridge)

块③的沙箱网络限制挡住了真 LLM 的 HTTP happy-path,故由 operator 用 curl 对**活 Bridge**逐步复刻手册序列(这段验的是服务端机制,非 LLM 自主性):

1. **claim → HTTP 409** `already_claimed_or_missing`(watchdog 已抢先切换)—— 手册的常态时序真实重现;
2. **读账本**:generation=2(=observedGeneration+1)、activeAccount=beta(≠alpha)⇒ 相邻切换确认,准入满足;
3. **quota rescue** `POST /api/rescue {route:runner, executionId:exec-victim, kind:quota_stuck, actorBackend:codex}` → HTTP 200 —— **准入守卫真的跑了**:接受了 kind + codex actor,进入 live revalidateQuota 活 pane 复核(见下),返回 `ok:false reason:revalidation_not_confirmed`(guard 活的,200 非 error)。

### revalidateQuota 活 pane 复核 — 真跑(harness pane-layout 说明)

rescue 触发了 `makeRunnerQuotaRevalidate`:它经 captureSession(CommDB→真 tmux capture-pane)**真捕到了牺牲 pane**,再 parseUsageGauge。诊断确认:
- **全 pane 解析 100% 正确**:`{fivehPct:100, scope:"5h", resetAt:2026-07-12T02:30, confidence:high}`;
- runner 复核按设计只看 pane **最后 20 行**(真 Claude TUI 的 gauge status-bar 永远钉在底部);
- 本 harness 用 `cat fixture; sleep` 起牺牲 pane,tmux 渲染把 gauge 落进 scrollback、末 20 行是空白 → 复核读到「已不封顶」→ revalidation_not_confirmed。

⇒ 这是 **harness pane-layout artifact,不是产品缺陷**:复核代码路径真跑、真捕、真解析;full-pane 解析证明解析器对 fixture 100% 有效;生产真 TUI 的 gauge 就在末行,复核会命中。已记为 follow-up:轨C 观察期首次自然封顶验真复核命中。

### 块③ 环境限制(诚实记录,非产品 finding)

codex:codex-rescue subagent 跑在 Codex 沙箱里,**无法连到 host 的 localhost:19871**(curl connection refused / status 000)—— codex 沙箱网络隔离,与本单已记的 tsx TMPDIR socket 限制同类。故真 LLM 的 HTTP happy-path 无法在沙箱内完成;由 operator-driven 复刻(块②)。

## 边界(Tadashi 裁定 05103e27,写进 qa-report)

- **2.9-A**(真 LLM 决策链):判断纪律真验(块①)+ 完整 HTTP 序列活 Bridge 验(块②);真 LLM 自主跑完 HTTP 被沙箱网络挡(块③,环境级)。
- **2.9-B**(牺牲 session 真 close+successor 翻活):Tadashi 接受边界,**不搭 FLY-115 全栈**。理由:翻活原语 = FLY-871 login 救援已真机验证的同一 close+resumed-successor(只差 audit reason `quota_stuck_rescue`)+ 本单 rescue-quota 24 单测(4 类部分失败可恢复 + per-kind reason 透传 + sweep 排除 + byte-compat)全绿 + a2 #14 真 claim 切换活 Bridge 验。
- **硬条件(Tadashi)**:① qa-report 如实写清哪部分真机验、哪部分靠原语等价+HTTP级验、full real-runner-spawn 推迟;② 「首次自然封顶在轨C 观察窗验真翻活」= 显式、有人接的 follow-up 验收点(Annie 极在意'真封顶真翻活')。两条已进 recovery-runbook + qa-report。

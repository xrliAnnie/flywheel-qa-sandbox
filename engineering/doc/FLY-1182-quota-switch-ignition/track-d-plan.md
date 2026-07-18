# FLY-1182 Track D — 529 Room 真机全栈翻活 — 计划 + 准备段

Issue: FLY-1182
日期: 2026-07-12
基于: qa-report.md(§10-14)· qa-fly-1182-track-c.mjs(模块级全链)· qa-fly-1182-track-b.mjs(真 Keychain 安全网)

## 0. 这一轨要证明什么(Annie 的硬标准,ed08e9ad + 3c807c0a)

> 真 runner 撞真的模型级封顶 → 自动检测 → 自动切号 → `/api/rescue` 正确判定它【仍未恢复】→ 真的把它重启/唤醒 → 它继续干活。**全程零人工按键。**「切换成功」不算过;「决策验过 + 原语在别处验过 ≠ 整条链验过」。

Track C 已在**模块级**用事故当晚逐字 pane 走完真 dist 全链(46/46)。Track D 把它抬到**真 runner + 真 tmux + 真 Keychain + 真 close + 真 successor**——只有「cap 文本」这一处是可信注入(见 §3 的诚实边界)。

## 1. 全链(真机,零人工)

```mermaid
graph LR
  A[真 runner 在 529 slot<br/>真 tmux pane] -->|pane 显示模型 cap| B[RunnerIdleWatchdog<br/>每 poll 捕获真 pane]
  B --> C[runnerQuotaScan<br/>classifyRunnerCap=capped]
  C --> D[alert → routedAlertSink]
  D --> E[AutoRepairBot enqueue<br/>durable pending]
  E -->|唯一同步点:真 Keychain 切号| F[switchAccount<br/>lock→CAS→freshness→verify→ledger]
  F --> G[rescue 再查 quotaCapState<br/>仍 capped]
  G --> H[closeAndDispatchSuccessor<br/>真 FSM terminate→真 closeRunner tmux→真 start successor]
  H --> I[successor 继续干活]
```

Ground truth(绝不信 runner 自报):隔离 slot 的 `teamlead.db`(`sessions` / `session_events` / `state_transition`)+ slot `bridge.log` + `land-status.json` + `~/.flywheel/claude-accounts.json` 台账 generation。

## 2. 两段跑(Tadashi 2495e626)

### ① 准备段(现在做完,不碰真 Keychain)
- **P1 529 slot 全栈**:worktree 本 PR head → `pnpm -r build` → `test-deploy.sh <slot>` 起隔离 slot Bridge,**FLYWHEEL_ACCOUNT_SELF_HEAL=1**(runnerQuotaScan 只在此 flag 下挂)+ `BRIDGE_DEPT_SCOPE_REJECT=off` + 隔离 `FLYWHEEL_CLAUDE_ACCOUNTS_PATH`(**指向 scratch 台账,绝不碰生产** `~/.flywheel/claude-accounts.json`)。
- **P2 真 runner inject**:`/api/runs/start`(带 `TEST_API_TOKEN`)把一个 sandbox issue 派进 slot,起真 tmux runner。
- **P3 rescue/revive 验证脚本就位**:`qa-fly-1182-track-d.sh`——驱动 + 从 ground truth 观测检测半程(cap 注入 → 捕获 → detect → alert → enqueue),切号前**停在 pending**。
- **P4 broadcast 文案**:`qa-fly-1182-track-d-broadcast.txt`(HL/Cass/Peter「Chrome 会短暂断」)。
- **P5 切换/回滚 dry-run**:Track B 安全网(字节备份 + 无条件还原 + fleet PID 前后核活)彩排,**不切**。

准备段全绿 → ping Tadashi。

### ② 切号瞬间(唯一同步点,和 545 QA 的 Chrome 真资源互斥)
- 等 Tadashi 给的几分钟切换窗(他同时广播 HL/Cass/Peter)。
- 窗内:字节备份(Keychain 项 + `~/.claude.json` + `.active` + 生产台账 + 池内 outgoing 凭据)→ 放 pending 到期 → AutoRepairBot 真切号 → rescue 判仍 capped → 真 close + 真 successor → successor 继续干活 → **无条件还原到 business** → 新 session 核 `list_connected_browsers` 验 Chrome 恢复。
- 全绿 → 报 Tadashi → 他把 GO 卡端给 Annie。

## 3. 诚实边界(端给 Annie 前写死,绝不用 stub 暗示)

- **注入的只有 cap 文本一处**:真 runner 的真 tmux pane 里贴入事故当晚逐字的模型-cap 行(按需真实注入,Track C 已获 Annie 接受)。其后**全部真**:真 idle-watchdog 捕获、真 quota-scan 检测、真 Keychain 切号、真 rescue、真 FSM terminate、真 closeRunner(tmux)、真 start() successor。理由:按需耗尽一个真模型配额不可行;引擎键控的是 cap **信号**,信号之后的反应链一处不 stub。
- **切号动的是 scratch 台账**(隔离 `FLYWHEEL_CLAUDE_ACCOUNTS_PATH`),但 **Keychain 是机器全局单项**——这一步真的写生产 Keychain(这正是 Track B 已证、也是这次唯一断 Chrome 的原因),所以必须字节备份 + 无条件还原,且排在 545 Chrome 之后。

## 4. 红线(全程)

- 绝不弄坏现有 claude 登录:字节备份 + 无条件还原 + verify-before-commit + fleet PID 前后核活。
- 不打断在飞的生产 runner(切窗只在 545 Chrome 间隙,Tadashi 给)。
- 529 slot 的台账/pending/pool 全隔离到 scratch;**只有 Keychain 那一项是真的**(不可隔离,机器全局)。
- 绝不自 merge、绝不自 enable、绝不自 ship —— GO 卡永远是 Annie 的 gate。

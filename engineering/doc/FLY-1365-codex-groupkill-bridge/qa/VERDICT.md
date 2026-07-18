# FLY-1365 Bridge 自伤 blink 根治 — QA VERDICT: PASS

Issue: FLY-1365 (URL 不可得,只写 issue 号)
日期: 2026-07-18
基于: plan.md, research.md, exploration.md

**PR**: #645 · **verdict 绑定的 exact head**: `d7eedd86ffc836d07e10101d5dc5b928bf512c75`
**QA session**: runner e36c85eb (三段式 QA 段,独立于 implement 段)
**结论**: **PASS ✅** — Tadashi 能力级四条铁规全部真机验证通过 + 全量单测通过(去除环境性假失败)。

---

## 一、Tadashi 能力级四条铁规(单测绿≠过,必须真机验证核心能力)

所有 harness 都驱动**真实生产代码**(从 source 经 tsx 导入,零 mock 主体),并带**正对照/变异对照**(证明尺子没坏、不是空过绿)。全部脚本在本文件夹 `qa/`。

### ① stall 免疫 — PASS
`qa/cap1-stall-immunity.mts`(驱动真 `BridgeEventLoopWatchdog` worker + 真 `ensureSessionWithRetryAsync`)
- **修复路径(async)**:注入锁 `acquire_timeout`(status=5)慢 seam,ensure 循环 **3 次越过 800ms 致死线**,事件循环 max gap = **54ms**(主循环全程活着),真 watchdog worker **从不发 stall/SIGKILL**。
- **正对照(旧同步路径 = 今天的死法)**:保留导出的旧 `ensureSessionWithRetry` + 阻塞 seam 冻结主循环 → **独立 watchdog 线程记录 `stall_age_ms=812`(> 阈值)→ 会 SIGKILL**。
- 意义:证明「async 免疫」不是空过绿 —— 同一探测器对旧死法确实触发。**前后铁证**。

### ② 归因告警真实到达 Discord(实发实收)— PASS
**part A 逻辑正确性** `qa/cap2a-attribution-logic.mts`(真 `findWatchdogStallForExit` + `buildAbnormalExitAlertContent` + `abnormalExitTicketEventId`)
- 精确 pid+代(bootTs)+落在上代 boot 窗口 → 归因文案「Bridge event loop 卡死自杀」含 `stall_age_ms` + `last_sync_op`;
- **变异对照**:pid 不符 / 代不符 / stall 早于上代 boot 窗口 / stall ≥ 本代 boot → **一律回退 generic 文案**(宁可少归因绝不误归因);污染/超大/坏 JSON/缺文件 → 不 throw、不归因;dedup eventId 稳定且按代区分。

**part B 真 Discord 送达** `qa/cap2b-real-discord-alert.mts` + `qa/cap2b-run.sh`(驱动真 `LeadAlertNotifier.alert()`,payload = 真 `buildAbnormalExitAlertContent`)
- 真 POST 到**隔离** `#test-flywheel-alerts`(1519421055805165842,TEST_BOT_TOKEN_1),**实收**:message 到达,**延迟 772ms < 30s**,收到的正文携带**归因**标题「🚨 Bridge event loop 卡死自杀 — 复活对账中」(不是 generic);
- **生产隔离**:queue/deadletter/claims 全走 `/tmp` 隔离目录,生产 `~/.flywheel/alert-queue|alert-deadletter|alerts/claims.db` 前后**零变化**。
- QA 诚实记录:首跑 403 Missing Access 是**测试环境串味**(生产 `FLYWHEEL_ALERT_SENDER_TOKEN_ENV` 泄进测试进程,把发送身份塌成生产 dispatch bot,不在隔离 guild) —— 用注入式 logging `fetchFn` 定位真因(非猜),unset 该 env 后隔离发送成功。**这是 harness 串味,不是 FLY-1365 缺陷**;送达链路(notifier→Discord)本就非本 PR 改动面。

### ③ 杀伤半径 / 自组保护 — PASS
`qa/cap3-kill-radius.mts`(驱动真 `createDefaultKillGroup`)
- 合法 daemon 组 → 以 `kill(-pgid)`(POSIX 组信号)精确打**该组**,半径不外溢;
- **拒绝** pgid == 自身 pid / 父 pid / **Bridge 真实进程组**(祖父 npm 组 28163,即 issue 担心的生产拓扑)/ 0 / 1 / 负数;
- **变异对照**:旧 pid/ppid-only guard **会**对 Bridge 真实组发 `-28163`(= issue 标题「组 SIGKILL 误伤 Bridge」) → 证明新自组 guard 是承重的、非装饰;
- 附带:E 项 settle 默认 10s / env 覆盖 / 坏值回退 10s 全对。

### ④ 09:35 事故形态回归(A 节点被杀→重生,Bridge 全程不死)— PASS
即 ① 的正对照 + 修复对照合起来的回归证明:今天的死法(同步 ensure 卡死 main loop >60s → watchdog SIGKILL → launchd 重生 → boot redrive 再 ensure → 循环)在 async 化后**不再发生**(主循环全程在线、watchdog 不自杀);旧形态被独立 watchdog 线程确证仍会触发(尺子有效)。

---

## 二、根因重定向的独立复核(审计推翻 issue 叙事,我独立证实)

issue 原述「codex daemon 组 SIGKILL 误伤 Bridge」被 implement 段审计推翻。我**独立**用生产 `~/.flywheel/bridge-watchdog.log` 复核:issue 钉死的「09:39:15 escalation→重启」中的那条 stall 实为 **`2026-07-17T16:39:14.901Z`(07-17,非 07-18)**,与审计结论逐字吻合。真凶 = Bridge 自家 `BridgeEventLoopWatchdog` 把 >60s 的同步 ensure 卡死转成 SIGKILL 自杀。修复方向(A async 化 + C 归因 + D/E 加固)对症。

## 三、全量单测(去环境性假失败后)

- `flywheel-claude-runner` 首跑 17 项「失败」→ **全部环境性/既有 flake**,非本 PR 回归:
  - `codex-daemon-runtime`(**本 PR 范围**):QA session 默认 `TMPDIR` 过长撞 `SUN_LEN(103)`,`TMPDIR=/tmp` 下 **43/43 全绿**;
  - `claude-profile` / `scaffold-prune.real-tmux`:本 PR **未触及**其 source(`git diff` 证),`TMPDIR=/tmp` 下各自通过(scaffold-prune 2 pass + 2 skip;claude-profile 高 load 下的既有 flake,见 MEMORY 记录)。
- 结论:**本 PR 无测试回归**。

## 四、复现命令(全部 `TMPDIR=/tmp`)

```
TMPDIR=/tmp pnpm exec tsx engineering/doc/FLY-1365-codex-groupkill-bridge/qa/cap1-stall-immunity.mts
TMPDIR=/tmp pnpm exec tsx engineering/doc/FLY-1365-codex-groupkill-bridge/qa/cap3-kill-radius.mts
TMPDIR=/tmp pnpm exec tsx engineering/doc/FLY-1365-codex-groupkill-bridge/qa/cap2a-attribution-logic.mts
bash engineering/doc/FLY-1365-codex-groupkill-bridge/qa/cap2b-run.sh   # 真 Discord(隔离通道)
TMPDIR=/tmp pnpm exec vitest run test/codex-daemon-runtime.test.ts    # (在 packages/claude-runner) 43/43
```

## 五、VERDICT

**PASS ✅ @ head `d7eedd86ffc836d07e10101d5dc5b928bf512c75`** — 四条能力铁规真机全过,根因重定向独立证实,无测试回归,生产隔离守住。ship 决定权归 founder(Annie),经 Tadashi 开 gate 呈报。

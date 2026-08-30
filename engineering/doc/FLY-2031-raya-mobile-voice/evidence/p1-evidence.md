# FLY-2031 P1 系统播报归属 — 验收证据
Issue: FLY-2031 (https://linear.app/geoforge3d/issue/FLY-2031/rayav3-随身语音b常开流-念读筛选-用嘴批-ship)
日期: 2026-08-27
基于: plan.md

## 结论

P1 **PASS**。真 Codex realtime 回答为:

> 好的，我会转述 Tadashi 的问题给 voice-test-2 里的验收人：“今天的发布窗口定在几点？”我不会代替他们回答。

它保留了 Tadashi 来源、问题原文与收件人,且明确没有代答,符合 plan §4 的通过条件。

## 真实运行与用量

- Lead gate: `70cbf648-2805-4674-9fc5-2eafe0e39547`。
- Codex CLI: `0.150.1`;transport: websocket;realtime version: v2。
- 1 条 realtime leg,1 次 `appendSpeech`,1 条 assistant transcript。
- 实际 realtime 时长: `3,793ms`;预估 `<60,000ms`,硬上限 `180,000ms`。
- 逻辑验收收件人:Discord `voice-test-2` (`1542708795720081408`)。P1 按批准计划是复用 `c0-lib.mjs` 的最小注入器,没有连接 Discord;真房音频是 C9/P0 的单独硬门。

## 隔离与恢复

- `codexCwd` 与唯一 writable root 都是 `~/.flywheel/raya/worktrees/raya-FLY-2031`。
- 使用一次性 `CODEX_HOME=/private/tmp/raya-fly2031-p1.v6PLau`,其中只预置 session-only `config.toml`;没有复用生产 state DB。
- 没有改 launchd plist,没有启动/停止生产 brain,没有写 `~/.flywheel/raya/code`;探针后该生产 checkout 仍 clean。
- 运行后删除一次性 `CODEX_HOME`;系统 Trash 不接受 `/private/tmp` 来源,故该临时生成状态已永久删除、不可恢复。原始 probe 证据保留在本目录。

## 判定器纠偏

第一次自动判定误报 FAIL:规则把“我会转述”里的“我会”错当成替收件人作答。原始 manifest 与 JSONL 未改,各自 SHA-256 固定在 `FLY-2031-P1-system-broadcast-adjudication.json`。新增真实 transcript 回归测试后,收窄规则并离线复算为 PASS;没有为修判定器再烧一次平台 credit。

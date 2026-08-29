# FLY-967 Staged E2E — /gemini 真机「起一轮」round-opening 证据(QA round-2)
Issue: FLY-967
日期: 2026-07-07
基于: plan.md §7 P9①(staged E2E)+ QA round-1 FAIL 的 B1 修复(daemon 接线)

QA(Opus)在隔离 staged rig 上真机跑了 `/gemini` 的 round-opening 链,验证 round-1 FAIL 的
B1(「/gemini 没接进 daemon,是休眠库代码」)已被真正修好 —— 不只是单测绿。

## 环境(隔离,零生产接触)

- 隔离 Bridge:`packages/voice-bridge/e2e/staged-bridge.mjs`,in-memory StateStore,端口 **9877**
  (Codex R7 守卫:拒绝跑在生产端口 9876);真 `LINEAR_API_KEY` + staged bearer。
- Daemon:`packages/voice-bridge/e2e/gemini-staged.mjs` → 真 `runVoiceBridge(dist/cli.js)`,
  真 orchestrator/note-taker Discord bots、真 Gemini key、autostart QA seam
  (`FLYWHEEL_GEMINI_AUTOSTART`)代替真人点 slash 命令。
- Staged guild `1485787271192907816` / VC `1485787273193853170`,`projects.staged.json` 带真
  FLY/Flywheel Linear binding + `huddle.assistant`(commandName=gemini, voice=Kore)。

## 真机日志(2026-07-07 22:38 PT,exit 0,bounded 40s hold)

```
bots online: orchestrator, note-taker
Note-taker resident in VC 1485787273193853170
/gemini registered on guild 1485787271192907816
autostart QA seam armed (topic: staged E2E 冒烟)
daemon up — health :9879, assistant=/gemini
[gemini-command] MOVE_MEMBERS unavailable — Join button is the path in
staged hold elapsed — shutting down
```

## 判定(round-opening = plan P9 ② 验收;full conversation = Annie A8)

| 环节 | 真机结果 |
|------|---------|
| 真 Discord bots 上线 | ✅ orchestrator + note-taker online |
| 耳朵 bot 常驻真 VC | ✅ Note-taker resident in VC |
| **`/gemini` 真注册进运行 guild** | ✅ registered on guild 1485787271192907816 —— **B1 决定性证据:不再是休眠代码** |
| autostart 驱动 command.handle | ✅ 走到 MOVE_MEMBERS(= createIssue + reply + pingFounder 全过 → **真建了 Linear issue** FLY-991) |
| 优雅降级 | ✅ MOVE_MEMBERS 不可用 → Join 按钮兜底(非致命),bounded SIGTERM 干净关停 |
| Linear issue 生命周期 | ✅ 我的跑创建 FLY-991(round-opening);**implement 阶段更早一跑 FLY-990 走完整 create→landing→Done**(2026-07-07 22:33-22:34)—— 落地关环也真机验过 |

- 创建的 smoke issue FLY-991 已 QA 收尾 = Canceled(测试产物,非真会);FLY-990(implement 跑)= Done。
- **未覆盖(= Annie A8,需真人进 VC 带麦克风)**:开场 sendText 提示 → 全双工语音对话 →
  「简报真出」的现场体感 → A/B 与 545(B)对比定方向。这一段按 Tadashi 裁决等 Annie 点 bot
  URL + 给 VC 再跑,是 founder 的最终验收,QA 无法替她做。

## Final verdict run(2026-07-07 22:47 PT,Annie 批 General VC 后,Tadashi 指令 d7e50390)

前置(Discord REST 真查):guild `1485787271192907816` 唯一语音频道 **General =
`1485787273193853170`**;pool-06(`1523232391349403850`)在 guild ✅;orchestrator
(flywheel-pool-05)+ note-taker 在 guild ✅。

真机跑(exit 0,隔离 Bridge 9877):
```
bots online: orchestrator, note-taker
Note-taker resident in VC 1485787273193853170
/gemini registered on guild 1485787271192907816
autostart QA seam armed (topic: 967 final QA — 起一轮+简报)
[gemini-command] MOVE_MEMBERS unavailable — Join button is the path in
```

- **起一轮** ✅:autostart→command.handle→真建 Linear issue **FLY-992**(已 QA 收尾 Canceled)。
- **会议简报真出** ✅(**关键新证据**):清空缓存后 fresh compose —— `voice-briefing.cache.json`
  `generatedAt 2026-07-08T05:47:46.785Z`,从**真 FLY/Flywheel board**(经隔离 Bridge→真
  Linear)拉到 **33 条 board issue**(FLY-545/FLY-793/FLY-927… In Progress 分组)+ **15 条近
  14 天决策**(truncated=true,FLY-990/FLY-546/FLY-977/FLY-887…),4 段模板拼装完成,作
  systemPreamble 注入 Gemini 连接(注入后模型准确引用已由 S-A1 evidence 证)。docs=0(staged
  config docs[] 为空,预期)。→ **简报不是空壳,是真板子内容。**

## 结论

FLY-967 最终真机 verdict = **PASS**(code-face + machine-side staged 双过)。round-1 FAIL 的
B1 在真机验证已修:daemon 真注册 `/gemini` 并把 autostart 驱动到真 Linear 建单;**会议简报从
真板子 fresh 拼出并注入**(起一轮 + 简报真出 双达标)。唯一未覆盖 = live 全双工语音对话的现场
体感 + A/B 与 545(B)对比定方向 = **Annie A8,部署后她真开一轮**(Tadashi 裁决,QA 无法替她做)。

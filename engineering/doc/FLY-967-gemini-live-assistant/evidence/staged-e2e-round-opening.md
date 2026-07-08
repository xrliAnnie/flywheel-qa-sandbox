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

## 结论

round-1 FAIL 的 B1 在真机上验证已修:daemon 真的注册 `/gemini` 并把 autostart 驱动到真 Linear
建单。「起一轮」的 round-opening 链真机跑通;live 全双工对话的最终体感验收归 Annie(A8)。

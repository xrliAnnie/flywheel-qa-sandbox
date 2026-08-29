# FLY-2126 Raya 语音链路 529 标准场景 — 场景说明
Issue: FLY-2126 (https://linear.app/geoforge3d/issue/FLY-2126/rayae2e-把-raya-语音链路做成-529-房标准场景真-voice-进程tts-注入判据脚本化)
日期: 2026-08-28
基于: plan.md

## 用途

`raya-voice` 用两个独立 QA bot 在 `voice-test-2` / `voice-test-3` 中拉起被测 Raya 的真实 voice 进程，以 macOS `say` 注入 TTS，并自动判定指令腿、spoken-exit、误退、静默窗、后台委托和 Raya 身份。它是 TTS 回归尺，不包含真人声或 founder 听感验收。

## 一条命令

```bash
scripts/qa-raya-voice.sh \
  --subject-root /absolute/path/to/built/raya-worktree \
  --criteria all \
  --run-id fly2126-positive
```

被测 worktree 必须先完成 `pnpm build`。默认 emitter 使用 `TEST_BOT_TOKEN_1`，voice 身份使用 `TEST_BOT_TOKEN_2`；可用 `--emitter-bot N --voice-bot M` 改槽位，但两者必须不同且在 `~/.flywheel/test-slots.json` 中映射到不同 bot id。

命令应在正常 macOS 用户会话中运行。TTS renderer 会用 `afinfo` 校验 `say` 产物的时长与 audio bytes；无 GUI audio session 或受限 runner 若只生成空容器，会在进入 Discord 前以 instrumentation failure 失败，不会把静音文件当作有效注入。

## 退出码与证据

| 退出码 | 含义 |
|---:|---|
| 0 | 全部选中判据 PASS |
| 1 | 至少一个 eligible 行为判据 FAIL |
| 20 | 仪器/链路不完整，无法下行为结论 |
| 64 | 参数或双 bot 角色配置错误 |
| 75 | 本机已有场景实例持锁 |
| 78 | build、凭据、preflight、房间或身份前置失败 |

证据包位于 `~/.flywheel/raya/qa/FLY-2126-runs/<run-id>/`，包括每场独占 state/log/workspace、TTS fixture、`verdict.json` 与 `summary.md`。所有临时 bot 凭据在成功、失败和信号路径同步删除。

## 资源与房间约定

- 只允许 Discord voice channel `1542708795720081408` (`voice-test-2`) 与 `1542709028742893699` (`voice-test-3`，默认)。
- 一次 full run 为 15 个真实 voice 生命周期，约占用 30–45 分钟和相应 OpenAI Realtime 额度。
- 标准路径使用专用 QA voice 身份，不触碰生产 Raya Discord 身份，也不做任何 launchd mutation。
- 场景开始时房间必须为空，voice 身份必须在全 guild 语音空闲；运行中第三成员进入会立即中止该场。
- C4 nonce 只写入该场 `workspace/canary.txt`，不会出现在 TTS 提问中；会话启动说明只告诉 Raya 隔离 workspace 的绝对路径，避免“复述问题”造成假阳性。

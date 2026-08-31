# FLY-2126 Raya 语音链路 529 标准场景 — 校准报告
Issue: FLY-2126 (https://linear.app/geoforge3d/issue/FLY-2126/rayae2e-把-raya-语音链路做成-529-房标准场景真-voice-进程tts-注入判据脚本化)
日期: 2026-08-28
基于: plan.md

## 结论

标准场景已用真实 Discord、真实 voice 进程和 Realtime 逐字转写校准。被测正样本固定为 Raya `4a67508`，负样本固定为 pre-FLY-2097 的 `46b5b6b`。C0/C1/C2/C3/C5 的正样本行为与 FLY-2097 人工 QA 一致；负样本 C0 被判为 instruction leg dead。C4 的业务判据和证据链已跑通，但 resident Codex 内再次启动 Codex 会触发 macOS nested sandbox 限制，因此本环境没有伪造 C4 正样本 PASS，保留为明确的 instrumentation limitation。

## 真链路证据

所有 evidence bundle 位于 `~/.flywheel/raya/qa/FLY-2126-runs/<run-id>/`，包含 provenance、逐字事件、voice state、TTS fixture、JSON verdict 和人类摘要。

| Run ID | Subject | 范围 | 结果 | 说明 |
|---|---|---|---|---|
| `fly2126-positive-c0-wav-r1` | `4a67508` | C0 | PASS | 英文-only 指令腿生效，真实上下行完整 |
| `fly2126-negative-c0-wav-r1` | `46b5b6b` | C0 | control FAIL；overall INSTRUMENT_FAIL | assistant 输出中文，正确识别 instruction leg dead |
| `fly2126-positive-archived-r1` | `4a67508` | C0/C1/C2/C3/C5 | C0/C1/C2/C3 PASS；C5 FAIL | C5 误用了 FLY-2097 `probe-identity.wav`，该问题问 founder 身份，不是 Raya 角色；证据保留用于证明失败不会被吞掉 |
| `fly2126-positive-c5-archived-r1` | `4a67508` | C0/C5 | PASS | 改用正确 `probe-role.wav` 后 Raya 自称判据通过 |
| `fly2126-positive-c4-openai-r1` | `4a67508` | C0/C4 | C0 PASS；C4 FAIL | 校准发现旧模板把 nonce 同时放进提问，既受 STT 同音词影响，也可能造成复述假阳性 |
| `fly2126-positive-c4-openai-r2` | `4a67508` | C0/C4 | C0 PASS；C4 FAIL | nonce 已只存在文件；后台任务因不知道隔离 workspace 路径而找错文件 |
| `fly2126-positive-c4-openai-r3` | `4a67508` | C0/C4 | C0 PASS；C4 FAIL | 已注入精确 workspace 路径；后台 Codex 到达正确文件，但 nested `sandbox-exec` 返回 `sandbox_apply: Operation not permitted` |
| `fly2126-positive-c4-openai-r4` | `4a67508` | C0/C4 | C0 PASS；C4 INSTRUMENT_FAIL | 诊断性 cwd 实验仍被同一 nested sandbox 阻断，证明不是路径或判据问题；该实验改动未保留 |

C4 校准音频仅为本次诊断，通过官方 `v1/audio/speech` 生成一次并复制进 evidence bundle；它没有进入仓库或正式 runner。标准产品路径仍为 macOS `say`。

## 校准驱动的修复

1. `say` 产物新增 `afinfo` 时长和 audio bytes 校验，空 AIFF fail loud。
2. 共享 timeout 计时器 `unref`，判据完成后 CLI 不再被 losing timer 挂住。
3. Discord-ready receipt、emitter unmute settling、room convergence 和 cleanup 等待都按真实链路补齐。
4. C4 nonce 从提问中删除，只写入场次 workspace；corpus version 升为 `fly2126-v1`。
5. C4 会话启动说明提供 workspace 的精确绝对路径，但不包含 canary 内容。

## 环境边界

- 当前 managed resident sandbox 中，`say` 可返回 0 但生成 `audio bytes: 0` 的空 AIFC；标准 renderer 现在会拒绝它。本次语义校准复用了 FLY-2097 已归档的 48 kHz stereo WAV，C4 另用一次性生成音频。
- resident Codex → voice → Codex 是嵌套沙箱；内层 macOS `sandbox-exec` 被外层策略拒绝。正常用户终端的一键场景没有 resident Codex 外层，FLY-2097 的 launchd 真机证据也已证明后台委托 2/2 成功。
- 校准前后 `com.xrli.raya.voice` 均保持 `state = not running`、`runs = 1`、last exit 0；生产 brain 进程保持运行。整个校准没有修改 plist、没有 bootout/bootstrap，也没有碰生产 Discord 身份。

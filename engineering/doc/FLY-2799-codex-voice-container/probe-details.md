# FLY-2799 Codex 语音容器 — 调研
Issue: FLY-2799 (https://linear.app/geoforge3d/issue/FLY-2799/语音v5-引擎-bcodex-语音容器-每次开一个新-codex-实时语音-session装进当前-lead-的-memory)
日期: 2026-09-22
基于: research.md

## 第 1 步实验复核明细

- 时间（UTC）：订阅负控 05:26:11–05:27:06；API 默认 V2 05:33:37–05:34:37；V3 05:34:55–05:35:05；显式 V2 05:35:27–05:36:27，均为 2026-09-23。精确时间、thread 身份、进程退出值以 [证据摘要](evidence/probe-summary.json) 和同目录 JSONL 为准。
- [官方 0.156.1 standalone release](https://github.com/openai/codex/releases/tag/rust-v0.156.1) 的 `codex-package-aarch64-apple-darwin.tar.gz`：SHA-256 `fea42f9625091f011e38f059da974d52e57ba31831648bb1c7f0b1a385fde547` 与 GitHub asset digest 一致。实际 `--version=codex-cli 0.156.1`；`features list` 为 `realtime_conversation stable true`。接口定义由该二进制生成，不能单靠定义判可用。
- 独立 `/tmp/fly2799-probe/{standalone,home,work}`；未改舰队两个 current/入口或共享认证。测试以 `app-server`（程序调用接口）建新临时 thread，`read-only`、`approvalPolicy=never`、`environments=[]`；实际 instructionSources/runtimeWorkspaceRoots 均为空。关闭 shell、插件、应用、hooks、多代理，不带 Flywheel/bot 凭据。最初默认文件环境被嵌套沙箱拒绝，改为无文件环境成功；没有放宽沙箱。
- [显式 V2 事件](evidence/api-v2.jsonl)、[开口音频](evidence/api-v2-appendSpeech.wav)、[外部输入](evidence/external-audio-in.wav)、[回答音频](evidence/api-v2-externalAudio.wav)、[V3 拒绝](evidence/api-v3.jsonl)、[首轮后台反例](evidence/api-default.jsonl)、[测试驱动](evidence/api-probe.py)。JSONL 是脱敏事件记录，音频 payload 换为长度/hash，并非逐字节 wire dump。外部 WAV 复用仓内 FLY-1443 的合成短句；这里只复用输入素材，结论来自本次新会话。
- 初轮 macOS `say` 生成空 PCM，所以订阅负控实际只送静音；没有将其算成音频通过。API 实验改用校验非空的 3.828 秒既有 WAV。`appendText` 的 12 秒观察窗不证明无限期不会出声；V3 只测本 key + 默认模型/声音的 WebSocket（持续双向连接）路径，未测 WebRTC 或 existingCall。
- 全部实验明确 stop/closed，并等待所拥有子进程退出（0）；隔离订阅认证副本已删除。只跑相关实验和本地离线音频识别，没有全量测试、实现、部署、房间接入或 successor。

**交付状态：** 本页是按 `[lead-instruction ff0b35b5-2331-40b4-a260-24a362dc5cb6]` 先交的第 1 步结果。待 Lead 收悉与 FLY-2795 合同到达后，继续探索、实施计划、有效设计评审及最终浅色 HTML；尚未运行设计完成命令。

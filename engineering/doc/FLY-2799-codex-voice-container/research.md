# FLY-2799 Codex 语音容器 — 调研
Issue: FLY-2799 (https://linear.app/geoforge3d/issue/FLY-2799/语音v5-引擎-bcodex-语音容器-每次开一个新-codex-实时语音-session装进当前-lead-的-memory)
日期: 2026-09-22
基于: 无

## 第 1 步首轮实测一页结论

**能力前置验证通过于 V2：独立 Codex CLI 0.156.1 能通过 `appendSpeech` 先开口，也能接外部音频；本次 V3 被拒绝访问。B 路需要 API key、按用量计费，不使用 ChatGPT 订阅额度。** 第 1 步通过不代表容器、身份注入、信箱隔离或真人房间 QA 已通过；下一步等待 FLY-2795 的正式接口合同。

| 必答项 | 0.156.1 真进程 / 真上游结果 | 可采用的结论 |
|---|---|---|
| V2 还是 V3 | 默认配置的 `started.version=v2`；显式 `v2` 也启动成功。显式 `v3` 回 `Voice session access denied`，没有 started | 本 key 可用路径为 **V2**；V3 文字/音频能力未验，不能承诺可用 |
| 塞文字先开口 | `appendSpeech` 发短句，返回 86,400 字节 PCM（未经压缩的音频），24 kHz 单声道、1.80 秒；模型转写与离线识别均为 “The purple lantern is ready.”。在此之前没送任何音频 | **可用**；需说明协议中的 `[BACKEND]` 是待朗读结果。`appendText` 单独只有输入 item 回执，12 秒窗口内没有音频，不能当成开口按钮 |
| 外部音频流 | 喂入本地 WAV 的 PCM + 2 秒静音尾；上游识别 “Hello, please reply with the words flywheel proboké.” 并返回回答音频 62,400 字节、1.30 秒 | **可用**；输入/输出音频、独立识别和逐事件记录已留档；这是真后端能力实验，不是真人进房 QA |

**认证纠正：** 初轮复制 Runner 的 ChatGPT Pro 认证，得到 `realtime conversation requires API key auth`，按指令先停并上报。Lead 通过问题 `a00af684-46b9-4e72-949c-e9f8ba8cd2cc` 明确纠正历史前提并授权使用生产语音现有 API key 续测。之后只按 `com.flywheel.voice` 安装配置 → 当前 wrapper → `host-config.sh` → 受管 `.env` 的现有来源读取该 key，经子进程环境传入，没有把 key 写入认证文件、命令行、日志或 git。首轮失败保留为负控，未静默换路。

**必须带入设计的反例：** 第一版简短提示下，`clientManagedHandoffs=true`（让调用方管理返回内容的选项）仍触发 `background_agent`（Codex 内置后台代理）及 `turn/started`，该后台因缺认证而 401。补充 `[BACKEND]` 前缀说明后，显式 V2 本轮成功播报且后台 turn 数为 0，但这只是一次行为证据，**不是禁止分身动手的权限边界**。后续必须按 V1 合同约束真实工具/执行入口，并把动作交给 Lead 本体信箱；不能靠提示词或这个布尔值宣称隔离完成。

## 追加模型实测（Lead 06:10Z / 06:14Z 指令）

同一 key 的公开 `gpt-live-1` 会话与 **client 自定义后台委托→回送结果→实际播报** 已跑通；但 Codex 0.156.1 V3 仅替换模型名仍被拒绝，不能把公开 API 可用等同于 B 载体已兼容。`gpt-realtime-2.1` 在 Codex V2 已完成先开口/外部音频问答，公开接口也完成了函数调用与打断。首包、插话、后台回传时间和独立音频识别见 [追加实测](new-model-probe.md)。均为单次隔离台架测试，真人手感及真实 Lead 信箱未验。后续语音模型必须可配置，不硬编码 1.5；具体字段待 V1 合同。

## 证据与下一步

官方独立包 SHA-256 与 release digest 一致，实际 `--version=0.156.1`、`realtime_conversation stable true`；私有 home、无文件环境、无舰队入口改动。全部测试进程已 stop 并退出，认证副本已删除。详见 [隔离与实验明细](probe-details.md)、[汇总](evidence/probe-summary.json)、[V2 事件](evidence/api-v2.jsonl)、[离线音频验证](evidence/offline-audio-verification.json)、[开口音频](evidence/api-v2-appendSpeech.wav)。V3、订阅失败及后台代理反例均保留，没有用成功样本覆盖失败。

按 Lead 指令先交这一页；等待 FLY-2795 合同后再完成设计、评审和浅色 HTML。没有实施、部署、真人进房测试或设计完成申报。

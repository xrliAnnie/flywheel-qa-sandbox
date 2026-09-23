# FLY-2799 Codex 语音容器 — 调研
Issue: FLY-2799 (https://linear.app/geoforge3d/issue/FLY-2799/语音v5-引擎-bcodex-语音容器-每次开一个新-codex-实时语音-session装进当前-lead-的-memory)
日期: 2026-09-23
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

以上为已完成的第一步历史报告；本轮不重跑。FLY-2795 已按下节固定版本放行，继续设计。没有实施、部署或真人进房测试。

## 2026-09-23 恢复审计：固定合同与代码接缝

权威：`git show 313befcfa3a7039dca2fc7eb1178803d47699026:engineering/doc/FLY-2795-voice-layering-contract/research.md` §4；同 SHA plan.md 的 K1–K6、G1–G2。Lead 回复 `50a4b17b-0669-479b-969b-1d677324432b` 确认 G1/G2 未关闭，作为集成准入依赖，允许设计继续。

| 已读来源 | 实际行为与设计处置 |
|---|---|
| Raya `apps/voice/src/codex/CodexLeg.ts@f669d1b`（blob `52459a7ebb3a5853dcc7921386dbd1930a6bc704`） | `openThread` 的显式 baseInstructions 替换 identity+memory；ACTIONS 在有 actions 配置时另行附加。恢复生成守卫、thread 回执检查与事件分发；改成统一强制装配，废弃可写 action.json 目录 |
| Raya `RealtimeTransport.ts@f669d1b`（blob `cda9f1b8b15ccafaf9d85411366d6bdf2666f757`） | start 同时等待 RPC 与 started；24k mono PCM 严格 base64 校验；appendAudio / appendSpeech 有 generation，appendText 没有；转写剥掉了上游 item 关联信息；事件 closed 后 audio 分支未再次检查 active。恢复时必须修这两个迟到入口，保留关联字段 |
| `teamlead/src/lead-backends/codex/CodexLeadProcess.ts:166` | 已有 spawnChild 注入、request、notify、notification / exit、server-request 白名单，K2 指定复用。stop 结束 stdin 并延时 SIGTERM，但不等待 exit、不升级 SIGKILL；音频热路径需要有界背压扩展 |
| `voice-core/src/types.ts:56,151,186,212,265` | 已有 backend/session、audio 格式集和静默 injectContext；缺 verbatim/attribution、规范 utterance 和可等待逐条持久化证明。共同类型按 V1 扩已有面，不建 B 私有词汇 |
| `voice-core/src/transcript.ts:49-71` | append/flush 吞写错并丢弃后续内容；目前不能证明某句已持久。先写后读回 sessionId+transcriptId+contentDigest，失败禁止动作 |
| `voice-codex/src/discord-room.ts:57,239,269,279` | 收音有 metadata，presence 可观测；playSpeech/cancelSpeech 已有；输出格式抽象、持续插话与 audibleTail（估算）由 G1 收敛 owner 提供 |
| `voice-codex/src/adapters.ts:103` | ingest 是整句 chat-ingest，只回 lane/deliveryId；不是通用 handoff 的授权/执行回执。模式层只投动作，不能照搬“每句话进 Lead” |
| `voice-codex/src/speech.ts:167` / `session.ts:457` | 回读等价规则可复用；confirmed 只到本地 submitted，不能升级成 playback_drained |
| `voice-core/src/factory.ts:102` | 目前 registry 仅注册 edge-tts / gemini-live；B 通过应用组合根注入注册，避免 voice-core 反向依赖 teamlead |

上表 Flywheel 路径省略共同前缀 `packages/`。Raya 当前项目 workspace 已无 Git；本次用 GitHub contents API 按精确 `f669d1b` 读取两份源码，没有 checkout 或修改 Raya。合同提供完整 commit `f669d1beac0cf052747a50a9b255516948936384`。

### 两个不应扩大解释的实验细节

`evidence/api-probe.py:78,81,94`（新模型驱动同样设置）把 thread 的 baseInstructions 与 realtime prompt 分开、`includeStartupContext=false`，且 appendText 明确为 `role=user`。因此：首轮证明可以开口/外部输入；**没有**证明 developer 静默注入、Lead memory 到达前台或后台无执行权限。方案把同一份强制上下文装入 thread 和 realtime prompt，独立验收回答中使用 memory 与当前状态。

官方 [Codex App Server 文档](https://learn.chatgpt.com/docs/app-server) 说明 thread/turn 与流式客户端协议；这是通用接口参考，不是 0.156.1 特定能力证明。本设计版本行为以已提交探针和精确版本生成 schema 为准，不用最新网页覆盖固定版本证据。

### 验证边界

不再重复首轮 API/模型探针。实现阶段必须补逐请求 proof/冲突测试、developer 注入测试、归属的无歧义关联、取消整轮迟到效果隔离、工具/凭据负控、真实 Raya 与 Honey Lemon 两场 room→container→Lead mailbox→minutes 验收。全量测试归 PR CI；本地只跑涉及包的定向测试。


## R1 后的真实来源与预算复核

生产projects.json的17个Lead都没有cosContext，包含本单两个人格；因此它只能是可选覆盖，不能是唯一输入。已按真正启动路径检查：Honey Lemon由 `packages/teamlead/scripts/claude-lead.sh:973-994,2938` 安装并以 `--agent flywheel-product-lead` 启动，identity frontmatter的 `memory:user` 对应 `~/.claude/agent-memory/flywheel-product-lead/MEMORY.md`（有效manifest无另一个CLAUDE_CONFIG_DIR）；安装副本与源identity hash一致。Raya身份的开场约定指向workspace memory/MEMORY.md，并有从当前CODEX_HOME得到的native memory_summary。完整路径、字节/码点/hash及o200k_base本地估计见 `evidence/context-source-measurements.json`，未提交文件正文。

Raya三文件共59139bytes/42423码点/15625估计tokens；Honey两文件41585bytes/36388码点/11040估计tokens。移除无法容纳两位身份的8192码点上限；计划最终prompt预算为128KiB与32768估计tokens，选定文件全文进入，其他索引引用不自动递归加载。该预算是应用防护，不是上游tokenizer或接入成功证明；实际状态和wrapper也必须算入，超限无静默裁剪。

本地0.156.1源码 `realtime-0.156.1.rs:1383-1492` 显示：8192估计token约束是V3初始items与realtimeStart/EndInstructions；显式prompt按本路径组装到instructions。`includeStartupContext=false` 不走隐式startup 5300估计token装配。官方[模型页](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)当前标128000上下文窗口，但不能拿整个模型窗口冒充语音instructions的实测上限。实现必须用真实规模的persona上下文完成T3/T8的模型消费证明；本轮只做本地文件与计数审计，未重跑首轮语音探针。

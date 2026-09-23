# FLY-2799 新语音模型追加实测 — 调研
Issue: FLY-2799 (https://linear.app/geoforge3d/issue/FLY-2799/语音v5-引擎-bcodex-语音容器-每次开一个新-codex-实时语音-session装进当前-lead-的-memory)
日期: 2026-09-22
基于: research.md

## 结论

**同一把生产语音 API key 能使用公开 `gpt-live-1`，并且能把委托交给开发者自己的后台；但它不是 Codex 0.156.1 V3 里只改模型名就能用的替换。`gpt-realtime-2.1` 则在现有 Codex V2 和公开 Realtime 两条实测路径上都通过。** 模型列表里的存在性只是发现证据，下面的连接、音频和委托回路才是能力证据。

本次追加来自 `[lead-instruction f32792b4-6fbf-49ca-a4d6-607a7e22302f]` 与 `[lead-instruction 31ca8913-1543-45c4-9eae-f073cd117c3d]`；继续第 1 步，不越过 FLY-2795 合同等待去自行定义产品接口。

| 路径 | 建会话、开口与音频 | 工具 / 自定义后台 | 结果边界 |
|---|---|---|---|
| Codex 0.156.1，V3，`model=gpt-live-1` | `Voice session access denied`，没有 started | 未执行依赖测试 | **当前载体路径未通过**；不能推断 key 无权使用公开 Live |
| 公开 Live，`/v1/live/sessions`，`gpt-live-1` | `session.started` 回显目标模型；纯文字 commentary 触发目标短句语音；持续输入外部 PCM，得到输入/输出转写与音频 | `delegation.type=client`，收到 `target=client` 和唯一委托 ID；本地无副作用函数回送“blue”，按原 ID append；模型实际说出结果，离线识别确认 | **公开 API 能力通过**；没有部署替代 Codex 引擎，未实接生产 Lead |
| Codex 0.156.1，V2，`model=gpt-realtime-2.1` | started V2；appendSpeech 读目标短句，外部音频输入后回答；正常 stop/退出 | 此组不额外测动作 | **现有载体适配可用**；不改变舰队 current |
| 公开 Realtime，`gpt-realtime-2.1` | 可说话、可接外部音频，用户插话触发旧响应取消 | 真 `response.function_call_arguments.done` 调用 `get_probe_status({})`；执行本地纯函数，回 function_call_output；模型说出“blue” | **函数调用通过**；并非真人房间或业务动作验收 |

## 可复核测量：每种配置各一场，不能据此排总体性能名次

两个公开 API 都使用 Marin、24 kHz 单声道、同一外部短句素材，按真实采样时长持续送帧（含静音），本机同时收流保存音频。长数数播报出现首个 RMS>200 的音频帧后 500ms 插入外部语音；RMS 是音频能量度量，不能单独证明内容。日志用单调时钟记接收时间；另用本地 Whisper base 做独立音频识别。

| 本机观测指标 | GPT-Live-1 | GPT-Realtime-2.1 |
|---|---:|---:|
| 发出开口命令 → 首个非静音 PCM | 1175.0 ms | 619.7 ms |
| 插话输入第一帧 → 新答案 “Flywheel…” 文本出现 | 4772.5 ms | 5234.7 ms |
| 插话输入第一帧 → 服务端明确取消旧响应 | 无对应 cancel 事件，不能填等价数值 | 167.7 ms（`turn_detected`） |
| 本地后台结果发出 → “blue” 文字出现 | 3016.8 ms | 506.1 ms |

这些是**单次传输/文字到达时间，不是耳朵听到的延迟、P50/P95 或可直接比较的架构基准**；最后一行也包含各模型自己的措辞与停顿。输入素材长 3.828 秒，第二行包含用户说完整句话的时间。会话建立指标另存 JSON，但两套协议 ready 含义不同，不拿它排名。

**全双工与打断：** Live 在持续收音时继续输出，服务端输入/输出转写的时间区间有 200ms 重叠（14,200–14,400ms）；长播报在“One”后结束，随后回答插入的短句，离线识别同样确认该内容。Realtime 2.1 的服务端旧响应明确 `cancelled / turn_detected`，随后回答新短句；服务端转写已生成到“seven”，离线音频识别只认到“two”，说明不可把生成文本全部当成已听到的音频。没有接扬声器、麦克风、Discord 播放队列或真人耳机；**真实打断手感、回声、播放缓冲清空仍未验**。

## 自定义后台结论与约束

Live 的 client 模式已实测：它发委托元数据给调用方，调用方可以运行自己的函数、agent 或信箱路由，再以原 `delegation.id` 回送结果；**不要求 OpenAI 托管后台模型**。此次执行的是固定返回“blue”的本地纯函数，既没有调用 Responses 后台，也没有读取 Lead memory、派单、批准或修改业务数据。结果被模型说出，不止是发送回执。

这证明“自定义后台通道能接”的协议能力，**不证明生产 Lead 收件、消费、动作执行及纪要回投已经闭环**。委托事件不携带完整任务文本，未来适配层需关联本会话转写与当前状态、校验身份和权限后投到真正的 Lead 信箱；消息送达和 Lead 实际消费仍须各自证据。[官方委托说明](https://developers.openai.com/api/docs/guides/live-delegation)

## 对后续设计的明确输入

1. 语音模型必须可配置，不硬编码 `gpt-realtime-1.5`。配置同时要与所选引擎/协议匹配；模型名存在不代表 Codex 路径兼容。具体字段服从尚待交付的 FLY-2795 合同，不在这里另立接口。
2. 公开 GPT-Live 使用新的会话入口与 `session.start`，Codex 0.156.1 V3 的现有连接并未因此自动兼容。要让 B 使用公开 Live，必须先选定并验证载体适配方式；本次只提供诊断与协议实验，不借机改成另一个产品引擎。[官方连接文档](https://developers.openai.com/api/docs/guides/voice-websockets)
3. 凭据/权限失败与额度耗尽均需明确显示“语音不可用”，保留原因，不静默切模型或切引擎。密钥依旧只由父进程环境注入，配置/纪要/证据不存值。
4. 官方公开 Live 语音按 $0.05/分钟、按秒计费，后台模型/工具另计；这次 client 纯函数实验没有托管后台模型调用。2.1 按文本/音频 token 计费。价格只作为 2026-09-23 文档快照，不是消费账单或预算承诺。[Live 模型页](https://developers.openai.com/api/docs/models/gpt-live-1)、[2.1 模型页](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)

## 证据与清理

[evidence/new-models/manifest.json](evidence/new-models/manifest.json) 固定测试身份、脚本与文件 SHA；[测量摘要](evidence/new-models/new-model-summary.json) 含单调时钟计算；同目录保存两种公开协议的脱敏逐事件记录、Codex 两组结果、输出 WAV、独立 ASR 和重跑驱动。日志中的音频载荷只保留长度、SHA 与 RMS；未复制外部官方文档全文。

公开 Live 两场均收到 `session.closed(reason=close_requested)` 及最终语音秒数；Realtime 2.1 的 WebSocket 显式关闭；两组 Codex 均 stop 后子进程退出 0（V3 驱动因预期能力失败返回 2，不能把它记为通过）。无生产服务改动、无舰队升级、无共享认证改写；KEY 未写 argv/日志/报告/git。这个补充报告不代表 design phase 完成。

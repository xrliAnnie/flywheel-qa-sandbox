# FLY-2799 GPT-Live 独立实测结论 — 调研
Issue: FLY-2799 (https://linear.app/geoforge3d/issue/FLY-2799/语音v5-引擎-bcodex-语音容器-每次开一个新-codex-实时语音-session装进当前-lead-的-memory)
日期: 2026-09-22
基于: new-model-probe.md

**结论：同一把获准使用的生产语音密钥已跑通 GPT-Live-1 公开语音协议及自定义后台委托；Codex 0.156.1 V3 指定该模型仍返回 `Voice session access denied`。** 两者是不同接入路径，不能把后者解释为密钥不能使用 Live。按 `[lead-instruction 542588a3-4f9a-4590-96cf-4f49d84ac221]`，公开 Live 归 FLY-2798 引擎 A，本单引擎 B 继续 Codex 0.156.1 V2 对照路线，接口仍等 FLY-2795 固定合同。

## 给 FLY-2798 用

**委托跑通。** 连接 `wss://api.openai.com/v1/live/sessions`，发送 `session.start`，指定 `gpt-live-1` 与 `delegation.type=client`；即由应用自己的后台接活。收到 `session.started` 后，文字 `session.commentary.append` 能触发开口，外部 24 kHz 单声道 PCM（未经压缩的音频样本）能持续送入。真实收到 `target=client` 委托后，本地纯函数返回固定结果“blue”，通过 `session.commentary.append` 携原 `delegation.id` 回送，模型实际说出结果，独立离线语音识别也确认。**没有调用 OpenAI 托管后台模型；也没有调用真实 Lead 或执行业务动作。**

| 单场本机测量 | GPT-Live-1 | Realtime 2.1 对照 |
|---|---:|---:|
| 开口命令 → 首个非静音音频 | 1175.0 ms | 619.7 ms |
| 插话第一帧 → 新答案文字出现 | 4772.5 ms | 5234.7 ms |
| 本地后台结果 → “blue”文字出现 | 3016.8 ms | 506.1 ms |

**打断与同时收发。** Live 持续收音时仍输出语音；服务端输入/输出转写时间区间重叠 200ms。长数数在“One”后结束，随后回答插话内容，离线识别确认。Live 此次没有与 Realtime 等价的取消事件；Realtime 对照在插话第一帧后 167.7ms 明确取消旧响应。两者都没有接真实房间的扬声器、麦克风和播放队列，因此不宣称真人打断手感或播放缓冲清空已经通过。

**限制条件与接入注意。** 每种配置仅一场；上述文字到达时间不是人耳听到的延迟，也不是性能排名。插话素材长 3.828 秒，第二项包含说话时间。委托事件只有元数据、不含完整任务文本：应用需要关联本会话转写、身份和状态，再按 FLY-2795 合同接真正的 Lead；信箱送达、Lead 消费、动作授权、纪要回投均未验。本实验没有加载 Raya/Honey Lemon memory，不替代两场真实测试房验收。模型及协议须匹配配置；额度或权限失败应明确“语音不可用”，不得静默切引擎。

## 证据与交付边界

结果与脚本固定于提交 `91534ea9e`：[完整测量与限制](new-model-probe.md)、[证据清单与 SHA](evidence/new-models/manifest.json)、[逐项测量 JSON](evidence/new-models/new-model-summary.json)。Live 正常关闭并收到最终用量，其他测试连接和子进程已关闭；密钥只经环境传入，未写入参数、日志或版本库；未改舰队 current 或生产服务。

公开 Live 不能只换旧 Realtime 的模型字符串：它使用新的入口和会话协议。语音价格文档快照为 $0.05/分钟，按秒计费，后台另计；该数字不是账单。[官方连接文档](https://developers.openai.com/api/docs/guides/voice-websockets)、[自定义委托说明](https://developers.openai.com/api/docs/guides/live-delegation)、[Live 模型页](https://developers.openai.com/api/docs/models/gpt-live-1)。本页是给引擎 A 的能力证据输入，不是实现、设计评审通过或生产验收。

# FLY-2798 前台快答与后台 Lead — 探索
Issue: FLY-2798 (https://linear.app/geoforge3d/issue/FLY-2798/语音v4-引擎-a前台快答-后台-lead-在现有通用管道上让实时模型自己答简单的复杂的交给)
日期: 2026-09-23
基于: 无

## 目标与授权
简单话由前台立即答，需要查询、行动、判断时说「我问下 Lead」，原话与身份经通用载体交给 Lead；回复直接推送，音频边生成边播，字幕分「🤖 前台」「💬 Lead」。V2 进来播报、V3 会议带节奏调用同一个 V1 speak 接口。
本次只设计，不实现、不跑生产探针、不部署、不派后继、不请求 ship。设计门通过后提交浅色 Mermaid HTML、静默发布、向 Lead 报告，再 phase_design_complete + park。

## 权威对账
- 起点 03bb98d4f，FLY-2795 合同已合并；任务 G2 裁定覆盖合同中尚待 founder 拍板的旧句子：前台自答已获准。
- A 固定适配器身份 openai-live；模型 gpt-live-1 和公开 Live endpoint 配置化；不是修改 legacy realtime.ts 或替换其模型字符串。
- 不新造函数工具。client delegation 是模型请求应用帮忙的接缝；不等于业务提交，不用 delegation.id 做业务幂等键。
- K1 单一 RoomIO；K2 不新造 Codex app-server；K3 不丢未知说话人整句；K4 本地 submitted 不等于人耳听到；K5 VoiceSessionState 唯一会话权威；K6 失败明确语音不可用、不可静默换引擎。
- Lead 问题 f2fec268-75dc-4661-8257-918cf72d10a2 已答：FLY-2796 拥有 RoomIO v1、通用 handoff carrier；本单是消费者。RoomIO 底座 discord-room.ts，ROOM_IO_VERSION=1，带 speaker 的帧、播放/取消、presence、收听健康、audibleTail（估算）、lease/SessionSlot。
- 同一答复明确 query/judgment 只读委托与 action 按 intentKind 区分，共用 durable 投递/回送身份；只读也须可查询幂等键与持久回执。不能把复杂查问删出范围。

## 当前证据与问题
FLY-2786 曾观察邮箱等待 12.7s，但根因未定位；不得写成已修。现有 Bridge 3s 与 voice 4s reply 拉取，加整段音频缓存，都是明确的结构等待点。当前 registry 只有 edge-tts、gemini-live；V1 语义合同不是已落地代码。
官方 Live 协议及 15fe2c875 实测都没有 output turn ID、输出音频 done 或转写 final。只有原始 delta、转写近似时间及 client delegation 句柄；不能从 quiet timer 编造服务端完成。

## 选定方向
1. 新 GptLiveBackend + session adapter 接 voice-core；现有 daemon 经接口选择它；同 RoomIO、同模式层。
2. 快答直接流音频，不进 Lead 邮箱。复杂话先持久化且归属，委托经 V2 carrier；推送通知只唤醒，DB 记录仍是权威。
3. 打断必须隔离整代连接；没有可证明 turn fence 时关闭旧 Live、以新 generation 接续，房间与 VoiceSessionState 不重建。输入有界保留；不得为低延迟而让旧输出漏出。
4. speak 的精确播报证据与快答流式分开：逐次 required 必须有独立证据；Live commentary 可改写，不得宣称天然逐字。具体方案等待 Lead 技术取舍答复 817101aa-c418-4fe2-ba6a-f1fd98169418。

## 否决项与边界
不减小轮询间隔假装推送；不发明新的房间层/会话状态机；不按最新一句或相近文本猜 delegation 归属；不把 HTTP/Unix socket ACK 当 Lead 消费；不以文字时间代替人耳延迟。
FLY-2767/2773/2711 留 backlog。若真实对比被其中某项挡住，仅允许具名最小补丁并在 PR 说明；不把相邻修复吞入此设计。

## 验收保留
Raya 测试房 10 次简单话，量同一录音说完→听到首字，列全部值及分布，≤2s 判据不变。复杂查询/判断及动作各有原话、投递、Lead 消费、结果与实际落地证据；字幕来源正确；V2/V3 speak 联调；本地相关测试，全量 PR CI。设计报告不声称这些已经通过。

# FLY-1006 M1 Annie 真人实测（P3，验收主体）— 会话清单

Issue: FLY-1006 (URL 不可得,只写 issue 号)
日期: 2026-07-08（滚动更新）
基于: plan.md §S3；evidence/m1-rig.md

> P3 验收物 = Annie 本人的体验结论落 [FLY-1006] thread；本文件只记会话
> 清单 + 指标 + 结论引用，不代替她的原话。

## Session 1 — 2026-07-08 下午（Tadashi/Eric，链路通但脑撞额度）

- 会话键：`m1-tadashi-1783546532766`（shim jsonl 留证——talk 页 override +
  `custom_llm_extra_body.conversation_id` 在她的真实会话里端到端生效）。
- **链路结论（她实测）**：连接 / 声线切换 / STT / 垫话全部正常工作。
- **故障**：每句回答 = brain error——shim jsonl 连续
  `brain_error: "claude -p exited 1"`，根因 = Claude 订阅 session limit
  正好在她测试时命中（980 D10' 的已知运维风险，如实记录：**这就是
  claude -p 订阅脑的真实产品风险**——脑的可用性绑着订阅额度窗口）。
- **体感反馈**（记进 M1 素材）：「你说话好奇怪啊」——对 Tadashi/Eric
  声线的中文表达观感。待她重测时对比 Cass/Belle 声线可分离归因
  （Eric 单声线问题 vs TTS 中文普遍水平）。
- 额度恢复后操作者复验（brain-verify，u1 一轮）：真答案返回（『嗯，我这边对
  "哈豆模式"不太了解…』），垫话首音 3.0s / 真答案 ~10.7s。
  wav/jsonl 留档 `~/fly1006-eleven/e2e-archive/e2e-fly1006-brain-verify*`。

## Session 2 — 2026-07-08 晚（重测，M1 终验结论落 thread 22:00 = P3 验收物 ✓）

Annie 的终验结论 + 四条 feedback（Lead 指示 bc366532 转达，原话在
[FLY-1006] thread 22:00）：

| # | 反馈 | 折进工作 |
|---|------|----------|
| ① | Tadashi/Eric 声线中文带怪方言口音（英文 OK） | 「中文口音干净度」列进声线对比维度。**Lead 已批占坑加库（可逆）**：从 shared library 加 3 条中文原生声线进 My Voices（28/30 坑）——Tadashi 备选 Jason（北京腔·深沉,`DowyQ68vDpgFYdWVGjc3`）/ Haoran（北京腔·沉稳,`pU9NaAwkoR3v0Mrg3uKz`），Cass 备选 Amy（北京腔·自然,`bhJUNIXWQQ94l8eI2VUf`,v9 就记过 Sarah 中文有小瑕疵）；George 留作英文 premade 对照。全部已上 talk 页下拉;zh+en 双语 TTS 样本（flash 档,v9 上岗规则）留档 `~/fly1006-eleven/audition/`。终选权在 Annie |
| ② | 延迟提示不够稳（『在思考』要全程可感知） | 垫话必出 + 轻量处理音效评估 → 记入 M2 设计（ElevenSession 拿到 turn 事件后可在首 audio_event 前垫处理音效；M1 平台侧只有 soft-timeout 一个杠杆） |
| ③ | 垫话语言写死中文（说英文也来『让我理一理』） | **已修（机制级）**：agent 加 language_detection 系统工具 + en language preset（英文垫话 "Let me think for a sec."）+ shim FLY980_TOOL_MODE=auto（用户说英文时确定性发起语言切换，980 V7a 机制）。**实测行为（限制如实记）**：语言切换本身即时生效（tool is_called=true），但 soft-timeout 垫话语言按平台侧会话状态取值，有 **1-2 轮滞后 + 混发**（首个英文轮仍中文垫话；稳态英文轮出现过 en+zh 混发——en preset 只接受单条 message，第二条垫话回落 zh 池）。根治留 M2（ElevenSession 可控事件层）或改默认垫话为语言中性哼声（中文侧体验降级，产品取舍留 Lead 拍）。jsonl 留档 e2e-fly1006-lang-follow*.jsonl |
| ④ | 角色/项目认知空洞 | 如实：M1 只带薄人设（personas/*.md），没接 Lead 记忆/项目上下文。这正是 Annie 的 persona+context 决策主轴 → **M2 的 Claude 脑必须接真 Lead 脑**（人格+记忆+issue 上下文注入，claude -p 走 Lead identity 路径）——已升格为 M2 核心需求（plan §4），不是 nice-to-have |

## 产品决策更新（Annie 拍板，取代 ②③ 的 spoken 垫话修法；Lead 指示 cbd5208c）

**垫话从『说话』改成『声效』**：用户说完 → 立即响轻量「处理中」音效
（循环至真答案 onset）→ 真答案。语言无关，②③ 一次解决；spoken 垫话降级
为可选配置。已落地：

- **agent 侧**：`soft_timeout_config.timeout_seconds=-1`（禁用 spoken 垫话；
  消息字段保留 = 可选配置，改回 3 即重开）；en preset 的 turn override 清空；
  shim 回 `FLY980_TOOL_MODE=off`（声效方案语言无关，语言切换工具不再需要，
  还省一轮工具往返延迟）。language_detection 工具 + en preset 留在 agent 上
  休眠（shim off 档永不触发）。
- **talk 页**：WebAudio 合成「处理中」脉冲音（620/930Hz 双 blip，1.4s 循环，
  低音量）——用户 transcript 到达即响、agent 开口即停；页面开关可关。
- **验证**：禁垫话后新会话录音频谱 = 纯语音（首音 9.3s = 纯脑延迟，无垫话、
  无音调伪影）；jsonl/wav 留档 e2e-fly1006-nofiller*。

### 「电话音」调查（Annie 报答案前有电话音）

频谱取证（`~/fly1006-eleven/e2e-archive/` wav + scratchpad 频谱图）：

1. **主嫌疑（她当时听到的）= spoken 垫话里「嗯……」的 TTS 哼声**——
   垫话音频段间存在 ~0.6s 平直谐波堆（稳定音调,与周围语音的波动共振峰
   截然不同），TTS 渲染的拖长鼻音听感即「电话音」。该段出现在
   **加语言工具之前**的冒烟录音里,与她 session 时段的配置吻合。
2. 次嫌疑（仅存在于语言工具启用窗口）：language_detection 工具的
   `tool_call_sound_behavior:"auto"` 平台等待音。
3. **两个来源都已随「垫话→声效」方案消除**：spoken 垫话禁用 + shim 工具
   off；禁用后新录音频谱确认无任何音调段。她下次实测若仍闻电话音,则来源
   在 SDK 客户端侧（widget chime）,届时再查。

## Rig 状态变更（Lead 指示,资源纪律）

2026-07-08 深夜:热 rig 拆除（shim + cloudflared 已停——idle 进程不耗
credits 但占资源,且 M2 被 967 round-4 gated 不 imminent）。保留零成本
测试面（serve.mjs 本地静态服务,无外联无 credits）:

- **/audition 声线试听页**:Tadashi（Eric 现役基线/Jason/Haoran/George）+
  Cass（Sarah 现役基线/Amy）同句逐字对比 + 英文跨语言样本,全部本地 mp3
  (flash 档,agent 实跑同款);声线终选完全不依赖 agent/脑/credits。
- **talk 页等待音本地演示**:不建会话——真 VAD + 真等待音,6s 模拟思考后播
  示例答案,零消耗体验完整等待音节奏;页面已挂脑离线提示横幅。
- **respin 路径** = evidence/m1-rig.md 复现命令(30 秒);M2 解锁时重建。

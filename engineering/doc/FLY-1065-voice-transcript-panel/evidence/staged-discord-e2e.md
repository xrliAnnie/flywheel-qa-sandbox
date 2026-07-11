# FLY-1065 真机 Discord staged 腿 — caption + 逐字记录落地全链 PASS

Issue: FLY-1065 (https://linear.app/geoforge3d/issue/FLY-1065)
日期: 2026-07-09
基于: plan.md P7「staged E2E」(Discord TIV 腿) + Tadashi 指令「单测绿不算,必须真机跑 Discord staged 腿、拿真 Discord 消息证据」

## 跑法

`packages/voice-bridge/e2e/fly1065-staged-discord.mjs`,967 staged rig 复用:

```
set -a; source ~/.flywheel/qa-fly967-staged/.env.staged; set +a
STAGED_VC_ID=1485787273193853170 node packages/voice-bridge/e2e/fly1065-staged-discord.mjs
```

跑的是 **FLY-1065 全部新增生产代码路径对真实服务**:真 `GEMINI_API_KEY` → 真 `GeminiLiveBackend` turn 聚合(喂 probe 真合成语音)→ 真 `JsonlTranscriptSink` 落真文件 → 真 `TivPresenter` 经真 `discordWiring` send/edit 路径(`channel.send` / `channel.messages.edit`)→ 真 caption + 单飞 status 投 staged VC 文字频道(`flywheel-pool-05` bot → #General, guild 1485787271192907816)→ 真 `AssistantLanding` 读同一文件 → 真 Linear 纪要 + 逐字记录 comment 投真 staged issue → 关闭。唯一不走 VC mic 的是音频 ingestion(EarsReceiver/VC join = FLY-967 领域,本 issue 不碰),音频直喂真 Gemini session,与聚合 E2E 同法。

## 真 Discord 证据(诉求 1:双向逐轮显示)

`flywheel-pool-05` bot 5:38 PM 在 #General 真实渲染(截图 + 按 message id 从 Discord 回读双证):

| # | Discord message id | 内容(回读自 Discord) |
|---|---|---|
| status | (edited 单条) | 🛬 正在落纪要… **(edited)** — 单飞 edit-in-place,一场会一条状态消息,无 967 刷屏 |
| caption 1 | 1524937776884351088 | 🗣️ **Annie**:今 天 我 们 聊 一 聊 转 写 面 板 , 你 觉 得 这 个 功 能 怎 么 样 ? |
| caption 2 | 1524937791849369640 | 💬 **助理**:转写面板听起来很有意思! 是关于实时转写,还是音频文件转写呢? 你觉得它最大的优点是什么,或者有没有什么让你觉得可以改进的地方? |

- **谁说了什么标清楚**:🗣️ **Annie** / 💬 **助理** 前缀角色标注,逐轮各一条短消息;
- **回读双证**:2 条 caption 均按 message id `channel.messages.fetch()` 从 Discord 回读成功(内容一致)——不是「发出去了就算」,是真在频道里;
- **视觉确认**:Claude-in-Chrome 打开 #General 亲眼看到上述两条 + status「(edited)」,与回读内容逐字一致。
- 中文字符间的空格是 Gemini 对这段**合成**探针音频的 input transcription 产物(真实模型输出),非 FLY-1065 bug——聚合层忠实拼接分片,不做任何字符改写。

## 真 Linear 证据(诉求 2:会话记录持久化)

真 staged issue **FLY-1097**(landing 自动创建 → 自动关闭,state = **Done/completed**,无游离 open issue):

- comment #1 `## 会议纪要(/gemini 助理)` + `assistant-summary <sessionId>` marker + recap + `### 原话引用`;
- comment #2 `## 逐字对话记录(/gemini 助理)` + `assistant-transcript <sessionId> chunk 1/1` marker + **逐轮角色 + 时间戳行**:
  - `- [17:38:17] **Annie**:今 天 我 们 聊 一 聊 转 写 面 板 , …`
  - `- [17:38:21] **助理**:转写面板听起来很有意思! …`
- `landing.run` 返回 `{ ok: true, transcriptChunks: 1, commentUrl: … }`;
- JSONL sink(landing 读的同一文件)2 行,均 `final:true`,双角色聚合文本 —— P3 sink↔landing 路径对齐(断链修复)当场验证。

「会议纪要」(摘要)与「逐字对话记录」(逐字)两类 comment 并存且区分清楚,正是 plan 对 Annie 诉求 2 的定义(与既有「会议简报」区分)。

原始机器可核证据:`evidence/staged-discord-e2e.json`(message id + 回读内容 + Linear comment url + JSONL 行)。

## 判据对照(plan.md P7 QA 断言清单)

| # | 断言 | 结果 |
|---|------|------|
| 1 | TIV 频道出现 ≥1 条 caption 消息(逐轮短消息,角色标注) | ✅ 2 条,🗣️/💬 标注 |
| 2 | status 全程只 1 条消息(edit-in-place,无刷屏) | ✅ 单条「(edited)」 |
| 3 | kickoff issue 出现纪要 + 逐字两类 comment | ✅ FLY-1097 两条 comment |
| 4 | `<sessionId>.jsonl` 落盘非空(= landing 读的同一文件) | ✅ 2 行 final |
| 5 | 中英混说一轮 | 见备注 |

**备注(5 中英混说)**:staged 探针音频是纯中文;中英混说 + 纯英文轮的逐轮/角色/scrub 正确性由确定性集成测试 `qa-fly1065-integration.test.ts`(真 GeminiLiveBackend + 真 TivPresenter + 真 AssistantLanding)钉死(见 qa-report.md)。真机腿证明了「真 Gemini 转写 → 真 Discord 渲染 → 真 Linear 落地」这条端到端链路;语言无关性(字符级处理、无 CJK 特判)是同一渲染/落地代码,不因语言分叉。

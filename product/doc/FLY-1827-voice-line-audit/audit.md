# FLY-1827 Voice 线历史挖掘 — 取证记录

Issue: FLY-1827 (https://linear.app/geoforge3d/issue/FLY-1827)
日期: 2026-08-17
基于: Linear (FLY-542 树 / FLY-906 / FLY-968 / FLY-1018 / FLY-1311 / FLY-1347 / FLY-1443 / FLY-1451 / FLY-1453) · 本仓代码与文档 · OpenAI / Google 官方文档

> 这份是 explainer HTML(`voice-audit.html`)的**出处台账**。HTML 里每一条声称在这里能找到来源。
> 红线遵守:**不给方向结论**。只摆「已知什么 / 已建什么 / 什么没定」。

---

## ① 历史打捞

### 时间线(可核)

| 日期 | 事件 | 出处 |
|---|---|---|
| 2026-03-10 | GEO-150 v0.4 Voice Interface(最早方向 doc) | `doc/engineer/exploration/new/v0.4-voice-interface.md` |
| 2026-06-24 | FLY-542 EPIC + 543~548 子树 | Linear |
| 2026-06-18 / 07-05 | FLY-342(DIY voice agent)/ FLY-883(realtime 选型 DR) | `engineering/doc/FLY-342-diy-voice-agent/`、`FLY-883-realtime-voice-research/` |
| 2026-07-06 | FLY-906 PRD v0.17 **Annie APPROVED**(10 轮共创) | `product/doc/FLY-906-voice-product-experience/prd.md` 抬头 |
| 2026-07-07 | FLY-968 三家真机横评定稿 | `engineering/doc/FLY-968-voice-model-bakeoff/bakeoff.md` |
| 2026-07-07→17 | 四条管线建成 + 真机 QA | `engineering/doc/FLY-1347-voice-measurement-pack/voice-measurement-pack.md` §0 |
| 2026-07-16→21 | FLY-1311 情报收集 + co-eval(推翻 PRD 两条) | FLY-1311 issue 描述括号段 |
| 2026-07-23 | FLY-1443 Codex realtime 探针 | `product/doc/FLY-1443-codex-realtime-probe/conclusion.md` |
| 2026-07-24 | FLY-1451 语音总管 EPIC + FLY-1453 安全前置 | Linear |
| 2026-07-24 后 | voice 功能代码零新增 | `git log -- packages/voice-*`:最后功能提交 `a5c012a40`(2026-07-17);其后仅 `e08c8d0a6`(FLY-1715 凭据隔离,08-13)与 `f3a27971e`(three-stage 清理,08-13)顺带触及 |
| 2026-08-10 | FLY-1311 Canceled(Linear 无原因) | Linear stateHistory |
| 2026-08-14 | 一批 voice-loop / huddle 立项 issue 批量 Canceled | Linear updatedAt 集中在 2026-08-14T23:4x |

### 被否决 / 被推翻的清单(重点)

| # | 被否的东西 | 理由 | 出处 |
|---|---|---|---|
| 1 | **gemini-cli** | Annie 原话「写的太差、千万不要抄」,从参考清单移除 | FLY-1018 issue 描述「gemini-cli 一票否决」 |
| 2 | **all-listen**(话同喂所有 Lead) | 10 轮 8 轮有人抢答,system prompt 压不住 → 这条路死 | FLY-968 bakeoff.md §0 问① |
| 3 | **per-Lead 常规语音频道** | R7 砍,改共享 Huddle VC + 动态成员 | prd.md v0.13 版本记录 + §18 |
| 4 | **早会 / 晚会** | R7 砍,v1 只做 Huddle 试跑 | prd.md v0.13 + §18 |
| 5 | **per-Lead 独立声线** | PRD §17 列为**硬需求** → 2026-07-21 co-eval 砍成「单声 + 身份报头」 | prd.md §10/§17/§18 **vs** FLY-1311 描述括号段。**两处冲突,PRD 未更新** |
| 6 | **优先级队列** | v1 纯 FIFO(Annie「先简单」红线);阻塞类被 FYI 淹的代价记进 Deferred | prd.md v0.12 + §18 |
| 7 | **一场一 issue / GitHub markdown 归档** | R8 改成:发起自动建立项 issue → 第一个被 @ 的 Lead 写 summary+action items → 关 | prd.md v0.15 + §18 |
| 8 | **Nova 2 Sonic / Hume** | 官方语言列表仍无中文,出局 | FLY-968 bakeoff.md §0 问② |
| 9 | **hermes-live-voice 整包搬** | beta v0.5 / 11 star,只借设计骨架 | FLY-1311 描述「纪律」段 |
| 10 | **脚本级 voice-control 安全** | 四条安全属性零实现;修 WRITE 后 review 发现 READ 不管(`cat ~/.ssh/id_rsa` 被当可信直接跑)。判死:改脚本补不上,要 OS 级隔离 | FLY-1453 issue 描述 |

---

## ② PRD 状态

### 有的

`product/doc/FLY-906-voice-product-experience/prd.md` — 42,231 字节,v0.17,**2026-07-06 Annie 最终 review 通过**。

段落齐全(实测 grep 标题):`problem` / `users` / `goals` / `non-goals` / `requirements` / `success metrics` /
能力边界与安全 / Part II 详细体验规格(§12 Discord 界面、§12.1 发起+拉人机制、§13 唤起与 Stop Word、
§14 action 三档、§15 latency 目标、§16 端到端 UX 流、§17 异步多-agent 语音模式含逐字 worked example)/
§18 Deferred / §10 build 映射 / §11 topic 树 / 完整版本记录(v0.5→v0.17)。

同目录另有 `exploration.md`(7KB)、`research.md`(19KB)、`huddle-review.html`。

### 过期的部分

PRD 锁的三条里至少两条已被推翻:
1. 命令名 `/meet`(R10 锁定)→ 代码 `DEFAULT_COMMAND = "glaw"`(`packages/voice-bridge/src/config.ts:117`)
2. per-Lead 声线 = 硬需求 → 7/21 co-eval 砍掉

### 没有的

- **「语音总管」FLY-1451 没有 PRD。** EPIC 描述里有 7 块 topic 树,状态自述「PRD 共创中,尚未拆单」,
  当前位置标在**第 1 块**(跟 Aunt Cass 的关系)。**不把 EPIC 描述当 PRD。**
- **FLY-1311 情报包没进 main。** `product/doc/FLY-1311-voice-qa-intel/` 在 `origin/main` 上不存在
  (`git ls-tree -r origin/main | grep -c FLY-1311` = 0);相关 commit(`d6e19a004` 等)只在
  `remotes/origin/rescue/FLY-1311-worktree-local-20260723`。

---

## ③ 建了多少(以代码为准)

### 代码规模(main)

| package | 源文件数 | 说明(取自 package.json description) |
|---|---|---|
| `packages/voice-core` | 65 | FLY-543 可插拔 voice skill core;dual-face(announce / converse)+ BrainAdapter |
| `packages/voice-bridge` | 106(+60 测试文件) | FLY-545 Huddle 常驻 Discord voice runtime;独立 launchd daemon,不属 Bridge 进程 |
| `packages/voice-headphone` | 16 | FLY-546 耳机模式 daemon(FIFO 队列 + turn 状态机) |
| `packages/gemini-agent` | — | FLY-1018 语音派活 agent |

`packages/voice-bridge/src/huddle/` 含 `GlawCommand.ts` / `HuddleSession.ts` / `ConclusionPipeline.ts` /
`AddressRouter.ts` / `ConfirmationLadder.ts` 等 —— PRD 设计的机制确实落成了代码。

### 四条管线状态(2026-07-17,FLY-1347 measurement pack §0)

| 管线 | 命令 | 状态 | 延迟基线 |
|---|---|---|---|
| 语音助理 | `/gemini` | ✅ SHIPPED+DONE,Annie 验收「一来一回正常」 | 开场首 chunk 0.76–0.80s;真人 speaking-end→response 0.86s |
| Huddle 会议 | `/glaw` | founder 真机 **FAIL ×2**,7 分钟死窗 | 比 /gemini 明显慢,未量化 |
| ElevenLabs | `/eleven` | 机器 PASS;Annie 真人 **FAIL**(barge-in 风暴) | 冷启 haiku 8.3s@load6-7 / 9.2s@load51;sonnet 3.6s / 5.2s;**真人 R1 1.5s → R2 28.5s 雪崩** |
| 语音派活 | `/gemini-advanced` | 代码 merged **default-off**;enablement 硬门未过 | 口头 ACK 8-12ms;深链几十秒到一两分钟 |

同 pack 记录的关键对照(干净 WAV vs Annie 真声):local barge-in「极少」vs「单场 8+ 次」;
延迟中位 6.4s vs 「R2 28.5s 雪崩」。→ **机器层绿不代表真人层绿。**

### 今天(2026-08-17)的部署状态 — 四条独立证据

1. `launchctl list | grep -i voice` → 只有 `com.apple.voicebankingd` / `VoiceOver` / `voicememod`,**无 flywheel voice job**
2. `ls ~/Library/LaunchAgents | grep -i voice` → **无** voice plist(该目录有 60+ 个 flywheel plist,唯独没有 voice-bridge 的)
3. `ps aux | grep voice-bridge` → 无进程;`curl http://127.0.0.1:9878/health` → 无响应
4. `grep -c huddle ~/.flywheel/projects.json` → **0**。voice-bridge 读的正是这个文件
   (`packages/voice-bridge/src/config.ts:127`),缺 `huddle` 块会 fail-closed 抛错
   (`config.ts:154`:"no project in projects.json has a huddle block")

**结论(可证伪)**:今天没有任何一条语音管线在跑,且配置未就绪。

### 一处不确定 — 明确标出

7 月的 huddle 立项 issue(FLY-1144 / 1146 / 1158 / 1169 / 1186 / 1196 / 1292)证明 `/glaw` 真跑过
且 PRD §12.0.4 的「自动建立项 issue」机制真生效。**但**参与者是 `ops-lead-test` / `flywheel-test-3`
(QA slot Lead);我检查的所有 7 月起 projects.json 备份(`bak-fly886-20260709`、`bak-fly1049-w5`、
`bak-fable-004038` 2026-07-25、`bak-fly1627` 2026-08-03、`bak-identity` 2026-08-13)**全部 huddle=0**。
另佐证:measurement pack §227 把 projects.json huddle 块记为「voiceChannelId **待定**、参会 Lead 名单待 Tadashi 拍」。
→ **没有证据表明它在生产配置上跑过。** 不做更强断言。

### FLY-1443 探针资产

`product/doc/FLY-1443-codex-realtime-probe/` 完整在 main:`conclusion.md`(25KB)+ `evidence/`(20 项:
C1/C2 全链 JSONL + 模型输出 WAV + D1/D2/D3 denial + E1 v1 + G1/G2 negative control + manifest)+ `probe.mjs` + `demo-voice.mjs`。

---

## ④ 7/23 结论的时效核查(2026-08-17)

### 逐条对照

| 7/23 原结论 | 今天 | 判定 |
|---|---|---|
| GPT-Live-1 全双工「活人感」档 —— **API 未开放**,只有消费端 App / Codex 集成 | **仍未开放**。OpenAI API 模型目录中无 `gpt-live-1`;官方口径「bringing GPT-Live-1 and GPT-Live-1 mini to the API soon」+ 报名表 | **没变** |
| `gpt-realtime` Realtime API GA 已久,任何 API key 可用,自然度差一档 | 仍成立,且**已换代**:现役 `gpt-realtime-2.1` / `gpt-realtime-2.1-mini`(OpenAI 官方 2026-07-06 公告,p95 延迟降 ≥25%);定价 $32/1M 音频输入、$64/1M 音频输出;上一代 `gpt-realtime` / `gpt-realtime-mini` 已 deprecated | **小变(更好)** |
| 我们的探针:V2 可用,V3 被 DENY | 未重跑,观察未过期。**但解读需更正,见下** | **要更正** |
| 差距是「接入权限」不是我们的 harness | 就 GPT-Live 而言仍成立(对所有开发者都未开) | **没变** |

### 7/23 之后的新增

- **2026-07-28 `gpt-live-transcribe` 进 API**(OpenAI changelog)。GPT-Live 家族第一个进 API 的成员,
  但**只做低延迟流式转写**,只支持 `v1/realtime/transcription_sessions` 端点,$0.017/分钟。
  **不是全双工对话模型。** 名字极易误读为「GPT-Live 开放了」。
- 同日另放出 `gpt-transcribe`(文件 + 已提交 Realtime turn 转写)。
- `gpt-realtime-2` / `gpt-realtime-Translate` / `gpt-realtime-Whisper`(2026-05-07 一代)仍在目录;
  Realtime API Beta 已于 2026-05-12 从 API 移除。

### ⚠️ 自我更正:「V3 = GPT-Live 全双工」这个等号没有证据支撑

7/23 给 Annie 的表里写「V3(= GPT-Live 全双工)被后端 DENY」。**原始 FLY-1443 报告并未如此声称。**

conclusion.md §2.3 明确把以下列为**不能下的结论**:
- ❌「卡的是 v3 版本本身」—— 理由:**v2 与 v3 的合法音色集不重叠**(v1/v3 用 `juniper maple spruce ember vale breeze arbor sol cove`;
  v2 用 `alloy ash ballad coral echo sage shimmer verse marin cedar`),因此该实验设计下**无法把 version 与 voice 隔离**。
- 报告原文的准确表述:「同一 client / 同一账号下,`v2 + marin` 的 text 与 audio 会话均成功;`v3 + cove` 的 audio
  会话在留档的 3 次尝试中均返回 access denial。**现有证据不能进一步归因。**」

**影响**:不改变「今天用不上 GPT-Live」(该判断由官方文档独立支撑)。但**「我们被拒的正是全双工那一档」这句话是无证据的**。
任何以「我们被 OpenAI 挡在全双工门外」为前提的方向决定,需先重验。

**另一条未做的 follow-up**(conclusion.md §4.5):Codex 二进制里存在一条 **API-key 身份的 realtime 路径**
(`core/src/realtime_conversation.rs` 的 `realtime conversation requires API key auth`),
本次全程走订阅身份(`auth.json` 的 `OPENAI_API_KEY` 为 null)。「换 API key 能不能开 v3」**从未验证**,
报告当时建议作为独立 follow-up —— 至今没做。

### 有没有第三条路

一手可确认的只有 Gemini;其余标注二手。

- **Gemini Live**(一手,Google 文档):我们已在用 `gemini-3.1-flash-live-preview`;
  Gemini 2.5 Flash Native Audio 已在 Vertex AI GA;2026 年加强函数调用与指令遵循;30 个 HD 声音 / 24 语言。
- **Moshi / Kyutai**(二手):开源全双工,<200ms,MIT;目前唯一开源亚-300ms 方案;**2026 年中仍仅英文**,
  多语言在做。同团队商业版 Gradium。
- **ElevenLabs**(我们自己的实测):首音 717ms,但 $4.8/小时 ≈ Gemini gated 方案的 7 倍(FLY-968)。
- **Qwen3.5-Omni-Realtime**:FLY-968 列为观察名单第一位(会话内克隆声线 + 中文最强先验),**本次未重核**。

---

## ⑤ issue 与代码不符之处(以代码为准)

| # | Linear / PRD 说 | 代码 / 事实 |
|---|---|---|
| 1 | PRD R10 锁定命令名 `/meet` | `packages/voice-bridge/src/config.ts:117` `DEFAULT_COMMAND = "glaw"`,注释「Annie-final ①: glaw = Gemini 耳 + Claude 脑」。PRD 未更新 |
| 2 | PRD §17 per-Lead 独立声线 = 硬能力要求 | FLY-1311 描述记 7/21 co-eval「单声 + 身份报头(砍 per-Lead 声线)」。PRD 未更新 |
| 3 | FLY-545 状态 = **Done**(2026-08-13 翻) | 其自身描述:「FOLDED INTO FLY-1160 / #555…不单独 ship、不单独跟踪」;最后有记录的 founder 真机结论 = **FAIL ×2**。Done 是记账,非「跑通」 |
| 4 | FLY-1311 = Canceled(2026-08-10) | 产出文档从未进 main,只在 rescue 分支;Linear 无取消原因 |
| 5 | FLY-547 = Duplicate、FLY-546 = Backlog | `packages/voice-headphone` 已有 16 个源文件在 main |

---

## ⑥ 未查清(诚实清单)

1. **FLY-1311 为何取消** —— Linear 无理由、无评论。
2. **`/glaw` 是否在生产配置上跑过** —— 证据只指向 QA slot,见 ③。
3. **7/24 之后线为何停** —— 只能确认「voice 代码零新增」这个事实;**停的原因查不到**,无任何 issue/文档写「暂停 voice」。
4. **Codex API-key 路径能否开 v3** —— 从未验证(需真配 key)。
5. **Qwen3.5-Omni-Realtime 今日状态** —— 本次未重核。

---

## 纪律

- 只读 + 写文档。未改任何生产代码、未改任何配置、未启动任何 voice 服务。
- 官方一手来源用于 ④ 的 OpenAI / Google 判定;二手来源已逐条标注。
- 未给方向结论(issue 红线)。explainer HTML 的结论区留空。

---

# 第 2 轮(2026-08-17)— Annie verdict passed=false 后的返工

## Annie 的反馈(逐字要点)

1. ③ 段准确:「差不多这就是我们之前做的程度」
2. **`/eleven` 可以直接立单删掉**,大概率不会用了
3. 剩下三条线暂时留着,之后看时候删 —— **因为大概率都会用 Codex 来做**
4. **「重心已经完全变到要用 Codex 来做这个东西」**;页面里 Gemini / glaw 都是「更老的内容」,Codex 是后期才聊的
5. 她问两个问题:**①「语音总管」具体用什么实现?②我对 Codex 那部分的认知停在哪?**
6. 她要的两件东西:**① Codex CLI 直接做语音总管(所有项目的总 CLI)② 用 Codex 去开会**

## 返工内容

整页重心从「老四条管线」翻转到 Codex 线;前两节正面回答她两个问题;老管线降级成「已建资产 + 她已定的处置」。

## 新增取证

### A. 语音总管的实现设想(答问题①)

四层地基,出处 FLY-1451 描述「为什么现在可以立项」段 + FLY-1443 conclusion.md:

| 层 | 内容 | 证据强度 |
|---|---|---|
| 耳朵+嘴 | Codex CLI 自己的 realtime 语音会话,不租 Gemini/ElevenLabs | 实测(C1/C2 全链) |
| 脑 | Codex 本身;语音链路挂在 agent 上,「说话→真执行命令→语音回报」 | 实测(FLY-1453 记 `item/commandExecution/outputDelta`,文件真落盘) |
| 身份 | Codex 当 Lead 已是既有生产模式 | 既有事实 |
| 进语音房 | 老 voice-bridge 的播音能力 | 既有代码 |

三条前提(报告自标)+ 一条未解前置:
- 验能力非稳定性(`realtime_conversation` = under development)
- 验 headless app-server,**非** CLAUDE.md 要求的生产 windowed TUI
- 不足以取消 Gemini/ElevenLabs fallback
- **FLY-1453 安全前置未解**:脚本级安全被判死(sandbox 只管写不管读;`approval_policy=untrusted` 让只读命令免审批 → `cat ~/.ssh/id_rsa` 直通),要 OS 级隔离;状态 Backlog 无人接

**产品层结论:没答。** topic 树 7 块停在第 1 块。上述四层是技术地基,不是产品设计。

### B. 我的认知边界(答问题②)

诚实声明:**不是「记得」,是本轮从文件 + Linear 挖的** → 认知严格等于系统里留存的东西。

Codex 语音全集 = **3 个单,全部创建于 2026-07-24**:FLY-1443(Done)/ FLY-1451(无 PRD)/ FLY-1453(Backlog)。
`list_issues query="Codex 语音"` 40 条结果内,7/24 之后无任何 Codex 语音新单。**7/24 → 8/17 三周多零新增。**

实物资产:conclusion.md(25KB)+ evidence/(20 项)+ `demo-voice.mjs`(麦克风进 / 出声回,参数锁死可用组合,用订阅登录不需 key)+ voice-control.mjs(已改危险警告版,commit `ff5b4c20a` 从 1443 PR 撤出)。

### C. 「Codex 出了语音功能」这个前提的核查(本机只读,零额度)

| 查什么 | 结果 |
|---|---|
| `codex --version` | `codex-cli 0.147.0` |
| `codex features list \| grep realtime` | `realtime_conversation  under development  false` |
| `codex --help \| grep -iE "voice\|realtime"` | 无输出(无 voice/realtime 子命令) |

**判定**:Codex CLI **没有**正式语音功能;有的是一个 under-development、默认关的实验开关。
我们实测过打开它能跑通 —— 但「实验开关能跑通」≠「有正式功能可排期」,协议随时可变。

**版本漂移(必须标)**:FLY-1443 验的是 `0.145.0`(manifest 内 sha256 `1da3f4e0…`),本机现为 `0.147.0`,
**跨两个版本未重跑**,且该 flag 正是最易变的 under-development 状态。
→ **「Codex 能跑通语音」今日未重新验证。** 重跑成本低(`probe.mjs` / `demo-voice.mjs` 现成),
但会消耗订阅额度并触及被争用的共享 codex symlink(conclusion.md §3.1 记录该 symlink 在反复摆动),
故**未自作主张执行**,已上报 Lead 由 Annie / Tadashi 决定。

> 另:尝试用 `codex app-server generate-json-schema` 做 0.147.0 的 schema 级复核,**Bash 权限被拒,未执行**。
> 不绕行、不据此下结论。

### D. 删 `/eleven` 的实测范围

| 项 | 实测 |
|---|---|
| 独立目录 | `packages/voice-bridge/src/eleven/` — 6 个源文件(`wiring/ElevenWs/ElevenCommand/landing/ElevenSession/config`) |
| 测试 | `src/__tests__/eleven-*.test.ts` × 6 |
| e2e | `e2e/eleven-staged.mjs`、`e2e/eleven-voice-loop.mjs` |
| 共享接线(需逐处拆) | 约 10 个文件:`VoiceRoomRuntime.ts` / `cli.ts` / `roomEars.ts` / `index.ts` / `brain/BrainPort.ts` / `assistant/GeminiCommand.ts` / `assistant/wiring.ts` / 相关测试 |
| 提及总量 | 429 行(voice-bridge + voice-core) |
| 凭据 | `~/.flywheel/.env` 的 `ELEVENLABS_API_KEY` 可一并撤 |

**判定**:主体是干净目录,但**不是纯删文件夹** —— 有十来处共享接线要拆。正常大小的活。

留着的三条线成本 ≈ 0:今天全部未运行(无 launchd job / 无进程 / `projects.json` 无 `huddle` 块 → fail-closed)。

### E. 建单纪律

Annie 说「eleven 可以直接立个单」。按 founder-facing 建单经 Lead 的规矩,
**未自行建单**,已把范围报 Honey Lemon,由他派。

## 第 2 轮未查清(累加)

6. **7/24 之后 Annie 口头聊过的 Codex 想法** —— 未落任何 issue/文档,我这边空白;需她下周补。
7. **0.147.0 上 realtime 是否仍可跑通** —— 未重跑(需授权 + 消耗额度)。
8. **0.147.0 app-server schema 是否仍含 realtime 类型** —— Bash 权限被拒,未执行。

---

# 第 3 轮(2026-08-17)— Annie 第二次 passed=false:「新 CoS」

## Annie 的反馈(逐字保存 —— 系统里查不到,这是唯一留档)

> 「B  新起一个 Codex 总管 这个东西 again,我不太记得了。你可能还是要看一下我们之前的 Linear、PRD 还有我们的聊天记录之类的。
>
> 我有跟你讨论过,说我们需要一个新的 COS。这个 COS 已经不单单是一个语音主管的角色,他是我们**所有项目的主管**。
> 他会知道我**所有项目的信息**,这样也可以帮助我去做一些 **prioritization** 的工作,但同时他也**兼顾语音主管**的工作。
>
> 这一部分讨论你还记得吗?」

**注意她开头的「B」** —— 她在回答 FLY-1451 topic 树第 1 块的选项:不是给 Aunt Cass 装嘴耳(A),而是**新起一个总管(B)**。

## 搜索结论:那次讨论无留档

搜索范围与结果:

| 搜索 | 结果 |
|---|---|
| Linear `query="CoS 跨项目 总管 prioritization"`(40 条) | 无「新起跨项目 CoS」的单 |
| Linear `query="Aunt Cass 总管 所有项目 主管"`(25 条) | 同上 |
| Linear `query="Codex 语音"`(40 条) | 只有 1443/1451/1453 |
| `grep -rn "新的 *CoS\|全局 CoS\|总 CoS\|所有项目的主管\|所有项目的 CoS"` 全仓 | **0 命中** |

**判定:Linear 与仓库中没有任何 issue/文档记录「新起一个管所有项目的 CoS」。**

⚠️ **真实盲区(必须声明)**:Annie 让我看「我们的聊天记录」。**我没有任何能读 Discord 历史消息的工具** ——
Linear MCP / 文件系统 / web 是我的全部。若该讨论发生在 Discord 且未落 issue/doc,**它对我不可见**。
这不是「没找到 = 不存在」,是「我的搜索半径不覆盖那里」。

## 找到的最接近的留档

| 出处 | 内容 | 与她说的差在哪 |
|---|---|---|
| **FLY-1451 topic 树第 1 块** | 「它是『Cass 装上嘴耳』还是**新起一个总管**?」标为「当前钻这块」 | **问题被记下来了,答案没记。她这次就是在答它。** |
| **FLY-1034**(7/08,Backlog) | CoS 经晨会学 founder **怎么派活**:节奏、依赖、什么先做后做。Annie 当时「不知道现在要不要做」 | 讲的是**现有 CoS 变聪明**,不是新起一个跨项目 CoS |
| **FLY-922 / FLY-1045** | 学 Annie 决策模式、逐步减 human-in-the-loop | 同族,范围不同 |
| **FLY-212**(北极星) | 「手机上的 Discord 就能操纵电脑上所有 process…敢离开屏幕」;FLY-1451 明确引用为上位目标 | 方向一脉相承,但没有「跨项目 CoS」这个角色 |

## 结构现状(本轮最有价值的硬事实)

实测 `~/.flywheel/projects.json`:

| 项目 | Lead 数 | CoS |
|---|---|---|
| flywheel | 5 | `flywheel-cos-lead`(Aunt Cass) |
| geoforge3d | 3 | `cos-lead`(Simba) |
| tidal-echo | 3 | `tidal-echo-cos-lead`(Triton) |
| growth | 3 | **无** |
| joycon-typeless | 1 | **无** |
| personal-assistant | 1 | **无** |

- **6 项目 / 16 Lead / 仅 3 个 CoS**;半数项目无 CoS
- **每个 CoS 的 scope 都是单一项目** —— 无任何跨项目角色
- 唯一跨项目 surface = `#leads-roundtable`(`packages/teamlead/lead-rules-base/cross-dept-channel-rules.md`,
  channel ID `1512578695468941333`),但它是**Lead 互相协调的频道,不是持有全局视图的角色**

→ **她描述的那个位置,今天是空的。** 这是对她说法的结构性印证(不是方向建议,是现状描述)。

## 本轮动作

- v3 页面重写:围绕这一问,前两版内容压缩下沉
- **她这段话逐字存进本文档** —— 因为系统里没有,这是唯一留档;已请 Lead 补进 FLY-1451
- 我对她话的三点解读(范围从「语音入口」→「跨项目主管」/ 新增 prioritization 职责 / 选 B 新起而非改造 Cass)
  已放进页面请她校正

## 旁记

Honey Lemon 已按第 2 轮报告建单:**FLY-1843**「[Voice·清理] 删掉所有 ElevenLabs 相关逻辑(Annie 直令)」,Backlog。

## 第 3 轮未查清(累加)

9. **那次「新 CoS」讨论的原文** —— 若在 Discord,我读不到;已请她给时间锚点由 Lead 代捞。

---

# 第 4 轮补录(2026-08-17)— 对 FLY-1443 §2.3 的一处更正(报告自身有误,我第一轮照抄了)

> 触发:Lead 导出本机 app-server schema,发现 `RealtimeVoice` 是一张平铺 enum(cove 与 marin 同表),
> 据此推断「v2/v3 音色集不重叠」站不住、v3 被拒的归因不可靠。**结论方向对,理由不成立;而真正的证据在我们自己的 evidence 里。**

## ① schema 推理为什么不成立

音色名单**不是**从 schema 或 binary strings 推的,是探针**运行时调 API** 拿回来的。
`evidence/A-v3-marin-LOCAL-voice-validation-failure.jsonl` 逐字:

```json
{"method":"thread/realtime/listVoices"} →
{"voices":{"v1":["juniper","maple","spruce","ember","vale","breeze","arbor","sol","cove"],
           "v2":["alloy","ash","ballad","coral","echo","sage","shimmer","verse","marin","cedar"],
           "defaultV1":"cove","defaultV2":"marin"}}
```

schema 的 `RealtimeVoice` 是**类型**(所有音色名的并集);per-version 合法性是**另一张运行时表**,
且本机真的按它拦截(实验 A:`marin` + `v3` 被本地挡下 `realtime voice 'marin' is not supported for v3`,未到后端)。
→ **拿类型定义当运行时约束 = 近似检查,证不了这件事。**

## ② 真正干净的对照 —— 报告自己漏了

conclusion.md §2.3 断言「无法把 version 与 voice 隔离」,理由是 v2/v3 音色集不重叠。
**它只比了 v2 vs v3,漏了 v1 vs v3 —— 而报告自己在 §3.3 写明 v1 与 v3 共用同一组音色。**

逐字对照(从 evidence 直接核):

| 运行 | `thread/realtime/start` params | 结果 |
|---|---|---|
| **E1** | `{transport:websocket, outputModality:audio, voice:"cove", version:"v1"}` | **收到 `thread/realtime/started`(后端准入)**,之后才因 `Quicksilver sessions require WebRTC.` 失败 |
| **D3** | `{transport:websocket, outputModality:audio, voice:"cove", version:"v3"}` | **0 个 `started`**,直接 `Voice session access denied.` |

**四个参数三个逐字相同,只有 `version` 不同。** 且两次 manifest 三项 hash 全等:

| | E1-manifest | D3-manifest |
|---|---|---|
| `codexSha256` | `1da3f4e0…` | `1da3f4e0…` |
| `probeScriptSha256` | `6f7599cc…` | `6f7599cc…` |
| 输入音频 `sha256` | `e3944fb4…` | `e3944fb4…` |

→ 同一二进制、同一探针、同一输入。**voice 被控住,version 被隔离。**

**结论**:「卡的是 v3 这个版本(对这个账号、这个客户端)」**现在是有证据的** —— 支撑它的是 E1/D3,不是 schema。
(仍不能推到「服务端按账号 gate」这一层 —— 那需要换账号/换身份的对照,见下。)

## ③ 我要再更正我自己一次(两件事必须分开)

- ✅ **仍然成立**:「v3 = GPT-Live 全双工」那个等号**没有证据** —— 产品名 → 协议版本的映射谁都没验过。第 1 轮的更正不变。
- ❌ **要更正**:我第 1 轮引用报告说「不能把 version 与 voice 隔离」—— **报告这句是错的,我照抄了**。
  我把上游报告当权威、没自己复核它的推理,这是我的错。

## ④ 对 FLY-1844(Codex 语音总管落地研究)的实际影响

- **「拿本账号直接试 v3、抄拒绝原文」已经做过 3 次** —— D1/D2/D3,三个不同 thread,原文逐字留档;
  D3 还是 event-driven 的干净版(输入前即中止,0 个 `appendAudio`)。**不用重做,直接读 evidence。**
- **真正没做过的是 §4.5 那条:换 API-key 身份试 v3。**
  二进制内有 API-key 的 realtime 路径(`core/src/realtime_conversation.rs` → `realtime conversation requires API key auth`);
  本次全程订阅身份(`auth.json` 的 `OPENAI_API_KEY` = null),而订阅身份在 v1/v2 都拿得到准入
  → 「realtime 需要 API key」已被证伪,但「**API key 能不能开 v3**」**从未验证**。报告当时即建议作为独立 follow-up。
- **版本漂移**:上述结论全部基于 `0.145.0`;本机现为 `0.147.0`,未重跑。

> 本轮未改任何代码、未重跑任何探针。以上全部由「读既有 evidence + 核 manifest hash」得到。

---

# 📌 可直接引用块(给 FLY-1844 / 给 Annie)

> 下面两块是自足的,引用时整块拷走即可,不需要回读上下文。

## 引用块 A — E1 vs D3:version 与 voice 已被隔离

> # 🔴 2026-08-17 更正 —— 本块结论已被 FLY-1844 超越,请连这句一起拷走
>
> **v3 从来没有被拒。** 真正原因是**传输层敲错门**:二进制里写着 **v1/v3 走 WebRTC、v2 走 websocket**,
> 而 FLY-1443 全程只试了 websocket。用 websocket 要 v3,服务端回的 `Voice session access denied.`
> 是**协议不匹配的误导性报错,不是权限问题**。
> FLY-1844 用真 WebRTC 栈递 SDP offer,**v3 当场就通,在 `0.147.0` 上复现两次**。
>
> **本块下面的方法学只在一个很窄的范围内成立**,而且**这个范围不足以承重** ——
> E1/D3 确实控住了 voice、隔离出了 `version`,但**没有隔离 `transport`**:
> **两次都固定用 websocket,而 websocket 对 v1 和 v3 都不是它们该走的路。**
> 所以这组对照能支持的,只到「**在 websocket 这条路上**,v3 被拒、v1 拿到一个走不完的准入」;
> **支持不到「这个账号被挡在 v3 门外」。** 请不要用它论证账号/权限层面的任何事。
>
> 更糟的是**这个 regime 本身不稳定,不适合承重**:E1 的同一组参数在 `0.145.0` 上拿到 `started`
> 之后死于 `Quicksilver sessions require WebRTC.`,而在 `0.147.0` 上**连 `started` 都没有,报的是另一句话**。
>
> **✅ 承重对照请改用 FLY-1844 的两组**(它们才是干净的):
> - **P1 vs P6** —— 只差 `transport`
> - **P8 vs P6** —— **在对的 transport 上**只差 `version`
>
> 「被拒的是 v3 这个版本本身」这句**结论已作废** —— 决定成败的是 transport。
> 详见本块末尾「结论」下的更正段。

### ⚠️ 这条推翻的范围(先读这句)

**本条推翻的是 FLY-1443 `conclusion.md` §2.3 的一句推理,不是推翻整份报告。**
该报告的实验、原始报文、manifest、hash 全部照常可信 —— 事实上本条**正是用它自己的 evidence 得出的**。
被推翻的仅是「本次实验设计下无法把 version 与 voice 隔离开」这一句。**其余结论不受影响。**

### 对照表

| 运行 | `thread/realtime/start` params(逐字) | 结果 |
|---|---|---|
| **E1** | `{"transport":{"type":"websocket"},"outputModality":"audio","voice":"cove","version":"v1"}` | **收到 `thread/realtime/started`** → 后端准入;之后才因 transport 失败 |
| **D3** | `{"transport":{"type":"websocket"},"outputModality":"audio","voice":"cove","version":"v3"}` | **0 个 `started`** → 直接 error |

**四个参数中三个逐字相同,只有 `version` 不同。**

### 两句原文(逐字)

```
E1  {"method":"thread/realtime/started","params":{"threadId":"019f91f8-7e11-7f60-a30c-ca4cf77a3d64",
     "realtimeSessionId":"019f91f8-7e11-7f60-a30c-ca4cf77a3d64","version":"v1"}}
    (随后) {"method":"thread/realtime/error","params":{"message":"Quicksilver sessions require WebRTC."}}

D3  {"method":"thread/realtime/error","params":{"threadId":"019f91cc-3e70-7430-9ff1-ee743fe2998c",
     "message":"stream disconnected before completion: Voice session access denied."}}
```

### 三个 hash(证明是同一次可比条件)

| | E1-manifest.json | D3-manifest.json |
|---|---|---|
| `codexSha256`(二进制) | `1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590` | 同左 |
| `probeScriptSha256`(探针) | `6f7599cc046f8de31307f1744755e87e69fc53a438c966cf5bdecc11c5a02fb4` | 同左 |
| 输入音频 `sha256` | `e3944fb44092ffd3f27238475f196a2ae10b0426f5e117cb48a41c08b4f6081a` | 同左 |

`codexResolved` 两次均为 `~/.codex-infra-bot/packages/standalone/releases/0.145.0-aarch64-apple-darwin/bin/codex`。

### 为什么原报告漏了它

§2.3 的理由是「v2 与 v3 的合法音色集不重叠」—— 但它**只比了 v2 vs v3**。
报告自己在 §3.3 写明 **v1 与 v3 共用同一组音色**(`juniper maple spruce ember vale breeze arbor sol cove`,默认 `cove`),
所以 v1 vs v3 天然可以固定 voice。**手里已有的对照被漏掉了。**

### 顺带:为什么不能用 schema 走到同一结论

`RealtimeVoice` 在 app-server JSON schema 里是**类型**(所有音色名的并集,cove 与 marin 同表)。
per-version 合法性是**另一张运行时表**,由 `thread/realtime/listVoices` 返回,且本机真的按它拦截:

```json
{"voices":{"v1":["juniper","maple","spruce","ember","vale","breeze","arbor","sol","cove"],
           "v2":["alloy","ash","ballad","coral","echo","sage","shimmer","verse","marin","cedar"],
           "defaultV1":"cove","defaultV2":"marin"}}
```
(出处 `evidence/A-v3-marin-LOCAL-voice-validation-failure.jsonl`;实验 A 用 `marin`+`v3` 被**本地**挡下,未到后端)

→ **类型定义 ≠ 运行时约束。** 用 schema 回答这个问题是近似检查。

### 结论(注意边界)

> 🔴 **2026-08-17 更正(FLY-1844 实测)**:下面这两行写于该实验之前,**第一行已作废**。
> 实际原因是 **v3 需要 WebRTC 而本次全程用 websocket** —— `Voice session access denied.`
> 是传输层协议不匹配的误导性报错,不是权限。真 WebRTC + SDP offer 下 **v3 在 `0.147.0` 上可用,复现两次**。
> 第二行(⛔ 那条边界)**仍然成立且是对的** —— 正是它挡住了「去换 key / 换账号层级 / 排 waitlist」这条错路。
>
> 🔴 **追加 caveat(FLY-1844 的 runner 纠出)**:E1/D3 **隔离的是 `version`,不是 `transport`** ——
> 两次都固定 websocket,而 websocket 对 v1 与 v3 都是错的路。因此这组对照
> **不能用来支持「这个账号被挡在 v3 门外」**,它只覆盖「在 websocket 这条路上会怎样」。
> 承重对照请用 FLY-1844 的 **P1-vs-P6**(只差 transport)与 **P8-vs-P6**(在对的 transport 上只差 version)。

~~✅ 「在这个客户端、这个账号下,被拒的是 `v3` 这个版本本身」现在有证据。~~ ← **已作废,见上**
⛔ **仍不能推到「服务端按账号 gate」** —— 那需要换账号 / 换身份的对照,本次没有做。**(这条成立)**

**回头看:线索一直在 E1 里,是我没走完最后一步。** E1(v1 + websocket)拿到 `started` 之后收到的正是
`Quicksilver sessions require WebRTC.` —— 而 v1 与 v3 不只共用音色组,**也共用 WebRTC 这个传输要求**。
我把那句读成了「v1 特有的怪癖」,没把它接到 v3 上。**控制变量做对了,机制只差一步没追到;
而机制的证据,就在我当时正在读的同一个文件里。**

---

## 引用块 B — §4.5:换 API-key 身份试 v3(唯一没做过的实验)

### 已被实测证伪的假设

「realtime 需要 API key」—— **假的**。本机 `auth.json` 的 `OPENAI_API_KEY` 全程为 `null`
(`auth_mode=chatgpt`,plan=pro),纯订阅身份实测:

| version | 准入 | 说明 |
|---|---|---|
| v1 | ✅ | `started` 已发出,之后因 transport 不符失败 |
| v2 | ✅ | 全链跑通 |
| v3 | ❌ | `Voice session access denied.` ← 🔴 **2026-08-17 更正:这不是权限拒绝,是 v3 需要 WebRTC 而本次用了 websocket;FLY-1844 用真 WebRTC 后 v3 在 0.147.0 上通了** |

**订阅身份在 v1/v2 都进得去** → 「必须 API key」不成立。
🔴 **2026-08-17 追加**:v3 既然在**订阅身份 + 正确 transport** 下就能通,
本块 B 原本要做的「换 API-key 身份试 v3」**已失去其原始动机**(它是为了解释一个并不存在的权限拒绝)。
是否仍需要 API-key 路径,请按新的问题重新界定,不要照着下面的旧动机开工。

### CLI 里确实另有一条 API-key 路径

二进制内两条只可能属于 API-key 路径的错误串,带源文件名:

```
core/src/realtime_conversation.rs   realtime conversation requires API key auth
                                    invalid realtime api key header
```

realtime 的参数/上下文字段簇里 `apikey` 与 `chatgptAuthTokens` **并存**;两个 endpoint 形态都在:

| endpoint | 身份 |
|---|---|
| `/v1/realtime` | 公共 API(API-key) |
| `/backend-api…realtime/calls` | ChatGPT 后端(订阅) |

**这两条串在 FLY-1443 全部实验中一次都没触发过** —— 与上表一致:我们走的是订阅那条路。

### 因此没做过的实验

**「API-key 身份能不能拿到 v3」= 完全未验。**
FLY-1443 当时按硬约束**没有**配 key、**没有**动任何凭据,并明确建议作为独立 follow-up。
两周前 FLY-968 横评里 OpenAI Realtime 胜出的那条路若走的是 API 身份,则**与本次被拒的维度不同**,
本次结果**不能**用来否定它。

### 开工前必读的两条环境事实

1. **版本漂移**:上述全部结论基于 `codex-cli 0.145.0`;**本机现为 `0.147.0`,未重跑**。
   且 `realtime_conversation` 仍是 `under development` + 默认 `false`(2026-08-17 实测)。
2. **`~/.local/bin/codex` 是被争用的可变 symlink**(conclusion.md §3.1 记录其在实验期间反复摆动)。
   复现请 pin versioned 绝对路径,不要依赖它。

### 已经做过、不要重做的

**「拿本账号直接试 v3、抄拒绝原文」已完成 3 次** —— `evidence/D1-` / `D2-` / `D3-`,三个不同 thread,
参数均 `version:"v3"` + `voice:"cove"` + `outputModality:"audio"`,均未收到 `started`,原文逐字留档。
**D3 是 event-driven 的干净版**(等 `started|error`,失败即中止,**0 个 `appendAudio`**)。
直接读 evidence 即可,无需重跑。

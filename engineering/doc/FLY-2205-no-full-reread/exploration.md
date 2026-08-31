# FLY-2205 插嘴后旧稿不整篇重念 — 探索
Issue: FLY-2205 (https://linear.app/geoforge3d/issue/FLY-2205/raya语音-插嘴后旧稿重念一遍被打断的内容不该从头再来)
日期: 2026-08-31
基于: 无(上游输入为 FLY-2031 QA verdict6 follow-up 表第 2 条、她 2026-08-31 的 90 秒实录、FLY-2178 设计文档)

> 成色标记:✅ = 有原件可核;🔶 = 推断/占位,一被纠正即作废;⬜ = 未知。
> 世界标记:[raya-main] = raya `origin/main` `1c71cd2`(raya#9 FLY-2031 rework 已合,当前产品 = 逐轮对话 + VoiceTextMirror,无自定义打断层);[qa] = `~/.flywheel/artifacts/FLY-2031-qa/`。

---

## 0. 本单是什么、从哪来

FLY-2031 QA 期间,founder 真人实录抓到:她插嘴打断 Raya 念读后,被打断的那条稿子之后会**从头整篇重念**——她已经听过的部分再来一次。她当场追问「why?」。verdict6 follow-up 表第 2 条(✅ [qa]/verdict6.txt:43):

> 【重念循环】ship 卡被拒后从头整条重念。她 08-31 亲身实录:90 秒内整卡念 3 遍,每遍都带编号,撞在她「说太多 / 一串数字听不懂」两个痛点上。建议重复上限或改短提示。

她对紧邻单 FLY-2178 的语义定义(issue 原文引用,✅):**「当前这轮停了就停了,等我说完新问题进下一轮」**——被打断的那轮就此结束,不许它以「从头再来一遍」的形式还魂。

⇒ 本单回答一个问题:**念读被打断/未确认之后,旧稿再次交付时该念什么**。issue 给出三个可接受形态(设计段定):从断点附近继续 / 只补要点 / 直接作废进下一轮。

## 1. 尸检:重念今天从哪来([raya-main] 逐机制,全部有原件)

### 1.1 机制 A:ship 卡「武装后被打断」环 —— 无上限、无退避(她实录的那个)

她 90 秒实录的逐事件时间线(✅ [qa]/founder-r3-final-snapshot/state/voice-evidence/events.jsonl):

| 时刻 (UTC) | 事件 |
|---|---|
| 02:38:54.949 | `speech_injected ship:…:prompt`(第 1 遍整卡) |
| 02:39:00.295 | `ship_gate_armed` |
| 02:39:29.799 | `ship_gate_context_interrupted{reason:unrecognized_founder_final}`(她开口,不是确认/不批词) |
| 02:39:32.068 | 拒绝旁白注入(「这次语音批准没有通过…」) |
| 02:39:33.239 | `speech_injected ship:…:prompt`(**第 2 遍整卡,距打断 3.4 秒**) |
| 02:39:39.036 | `ship_gate_armed` |
| 02:40:11.948 | `ship_gate_context_interrupted{reason:unrecognized_founder_final}` |
| 02:40:12.453 | `speech_injected ship:…:prompt`(**第 3 遍整卡**) |
| 02:40:14.450 | `inbox_speech_retry_scheduled`(attempts 记账**第一次**出现) |
| 02:40:49.461 | `ship_gate_invalidated{event:HumanLeft}`(她离房) |

机制(代码级,✅):armed 之后任何非确认/不批的 founder 发言、任何 assistant final、任何其它 speech 注入 ⇒ `ShipGateFlow` 只 `clearArmed` + 记 `ship_gate_context_interrupted`(`ShipGateFlow.ts:210-307`),**不写 ack、不进 attempts 记账** ⇒ 条目仍活 ⇒ 下一轮 poll(`inboxPollMs` 默认 1s)重新走 `prepare()` ⇒ **整卡从头再念**(`shipPrompt` 三句含 issue 编号 + PR 号中文数字,`ShipGateFlow.ts:116-127`)。`MAX_ATTEMPTS_PER_SESSION=2` 与 60s 退避只覆盖 `prepare()` 内部失败返回的 `"retry"`(`InboxReader.ts:179-196,296-334`),**覆盖不到这个环**。

⚠️ qa attempt 6 的宽容匹配(「确认认」→approve)只收窄了「近似确认词被误判 unrecognized」这一个触发,**环本身原样还在**:她问一句别的、Raya 答一句话,都会重启整卡。

### 1.2 机制 B:inbox 念读的 attempt 链 —— 有上限,但每次都是全文重念

她在念读中开口 ⇒ 确认回调看到插话即判不确认(`InboxReader.ts:42-45`:`entriesAfter(afterId)` 里有 user entry ⇒ `false`)⇒ `noteAttemptFailure` ⇒ 60s 后第 2 次注入 ⇒ `renderInboxSpeech` **重新渲染全文**(what+why+next 三段 + 续接句,`SpeechBrief.ts:57-81`)⇒ 再失败即 `deferred{attempt_cap}`,无终态 ack,下场 at-least-once 整篇重播。FLY-2178 research §1 已确认:「自然重叠说话在今天也会(慢速地)吃掉条目」——吃掉之前,先把她听过的部分再念一遍。

### 1.3 断点今天就可观测(不用新增声学信号)

- `Speaker` 逐 chunk 注入、逐 chunk 确认,`SpeakerResult.chunks[]` 带每 chunk 的 `confirmed/confirmedById`(`Speaker.ts:35-45,369-377`)。但 `briefingChunkChars` 默认 1400(`config.ts:512-517`),而 speechBrief 三段各 ≤200 code points ⇒ **念读稿几乎总是单 chunk**,chunk 粒度≈全有全无。
- 更细的断点在 transcript:被截断的 assistant final 文本就是「已念出的前缀」。`confirmationFor` 已经在做 `comparableSpeech` 归一化包含比对(`InboxReader.ts:46-69`)——同一套归因机制可以回答「三段里哪几段已被完整念出」。FLY-2178 R6-1 也把「前缀归因」定为运行时归因原语。⇒ **段落(what/why/next/卡片句)粒度的断点是结构可得的,零新声学机制、零阈值。**

## 2. 三个候选形态(issue 给定)与取向

| 候选 | 说明 | 反面 |
|---|---|---|
| F1 从断点附近继续 | 再交付时只念**未被覆盖的段落**起(段落 = speechBrief 三段/卡片句,句末终止符是既有校验合同),带一句跨度外续接语 | 断点归因依赖 assistant final;final 缺失(FLY-2159 形态)时退化为全篇——退化态 = 今天的行为,不更坏 |
| F2 只补要点 | 再交付时只念 what 段 + 「详细的在文字区」 | why/next 永久丢失在语音道;文字区兜底但她开车/走路时看不了;比 F1 激进,信息有损 |
| F3 直接作废进下一轮 | 本 session 不再念,无终态 ack,下场重播 | 「下场重播」仍是全文重念,只是换了时间;且 needsDecision 条目会静默滞留到下场——她今天想批的事今天听不到 |
| F0 维持现状 | — | ⛔ 她实录 + 当场追问,已判死 |

⭐ 取向:**F1 为默认**(段落粒度续念,带续接语),F2/F3 做成同一策略开关的可选值,founder HTML 决策点让她选。三者共享同一断点归因原语,差别只在「回来时念多少」。

ship 卡另有一层:卡片已经**完整确认交付过一次**之后的重武装(机制 A),连 F1 都不该走——那不是「续」,是「催」。取向:**重武装不重念**,拒绝旁白/重武装提示带一句短卡(标题+编号一句话),并给重武装环补上有界性(cap + 记账)——verdict6 的原话建议就是「重复上限或改短提示」,两个都要。

## 3. 与紧邻单的边界(issue 钉死,本单不许越)

| 单 | 它管什么 | 本单与它 |
|---|---|---|
| FLY-2178(插嘴即停,implement 2/7,C3 未动工) | 停得下来:停口、假 VAD 免疫、条目命运四值仲裁、**何时**回来(空闲门/队尾/下场) | 本单只管**回来时念什么**(内容策略)。2178 plan D3/D15 现文写死「恢复注入 = 恢复前缀 + 原三段」——本单落地后该渲染改走本单的续念渲染,设计段给出单一渲染原语供两单共用;实现互不阻塞,QA 联测 |
| FLY-2159(恢复通道,implement 5/6) | 上游间歇无 assistant final 的恢复 | 不碰。本单断点归因**依赖** final 存在;final 缺失时按「零覆盖」退化为既有行为 |
| FLY-2203(外部仓 ship 铁律) | — | 改动全部在 raya 仓;ship 走 flywheel 主仓锚 PR,`complete --pr` 只登记锚 PR 号(verdict7 血训) |

不动的合同:ack 终态四值(spoken/filtered/expired/text_fallback)与 at-least-once 重播;确认跨度语义(续接语在跨度外,正文在跨度内——沿用 2178 R1-9 已定规则);ship 词表与宽容匹配;武装/cue 时序(qa⑥ ② 已验);20ms 常开流与 R16 硬门;⛔ 不新增任何阈值数字(新增量全走 `RAYA_VOICE_OPTIONS_JSON`,默认值 🔶)。

## 4. 待 founder / Lead 的问题

- Q1(founder,HTML 决策点,非阻塞):被打断的念读稿回来时,默认「从段落断点继续」还是「只补要点」还是「作废等下场」?🔶 推荐:从段落断点继续。
- Q2(founder,HTML 决策点,非阻塞):ship 卡重武装的短卡一句话里,要不要保留标题(「刚才那张卡:『标题』,X 单、PR 几,要批就说确认,不批就说不批」)?🔶 推荐:保留标题+编号。
- Q3(设计内已答):跨 session 的 at-least-once 重播保持全文——那是崩溃恢复合同,不是本单的「这轮体验」;写进诚实边界。

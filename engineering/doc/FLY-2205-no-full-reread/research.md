# FLY-2205 插嘴后旧稿不整篇重念 — 调研
Issue: FLY-2205 (https://linear.app/geoforge3d/issue/FLY-2205/raya语音-插嘴后旧稿重念一遍被打断的内容不该从头再来)
日期: 2026-08-31
基于: exploration.md

> 世界标记:[raya-main] = raya `origin/main` `1c71cd2`;[2178] = `~/Dev/flywheel-FLY-2178/engineering/doc/FLY-2178-bargein-redesign/`(设计已过评审,implement 2/7,C3 未动工);[2159] = FLY-2159 设计文档;[qa] = `~/.flywheel/artifacts/FLY-2031-qa/`。
> 本文只记能被重读/重跑核实的事实;方案取舍在 plan。代码行号以 [raya-main] 为准。

---

## 1. 重念的完整机制清单 [raya-main]

### 1.1 ship 卡:两条重念路径,只有一条有界

| 路径 | 触发 | 有界性 | 出处 |
|---|---|---|---|
| **prepare 内失败** → `"retry"` | binding/context/card 取不到、`prompt_not_confirmed`、`prompt_cursor_missing`、audible-tail 期间有 transcript、cue 失败族 | ✅ `MAX_ATTEMPTS_PER_SESSION=2` + `inboxRetryBackoffMs`(默认 60s),超限 `deferred{attempt_cap}` | `ShipGateFlow.ts:339-472`;`InboxReader.ts:87-88,179-196,296-334` |
| **armed 后被打断** → `clearArmed` | `unrecognized_founder_final` / `non_founder_final` / `assistant_final` / `speech_injected` / `transcript_order_lost`(`observe`/`observeSpeechInjection`)+ `arm_expired`(180s 定时器) | ❌ **零记账零退避**:不写 ack、不进 attempts ⇒ 下一轮 poll(`inboxPollMs` 默认 1s)整卡重走 `prepare()` | `ShipGateFlow.ts:210-307,717-725`;实录时间线见 exploration §1.1 |

整卡 = `shipPrompt()` 三句(标题句 + 「走到门口」句 + 编号句:issue identifier + PR 号中文数字)+ audible-tail 等待 + cue 句(`SHIP_APPROVAL_CUE`)。`ShipGateFlow.ts:116-127,22`。

她 90 秒实录里三遍整卡全部走第二条路径:两次 `armed → unrecognized_founder_final → 3.4s/0.5s 后重念`;attempts 记账直到第三遍 prompt 被新 final 判 unconfirmed 才第一次出现(`inbox_speech_retry_scheduled` @ 02:40:14,nextAt = +60s)。✅ [qa]/founder-r3-final-snapshot events.jsonl。

⚠️ 实录跑的是修复前 build(「确认认」被判 unrecognized 是当时的触发点);1c71cd2 的宽容匹配(qa⑥④)收窄了这个触发词,但**环形不变**:armed 后她问任何别的话、或 Raya 产出任何 assistant final(比如回答她),都重启整卡。

### 1.2 inbox 念读:attempt 链有界,但每次全文

- 确认回调:注入游标(`afterId`)之后出现**任何 user entry** ⇒ 该 chunk 判不确认(`InboxReader.ts:41-45`);assistant finals 归一化后不覆盖期望跨度也判不确认(`:46-62`)。
- 不确认 ⇒ `noteAttemptFailure`:第 1 次后 `nextAt = now + 60s`;第 2 次后 `deferred{attempt_cap}` + needsDecision 条目发一次文字兜底通知(`:296-334`)。
- 重试时 `renderInboxSpeech(item, remaining)` **无条件全文重渲染**:what+why+next 三段拼接 + 续接句尾(`SpeechBrief.ts:57-81`),`confirmStart=0, confirmEnd=全文`。
- 无终态 ack 的条目下一 session 重播(at-least-once):`runPoll` 只按 `acks` 判终态(`InboxReader.ts:170-175`)。

### 1.3 断点可观测性:三层,只有 transcript 层够细

| 层 | 粒度 | 现状 |
|---|---|---|
| `SpeakerResult.chunks[]` | chunk(`confirmed`/`confirmedById`/`afterId` 每 chunk 都有) | ✅ 已返回给调用方(`Speaker.ts:35-45,369-377`),但 `briefingChunkChars` 默认 1400(`config.ts:512-517`),speechBrief 三段各 ≤200 code points(`SpeechBrief.ts:21,43-45`)⇒ 念读稿几乎总是**单 chunk** |
| TranscriptLog assistant finals | 字符级(截断 final 的文本 = 已念出内容) | ✅ `entriesAfter(afterId)` 现成;`comparableSpeech` 归一化(NFKC + 只留字母数字)已在确认路径使用(`InboxReader.ts:65-69`) |
| 音频层 | 帧级 | ⛔ 不用。她「听到哪」在本机只能由 transcript 近似;2178 的 P-A0 分离性探针管音频/转写对齐,本单不重复 |

**顺序覆盖归因(本单核心原语)的结构可行性**:段落序列(speechBrief 的 what/why/next)逐段做 `comparableSpeech` 包含匹配,且每段的匹配起点 ≥ 前一段匹配终点(顺序约束);第一个未命中的段 = 断点段。零阈值、零声学、纯文本;与 2178 R6-1 定下的「前缀归因」原语同族。已知限制:
- final 缺失(FLY-2159 间歇形态)⇒ 归因得到零覆盖 ⇒ 退化为全文——**退化态 = 今天的行为**;
- ASR/模型改写(paraphrase)⇒ 段落判未覆盖 ⇒ 宁可多念不少念,方向安全;
- `comparableSpeech` 目前是 `InboxReader.ts` 模块私有函数,需提为共享 helper(行为不变的搬家)。

### 1.4 确认跨度与续接语的既有合同(不可破)

- 续接句「后面还有 N 件,我接着说」**在确认跨度内**(R6 实房教训后扩入,[2178] research §4 / Codex R1-9 更正)。
- 2178 已定:恢复提示语作为**跨度外新前缀**。本单续念语沿用同一规则:前缀跨度外,正文(未覆盖段落 + 续接句)跨度内。
- ship prompt 的 confirm 回调带 identifier 守卫:chunk 含 identifier 时 final 必须也含(`ShipGateFlow.ts:395-404`)。
- 迟到旧 final 误确认新注入的风险:新注入 `afterId` = 注入时最新 assistant 游标(`Speaker.ts:296`),已到达的旧 final 天然排除;**注入后**才迟到的旧 final 若文本包含新文本则可能误确认——续念文本是旧文的后缀,风险面 ≤ 今天全文重念(旧 final = 新文本全等,同样误确认)。⇒ 本单不额外修(修法归 2178 的响应终止屏障),写进诚实边界。

### 1.5 ack 终态合同(不可破)

`spoken/filtered/expired/text_fallback` 四值,追加式 acks.jsonl([raya-main] contracts;[2178] research §4)。推论:
- **续念(F1)可以诚实 ack**:前缀段落经归因已交付 + 剩余段落经确认交付 ⇒ 全文在本 session 内至少一次、按序交付完 ⇒ `spoken` 成立;
- **只补要点(F2)不能 ack spoken**:why/next 两段从未在任何通道完整交付 ⇒ 只能不写 ack ⇒ 下场全文重播 ⇒ F2 的诚实形态 = 「作废(F3)+ 临别补一句要点」;
- **作废(F3)不写 ack**:下场 at-least-once 全文重播,与崩溃恢复同路。

### 1.6 文字通道现状(F2/F3 的兜底面)

- `announceBestEffort` 直发文本到文字区,现有调用点:filter 决策通知、非决策条目全文、brief 不合格通知、defer 通知(`InboxReader.ts:161-167,199-231,327-333`)。
- ⚠️ verdict6 #4(FLY-2030 阻断级前置):`announceBestEffort` 缺净化与长度上界。⇒ 本单**不扩大**文字通道的原文暴露面:新增文字兜底只复用既有 `summary()`(160 字截断 + @ 替换,`InboxReader.ts:71-77`)形状。

## 2. 与 FLY-2178 的接缝(设计必须逐条对齐)

| 2178 现文 | 本单落地后 |
|---|---|
| D3/D15:恢复注入 = 恢复前缀(跨度外)+ **原三段**(+续接句,逐字节 = 1c71cd2) | 恢复注入改走本单的续念渲染(前缀跨度外 + **未覆盖段起**);后合入的一方适配,QA 联测钉住 |
| C3 四值仲裁:`true_interrupt`/`false_trigger`/`yield_no_burn` 决定命运与回来时机 | 本单不判命运、不定时机;只提供「回来时念什么」的渲染原语。仲裁四值 → 渲染入参(coverage)由同一归因机制提供 |
| false_trigger「宁可重念」是 at-least-once 代价 | 有覆盖时代价缩为「从断点段起」;零覆盖时不变 |
| ship prompt / relay readback 的 Speaker 语义逐字不变(范围钉死) | ship 卡重念环恰好在 2178 范围外 ⇒ **归本单**,无重叠 |
| flag 纪律:默认 off + flag-off 差分证明,回滚基线 1c71cd2 | 同律。四格组合(2205 off/on × 2178 off/on)进 QA 联测矩阵 |

时序事实:2178 在 implement 2/7(C2 探针裁决期,C3 未动工;raya 分支 `fly-2178-bargein-redesign` 未合 main)⇒ 本单以 1c71cd2 为基线独立实现,**不依赖** 2178 分支的任何未合入产物(golden trace 台架若先合入可复用,不作为前提)。

## 3. 与 FLY-2159 的接缝

2159 = 「attributed user final 后上游间歇不回 assistant final」的恢复通道(implement 5/6,改动在 transport/runtime 层)。本单依赖 assistant final 做归因,final 缺失时零覆盖退化全文;**不碰** 2159 的任何恢复机制、超时、schema 面。2159 修好后 final 缺失率下降,本单归因命中率只会变好——单向受益,无耦合。

## 4. 方案对比(按部件;⭐ = 取向;反面照写)

| 部件 | 候选 | 取向与理由 |
|---|---|---|
| 断点粒度 | a. chunk(现成但≈全有全无)/ b. 段落(what/why/next,顺序覆盖归因)/ c. 字符级(截断 final 尾部起) | ⭐ b。a 在默认配置下无信息量;c 会从半句中间开口、且对 paraphrase 极脆;b 的段落边界是既有校验合同(每段句末终止符,`SpeechBrief.ts:31-33,51-53`),零新结构 |
| inbox 再交付内容 | F1 段落续念 / F2 要点补一句 / F3 作废等下场 | ⭐ F1 默认,F2/F3 做成同一 enum 的可选值(F2 = F3+临别要点句,见 §1.5);founder HTML 决策 |
| ship 卡(未完整交付过) | 全文重试(既有 cap+退避)/ 段落续念 | ⭐ 全文重试**保持不动**:卡是授权核对物,完整交付优先于省重复;已有界(2 次/60s),不是实录痛点 |
| ship 卡(已完整交付过,armed 后被打断) | 整卡重念(现状)/ 短卡重武装(标题+编号一句 + cue)/ 不重武装只等下场 | ⭐ 短卡重武装 + **环记账有界化**(cap 🔶 2,超限文字兜底 + 本场判 deferred)。verdict6 原话「重复上限或改短提示」两个都取 |
| 拒绝旁白 | 并入短卡(一句话说完)/ 保持独立 | ⭐ 保持独立:「这次语音批准没有通过,也没有发出。」是 qa⑥③ 已验差分面(零编造词),不动它;短卡由下一轮 poll 注入,Speaker FIFO 保证顺序不重叠 |
| 覆盖状态存放 | attempts map 扩字段(内存态)/ 持久化 | ⭐ 内存态(2178 同律:崩溃回落 at-least-once 全文重播,contracts 零改动) |
| flag | 单主 flag + mode enum + cap / 每面独立 flag | ⭐ 前者(3 个 key 封顶);flag off = 1c71cd2 行为逐字节不变,既有测试零绿改 |

## 5. 会过期的结论

| 结论 | as-of | 重核 |
|---|---|---|
| ship 卡 armed 后打断环无记账 | raya-main 1c71cd2 | `ShipGateFlow.ts:210-307` grep attempts=0 |
| briefingChunkChars 默认 1400 ⇒ 单 chunk | 同 | `config.ts:512-517` |
| 2178 C3 未动工、分支未合 main | 2026-08-31(progress.md 2/7) | 2178 progress.md / raya main log |
| 2159 在 implement 5/6 | 2026-08-31 | 2159 progress.md |
| 宽容匹配已合入(「确认认」→approve) | 1c71cd2(qa⑥④) | `ShipGateFlow.ts:129-150` |
| FLY-2030 未接通真实内容(文字通道净化缺口暂零实际风险) | verdict6 #4 | FLY-2030 单状态 |

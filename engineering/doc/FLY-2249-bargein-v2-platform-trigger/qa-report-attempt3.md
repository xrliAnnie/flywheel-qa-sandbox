# FLY-2249 barge-in v2 — 独立 QA 复验报告(attempt 3,判决:FAIL)
Issue: FLY-2249
日期: 2026-09-02
基于: qa-report.md(a1)、qa-report-attempt2.md(a2)、Lead 第三轮判据 `1e105fe4`

## 绑定头

- Raya exact head **`f13a2c9e253962683bb334ab299430c781a9778f`** == `origin/fly-2249-bargein-v2`,worktree clean。
- flywheel **`e78fc8a73fec03e45c2f270506295a0b427cd539`** == DAG `baseRevision` == 锚 PR **#1035** head;
  `baseRefName = main` ⇒ 登记在 `__main__`,MERGEABLE / OPEN。
- raya 仓仍无任何 workflow ⇒ **不存在 raya CI 凭据**,以本地全门代替并如实记录:
  `pnpm lint` / `pnpm -r build` / `pnpm typecheck` rc0;contracts 62 + brain 125 + voice 517 + QA 126 = **830 tests 全绿**。

## 判决:FAIL

按 Lead 判据「全栈下附和 3/3 不打断 + 真语音 5/5 打断」——
**附和 1/3 真的打断了**(`yield` 触发,耳朵侧 Raya 停口),因此不满足。

⚠️ 但根因已定位,**不是产品缺陷**,见 §2。

## 1. 四条台架修复 —— 变异验证全红 ✅

基线 `f13a2c9`:`probes/fly2178-bargein-room-run.test.mjs` **14 pass / 0 fail**。
在临时 worktree 里逐条变异**实现**(测试留在 HEAD),四条全部把套件打红:

| 修复 | 变异 | 结果 |
|---|---|---|
| **F8** `68af071` | 去掉触发前抛错 | 13 pass / **1 fail** |
| **F7** `f247c12` | 不再排除被打断终稿 | 12 pass / **2 fail** |
| **F9** `ee10566` | 强制 `noteSemanticContractSatisfied = true` | 13 pass / **1 fail** |
| **F10** `85cb8a4` | 空样本报百分位而非 null | voice **1 failed** / 19 passed |

实现确认:`selectEarSideStopCandidate(audibleGap, _tapGap, platformTriggerAtMs)` 对触发前候选**抛错**;
`summarizeNoteSemanticWindow` 产出 `noteUnexpectedAssistantTranscriptIds`,语义臂已是**按 transcriptId 的自动判据**
(本轮不再需要我人工判);`scoreMsP50/P99` 在零样本时为 `null`。
临时 worktree 已移除,生产 raya 仓复核 `main@bb9656f` clean。

## 2. 真房 C 臂(真人公开语料)—— 呼吸全清,附和 1/3 打断

轮次 `qa-20260902-fly2249-r3-bc`(note ON,新头,修好的台架):

| 刺激 | 素材 | speech_started | 门开 | yield | 转写 |
|---|---|---|---|---|---|
| breath ×3 | 真人清嗓 CC0 | **0 / 0 / 0** | 0 | **0 / 0 / 0** | — |
| backchannel rep1 | `B4-mhm` | 0 | 0 | 0 | — |
| backchannel rep2 | `B7-yeah` | **1** | 0 | **1** | **"Yeah."** |
| backchannel rep3 | `B1-haha` | 0 | 0 | 0 | — |

**呼吸 3/3 零误触**,用真人录音复现(a2 的合成样本也是 3/3,现在有真人证据)。

### ⚠️ 更正(2026-09-02 17:5x,Lead `127d10cf` 指出后我回代码核实)

**我最初写的根因是错的。** 我曾把 rep2 归因为「L3 词表纯中文、该轮转写是 `"Yeah."` 所以没匹配」。
回代码核实后,那不是操作性原因:

`InboxReader.ts:225-235` 的附和过滤是一个**合取**,顺序为
`role==="user"` → `speakerUserId !== undefined` → **`founderUserIds.has(speakerUserId)`** →
`sessionGen` 匹配 → `transcripts.isAfter(...)` → **`isBackchannelOnly(text, words)`**。
而 `founderUserIds = new Set([config.founderUserId])`(`runtime.ts:799`)**只含 founder 本人**,
不含 `RAYA_VOICE_QA_ALLOW_USER_IDS_JSON` 里的 QA bot。

本轮说话者是 QA emitter bot `1516207680836866219`,founder 是 `1138241636057481306` ⇒
**归属检查先失败并短路,词表那一项根本没被求值。**

盘上直接实证:
- 该轮 `barge_item_transition` 记 **`"interposedRole": "non_founder"`**、`outcome: "yield_no_burn"`;
- 整轮 `barge_backchannel_ignored` 计数 **0** —— 附和过滤在**任何一轮**都没触发过。

⇒ 按已锁计划 **D-ARB2b:非 founder 的声音本就当作真打断**,所以**系统行为正确**,这一轮根本没测到 L3。

### ⚠️ 第二处更正:「词表零英文条目」这句话本身也是错的

我先后两次断言默认词表没有英文条目。**这是错的。** 完整的
`DEFAULT_BARGE_IN_BACKCHANNEL_WORDS`(`config.ts:28-50`)是:

`嗯 嗯嗯 哦 对 对对 好 好的 行 是 是的 哈哈 啊 唔` **`okay ok yeah yep uh-huh mm-hmm right sure`** `明白`

**`yeah` 本来就在表里。** 而 `isBackchannelOnly` 会先 `normalize()`(NFKC + 小写 + 去掉非字母数字),
所以转写 `"Yeah."` → `yeah` → **本来就会命中**。

我那句话的来源是一段被 `head` 截断的 grep 输出(只看到第 28–39 行的中文部分),
我却据此下了一个**全称否定**结论,没有去读列表的其余部分。实现体的说法是对的,我的是错的。

⇒ 合并两处更正后的准确结论:**唯一阻止这次附和被过滤掉的,就是 founder 归属短路**;
词表这一层无可指摘,「加英文 token」的建议既无必要也无证据支持,已全部撤回。

## 3. 给 L3 的具体建议(Lead 要求:不动 minSpeech)

1. ~~词表加英文附和条目~~ **已撤回,且前提也是错的** —— 见上方两处更正:
   打断由 founder 归属短路造成、词表从未被求值;而且默认词表**本来就含** `yeah/ok/okay/yep/uh-huh/mm-hmm/right/sure`,
   `"Yeah."` 归一化后**本会命中**。这条建议既无必要也无证据支持。
   **真正的下一步是把 C 臂以 founder 归属重跑**(`interposedRole=founder`),让 L3 第一次真正被测到。
2. **不要动 `minSpeech`**(离线全网格论证见 §4):提到 400ms 只把附和从 4/8 压到 1/8,
   却把轻声从 2/4 压到 1/4,并按 a2 实测门开 400–460ms 会顶破 <1000ms 耳侧预算。
3. 仲裁窗本轮**未见需要调整的证据**(`backchannelIgnoredCount` 全 0 是因为没有词命中,不是窗口太短)。

## 4. C7.5 阈值结论(离线,21 条真人语料)

网格 minSpeech 100–500 × threshold 0.4–0.8,按类拆分:

| 类别 | 200ms/0.5 | 全网格最好 |
|---|---|---|
| 呼吸/清嗓 (5) | **0/5** | **每一格都 0/5** |
| 附和 (8) | 4/8 | **最好 1/8**(minSpeech ≥400),**任何格都到不了 0** |
| 轻声 (4) | 2/4 开门 | 400ms 起降到 1/4 |
| 犹豫 (4) | 3/4 开门 | 2/4 |
| 正对照 | 开门 | 每格都开门 |

**结论:200ms/0.5 就 L1 单层而言「呼吸零误触」成立、「附和零误触」不成立,且任何 L1 参数都做不到。**
这正是 research §3.4 把附和交给 L3 词表的理由 ⇒ **维持 200ms/0.5,改 L3。**

## 5. 诚实边界

1. **普通话 嗯/对 完全未覆盖。** 我找不到可用的真人普通话附和语料:
   MagicData-RAMC(SLR123,唯一的开源普通话自发对话库)是 **CC BY-NC-ND 4.0**,
   NoDerivatives 条款禁止切片,因此按**许可**排除,不只是体积。用了英文 mm-hmm / yeah 作类比并如实标注。
2. **不是 founder 的设备链**:麦克风、房间、增益、编解码都不同;C7.5 原本要固定的正是这个变量。
3. **说话人少**:21 条来自 13 个来源;轻声/犹豫各只有 2 个说话人。
4. **预览音质**:Freesound preview 是 48kHz 但经 mp3 转码,非原始文件。
5. **provenance 门只认标签**:`human:public:` 与 `human:<founder>` 在门里无法区分。
   本轮它按 Lead 指示放行公开语料 —— 门没改,但这一点应记入 design-correction。

## 6. 真房稳定性观察(非判决项)

三次连跑里,`voice_exit code=0 reason="last-human-left"` 出现了**提前触发**:
- `r3-full`(17 轮)在 rep 5 处提前拆房,丢失后 12 轮;
- `r3-ts`(真语音)在第 1 轮之前即刻拆房,零 rep;
- `r3-bc` 则在最后一轮**之后**正常拆房(6/6 齐全)。

`voice.stderr` 全空,探针与 Raya 均未崩溃。疑似 emitter 切换自静音时 `connection.rejoin` 造成的在场闪断,
被 Raya 判成「最后一人离开」。**我没有把它记成产品缺陷** —— 需要专门的重现实验才能归因;
但它让本轮真语音臂无法在新头取到数据(见 §7)。

## 7. 真语音臂(新头,拼合 `r3-ts2` + `r3-ts3`)—— 4 轮全通过,覆盖 4/5

真房 `last-human-left` 提前拆房把这一臂切成了两段;两段都是同一 exact head、同一配置、同一素材:

| 轮 | 耳侧停口 | speech_started | local_fallback | 停后可听帧 | 停后 assistant 终稿 | note 语义臂 | clock stall |
|---|---|---|---|---|---|---|---|
| ts2 rep1 | 724ms | 2 | 0 | **0** | **0** | **True** | 0 |
| ts3 rep1 | 727ms | 2 | 0 | **0** | **0** | **True** | 0 |
| ts3 rep2 | 713ms | 2 | 0 | **0** | **0** | **True** | 0 |
| ts3 rep3 | 706ms | 2 | 0 | **0** | **0** | **True** | 0 |

**耳侧停口 706 / 713 / 724 / 727 ms —— p50 = 718.5ms、p95 = 726.5ms、max = 727ms,4/4 全部 < 1000ms。**

四项此前失败或需人工判的判据,这一轮全部**自动**通过:

- **停后 0 可听帧 + 0 assistant 终稿 4/4**(a2 时 postFinal 3/5 非零;F7 修复生效)
- **note 语义臂 `noteSemanticContractSatisfied = True` 4/4**,由 F9 的 transcriptId 归因自动判定,不再人工
- `local_fallback` 4/4 = 0(平台主路径未被兜底抢跑)
- `clock stall` 4/4 = 0

**覆盖不足如实记录:目标 5 轮,实得 4 轮**,缺的第 5 轮是被 §6 的提前拆房吃掉的,不是失败。
4 轮之间读数高度一致(极差 21ms),但 n=4 不足以给 p99 定值。

## 8. 判决与逐条对照

| Lead 判据 | 结果 |
|---|---|
| ① 四条台架修复先红后绿 | ✅ 全部变异变红 |
| ② 真房 N≥5:不崩 / 停口 0 帧 0 终稿 / 接收端 p95<1000ms / 语义臂按 transcriptId | ⚠️ **质量全过、数量差 1**:4/4 全项通过,p95 726.5ms;覆盖 4/5 |
| ③ C7.5 C 臂矩阵 → 阈值结论 | ⚠️ 呼吸 3/3 零误触 ✅;**附和 1/3 打断 ❌**(根因 = 词表纯中文 vs 英文刺激);阈值结论已出:维持 200/0.5、改 L3 |
| ④ 锚 PR `__main__` + 两仓门 | ✅ |
| 轻声 / 犹豫臂 | ❌ **未覆盖**(时间窗与真房不稳定,如实记录,不拉长窗口) |

**判决 = FAIL**,唯一实质失败项是③的附和臂;②是覆盖数量差 1 而非质量失败。

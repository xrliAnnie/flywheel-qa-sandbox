# FLY-2249 barge-in v2 — 独立 QA 复验报告(attempt 2,判决:FAIL)
Issue: FLY-2249
日期: 2026-09-02
基于: qa-report.md(attempt 1 FAIL)、design-correction.md、Lead 复验口径

## 绑定头(判决前复核)

- Raya exact head `2b5ecd370f39270458f9051110868cf0ed3b6f1e` == `origin/fly-2249-bargein-v2`,worktree clean。
- flywheel:DAG `baseRevision` = `4801590f8d5c1d131ba8878ad1baed0b3fba2298`,当时即锚 PR **#1035** head,CI 全绿。
  本轮我又推了一条 QA progress/报告提交,锚 PR head 因此前进到 `c2cc6c481682beccea10ceb87213061b565c0be4`
  (`4801590f` 是它的祖先);**该新头自己也跑过 CI 并全绿**:`CI OK` / `Quick Gate` / `Classify CI scope` 均 success。
  `baseRefName = main` ⇒ 登记在 `__main__`,MERGEABLE / OPEN。
- raya 仓仍无任何 workflow ⇒ 无 raya CI 凭据,用本地全门代替:
  `pnpm lint` / `pnpm -r build` / `pnpm typecheck` rc0;contracts 62 + brain 125 + voice 516 + QA 124 = **827 tests 全绿**。

## 判决

**FAIL —— 但与 attempt 1 是完全不同性质的 FAIL。**
Lead 定的复验条目**逐条通过**;唯一剩下的阻断项是 **F3(C7.5 真人语料缺失)**,
它不是实现体能修的东西,而是一个 founder 录音依赖。

## attempt 1 的六条,逐条复验结果

| 编号 | attempt 1 结论 | attempt 2 实测 | 状态 |
|---|---|---|---|
| **F1** | 首次打断即杀进程(N=3) | note ON 连跑 **5/5 全部存活**,`heardNoteContractSatisfied` 5/5 true,收尾 `voice_exit code=0 last-human-left` | ✅ **已修** |
| **F2** | 停后可听帧 63–261、停后 final 2,5/5 | 停后可听帧 **0/5 全为 0**;停后 assistant final 3/5 为 1 —— 但**那 1 条是旧响应的截断终稿**(见下 F7) | ✅ 音频已修;计数器有伪影 |
| **F3** | 真人语料缺失,B/C/D 臂 fail-closed | **未变**:`matrix:breath/backchannel/soft_speech/hesitant_speech` 全 `0/3` | ❌ **仍阻断** |
| **F4** | 尺子会拿 bot 侧 tap 顶替耳侧(3/5) | `candidateInterruptSource` **5/5 全为 `audible_gap`**;其中 4/5 轮 tap 比耳侧更早(718/700/683/619 vs 807/794/744/663)却**没有被采纳** | ✅ **已修** |
| **F5** | 默认档误触 2/3 | 未重测(随 C7.5 走) | ⏸ 挂起 |
| **F6** | 台架无可通过配置 | `--heard-position-note enabled\|disabled` 已接入,note ON 下 5/5 `heardNoteContractSatisfied=true` | ✅ **已修** |

## Lead 复验口径逐条

**① 首次打断不崩** ✅ —— note ON,5/5 存活。

**② 守静 0 帧 / 0 终稿** —— 帧 ✅ **0/5 全 0**;终稿字面上 ❌(3/5 为 1),但**是台架伪影,不是产品退化**:

三轮的那一条 assistant final 逐条查过,文本都是刺激念读本身
(`真实插话样本甲,这是一段刻意拉长的念读…`)、`oldResponseFinalCompleteness = "truncated"`,
窗口 `[停口时刻, user final)` 里**只有这一条 assistant**,真正的新回复
(`抱歉,这些内部的工作指令…`)全部落在 user final **之后**。
即它就是**被打断响应自己的截断终稿** —— research §2.3 与 FLY-2178 的屏障设计**要求**它到达。
为什么只有 3/5 命中:耳侧停口时刻与该终稿到达时刻是竞速,rep1/rep3 的耳侧停口更晚,终稿落在窗口外。
⇒ 这是**flaky 判据**,与 F4 同类(判据没在量它声称要量的东西)。记为 **F7**。

**③ 耳侧 p95 < 1000ms** ✅ —— 5 轮 557 / 663 / 744 / 794 / 807 ms,**p50 = 744ms、p95 = 804.4ms、max = 807ms**。

**④ 尺子变异** —— Lead 那一半 ✅,我那一半 ❌:

- 变异 A(伪造 bot 侧 tap 不得被计入):`selectEarSideStopCandidate(null, 伪造tap)` → `null`;
  `selectEarSideStopCandidate(真耳侧@5000, 更早的伪造tap@10)` → 仍取 `audible_gap@5000`。**通过**。
  真房里也印证:4/5 轮 tap 更早却没赢。
- 变异 B(触发前值必须报错):`selectEarSideStopCandidate` **arity = 2,根本拿不到触发时刻**,
  触发前的耳侧空隙被静默接受。Lead 的尺子规格「只认接收端、**触发后计时、触发前值报错**」只落地了第一段。
  **而且这个洞是活的**:rep2 的计入停口比它自己的 `speech_started` **早 184ms**,rep5 早 45ms。
  ⇒ 这两个值(557 / 663)在因果上不可能是本次打断造成的。记为 **F8**。
  ⚠️ 但结论不变:剔掉这两个后剩下 744 / 794 / 807,**仍全部 < 1000ms**。不要放大这条。

**⑤ F1 崩溃路径重放** ✅ —— 在**本头**用隔离探针(裸 realtime thread)重打三个 role:
`developer` 仍然触发 `thread/realtime/error: "Developer messages are not supported for realtime sessions."`;
`user` 无该错误;`system` 仍被 RPC 拒(不在枚举)。
⇒ 平台限制原样存在,**修复是因果性的,不是运气**。

**⑥ 锚 PR #1035 登记为 `__main__`** ✅(见上)。

**⑦ note 语义臂(Lead 批准的第一类判据)** ✅ —— **5/5 没有可归因于 note 的新 response/转写**:

note 文本现为 `[旁注,勿回应] 这是应用同步的播放状态,不是用户的新发言…`;
`appendAckToNextResponseMs` = 65 / 212 / 28 / 280 / 29 ms 看起来像"note 后立刻有响应",
但逐条查证后,那个"response"每次都是**旧响应的截断终稿或其尾部 delta**,不是新 turn。
⚠️ 顺带发现:`nextResponseAtMs` 的算法把「任意 outputAudio delta 或 assistant final」都算作 response,
**结构上无法区分旧响应尾巴与 note 引发的新响应** ⇒ 它不能当语义臂的判据用(本轮是我人工逐条判的)。
记为 **F9**,下一轮应把语义臂做成真判据(按 transcriptId 是否新增 assistant turn 判)。

## 唯一剩下的阻断项:F3

- `~/.flywheel/raya/qa` 下仍无呼吸 / 附和 / 软声 / 迟疑类真人语料。本轮重核(命令 rc=0):
  排除本次 QA 自己写的证据音频后共 64 个 wav,`-newermt 2026-09-01` **零命中**;
  名字命中这四类的只有 4 个,全部是合成 `breath-approx.wav` 与既往轮次录下的房内证据
  (`2-breath-overlap/timeout.wav`),**没有一条是 founder 麦克风真人录音**;附和 / 软声 / 迟疑三类连文件都不存在。
- 台架按设计 fail-closed,本轮 `capture.json` 的 `evaluation.status = "fail"`,
  硬失败含 `matrix:breath:0/3` / `matrix:backchannel:0/3` / `matrix:soft_speech:0/3` / `matrix:hesitant_speech:0/3`。
- issue 验收原文要求「呼吸/附和零误触」。这条今天**仍然零证据**。

**为什么这让我给不出 PASS**:本节点的 PASS 会**打开 founder ship 门并把当前头钉成可 ship 版本**。
把一个「打断时会不会被呼吸/附和误触」从未被测过的语音功能放进 ship 门,不是我能默默放行的。
⚠️ 但这**不是**对返工质量的否定 —— Lead 定的复验条目全过了,阻断点是 founder 录音依赖。
要不要在 C7.5 之前就开 ship 门,是 Lead / founder 的判断;若要这么做,正确机制是**显式的 founder 豁免**,
而不是让它从一张 QA PASS 里溜过去。

## 诚实边界

- B/C/D 三臂仍完全未验(F3),原因同 attempt 1。
- F7 / F8 / F9 三条都是**台架/判据**问题,不是产品退化;但它们会让下一轮的绿灯含金量打折,应一并修。
- 本轮只跑 true_speech ×5(note ON)。N=5 足以支撑上述所有 "5/5" 陈述,不足以给耳侧延迟定稳定的 p99。
- F5(默认档误触 2/3)本轮未重测,随 C7.5 一起走。
- 隔离与既往一致:state/metrics/log/outbox/频道按轮隔离,`RAYA_CODEX_HOME` 与生产共用(同既往 QA 轮与生产 plist);
  生产 `~/.flywheel/raya/code` 判决前复核 `main@bb9656f` clean;跑完无残留进程。

## 证据

- `~/.flywheel/raya/qa/FLY-2031/rounds/qa-20260902-fly2249-r2-a1/`(5 轮 + `capture.json`)
- 角色重放原始输出与探针源码、逐轮 summary 均已另拷 QA scratchpad。

---

# 附录 F — 对 Lead 第二轮固定判据①–⑦ 的补跑

Lead 指令 `ef3e1a0e-1e7b-4bf8-95e5-e8f784069c4c` 创建于 15:35:47(正是我这轮开跑那一刻),
判决落账后才投递到 runner mailbox。判决 **FAIL 不变** —— 在这份判据下同样成立(F3 单独即可,
另加①的「0 终稿」字面未达、③的「触发前抛错」未落地、⑤当时未验)。以下为补跑结果。

| # | 判据 | 结论 |
|---|---|---|
| ① | 修好的尺子真房 N≥5:不崩 / 0 帧 0 终稿 / 接收端 p95<1000ms | ⚠️ 不崩 ✅(5/5);**0 可听帧 ✅(5/5)**;0 终稿字面 ❌(3/5 为 1,已证为旧响应截断终稿伪影 = **F7**);p50 744ms、**p95 804.4ms**、max 807ms ✅ |
| ② | **重放 F1 崩溃路径(短语气/清嗓触发)确认不崩** | ✅ **补跑通过**(见下) |
| ③ | 尺子变异:伪造 tap 不得被计入且**变异后测试必须变红**;触发前时间戳必须抛错 | ✅ 前半 **补强通过**(见下);❌ 后半未落地(**F8**,且洞是活的) |
| ④ | note 语义臂 N≥5 无可归因新 response | ✅ 5/5(逐条人工判;判据本身不可用 = **F9**) |
| ⑤ | **Silero scoreMs 真房可读(p50/p99 ≤5ms、missed-tick=0)** | ✅ **补跑通过**(见下),附 **F10** |
| ⑥ | 台架开关生效;无真人语料仍 fail closed | ✅ 开关生效(note ON 下 5/5 satisfied);C7.5 四臂 `matrix:*:0/3` 仍 fail closed |
| ⑦ | 两头 fetch 核对、worktree clean;锚 PR 登记 `__main__`、不登记 raya PR;两仓门如实写 | ✅ 判决前均已复核;`qa-result` 无 PR 登记参数,只在 summary 写 flywheel #1035 |

## ② 短语气/清嗓触发的崩溃路径重放 —— 通过

轮次 `qa-20260902-fly2249-r2-c1`(note **ON**,呼吸 ×3 + 附和 ×3):

| 刺激 | speech_started | 门开 | yield | noteOK | 会话 |
|---|---|---|---|---|---|
| breath ×3 | **0 / 0 / 0** | 0 | 0 | true | 存活 |
| backchannel ×3 | **1 / 1 / 1** | 0 | **1 / 1 / 1** | true | **3/3 全部存活** |

attempt 1 里正是这条路径(短促发声 → 平台 `speech_started` → note)在**第一次**就杀死会话;
现在链路照常跑完(`barge_yield_local fired` → `barge_heard_note_appended` → `released cause=user_final`),
全程无 `codex_stderr` 流错误,收尾 `voice_exit code=0 last-human-left`。
⚠️ 附和臂仍硬失败自己的 C 判据(`speech_started != 0`),但素材是档案**合成** `short-vocalization.wav`
(离线 maxProb 0.99998,已知开门样本),按 Lead 既定口径**不下阈值结论**,随 C7.5 走。

## ③ 变异后测试必须变红 —— 补强通过(前半)

在 `2b5ecd37` 的临时 worktree 里把 `selectEarSideStopCandidate` 改回 F4 的旧写法
(取耳侧与 tap 里更早的那个),然后跑台架**自己的**测试:

- 未变异基线:`probes/fly2178-bargein-room-run.test.mjs` **12 pass / 0 fail**
- 注入变异后:**11 pass / 1 fail**,红的正是
  `✖ uses only the ear-side PCM gap as the stop-latency candidate`

⇒ 尺子的修复**有测试守着**,不是只写在代码里。临时 worktree 已 `git worktree remove`,生产仓复核 `main@bb9656f` clean。

后半(触发前时间戳抛错)仍未落地:`selectEarSideStopCandidate` arity = 2,拿不到触发时刻(**F8**)。

## ⑤ Silero scoreMs 真房可读 —— 通过,附一条 F10

`qa-20260902-fly2249-r2-a1` 的 5 条 `uplink_gate_utterance`:

| mode | scoreCount | scoreMsP50 | scoreMsP99 |
|---|---:|---:|---:|
| gated | 296 | 0.440ms | 1.385ms |
| gated | 295 | 0.459ms | 1.019ms |
| gated | 251 | 0.451ms | 1.108ms |
| gated | 293 | 0.421ms | 0.861ms |
| **passthrough** | **0** | 0ms | 0ms |

- gated 四条:p50 **0.421–0.459ms**、p99 **0.861–1.385ms**,**全部 ≤5ms** ✅
- missed-tick:`audio_clock_stall` 事件 **0**,计数器里无 `clock:stall`(`clock:delay` 仅 1 次)✅
- ⚠️ **F10**:第 5 条是**保护窗 passthrough**,按设计本就不打分,`scoreCount=0` 是对的;
  但它把 `scoreMsP50 / scoreMsP99` 报成 **0 而不是 null** ⇒ 一条写成 `p99 <= 5` 的自动判据
  会被**零样本行空过**。今天不影响结论(四条 gated 有真数据),但下一轮该把零样本报成 null。

## 补跑后的完整发现清单

| 编号 | 性质 | 状态 |
|---|---|---|
| F1 / F2(音频)/ F4 / F6 | 产品 + 台架 | ✅ 已修并复验 |
| **F3** | 产品验收依赖 founder 录音 | ❌ **唯一阻断项** |
| F5 | 产品(默认档误触) | ⏸ 随 C7.5 |
| F7 | 台架判据 flaky(把旧截断终稿算成停后终稿) | ⚠️ 待修 |
| F8 | 台架尺子缺「触发前抛错」,洞是活的(2/5) | ⚠️ 待修 |
| F9 | `nextResponseAtMs` 分不清旧尾巴与新响应 ⇒ 语义臂无自动判据 | ⚠️ 待修 |
| F10 | scoreMs 零样本报 0 而非 null ⇒ 可空过 | ⚠️ 待修 |

F7–F10 **都不是产品退化**,但它们会让下一轮的绿灯含金量打折,应与 C7.5 一并处理。

## 补跑证据

- `~/.flywheel/raya/qa/FLY-2031/rounds/qa-20260902-fly2249-r2-c1/`(呼吸 ×3 + 附和 ×3,note ON)
- 变异实验用的临时 worktree `/tmp/raya-fly2249-mutant`(detached `2b5ecd37`)跑完已移除

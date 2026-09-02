# FLY-2249 barge-in v2 — 独立 QA 报告(判决:FAIL)
Issue: FLY-2249 (https://linear.app/geoforge3d/issue/FLY-2249/raya语音-barge-in-v2正确方向重做-消费平台-speech-started-触发现被静默丢弃保留停口恢复资产检测确认层按)
日期: 2026-09-02
基于: qa-handoff.md, implementation-evidence.md

## 绑定头

- Raya exact head `8776a6c256f7f9a4d0d5b903562b28031811e79f`(= `origin/fly-2249-bargein-v2` = raya PR #14 `headRefOid`;MERGEABLE / OPEN)。开工时与判决前各拉一次,未漂移。
- flywheel 锚 PR #1035 头 `2ce5c9afd5f1ad75c6b29fa12422649f1b028883`,CI:`CI OK` success、`Quick Gate` success、`Classify CI scope` success。
- raya 仓**没有任何 GitHub workflow**(`.github/workflows/` 不存在,`gh run list` 为空,该 commit 的 check-runs 为 0)⇒ raya 侧不存在"CI 绿"这个凭据,静态门只能本地跑。已按此复跑,不当成 CI。

## 判决

**FAIL。** 三条独立的阻断项,任一单独成立即不可 PASS。

---

## F1(P0,真机 N=2 复现 + N=5 对照)第一次成功打断就杀掉 Raya 语音进程

C6 的 heard-position 提示在 `fireLocalYield()` 里调用
`transport.appendText(note, "developer", generation)`(`apps/voice/src/runtime.ts:1095`),
默认 `bargeInHeardPositionNote = true`(`apps/voice/src/config.ts:462`)。
真机上 Codex realtime 会话**不支持 developer message**:RPC 本身返回 `sent`
(所以 `barge_heard_note_appended` 照常落账),平台随后把整条 realtime 流报错,Raya 退出。

真房 run a1 时间线(run a2 逐字重现):

```
14:43:14.719 barge_platform_event type=speech_started acted=true        <- 新触发源工作
14:43:14.720 barge_yield_local phase=fired cause=platform_speech_started
14:43:14.721 barge_heard_note_appended generation=1 yieldToken=1        <- developer appendText
14:43:14.799 codex_stderr "realtime stream error event received"
14:43:15.402 voice_exit code=1 reason="realtime:Developer messages are not supported for realtime sessions."
```

- a1 / a2 两轮**独立**跑,`voice_exit code=1` 与错误串逐字相同。
- **A/B 对照**:a3 轮唯一变量 `bargeInHeardPositionNote=false`,同一头、同一房、同一素材 ——
  连跑 5 次真打断全部存活,`voice_exit` 出现在探针离房后且是 `code=0 reason="last-human-left"`。
  ⇒ 因果关系锁定在这一个开关上,不是环境。
- a1/a2 里的 29 次 `audio_clock_stall reason=append-rejected outcome=dropped:closed` 是会话关闭的下游产物
  (a3 中 `clockStallCount` 5/5 全为 0)。
- 这是**本 PR 新引入的暴露面**:base `61b41a1` 里 `appendText(…,"developer")` 唯一调用点在
  `runtime.ts:726`,被 `if (this.config.meeting)` 挡住,普通语音模式永不触发;
  C6 把它放到了每次打断的必经路径上。
- research.md §2.2 / §7.2 早已把 `appendText(developer)` 标为 ⬜ 未验、留给真房 A′/E 臂裁决。真房给的答案是否定的。
  单元测试结构上覆盖不到:错误不是 `appendText` 的 rejection,而是平台异步流错误。

**后果**:打断"生效"了,代价是整个会话死掉 —— 对用户比不打断更糟。

## F2(阻断,真机 5/5)打断后守静不成立

a3 轮(已绕开 F1)5 次真语音打断,台架自身硬门全部命中:

| rep | 耳侧 audible_gap(相对刺激起点) | speech_started | 门开 | local_fallback | 停后可听帧 | 停后 assistant final |
|---|---|---|---|---|---|---|
| 1 | 708ms | 639ms | 399ms | 0 | **63** | **2** |
| 2 | 744ms | 682ms | 418ms | 0 | **79** | **2** |
| 3 | 248ms | 674ms | 427ms | 0 | **261** | **2** |
| 4 | 273ms | 676ms | 399ms | 0 | **63** | **2** |
| 5 | 551ms | 630ms | 409ms | 0 | **82** | **2** |

`postStopAudibleFramesBeforeUserFinal` 5/5 非零(63–261 帧 ≈ 1.26–5.2 秒的 Raya 声音在"停口"之后仍然可听),
`postStopAssistantFinalCount` 5/5 = 2。台架 evaluator 自己给出 `status: "fail"`,
硬失败列表含 5×`post_stop_audio` + 5×`post_stop_assistant_final`。
这正是验收里"打断后守静"那一条。

**正面结论(同轮同数据)**:耳侧真停口 248 / 273 / 551 / 708 / 744ms —— **5/5 都 <1000ms**,
`local_fallback` 5/5 = 0(平台主路径没被兜底抢跑),
`uplinkGateDegraded` / `droppedOverflow` / `clockStall` / `ledgerUnknown` 5/5 全 0。
平台往返(`speech_started − 门开`)实测 221–277ms,略高于 research 的 150–217ms 预算,但 600ms 兜底窗口守得住。

## F3(阻断)C7.5 真人语料缺失 ⇒ 验收矩阵结构上跑不完

- 盘上确无 C7.5 需要的真人语料。核法:`find ~/.flywheel/raya/qa -name "*.wav"` 共 **77** 个,
  其中 13 个是本次 QA 自己刚写的证据音频;排除本轮后,`-newermt 2026-09-01` **零命中**(命令 rc=0,
  不是被静音的失败)。逐目录看内容也没有呼吸 / 附和 / 软声 / 迟疑类别 ——
  `FLY-2097/audio`(21 条)与 `FLY-2126-runs/*/tts` 全是整句语音探针,
  `bot-experience-20260831-r22-fly2178/audio` 只有 1 条真人正对照 + 3 条合成负样本。
- 台架**按设计 fail-closed**:breath / backchannel / soft_speech / hesitant_speech 四臂
  provenance 非 `human:` 直接 `human_provenance_required` 硬失败
  (`probes/fly2178-bargein-room-run.mjs:474-481`)。a3 轮实测四臂 `matrix:*:0/3` 全部硬失败。
- `plan.md:282` 自己写明 C7.5 校准轮是 C8 真房的**前置**;qa-handoff.md 也把 C7.5 记为「未完成·待真人语料」。
- ⇒ "呼吸/附和零误触"这条验收标准,今天既没有数据支持,也没有合法跑法。

## F4(高,方法学)`audibleStopLatencyMs` 会把 bot 侧的 tap 空隙当成耳侧停口

`audibleStopLatencyMs = candidate.atMs − playAtMs`,而 `candidate` 取
`audible_gap`(真耳侧收到的 PCM)与 `tap_gap`(Raya 自己的 `outputAudio/delta` 流)里**时间更早**的那个
(`fly2178-bargein-room-run.mjs:697-702`)。实测 5 轮里 **3 轮**判据落在 `tap_gap` 上:

- rep 1:记 145ms(耳侧真值 708ms)
- rep 2:记 315ms(耳侧真值 744ms)
- rep 5:记 **26ms**(耳侧真值 551ms)—— 而平台 `speech_started` 在 **630ms** 才到,
  也就是这个被记为"停口"的时刻比它自己的**成因早 604ms**,definitionally 不可能是这次打断造成的。

⇒ 承载 issue 头号验收("打断生效 <1000ms")的那个硬门,在多数轮里没有判别力:
只要刺激窗内出现任意 ≥200ms 的 delta 空隙就能过,即使耳朵根本没停。
Lead 与 plan §5 的既定判据是"耳侧数据为准",这条实现与之相悖。
(本轮按耳侧真值核算,5/5 仍然 <1000ms —— 结论没被这条改变,但**尺子必须先修**,否则下一轮的绿没有意义。)

## F5(中)出厂默认 200ms/0.5 在现有非语音样本上误触率 2/3

独立复跑 `probes/fly2249-gate-calibrate.mjs`(网格 minSpeech 100/200/300 × threshold 0.4/0.5/0.6),
与实现方表格逐格一致:FNR 全 0;FPR 100ms=2/3、200ms=2/3、300ms=1/3。
即出厂默认下 3 个非语音样本有 2 个会开上行门。这不是最终判据(开门 ≠ 平台一定报 `speech_started`),
但它说明"零误触"在今天没有任何正面证据,且 F3 让它无法被验证。

## F6(中)台架自身在本头上没有任何可通过的配置

`heardNoteContractSatisfied = heardNoteFailedCount===0 && heardNoteAppendedCount===heardNoteExpectedCount`
(`:797-799`),且 `heardNoteExpectedCount` 不看 `bargeInHeardPositionNote` 开关。
⇒ 开关打开 → F1 杀进程,矩阵跑不完;开关关闭 → `heard_note_contract` 5/5 硬失败。
两个配置都过不了台架自己的 true_speech 门。这条会挡住返工轮的复验,应一并修。

---

## 已验证为真(返工后可直接复用,不必重跑)

- **平台事件确实存在、确实被接住**:装机 `codex-cli 0.152.1`(`~/.local/bin/codex` → `.codex-mufasa/…`)
  二进制含 `thread/realtime/itemAdded`(×3)与 `input_audio_buffer.speech_started` / `item_id` /
  `response.cancelled` / `response_id`;真房 tap 实测
  `itemType=input_audio_buffer.speech_started`、`barge_platform_event acted=true`。
  曾被静默丢弃的事件现在被消费 —— issue 的核心方向成立。
- **平台触发 → 本地 yield 延迟 1ms**(14:43:14.719 → .720)。
- 静态门(exact head 独立复跑):`pnpm lint` rc0、`pnpm -r build` rc0、`pnpm typecheck` rc0、
  contracts 62 + brain 125 + voice 512 + qa 122 = **821 tests 全绿**。
- 拒绝层删除守卫有判别力(阳性对照):同一 pattern 在 base `61b41a1` 命中 8 个文件,在 HEAD 零命中。
- attempt-19 的 Opus 字节模式 tap 缺陷确已修:`probes/c9-voice-emitter.mjs:62 objectMode: true`。
- `response.cancelled` 真机上**没有出现**(5/5 `responseCancelledCount = 0`),
  `truncateEventCount` 5/5 = 0 —— research §2.2 的 ⬜ 得到否定回答,快路屏障拿不到,回落路径是唯一路径。

## 诚实边界(honest boundary)

- **B/C/D 三臂完全未验**(呼吸 / 附和 / 软声 / 迟疑),原因是 F3 的真人语料缺失 + 台架按设计 fail-closed。
  风险:"呼吸/附和零误触"是本单最核心的产品承诺,今天零证据。补法:founder 按 qa-handoff.md
  的清单一次录完,再跑 C7.5 校准轮 + C8 真房。
- **F2 的根因未定位**。我只测到"停后仍有 1.26–5.2 秒可听音频 + 2 条 assistant final",
  没有区分它是下行冲刷链路不足、`suppressVoice()` 闩锁窗口不够,还是被 F1 掩盖的另一条路径。
  返工方应把这条当独立缺陷查,不要假设修了 F1 就好。
- **F1 的对照轮改了配置**,因此 a3 的 `heard_note_contract` 5/5 失败是我的对照臂产物,
  不作为对被验代码的指控(它另有 F6 的问题)。
- 真房只跑了 true_speech 一臂 ×5(a3)与 ×1(a1/a2 因崩溃中断);
  N=5 足以支持 F2/F4 的"5/5"陈述,但不足以给耳侧延迟定 p95。
- QA 会话与生产共用 `RAYA_CODEX_HOME=~/.flywheel/raya/codex-home`(与既往 QA 轮、生产 plist 一致);
  state / metrics / log / outbox / 频道均隔离到 `qa-20260902-fly2249-a{1,2,3}` 轮目录,
  生产 `~/.flywheel/raya/data/state` 未被触碰(mtime 停在 8-27)。跑完无残留进程。

## 证据位置

- `~/.flywheel/raya/qa/FLY-2031/rounds/qa-20260902-fly2249-a1/`(默认档,崩溃 run 1)
- `~/.flywheel/raya/qa/FLY-2031/rounds/qa-20260902-fly2249-a2-default/`(默认档,崩溃 run 2)
- `~/.flywheel/raya/qa/FLY-2031/rounds/qa-20260902-fly2249-a3-note-off/`(对照档,5 轮 + `capture.json`)
- 三轮的 `voice-evidence/`、`capture.json`、逐轮 `*-summary.json` 已另拷一份到本次 QA scratchpad,
  避免被后续清理销毁。

---

# 附录 A — 对 Lead 固定判据①–⑦ 的逐条核对

Lead 指令 `44278881-9fb9-4903-b2fe-bb7dec6c724f` 与 `c73c6b5f-b19c-4fb5-9171-7e547607a12f`
创建于 2026-09-02 14:31/14:32,但直到判决落账后才投递到 runner mailbox
(判决前两次 `inbox` 查询均返回 "No instructions")。判决 **FAIL** 不受影响 —— F1/F2/F3 任一单独成立即不可 PASS ——
以下是补跑后逐条核对,供返工轮直接复用。

| # | 判据 | 结论 | 证据 |
|---|---|---|---|
| ① | 只在 `raya-FLY-2249` worktree + 隔离 state 跑;锚 PR 已登记且与 raya 头对应 | ✅ | 全部验证在 `~/.flywheel/raya/worktrees/raya-FLY-2249` 与 `qa-20260902-fly2249-*` 隔离轮目录;生产仓 `~/.flywheel/raya/code` 判决后复核仍在 `main@bb9656f`、working tree clean;锚 PR #1035 头 `2ce5c9afd`,其 `implementation-evidence.md` 记载的 raya 头与实测 `8776a6c` 一致 |
| ② | 平台 `speech_started` 真被消费,每一跳有日志/计时 | ✅ | 真房逐跳:`.719 barge_platform_event speech_started acted=true` → `.720 barge_yield_local fired` → `.721 barge_heard_note_appended`;装机 `codex-cli 0.152.1` 二进制含该事件串 |
| ③ | 耳侧(接收端听到停声)延迟,报 p50/p95;守静也在接收端验 | ⚠️ 已测,但**尺子有缺陷(F4)** | 接收端 `audible_gap`(a3,N=5):248 / 273 / 551 / 708 / 744 ms,**p50 = 551ms、p95 = 736.8ms、max = 744ms**,5/5 <1000ms。守静在接收端**不通过**:停后可听帧 63–261(F2)。台架自身的 `audibleStopLatencyMs` 会拿 bot 侧 tap 空隙顶替耳侧(3/5 轮),必须先修(F4) |
| ④ | C 臂附和不打断(不下阈值结论);无 provenance 台架必须拒跑 | ⚠️ 拒跑已验;C 臂**首轮即触发** | 拒跑四例正/负对照全过:provenance 缺失 → parse 拒;前缀非法 → parse 拒;合法 → 通过;真人类别标 `synthetic:` → `human_provenance_required` 硬失败。C 臂真房(c1 轮):呼吸 ×3 全部 `speech_started=0 / 门开=0 / yield=0`(合成 c-min);**附和第 1 轮就 `speech_started acted=true` 并 `yieldFiredCount=1`**,随即被 F1 打断整轮。
⚠️ 该轮 `gateOpenedCount=0` **不能**读成「门关着平台也照样报」—— 会话在 utterance 结束前就死了,
`uplink_gate_utterance` 汇总根本没来得及落账(c1 全轮只有呼吸 ×3 的三条汇总),所以那一轮门开没开**未知**。⚠️ 按 Lead 要求**不下阈值结论** —— 该素材是档案合成 `short-vocalization.wav`,离线校准里 maxProb 已达 0.99998,本就是已知开门样本,不能代表真人「嗯/对/哈哈」;C7.5 仍标「待 founder 录制」 |
| ⑤ | review 三条各有先红后绿回归测试;独立重放崩溃复现路径确认不崩;heard-note 在 idle 恢复后仍生成 | ✅ 单测层面 | 把 HEAD 的三个测试文件原样放到**修复前**头 `a6229c0` 的临时 worktree 上跑:`D-GATE6 preserves frame order`(+1 条)、`D-GATE5 restarts an active gated utterance`、`D-HEARD5 keeps the voice ledger known`、`wires self-mute to a non-replaying uplink mic gate`、`fail-opens a synchronous uplink ingestion fault`、`D-HEARD5 appends a heard-position note` —— **6 条全红**。同三文件在 HEAD **127/127 全绿**。⚠️ 但 `D-HEARD5 appends a heard-position note` 在单测里是"必须生成",而真机上正是这条 note 杀死会话(F1)—— 单测绿与产品可用在这一点上方向相反 |
| ⑥ | Silero 打分 ≤5ms、missed-tick=0 **真房实测** | ⚠️ missed-tick 已验;**打分时延真房无仪器** | 真房 a3(生产单进程,5 轮打断,~2.5 分钟):`clock:stall = 0`、`audio_clock_stall` 事件 0 条;`clock:delay` 5 次,22/23/30/43/50ms(max 50ms)。但**没有任何 evidence kind 携带每次打分耗时** —— `uplink_gate_utterance` 只有 `heldMs`(5/5 = 0)与 `endedWithScoreInFlight`(5/5 = false),`SileroVad.ts` 不发时延 evidence。⇒「打分 ≤5ms 真房实测」当前**测不到**,只有隔离串行探针的数(本轮复跑:max 0.189–0.353ms、p99 0.110–0.116ms、missed 0、gate passed)。这是仪器缺口,返工轮应补 |
| ⑦ | CI 在 raya 头与锚 PR 头都绿 | ⚠️ 锚 PR 绿;**raya 仓根本没有 CI** | 锚 PR #1035 头 `2ce5c9afd`:`CI OK` success、`Quick Gate` success、`Classify CI scope` success。raya 仓 `.github/workflows/` 不存在、`gh run list` 为空、该 commit check-runs = 0 ⇒ 不存在可核的 raya CI 凭据;只能以本地门代替(已复跑全绿),报告不把它记成 CI 绿 |

⛔ 禁令遵守情况:未碰生产 `~/.flywheel/raya/code`(判决后复核 `main@bb9656f` clean);未重启生产语音进程
(`com.xrli.raya.voice` 全程未被 load,验证用的是隔离轮目录里另起的进程,跑完无残留);未 merge raya PR #14。

## 附录 B — 关于登记头的核对(Lead `c73c6b5f`)

`qa-result` 命令**没有 PR 登记参数**,本次只传了 `--exec-id / --target-exec / --status / --summary`,
因此**没有登记任何仓的 PR**,不存在把 raya PR #14 登记成锚 PR 的风险(2029 死锁)。
判决正文里锚 PR 明确写为 flywheel #1035 / 头 `2ce5c9afd`,raya 实现头 `8776a6c2` 只作正文说明。
判决为 FAIL,不铸 ship 卡、不投 ship 报告。

## 附录 C — F1 的加重情节(C 臂带来的新信息)

c1 轮给出 F1 的**第三次独立复现**,并且把它加重了:触发它的不是真语音,而是一段**短促发声**
(合成附和素材)引发的平台 `speech_started`。⇒ 只要平台判一次开口 —— 哪怕是清嗓子那种误判 ——
整个 Raya 会话就会死。同时这意味着**F1 不修,C/D 两臂在真房里根本无法测完**:
第一次误触就把会话打死,矩阵后续轮次全部作废。返工顺序上 F1 必须排在 C7.5/ C8 之前。

## 附录 D — 补跑证据位置

- `~/.flywheel/raya/qa/FLY-2031/rounds/qa-20260902-fly2249-c1-backchannel/`(呼吸 ×3 + 附和,F1 第三次复现)
- 修复前红灯重放用的临时 worktree `/tmp/raya-fly2249-prefix`(detached `a6229c0`)跑完已 `git worktree remove`

## 附录 E — 替返工轮排掉一次失败:`appendText` 到底接受哪些 role

Lead 返工清单①提出「note 改 `role=system`(拒绝则 `user`)」。这是个未验证的猜测,
我用一支隔离探针(自己开 throwaway realtime thread,不经 Raya 语音栈、不改产品代码)当场量了三个 role:

| role | Codex RPC | 平台异步流 |
|---|---|---|
| `system` | ❌ **直接被拒** `-32600 Invalid request: unknown variant \`system\`, expected one of \`user\`, \`developer\`, \`assistant\`` | — |
| `user` | ✅ accepted | ✅ 4 秒观察窗内**无** `thread/realtime/error` |
| `developer` | ✅ accepted(RPC 层"成功") | ❌ `thread/realtime/error: "Developer messages are not supported for realtime sessions."` |

结论:
1. **`system` 不可行** —— 它根本不在 Codex 协议的 role 枚举里,连 RPC 都过不去。返工请直接跳过这一步,
   候选只有 `user`(和未测的 `assistant`)。
2. **`user` 在传输层可行**,但⚠️ **语义安全性未验**:user message 很可能被模型当成"founder 又说话了"
   而触发一次新 response,那对 barge-in 语义可能比不发 note 更糟。返工轮必须真房验这条,
   我这支探针只回答了"传得过去吗",没回答"传过去以后会怎样"。
3. 顺带这是 F1 根因的**第三次独立复现**,而且是在**裸 Codex realtime thread** 上复现的
   —— 与 Raya 语音栈无关,排除了"Raya 用法不对"的可能。
4. 该错误串在装机 codex 二进制里**零命中**(`strings | grep -c` = 0)⇒ 它来自 **OpenAI Realtime 上游**,
   Codex 只是转发。也就是说这是平台能力边界,不是 Codex 的校验,改 Codex 侧无解。

探针源码与原始 evidence 已存 QA scratchpad(`fly2249-role-probe.mjs` / `fly2249-role-evidence/`);
probes/ 下的临时文件跑完已删除,raya worktree 复核 clean。

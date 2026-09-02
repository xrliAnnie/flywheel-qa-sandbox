# FLY-2249 barge-in v2 — 实施证据
Issue: FLY-2249 (https://linear.app/geoforge3d/issue/FLY-2249/raya语音-barge-in-v2正确方向重做-消费平台-speech-started-触发现被静默丢弃保留停口恢复资产检测确认层按)
日期: 2026-09-02
基于: plan.md

## C2 · Silero / AudioClock

- 环境:darwin arm64、Node 25.6.1、`onnxruntime-node@1.29.0`、官方 Silero v6.2(`be95df9`),模型 SHA-256 `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`。
- 初次隔离测量共 7 轮,每轮 1,000 次真模型评分并跑 20ms `AudioClock`:max 分别为 `0.301 / 0.332 / 0.541 / 0.508 / 0.423 / 0.326 / 0.353ms`;全轮 p99 `<0.3ms`,missed ticks `0`。
- 迁到显式串行探针 `probes/fly2249-silero-clock.mjs` 后再跑 7 轮:max `0.137–0.420ms`,p99 `0.110–0.168ms`,每轮 fired ticks `4`,missed ticks `0`;5ms / 零漏 tick 门通过。
- 争用反例:把 clock、smoke、模型合同、gate 四个 Vitest 文件并行跑时,clock 样本出现 max `47.730ms`,p99 `1.031ms`,missed ticks `1`。Lead ruling `3f9e39a3-ecd7-40b3-84cf-352bb832818c` 裁定这是三个并行 ORT worker 的台架争用伪影:时钟测量移出默认 CI 矩阵,只保留显式串行探针;阈值不变、不加 worker 机制。C7.5 与真房 QA 仍必须带生产单进程的 max / missed-tick 实测。

## C2 · 首组离线校准

命令:`probes/fly2249-gate-calibrate.mjs`;网格 = minSpeech `100 / 200 / 300ms` × threshold `0.4 / 0.5 / 0.6`。这只是档案控制组,不是 C7.5 真人语料定稿。

| 样本 | 标签 | SHA-256 | maxProb | 100ms | 200ms | 300ms |
|---|---|---|---:|---|---|---|
| `true-speech.wav` | speech | `3e81e4d594a4395a4b693fae3244f37dccf42e892d99b4b2da12e57667588e04` | 0.999999 | open@280ms | open@380ms | open@460ms |
| `breath-approx.wav` | non-speech | `a1d1445643c63e02a3ee8a3cfabac557fe2351e23939b93b2395edd2d9525b0f` | 0.041577 | closed | closed | closed |
| `short-vocalization.wav` | non-speech | `e052009494e80a5e791c2dded73ff919525709936535076277a8f14c5ce8467b` | 0.999985 | open@140ms | open@240ms | open@340ms |
| `short-vocalization-nonsemantic.wav`(mono→stereo upmix) | non-speech | `f686bf4a5ec9736f74edaef69ef418646c9ea41b47ff6d57872f67836ffdcb9e` | 0.880754 | open@140ms | open@240ms | closed |

threshold 在这四个样本上不改变开门结论。FNR 全部为 `0/1`;负样本 FPR 为 100ms `2/3`、200ms `2/3`、300ms `1/3`。边界探查(minSpeech `500ms`,threshold `0.5`)让 `true-speech` 在 `660ms` 开门、`breath-approx` 与 `short-vocalization` 都关闭;该值不采用,因为会吞掉 <1000ms 耳侧预算。

Lead ruling `17978c81-ddb7-43c3-8ec1-d28210b1a1ac` 裁定不停方向:C3 继续,默认仍取 plan 的 200–300ms 档并标为 C7.5 待定。Silero 是声学前置门,短语气声由后续转写仲裁 + 附和词表共同处理;最终硬门不变 —— 真房 C 臂附和 `speech_started=0`,D 臂耳侧 `<1000ms`。C7.5 三层叠加仍不过 C 臂时再停下上报。

## C3 · 上行串行化、拒绝层删除与下行账本

- Raya commits:`7e70c1b`(FrameQueue residue)、`b0d044f`(48k stereo byte ledger)、`81d9676`(runtime/platform trigger + rejected-layer deletion)。三批均在专用 `raya-FLY-2249` worktree 完成并推送。
- `Uplink` 已将 gate 延迟线串入唯一上行路径;保护窗走逐字节 passthrough,epoch 边界不再清空 jitter。D-GATE4/5、D-BYTES 两种边界状态均通过。
- `BargeGate`、`WebRtcSpeechDetector`、`webrtcvad`、旧 density/config/evidence 全部删除;`scripts/qa/fly2249-dead-code.test.mjs` 对七个拒绝符号执行仓内零命中守卫。
- Downlink 账本统一使用 48kHz stereo 字节域:accepted / FrameQueue full+residue / PassThrough kind-deque。已覆盖部分帧消费、`6×targetFrames` 停滞、多 tick 零消费增量、外部 backlog 失配→`ledgerUnknown`。
- 平台 `speech_started` 已驱动原 0.55s 停口/抑制/恢复链;门开 600ms 无平台事件时只触发一次 `local_fallback`,迟到平台事件被 one-shot latch 拒绝。
- 提交前门禁:`@raya/voice` 36 files / 475 tests 全绿、typecheck/build 全绿、D-DEAD 守卫全绿。

## C4 · 平台触发与 heard-position

- Raya commits:`f758c1b`(heard-position 估算器 + fired evidence)、`1dd2c93`(平台/兜底竞争矩阵)。
- `speech_started` 的 Live / generation / protected / audible-tail 守卫已覆盖;重复事件、迟到事件、下一轮重新开闩均与同一个 one-shot latch 竞争。
- 门开后 600ms 兜底与平台事件互斥:平台先到会取消 timer;兜底先到只 flush 一次,迟到平台事件记 `already_yielded`。
- `HeardPosition` 用 Downlink 同域账本给出 `heardLowerMs / heardUpperMs / droppedMs`;转写正文只留在内存供后续补偿,持久化 evidence 只写 `heardTextPrefixChars`。
- D-TRIG1–8、D-HEARD1/2/2b 与完整 runtime 回归均通过。

## C5 · 仲裁语义

- Raya commit:`794ff02`。
- Inbox arbitration cause 已从旧 `local_yield` 拆成 `platform_speech_started | local_fallback`,并原样进入 `barge_item_transition`。
- 附和过滤在 release / arbitrator 之前执行,且同时要求 founder attribution、当前 session、active attempt、injectedAt 之后和整段词表命中;assistant、非 founder、旧 generation、无 active attempt 四类阴性守卫均覆盖。
- `response_cancelled` 可在 reading / awaiting_reply / arbitrating / false_barrier 提前持久化旧响应终点;false barrier 到达后走既有 final 快路。旧 generation 与无 active attempt 只记 evidence,不改变屏障。
- Backchannel / InboxArbitrator / InboxReader / runtime 共 135 tests 通过,typecheck 通过。

## C6 · developer heard-position 补偿项

- Raya commit:`6cdfbf3`。
- `fireLocalYield` 在 `barge_yield_local{phase:"fired"}` 与 `barge_heard_position` 两行 evidence 同步落定后,立即调用 generation-bound `appendText(note,"developer",gen)`;本地 yield token 让每次真打断至多发送一条。
- 文本只取 Raya 自己的保守 transcript checkpoint 尾 40 个 Unicode 字符,以 `【系统提示】` 开头并明确「不要复述」;不包含 user 转写正文。
- `bargeInHeardPositionNote=false`、`droppedMs=0`、`ledgerUnknown`、保护窗和同 token 重复均不发;stale / closed / exception 仅记 `barge_heard_note_failed`,不重试。异步结果返回时会复核 yield token,旧打断的迟到失败不得污染下一轮。
- 提交前门禁:`@raya/voice` 38 files / 504 tests 全绿、typecheck/build 全绿;focused Biome 与 `git diff --check` 全绿。

## C7 · 真房台架与门禁

- Raya commits:`dc6ac5d`(FLY-2249 room harness + live instrument evidence)、`97f5021`(全仓 formatter gate 清理)。
- 保留 object-mode ear-side capture 与 N=3 codec/uplink 指纹资产,把旧 detector 判据换成平台 `speech_started`、Silero gate、yield/fallback、heard-note、仲裁、post-stop audio/final、overflow 与 clock-stall 直接计数。
- 矩阵固定为 true speech ×5、breath ×3、backchannel「嗯/对/哈哈」各一、soft speech ×3、hesitant speech ×3;CLI 固定 exact `--raya-head`,provenance 使用 `human:` / `synthetic:` 结构标签。缺 provenance、真人类别冒充 synthetic 或矩阵不全均 fail closed;F 臂人工最后可听词仍明确保持 incomplete。
- 首轮全仓:build/typecheck 通过;contracts 62 + brain 125 + voice 505 + QA 118 = 810 tests 通过;串行真模型/AudioClock 7 轮 max `0.197–0.390ms`、p99 `0.123–0.152ms`、每轮 missed ticks `0`。lint 首轮只发现 3 个 formatter drift,`97f5021` 后 lint 全绿。
- C7.5 状态:**未完成·待真人语料**。Lead `26ba20d3` 同意保持已审 `200ms / 0.5` 默认、不造假;founder 一次录完清单与 exact QA 顺序见 `qa-handoff.md`。

## Review 返工与最终门禁

- focused review round 1 在 Raya head `a6229c0` 拦下两条 HIGH:`uplink-gate-mute-unmute-crash` 与 `uplink-gate-degrade-frame-reorder`;Lead 同时把 `downlink-ledger-unknown-latches-after-idle` 升为本单必修。`08ef0bf` 以 TDD 修复三条:同一 owner 的 mic reopen 会重新 `begin()` active gate、runtime 数据入口同步异常转 fail-open 而不崩进程、gate degrade 当刻按 push 顺序冲刷 delay、player idle 换流不再把 ledger 永久锁成 unknown。
- 对应红→绿测试:`D-GATE5 restarts an active gated utterance when the mic reopens`、`wires self-mute to a non-replaying uplink mic gate`(unmute 后真实再写一帧)、`fail-opens a synchronous uplink ingestion fault without crashing`、`D-GATE6 preserves frame order when an in-flight score fault fail-opens`、`D-HEARD5 keeps the voice ledger known after player idle recovery`、`D-HEARD5 appends a heard-position note after player idle recovery`。
- `aee03de` 把既有 `fly2249-gate-calibrate.test.mjs` 四条测试接进 root `test:qa`。round 2 在该 head 通过硬门,但指出 idle rebase 会让 accepted byte origin 后退而 transcript checkpoints 留在旧坐标;`8776a6c` 改为保持 accepted bytes 单调,仅重置新 PassThrough 的核销账本,并把 gate delay 公式收口为唯一 helper、ingest fault 改成独立 evidence kind、`takeDue` degrade 分支显式 break。
- fresh review round 3 gate `9d5c1072-a265-41a6-b762-3bd228a0d120` 在精确 Raya head `8776a6c256f7f9a4d0d5b903562b28031811e79f` **APPROVED**。伴生 PR:[raya #14](https://github.com/xrliAnnie/raya/pull/14),需要 founder 独立 merge 授权。
- 最终 Raya 门禁:`pnpm lint`、`pnpm -r build`、`pnpm typecheck` 全绿;contracts `62`、brain `125`、voice `512`、QA `122`,合计 `821` tests 全绿。`codex:rescue` companion 也按合同在最终返工前后调用,但 resident 外层 macOS seatbelt 均在读取仓库前以 nested sandbox status 71 拒绝,因此未伪记 PASS;结构化 cross-family review 才是有效 review 证据。
- APPROVED advisories 已报告 Lead:未改动的 `InboxReader` suppression-bound / user-final 窗口可能滞留 lease(MEDIUM);无 idle 事件的静默 player stall 会让 PassThrough ledger 增长(LOW);removed-option dead-code guard 的字符串可读性(LOW)。均按 `medium_low_findings_are_non_blocking_v1` 留待 follow-up,不改写本单 C7.5/C8 真房硬门。
- Flywheel 锚仓门禁:`pnpm lint` exit 0(14 条既有 warning/diagnostic)、`pnpm -r build` 22/23 projects 全绿。精确 `pnpm test:packages:run` 在受管无 GUI 会话中只有两条真实 Terminal.app / HiServices 用例因 `Connection invalid` 失败;headless core 为 19 files、219 pass / 3 skip。随后 aggregate 的五个未改动文件在并行负载下出现 6 条 timeout/state-collision failure,逐文件串行复跑 5 files / 91 tests 全绿;未把该 aggregate 记成全绿。

C7.5 状态保持:**未完成·待真人语料**。本实现节点没有真房验收、merge、部署或 ship。

## 独立 QA FAIL 后返工

- 独立 QA 在 Raya `8776a6c` 证伪 developer note、耳侧守静和台架归因;原始 FAIL 证据保持在 `qa-report.md`,没有覆写为通过。设计更正见 `design-correction.md`。
- `c839c4c` + `2946581`:heard-position 改为 generation-bound user context,文本以 `[旁注,勿回应]` 开头并声明不是用户新发言;transport 请求流回归证明只发 `appendText`,不发 `createResponse`。
- `e54e77a`:`audibleStopLatencyMs` 只接受 ear-side `audible_gap`;较早的 server `tap_gap` 仍保留诊断,不能再赢得验收候选。
- `ba35afd`:当 founder speaking 仍为 true,仲裁 timeout 重新布防而不恢复被打断 inbox item;长发言持续跨多个 2.5s window 的红→绿回归已覆盖。
- `2134132`:room harness 的 heard-note expected count 绑定 `--heard-position-note enabled|disabled`,note-off 对照不再结构性假失败。
- `200727a`:每条 `uplink_gate_utterance` 新增真实 score 调用的 `scoreCount / scoreMsP50 / scoreMsP99`;确定性测试以 `1 / 4 / 9ms` 样本证明 nearest-rank p50/p99 聚合。
- `69faed0`:suppression-bound failure notice 与 user final 竞态时立即归还 code-speech lease;正常 suppression-bound 两段式归还合同保持不变。
- rework 全仓门禁:`pnpm lint`、`pnpm -r build`、`pnpm typecheck` 全绿;contracts `62`、brain `125`、voice `516`、QA `124`,合计 `827` tests 全绿。Raya exact head `2b5ecd370f39270458f9051110868cf0ed3b6f1e` 已推送。
- fresh review round 4 gate `900ec44f-7645-428a-8ef6-96bb98b49d9f` 在精确 Raya head `2b5ecd370f39270458f9051110868cf0ed3b6f1e` **APPROVED**。新增 advisories:Discord speaking-end 丢失时仲裁重布防没有绝对上限(MEDIUM);user-role note 的「不触发 response」仍须 N≥5 真房语义臂裁决(MEDIUM)。旧的 player silent-stall ledger 增长与 dead-code guard 可读性维持 LOW。均已通过强制 report 通知 Lead;没有把 advisory 写成已验收。
- Flywheel 锚仓在返工文档头上重跑精确门禁:`pnpm lint` exit 0(14 条既有 diagnostics),`pnpm -r build` 22/23 projects 全绿;`pnpm test:packages:run` 仍仅有受管无 GUI 会话的两条 Terminal.app / HiServices 用例因 `Connection invalid` 失败,其余 core 为 19 files / 219 pass。该环境失败与 FLY-2249 改动无关,仍如实保留为非绿聚合。
- C7.5 和 note 语义真房臂仍未完成:必须使用 founder 真人语料,且 note-on 真打断至少 N=5 无可归因于 note 的 response/转写;失败即按 `design-correction.md` 关闭 note,只保留 heard-position evidence。

## QA attempt 2 后的测量器返工

- 独立 QA attempt 2 在 Raya `2b5ecd3` 证明产品修复成立:note-on N=5 全部存活、耳侧停口 p95 `804.4ms`、停后可听帧 5/5 为 0、note 语义人工核验 5/5 无新 response。判决仍 FAIL 的唯一产品验收缺口是 C7.5 founder 真人语料;原报告见 `qa-report-attempt2.md`。
- 同轮暴露三个台架伪影:`postStopAssistantFinalCount` 把被打断响应自己的截断终稿算成新响应(F7);ear-side gap 可早于平台 trigger(F8);`nextResponseAtMs` 把旧响应尾部 delta/final 当成 note 新响应(F9)。
- `68af071`:stop candidate 新增平台 trigger 因果边界,触发前 ear-side gap 直接 fail loud;bot-side tap 仍只作诊断。
- `f247c12`:post-stop assistant-final 窗口显式排除已识别的 interrupted final,只统计真正新增的 assistant transcript。
- `ee10566`:note 语义窗口以新 assistant `transcriptId` 归因;旧 interrupted final 与 user final 后的正常 reply 均排除。`noteSemanticContractSatisfied` 进入 true-speech hard evaluator,不再依赖任意 audio delta 的代理时间。
- `f14da87`:room sample 汇总真实 `scoreCountTotal / scoreMsP99Max`,true-speech 必须有推理样本且 p99 `≤5ms`,否则 fail closed。
- Lead `[lead-instruction 4d17cd9c-247a-430b-a934-d10db636de50]` 补充 F10:`85cb8a4` 把零次推理的 `scoreMsP50/P99` 从伪装成功的 `0` 改为 `null`;passthrough-only room summary 同样保持 `scoreMsP99Max:null`,不能自动穿过延迟硬门。
- attempt-3 静态门禁:Raya `pnpm lint`、`pnpm -r build`、`pnpm typecheck` 全绿;contracts `62`、brain `125`、voice `517`、QA `126`,合计 `830` tests 全绿。exact head `f13a2c9e253962683bb334ab299430c781a9778f` 已推送。
- fresh review round 5 gate `ba5bae12-4c6b-4c37-98ca-3cb43ea40870` 在该 exact head **APPROVED**。非阻塞 advisories 已报告 Lead:pre-trigger ear gap 的 fail-loud 会中止整次 room capture、speaking-end 丢失时仲裁重布防没有绝对上限、user-role note 仍需真人语义臂(MEDIUM);player silent-stall ledger 增长与 dead-code guard 可读性(LOW)。它们没有被误写成已验收或阻塞 finding。
- Flywheel 锚仓 attempt-3 门禁:`pnpm lint` exit 0(14 条既有 diagnostics)、`pnpm -r build` 22/23 projects 全绿;`pnpm test:packages:run` 仍仅有受管无 GUI 会话的两条 Terminal.app / HiServices 用例因 `Connection invalid` 失败,其余 core 为 19 files / 219 pass。该环境失败与本轮仅改 Raya QA harness 无关,没有冒充全绿。
- C7.5 仍为 **未完成·待 founder 真人语料**;本实现没有用合成样本覆盖该外部依赖,也没有自行打开 ship 门。

## QA attempt 3 后的英文 L3 返工

- QA attempt 3 在 `f13a2c9` 的公开真人语料中记录到一轮 `"Yeah."` 附和;完整报告保留在
  `qa-report-attempt3.md`。Lead `[lead-instruction 84eac090-fbaa-4e3a-a7bd-a19ea60a9c8f]` 将第 4 轮
  返工锁为两项:补齐英文 L3 词表并增加 `"Yeah."` 大小写/尾标点回归;`200ms / 0.5` 不动,不加
  `minSpeech`,不改架构。
- 新默认配置级测试先以缺少 `yep`、`sure` 变红;`c0db13a` 只补这两个默认词,保留既有
  `yeah / uh-huh / mm-hmm / right / ok / okay`,并用实际默认词表证明 `"Yeah."` 归一化命中。
  `f950685` 仅应用 Biome 要求的机械排版。
- exact Raya head `f9506854fa1484464b799dba0613c559da1a72cc` 已推送。全仓 `pnpm lint`、
  `pnpm -r build`、`pnpm -r typecheck` 全绿;contracts `62`、brain `125`、voice `518`、QA `126`,
  合计 `831` tests 全绿。没有修改平台触发、神经门、仲裁身份守卫、停口/恢复链或任何阈值。
- fresh review round 6 gate `0233eae1-725a-4a21-8d01-b129ab207038` 在该 exact head **APPROVED**;
  finding 全为既有 MEDIUM/LOW advisory,没有 blocking finding。
- Lead 裁定 QA attempt 3 的 `"Yeah."` 由非 founder QA bot 发出,D-ARB2b 把它当真打断是正确行为,
  因此该轮没有测到 L3。第 4 轮直接在被测实例把 `RAYA_FOUNDER_DISCORD_USER_ID` 设为 QA emitter
  身份来重跑 backchannel/soft/hesitant;Lead 随后明确收回新增 harness 开关的要求,实现节点没有保留任何
  台架或产品改动。C 臂允许观察到 platform `speech_started=1`,硬语义改为 founder 归属附和不得造成耳侧
  停口、下行冲刷或输出截断。

## QA attempt 4 · OpenAI Realtime 外部额度阻断

- attempt 4 绑定 Raya `f9506854fa1484464b799dba0613c559da1a72cc`;相对 attempt 3 只改
  `config.ts / config.test.ts`,平台触发、L3 仲裁、神经门、heard-position 与 room harness blob 均未变。
  QA 重跑静态全门仍为 831 tests 全绿。
- founder 归属座按交接通过 process env 覆盖 `RAYA_FOUNDER_DISCORD_USER_ID`;两次隔离房间启动都在
  Realtime 到达 Live 前失败。直连 `gpt-realtime-1.5` WebSocket 三次均先 HTTP 101,随后服务端返回
  `insufficient_quota / credit_balance_exhausted` 并以 1013 关闭,证明认证正常而平台 API credit 已耗尽。
- 因外部额度阻断,founder 归属 backchannel/soft/hesitant、真语音 ×5 与呼吸 ×3 的 attempt-4 新真房证据
  均未产生;没有把未到 Live 的运行写成产品 FAIL 或验收通过。完整证据见 `qa-report-attempt4.md`。
- QA@5 必须在平台 credit 恢复后先跑一个两分钟隔离存活探针,只有确认 Realtime 到达 Live 才投入矩阵;
  若仍返回同一 quota 签名,应停止而非修改产品或台架来掩盖外部依赖。

## QA@5 前的短刺激测量器返工

- Lead 明确把返工锁为两处 harness-only 改动,产品代码与阈值不动。`9e476b4` 将非 `true_speech`
  的耳侧 gap 搜索窗从刺激开始延到 `min(userFinal, stimulusStart+3s)`,`true_speech` 保持原刺激窗。
- 694ms backchannel 夹具模拟 Raya 音频持续到 `+900ms`,随后耳侧静默 1,200ms:旧刺激窗返回
  `audibleGap:null`;扩窗后的真实 `summarizeSample` 产出 `audibleGap.atMs=+900ms / gapMs=1220ms`
  与 `audibleStopLatencyMs=900ms`。Lead 提供的独立
  `~/.flywheel/artifacts/fly2249/short-stimulus-gap-check.mjs` 同样 exit 0。
- 同一 summary 夹具把 `firstSpeechStartedAtMs` 移到 `+920ms` 时仍抛
  `ear-side stop candidate precedes platform trigger`,证明扩窗没有绕过 F8 因果守卫。
- backchannel hard evaluator 删除 `speechStartedCount !== 0` 字面硬门,改为三个直接听感/链路判据:
  `yieldFiredCount===0`(无下行冲刷)、`audibleStopLatencyMs===null`(耳侧无停口)、
  `oldResponseFinalCompleteness==="full"`(输出不截断)。三种反例各自 fail closed。
- exact Raya head `9e476b4` 已推送;`pnpm lint`、`pnpm -r build`、`pnpm -r typecheck` 全绿,
  contracts `62` + brain `125` + voice `518` + QA `128` = **833 tests** 全绿。founder 在 11:18 PT
  完成 OpenAI 平台充值;QA@5 仍须先跑隔离 Live 存活探针,再投入真房矩阵。
- fresh review round 7 gate `0d6767bc-5664-4da1-abe5-8fa074e0462a` 在 exact head
  `9e476b4906a107b019cf38daee4cb56970405ca6` **APPROVED**。新增 MEDIUM advisory 已报告 Lead:
  当前 runtime 只要 acted `speech_started` 就会立即 local-yield,因此新的 backchannel outcome gate 可能
  必然报 `downlink_flushed`;扩窗遇到上一轮迟到 user final 早于当前 stimulus 时也会 fail loud。它们不是
  blocking finding,没有在 implement 节点擅自改产品或撤销 Lead 指定判据;QA@5 真房结果负责给出下一步事实。

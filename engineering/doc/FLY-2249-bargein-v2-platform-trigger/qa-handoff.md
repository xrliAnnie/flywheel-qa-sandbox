# FLY-2249 barge-in v2·真人校准与真房交接 — QA 交接
Issue: FLY-2249 (https://linear.app/geoforge3d/issue/FLY-2249/raya语音-barge-in-v2正确方向重做-消费平台-speech-started-触发现被静默丢弃保留停口恢复资产检测确认层按)
日期: 2026-09-02
基于: implementation-evidence.md

## QA@6 founder 裁定交接

QA attempt 5 的原始判决保持 **FAIL(B 臂)**:公开呼吸/清嗓语料合并 n=9 中 8 条干净、1 条到达
OpenAI `speech_started`;泄漏 rep 没有逐 rep L1 `uplink_gate_utterance` 摘要,因此不能归因是门放行、摘要
落窗外还是链未关闭。A 真插话 n=5 全部以耳侧数据 `<1000ms` 停口且停后 0 可听帧/0 新终稿,D 轻声
3/3 到达平台;C 附和只记 leak 1/3,不附产品判决。原始数据与诚实边界见 `qa-report-attempt5.md`,不得
把 founder 后续豁免反写成「本轮测得 B 零泄漏」。

founder 实听后原话: **「目前来看效果还挺不错的」**。Lead 据此登记 Option A:对 B 臂的 **1/9**
泄漏作本单治理豁免,不要求 implement@6 调阈值或修改产品;implement@6 因此保持零产品/零 harness 改动。
QA@6 应在 exact head 上复验交接与工件完整性,把 B 原始 FAIL 与 founder 豁免并列记录,而不是删除失败数据。

当前待验 Raya exact head 为 `f8c638be765ff4a9043fb5ab07980ed884374573`:QA 自撰的 attempt-5 harness
经 implement 跨族只读复审后,已把短刺激窗口、逐样本 fault containment、leak/recovery/条目复位门、
schema-v2 L1 evidence、未知 mode fail-closed 与 never-resumed 负例钉住。该头本地证据为 probe
20/20、contracts 62 + brain 125 + voice 518 + QA 132、lint/typecheck 通过。Raya PR #14 仍需 founder
单独 merge authority;锚 PR #1035 是 `__main__` handoff 锚,两者不得互换。

## C7.5 状态

**未完成·待真人语料。** 已审默认值保持 `bargeInGateMinSpeechMs=200`、`bargeInGateThreshold=0.5`;没有真人校准数据前不改默认、不把合成样本写成真人通过。归档 FLY-2178 只提供合成呼吸、短促发声和 true-speech 控制组,不足以完成 C7.5。

## Founder 一次录完清单

- 呼吸:至少 3 条自然吸气/呼气,每条约 0.3–1.0 秒,不夹带词语。
- 附和:「嗯」「对」「哈哈」各至少 3 条,每条约 0.15–0.8 秒;按平时打断 Raya 时的音量说。
- 轻声:至少 3 条轻声「你等一下」或同长度真插话,每条约 0.6–1.5 秒。
- 犹豫分段:至少 3 条,每条约 1–3 秒;刻意含短音节和停顿,模拟 Discord 把一句话切成多段的情况。
- 正常真语音正对照:至少 3 条正常音量「你等一下」或同长度插话,每条约 0.6–1.5 秒。

设备:使用 founder 日常进 Discord 房间的同一支麦克风/耳机、同一输入增益与降噪设置,录制中途不要换设备。

环境:在日常使用 Raya 的房间一次录完;保持通常的门窗、电脑风扇和背景噪声,不要额外做录音棚式降噪。

格式:每条单独保存为 PCM16、48kHz、mono 或 stereo WAV;文件名写类别和序号,不放私人内容。每个输入给 room harness 传结构化 provenance:`human:<设备/环境简述>`;`synthetic:` 只允许标控制组,不能代替真人矩阵。

## QA 执行顺序

1. **先做额度存活探针。** founder 已在 2026-09-02 11:18 PT 完成平台充值;起一个两分钟隔离实例,
   确认 OpenAI Realtime 到达 Live 后立即
   拆掉。若直连仍返回 `insufficient_quota / credit_balance_exhausted`(HTTP 101 后 1013),停止本轮并保留
   服务端签名;不要继续投入矩阵,也不要改产品或 harness 掩盖额度错误。
2. 在 Raya exact head 上 build,用 `fly2249-gate-calibrate.mjs` 对全部真人 WAV 跑 `minSpeech=100,200,300` × `threshold=0.4,0.5,0.6`;呼吸与附和标 `non_speech`,轻声/犹豫/正常真语音标 `speech`。
3. 同表报告每格 FPR/FNR、每类 open rate、`openAtMs−onset` 分布。只有表能同时守住 B/C 零误触与 D 软声 ≤400ms 时,才提交选定默认;否则停下交 founder 裁取舍。
4. 用 `fly2178-bargein-room-run.mjs` 跑 exact-head 矩阵:A 真语音 ×5、B 呼吸 ×3、C 附和三种各一轮、D 轻声 ×3、迟疑 ×3。CLI 的 `--raya-head` 必须等于待验 SHA;provenance 缺失、真人类别标成 synthetic 或矩阵不全都会 fail closed。
5. 以 bot 耳侧录音判停口 `<1000ms`、停后守静和 `[heardLowerMs, heardUpperMs]` 最后可听词;不能用 bot 侧事件替代耳朵侧听感。candidate 必须在 `speech_started` 之后,触发前 gap 会 fail loud;呼吸 N=1 不得宣布通过,Opus tap 必须保持 `objectMode`。
6. note-on 真打断至少 N=5。`nextResponseAtMs` 现在只来自 note ack 后、founder user final 前、且排除 interrupted final 的**新 assistant transcriptId**;`noteSemanticContractSatisfied` 必须 5/5 true。任一轮失败就按 `design-correction.md` 关闭 note并跑 note-off 对照;不得继续调 prompt 后宣称通过。
7. 另跑 9/9 interrupted-item 恢复回归和串行 `fly2249-silero-clock.mjs`;要求 `uplink_gate_degraded=0`、`droppedOverflow=0`、`audio_clock_stall=0`、呼吸三次 uplink 指纹全等。true-speech sample 必须 `scoreCountTotal>0 && scoreMsP99Max≤5ms`;零次推理时 p50/p99 为 `null`,必须 fail closed,不能当成 0ms 通过。

## 硬判据归属

实现 PR 只交付仪器、fail-closed evaluator 和当前审过默认。C7.5 由 QA 拿到上述真人语料后完成;C8 再在同一 exact head 真房裁 A–H 与 A′。在 C7.5 产出和耳侧判决之前,本文件不得改写为「已完成」。

## QA@6 待验版本与复验边界

- Raya exact head:`f8c638be765ff4a9043fb5ab07980ed884374573`;Raya PR
  [#14](https://github.com/xrliAnnie/raya/pull/14)。锚仓 PR 为
  [#1035](https://github.com/xrliAnnie/flywheel/pull/1035)。
- QA@6 不重开产品设计,不调 `200ms / 0.5`,不增加 min-speech 规则。它核对 exact-head 工件、重放必要的
  fail-closed harness 合同,并把 B 1/9 原始 FAIL 与 founder Option-A 豁免写在同一结论中。
- B 泄漏 rep 缺 L1 摘要是仍然存在的测量归因限制;Option A 豁免泄漏结果,不等于证明 L1 摘要已逐 rep
  可靠落盘。若后续另开 B 路径诊断,范围只能是让 gate-utterance 摘要逐 rep 关闭或周期落盘后追因,不能
  在本单暗调阈值。
- C 臂继续只记 leak/recovery/条目复位/新 reply 数据;platform `speech_started=1` 本身不是独立失败。
  触发 rep 必须证明 `attemptBurned=false`、`false_trigger + front`、旧输出完整、flush/trigger 到重新可听
  `<=1500ms` 且没有新 assistant reply;未触发 rep 的自然耳侧 gap 只作信息。
- C7.5 仍是 **未完成·待真人语料**。founder 的本轮实听与 B 豁免不能冒充此前要求的同设备真人 WAV
  网格;若 Lead/Founder 后续另行关闭 C7.5,必须用新的明确裁定记录,不得由 QA@6 自行推定。
- attempt 4 的 `credit_balance_exhausted` 已由充值解除;attempt 5 已实际到达 Realtime Live。QA@6 不再把
  旧额度签名当成当前 blocker,但若新运行再次出现同一签名仍须原样保留并停止。

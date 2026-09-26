# Design Review — plan.md (Round 3)

Date / Author: 2026-09-25 / Codex / Status: CHANGES REQUESTED

## Summary

WebRTC + 订阅认证方向继续成立。v3 修复了 R2 的具体迟到事件反例，恢复了 T8，也正确收窄了父进程退出实验的结论。但 T5 的“有界缓冲”还不等于有界恢复；回放队列与现有插话触发条件之间新增了缺口；T5b 仍把旧回答的完成误当成新问题已答完。本轮 **3 HIGH、1 MEDIUM**。

评审基线：`47b1f619175e45d97229fd5a8bf93da7065bee86`；已确认磁盘 plan.md 与该提交一致。本轮重新读取 v3 正文和修订 diff，复核相关源码、消费者、固定 Codex 源码、probe 与 s3 逐帧证据，并用只在内存运行的脚本重放关键状态转换。没有运行项目测试套件、live probe 或操作 529 房；离线重放不等于实现测试通过。只写本反馈文件；评审期间观察到的四个设计展示文件改动未作处理。

下文 `plan.md` / `evidence/` 指 `engineering/doc/FLY-2885-webrtc-voice-connection/`；`V:` 指 `packages/voice-codex/src/`；`TL:` 指 `packages/teamlead/src/`。`P2884:` 指提交 `148e53fe0869e4a1d757a593003620eec34e301b` 下的 `engineering/doc/FLY-2884-discord-webrtc-voice/`；`C156:` 指本地 Codex clone 的 `rust-v0.156.1` 下的 `codex-rs/`。

| R2 项目 | 本轮结论 |
|---|---|
| R2-1 迟到证据吞句首 | **部分关闭**：原来的一秒静音反例现在能回放全部 40 个回答包；但短于 400 ms／没有合格间隙的路径仍会吞掉回答，见问题 1。回放还引入问题 2。 |
| R2-2 朗读错绑自然回答 | **部分关闭**：准入、逐块重检、抢占及 trim 结算已补齐；“任意 assistant done 晚于用户证据”仍不足以清除待答状态，见问题 3。 |
| R2-3 T8 误删／迁移缺失 | **原问题关闭**：`plan.md:199–216,262` 已恢复端到端契约和两侧测试。新增 digest 公式存在一处自引用，需要问题 4 的小范围修正。 |
| R2-4 orphan 证据措辞 | **关闭**：`plan.md:195–197` 与 EOF watchdog 源码一致，并明确 lsof 失败保留目录。无需恢复 owner/PID 方案。 |

R1 已关闭的资源替换 cut、租约检查、重连关闭屏障、可选 liveVoice、wrapper 去 key、QA 分阶段检查及 started/SDP 顺序，本轮没有出现需要重开的变更。“关闭”均指设计契约，不表示实现或真人 QA 已通过。

## What's Good (Keep)

- 从 cut 起保留原始音频，确实解决了“边界已过去，用户证据才到”的原始反例；对回放丢失给出可观测结果也是正确方向。不要退回把迟到事件直接当音频边界。
- T5b 在发送前准入、超时返回 busy、每块重新检查，并将 cut／换代／trim 纳入回执，明显优于只按 RPC 后第一条事件绑定。
- T8 保留完整 backing-thread 上下文，实时 prompt/items 分别计量、不截断，且修改容器旧的 startsWith 不变量。32,000 字节／128 条的 items 预算与 `C156:core/src/realtime_conversation.rs:1436–1454` 的校验相容。实际 context 路由直接返回 builder 结果，唯一生产调用是引擎 B 的 `V:cli.ts:427–435`；共享 client 只是泛型透传（`V:bridge-client.ts:510–523`）。无需为旧引擎新增此接口的迁移层。
- EOF 45 秒兜底的引用正确（`C156:app-server-transport/src/transport/stdio.rs:125–133,168–180`）；initialize-only 实验的适用范围也已说明。锁后清扫、busy/unverified 保留目录的简化方案可以保留。

## Issues & Recommendations

1. **HIGH — T5 没有合格静音段时仍可无限等待并吞掉整个回答；1.5 s 只限制存储量。〔R2-1 未完全关闭〕**

   **问题与证据：** `plan.md:134–136` 只有“找到 ≥20 个无声包”或“曾找到的段被挤出”两种恢复依据；`WaitGap` 没有失败期限。`head_lost` 也没有覆盖从未出现合格间隙的情形。持续收到静音 RTP 时，T2 的“5 s 无下行包”检测不会救回这个状态（`:86`）。

   **离线执行结果：** 原 R2 反例（旧音到 800 ms、静音到 1,800 ms、新回答到 2,600 ms、证据在 2,200 ms）现在成功输出全部 **40/40** 个回答包，这个修复应确认。将间隙改为 **800–1,120 ms，共 16 包**，新回答为 **1,120–1,820 ms，共 35 包**，founder 门已关、用户证据在 1,200 ms 到达：按 v3 转换规则进入 WaitGap，回答 **0/35 包**被播放；回答结束后的长静音只让它等待“下一次有声”，到 4 s 仍未恢复。此时不会记录计划定义的 head_lost。这是允许时序的合成反例，不冒充 live probe。

   现有证据也不支持把 400 ms 当作可靠分界：重新解析 `P2884:evidence/s3/frames-bridge.json.gz` 的 down 数组，按该场 `metrics-bridge.json` 的 RMS 阈值 300，70,174.6 ms 开始的间隙是 **19 包**；71,655.9–71,983.1 ms 是 **15 包**（零基索引 3184–3198），不是合格的 20 包。直到 79,358.2 ms 才出现下一段 24 包间隙。换用 probe 的 RMS 400 阈值，71.7 秒附近仍只有 15 包。因此本轮说明中“选中 71,838 前的长间隙”不能作为 v3 已通过 s3 的依据。这里仅验证包序列，不据此声称每包的语义归属已知。

   **为什么重要：** 缓冲有上限，等待时间和回答损失却没有上限；状态机可能把一次完整问答静音。单测列出“回答内 200–350 ms 停顿不作边界”还不够，必须覆盖“真正切换处也没有 400 ms 间隙”。现有 QA-4 只测停旧声，也会漏掉随后整句无声。

   **建议：** 明确“没有可判定边界”的有界失败／恢复路径及期限，不能仅继续等下一段静音，也不要通过强放旧音规避问题。给所有静音期间丢弃新内容的路径记明确结果。若继续使用启发式，区分已证实、估计及无法判断，收窄句首完整／零额外延迟的保证。补上述 16 包间隙、整段回答无合格间隙、双方事件缺失用例；断言最终实际播放序列或明确失败结果。QA-4 同时检查插话后的回答是否完整、何时开始可听。

2. **HIGH — 新回放队列会在 response-done 之后继续出声，现有插话条件因此可能完全不调用 cut。〔v3 新增的接口交互〕**

   **问题与证据：** `plan.md:135–137` 将最长约 1.5 s 的音频一次性推给播放器，并豁免回放包的普通裁剪；但 `:110` 仍按 WebRTC 下行最近 300 ms 的能量判断 response-active，`:112–114` 又明确保留 session.ts 的触发条件。实际 `V:session.ts:147–158` 只有在 `frontendResponseActive` 为 true 时才调用 cancelSpeech 和 room.cancelAllSpeech；`V:codex/CodexRoomFrontend.ts:162–166` 把 response-done 直接转成 false。

   例如回放后队列中还有一秒的有声包，而新到的 RTP 已连续 300 ms 无声：房间仍在播旧内容，backend 却报告 inactive。founder 此时开口，离开门的每一帧都绕过取消分支。正确实现了 T4 的 cut 也无济于事，因为没有调用它。离线按该规则重放，结果正是 inactive／cut 未调用；余下旧内容会自然播完。具体停声时长取决于队列余量，而非门打开时的本地截断。

   **为什么重要：** 新增回放后，“最近收到声音”与“用户还听得到声音”不再接近。它直接影响本单的“开口就本地截断、不要播完旧句子”，也削弱 T5b 的“600 ms 安静即无其他播放”前提。

   **建议：** 将待播有声包与播放器消费进度纳入 response-active／idle 契约：只要还有可能播出的旧有声包，插话就必须清队列。可以由 OpusDownlink 提供播放活动和排队状态，沿用现有 `V:audio.ts:363–374` 的消费进度思路，无需改变旧引擎。T5b 的空闲准入也需等待旧有声队列排空。补跨层测试：有回放积压、网络已静音超过 300/600 ms 时 founder 开口，验证 cut 确实执行，后续旧包消费为零；不能只单测显式调用 cut 的效果。

3. **HIGH — T5b 用任意晚到的 assistant done 清除待答状态，仍能错绑迟到的自然回答。〔R2-2 未完全关闭〕**

   **问题与证据：** `plan.md:149` 的条件③只是“最近用户证据之后出现过 assistant turn.done”，没有要求该 done 属于回应这一用户轮次的 assistant。`:151,153` 却据此断言没有在途自然回答、后续声音只能属于朗读。

   这种事件顺序已经出现：`P2884:evidence/s3/bridge.jsonl:261` 在 **70,747 ms** 收到新用户 delta；`:263` 在 **70,869 ms** 收到的 assistant done，内容仍是先前的“春天万物复苏……风会变得柔和”，不是新问题“四加四”的完成。此外，`evidence/probe-run2-prompt48kb.jsonl:17–19` 已证明自然回答声音可以领先 created **915 ms**。600 ms 安静并不是这些事件的最大迟到时间。

   **允许的反例：** 用户在旧回答已安静的间隙里说话，因此未触发本地 Muted；新用户证据在 t=0 到达，旧 assistant A 的 done 在 t=100 到达。新自然回答 B 在 t=1,000–1,100 出声后停顿，B 的 created 到 t=1,915 才到。t=1,700 时，四条准入条件全满足：没有已知 open assistant、600 ms 无声、门已关且 A.done 晚于用户证据、状态 Playing。此时发送 appendSpeech，随后 B.created 就被错绑。该序列只需要当前用户的 DC 事件缺失、已有 app-server 用户证据；这正是计划允许的退化输入，不要求后续事件永远缺失。B 后续音频和 done 会结算给朗读，通常提前报不等价；措辞恰好相同时还可能误报 confirmed。

   这不是声称既有 probe 做过该并发实验，而是利用已观测的事件次序和延迟构造准入反例。固定服务端仍只返回 appendSpeech 入队成功，没有 request→turn 标识（`C156:app-server/src/request_processors/turn_processor.rs:1339–1361`）；现有前端对 completed 无条件返回 confirmed（`V:codex/CodexRoomFrontend.ts:131–143`）。

   **为什么重要：** 新准入挡住了“自然回答持续出声”的旧反例，但不能把“旧回合结束”升级成“最新用户已获回答”。first-after-send 仍可能借用其他回合的证据。

   **建议：** 显式保留待答用户轮次／输入状态，禁止在该用户输入前已经打开的 assistant 回合之 done 清除它；不能只比较两个到达时间。结合已观察的 turn id 与生命周期，无法证明待答状态已消除时保持 busy／不可绑定，而不是发出后给出强 proof。将本反例、旧 done 晚于新用户 delta、短自然回答后长停顿、相关事件缺失加入准入测试；等价旧转写测试必须包含这些时序。加长 600 ms 常量本身不是关联证明。

4. **MEDIUM — T8 的 digest 输入包含带 digest 的 realtime.prompt，按正文计算存在自引用。〔恢复 T8 后的小范围契约修正〕**

   **问题与证据：** `plan.md:206` 定义 prompt 包含头，`:215` 明确头中有 snapshotDigest；`:210` 又要求 snapshotDigest 覆盖整个 realtime.prompt。这等价于要求 `D = SHA256(... prompt(header(D)) ...)`，不是正常的一次确定性装配。相比之下，当前 `TL:bridge/voice-session-context.ts:529–539` 先 hash 不含头的 assembled，再将 digest 写入头，明确避免了循环；同文件 `:594–603` 的返回 manifest 也另外加入 snapshotDigest，因此新公式中的 manifest 应明确是源 manifest／不含衍生 digest 的规范化部分。

   **为什么重要：** 两侧各自按字面实现会出现不同 digest 算法，或 builder 先用占位值 hash、校验器再按最终文本 hash，导致合法快照被拒绝。缺失 T8 的原问题已解决，这不是要求重做上下文方案。

   **建议：** 明文规定先构造不含头的 base body、realtime prompt body 和最终 items，对固定字段的 canonical 结构 hash，再给两个字符串加同一头；明确排除 manifest 中哪些衍生字段。最终字节/token 预算仍对加头后的实际发送文本计量。补一个 builder→container 的确定性样例，验证修改任一 prompt body／item 会改变 digest，而正确加头不改变其计算输入。

## Verdict

**CHANGES REQUESTED**。R2-3 的缺失任务和 R2-4 的进程退出说明可以关闭；继续保留已批准的认证、声线、旧引擎隔离及清理方向。实施前需补齐 T5 的无边界失败路径和播放队列活动语义，修正 T5b 的待答状态关联，并消除 T8 digest 自引用。无需扩大到通用 supervisor 或重新询问已获批准的产品取舍。

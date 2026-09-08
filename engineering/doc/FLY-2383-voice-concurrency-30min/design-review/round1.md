# Design Review — plan.md (Round 1)

Date: 2026-09-06
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向正确，但当前计划还不能安全地产出它声称的数据。最关键的问题不是 driver 的工程美观，而是测量效度：计划把 Discord 下行包的“有/无”当成 Raya 是否正在说话，但当前 Downlink 会连续发送 voice、bed 或 PCM silence；同时计划中的分钟采样与静默守卫会争用同一个会被 `arm()` 重置的 observer。按现设计，注入可能长期被错误跳过，或者分钟包统计被静默守卫重置，最后仍生成一份看似完整、实际口径错误的 manifest。

此外，计划只调用 `spawnVoiceProcess`，却没有补齐现有 529 路径负责的 marker、subject preflight、启动收据、全程房间 guard、共享锁和 fail-closed 清理；按当前 CLI 契约，缺少 `voice-mode.requested` 时进程会以 `voice_mode_not_requested` 拒绝运行。`GET /api/sessions?mode=live` 与 `last_activity_at` 也不足以证明真实 runner 正在执行。

因此本轮结论为 **CHANGES REQUESTED**。以下是数据可采信之前必须修正的计划契约；不要求改 voice pipeline，也不要求把一次性尺子做成新产品。

## What's Good (Keep)

- 明确把交付物限定为一次观测及数据附录，禁止修改 voice pipeline、触碰 production Raya、设置产品阈值；边界正确。
- 正场要求一场连续不少于 30 分钟，拒绝拼接短场；pilot 后再跑正场，顺序合理。
- bed ON 与 `bedEnabled:false` 必须分成两场，且明确 B 臂不是另一场 30 分钟；启动期配置这一事实与 `apps/voice/src/config.ts:622-624` 一致。
- 作废场次、`voice_exit` 和额度不足都要求如实保留，禁止只挑跑通的一次；这能避免幸存者偏差。
- 对干净 TTS 上行、无扬声器回灌、非真人听感、主动避开抢话以及不外推超过实测时长的限制写得清楚，应原样保留。
- 动态 import 后校验 `CONTRACT_VERSION === "raya-voice-529/v1"` 并 fail closed 是对的；不新建明文凭据文件也应保留。后述 lifecycle 问题与是否复制 `qa-raya-voice.sh` 的凭据文件模式无关。
- 数据附录坚持只陈述观测事实，并禁止把结果写成“可以同时做”，符合 PRD §7.2–§7.3 的逐字边界。

## Issues & Recommendations

### 1. P0 — “连续 3 秒 packets 增量为 0”不是 Raya 静默，且两条采样线会互相破坏

**证据：**

- `apps/voice/src/pipeline/Downlink.ts:189-210` 每个 tick 都会输出 voice、bed 或 PCM silence；只有 voice 分支才更新 `lastVoiceFrameAtMs`。所以内部 `hasInterruptibleAudio()` 能区分 voice 与 bed，但 Discord 接收端的 packet count 不能。
- `probes/c9-voice-emitter.mjs:185-195` 对收到的每个 Opus chunk 都累计 `packets/bytes`，没有区分 voice、bed 和编码静音；该文件 `:241-243` 还明确说明 Raya 是 continuous stream。
- 同一 observer 只有一组共享的 `armedUserId/packets/bytes/pcm/resolveAudio`；每次 `arm()` 都在 `:229-240` 清零并替换 Promise。现有测试 `c9-voice-emitter.test.mjs:215` 也明确验证了 re-arm 会 reset capture。

**影响：**bed ON 时 packets 必然增长；空闲时连续静音也可能增长。守卫会把安全的 bed/静音误判成“Raya 一直在说”，而每分钟的 `arm→睡→wait` 与每次 3 秒守卫的 `arm` 又会重置对方的计数。这样既得不到可信的 30 格序列，也不能据此避开 `hasInterruptibleAudio()`。

另外，`packets > 0` 最多证明 Discord 下行传输仍有 Opus 包，不能证明电话里存在可听音频。附录若继续记录该指标，名称必须写成“下行 Opus 包（包含 voice/bed/编码静音）”，不得把它表述为“声音连续”或“没有静音”。

**要求：**把下行观测改为一个单一所有者、只 arm 一次的连续时间线，分钟分桶、静音/bed/voice 判定都从这条时间线派生，不允许两个并发调用方 re-arm 同一 observer。静默守卫必须使用能区分 interruptible voice 与 bed/静音的可观测量，例如在 harness 侧解码 PCM 后做经过校准的内容分类，或增加只读的 harness/runtime evidence；不得再用 packet delta 代替。pilot 必须包含已知 voice、已知 bed 和已知静音的正/负对照，并把原始窗口保留下来。这个修正可以只改 QA harness/driver，不需要改 production voice pipeline。

### 2. P0 — 计划绕过了 `runVoiceSession`，但没有承担它的生命周期契约；按现计划甚至不会启动

**证据：**

- `spawnVoiceProcess`（`scripts/qa/lib/session.mjs:145-185`）只负责启动并拥有 detached process group。
- 当前 CLI 在缺少 `voice-mode.requested` 时返回 `{"status":"voice_mode_not_requested"}` 后退出（`apps/voice/src/cli.ts:296-312`）。marker 是 `runVoiceSession` 在 `session.mjs:79-85` 写入的；计划没有写它。
- `runVoiceSession` 还负责 room/identity preflight、等待本次 boot 的 Discord-ready 与 fresh Live receipt、全程第三人/目标 identity 离房 guard、child exit 竞速，以及 finally 中 leave、进程组终止和 cleanup census。聚焦单测 32/32 通过，其中现有契约明确把 missing marker、第三人进入和 cleanup 不收敛判为 instrumentation failure。
- 主 529 harness 另有 subject `cli preflight`、共享 `.raya-voice-529.lock`、exclusive run directory、lock 中的 child ownership 与 artifact secret scan；这些都不在计划的主循环里。

**影响：**最好情况是 voice 立即拒跑；更坏情况是另一个 529 场次并发占用 bot/房间，或 driver/终端中断后遗留 voice 进程，污染下一场和共享 QA 环境。只在开头做一次房空检查也无法发现 30 分钟中途第三人进入。

**要求：**优先复用/小幅扩展 `runVoiceSession` 来支持长观察窗；如果确实不能复用，计划必须逐项写出并测试等价契约：

1. room census 前获取与 529 相同的共享锁，并创建 0700、排他的 evidence 目录；
2. 用 subject dist 跑 `cli preflight`，校验嵌套 receipt 的 bot/channel；
3. 写合法 0600 `voice-mode.requested`；spawn 后立即把 PID/process group 写入锁收据；
4. 等待本次 boot 的结构化 Discord-ready 与 fresh `voice-session.json` Live receipt，之后才开始 30 分钟计时和注入；
5. 全场订阅第三人进入、Raya/emitter 离房和 child exit，任一发生即终止本场并保留作废证据；
6. `SIGINT/SIGTERM/异常` 全部进入同一 finally：emitter leave/destroy、SIGTERM process group、超时后 SIGKILL、await child/evidence flush、post-cleanup census、最后释放锁。

这不要求复制 shell wrapper 的临时凭据文件；无新明文凭据文件的设计仍可保留。

### 3. P0 — 用来证明“第一次打断必崩”的 F1 前提在锁定的 `b1b5a64` 上已经不成立

**证据：**旧 `qa-report.md:18-40` 的 F1 来自 `appendText(note, "developer", generation)`；但当前 `b1b5a64` 的 `apps/voice/src/runtime.ts:1095-1099` 已是 `appendText(note, "user", generation)`，构建产物同样如此。旧报告附录 `:201-215` 也只证明 `user` 在 transport 层不报错，并明确说语义安全性尚未真房验证。

**影响：**计划把一个已经修掉的确定性 crash 当作避开抢话的事实依据，会把本次观测缩窄成 silence-only，却让读者误以为这是当前 HEAD 的技术必需。它还掩盖了真正的问题：当前 `user` note 的 barge-in 语义是否正确仍未知。

**要求：**删除“当前 HEAD 第一次真打断会因 Developer messages 退出”的陈述。若本单经产品边界仍只测非抢话注入，可以保留，但必须把它写成显式测量范围，而不是当前 crash mitigation，并继续明确“没有测抢话稳定性”。若要以当前实现风险作为理由，pilot 应单列一次受控 overlap probe，观测 `b1b5a64` 的真实结果；该 probe 不得混入 30 分钟正场的 turn/稳定性数字。

### 4. P0 — 没有证据证明探针真的落在 bed 窗内，也没有把 assistant final 归因到对应注入

**证据：**`runtime.ts:2077-2090` 只有 busy 持续达到 `minBusyMs` 后才启动 bed；现有事件流没有被计划引用的 `bed_active` 收据。packet count 又无法区分 bed 与静音/voice。因此“抛一个工具问题”不等于每次探针播放时 bed 已经可听。

同时，`runtime.ts:1740-1760` 只在 final chunk 时写 `realtime_transcript`，但写出的 JSON row 本身没有 `final: true` 字段。按计划字面筛 `(role=assistant, final)` 可能筛不到任何记录。仅取“下一条 assistant final”也会把旧 response、探针自身触发的 response 或别的 turn 错配给工具问题。

**要求：**

- 为每个 ON 探针保存能证明 BoxB 在播放窗口内存在的耳侧内容证据，并在 OFF 臂证明同一检测器看不到 BoxB；不满足者记 `ineligible/skipped:not_in_bed_window`，不能计作识别 miss。
- 预先固定两臂相同的句子表、配对顺序和目标有效样本数 N；B 臂可以约 10 分钟，但“可比”必须由同句、同判定和实际 N 支撑，而不是只靠描述。
- 每轮使用唯一 nonce/canary，把 fixture hash、播放 `onStarted` 时间、匹配到的 user transcript、expected assistant nonce、assistant event 时间和 generation 写入同一 turn receipt。工具题应像现有 C4 一样由隔离 workspace + start instructions 限定，并用返回的 exact nonce 证明工具实际执行，而非只凭任意 assistant final。
- 明确定义 RTT：建议至少报告 `emitter playback started → matched assistant final`；若另报 `matched user final → matched assistant final`，必须作为不同指标命名。不得事后选择更好看的起点。
- 不要筛不存在的 `final` 字段；应说明这些 evidence rows 本来就是 final-only，并以 `kind/role/nonce/generation` 关联。

### 5. P1 — `mode=live` 加 `last_activity_at` 不能证明“真实 runner 编排在跑”

**证据：**`packages/teamlead/src/operational-terminal-status.ts:15-22` 的 live 集合同时包含 `pending`、`running`、`ship_parked`、`awaiting_review`、`design_done`、`approved_to_ship`。`packages/teamlead/src/bridge/tools.ts:145-161` 的 `mode=live` 只是按该生命周期集合取 session；`last_activity_at` 是通用 session 活动字段，不是 runner 正在执行的专属收据。Bridge 已有 `GET /api/sessions/:id/status`（`tools.ts:332-371`），会从实际 runner pane 判定 `executing/waiting/idle/unknown`。

**影响：**一个 parked/pending session 的 `last_activity_at` 变化也可能被报告成“真实编排推进”，从而错误关闭 PRD §7.3 的第三个条件。

**要求：**把 `mode=live` 仅用于候选发现；对至少一个非本 soak、`session_status=running` 的候选，在预先定义的采样点调用 `/status`，保存原始 receipt，并要求 voice 30 分钟窗口内实际出现 `status=executing` 的重叠区间。若没有合格 overlap，本场可以保留为观测，但不能算“三条件齐”，应重跑或明确仍缺第三条件。HTTP/auth/parse 错误必须记 instrumentation failure，不能写成 live=0。报告应写实际重叠时段/样本，不把整场都推定为 runner 忙。

### 6. P1 — disconnect/reconnect 与 meeting 事件的口径会产生虚假“0 次”

**证据：**`meeting_container_starting/live` 只在 `runtime.ts:548-668` 的 meeting 配置路径产生；标准 529 voice session 没有 meeting context 时，这些事件缺失是 N/A，不是“没有掉线”。`voice_exit` 才是通用进程退出证据（`runtime.ts:786-790`）。

**要求：**为本场实际启动模式定义可用的连接生命周期证据：本次 boot 的 fresh Live receipt、child lifetime/exit、Discord voice-state join/leave、receiver error/stream end 与连续时间桶。meeting 事件只有在确实配置 meeting 时才统计，否则在附录标 N/A。计划还应说明当前路径观察的是“是否退出/是否重新启动”，还是产品内部 reconnect；两者不能混成一个 `掉线/重连` 数字。

### 7. P1 — 证据 provenance、secret 最小化和 30 分钟计时尚未形成 fail-closed 契约

**问题：**仅校验 `CONTRACT_VERSION` 不能证明实际运行的是哪份 harness、哪份 subject dist。计划也没有规定 raw bundle、dirty state、dist hash、Bridge 原始采样、作废 run receipt、信号中断后的原子落盘。另需注意 `composeVoiceEnv` 会展开传入的 `baseEnv`；如果把整个 `~/.flywheel/.env` 当 base 传给 child，会把与 voice 无关的 Bridge/owner secrets 一起注入。

`startedAt/endedAt` 只能给人读，不能抵御系统时钟跳变；“30 个 60 秒格”也没有定义从 Live 前还是 Live 后开始、timer lag/partial bucket 怎么处理。只写“用 caffeinate”不足以证明没有睡眠断档。

**要求：**在计划中冻结 manifest/run bundle 契约：resolved harness/subject roots、完整 Git SHA 与 dirty bit、subject dist SHA-256、contract version、脱敏后的实际 CLI/config、channel/bot IDs、sentence-set/fixture hashes、wall-clock timestamps、monotonic start/end/duration、每个 raw evidence 文件及其 hash、所有有效/作废场次和 instrumentation errors。Bridge token 与 bot token单独最小读取；child 的 `baseEnv` 只用 Raya 必需项，不得把 owner `.env` 整包扩散；落盘前做现有同等级 secret scan。

30 分钟资格必须从 fresh Live + emitter joined 后的 monotonic clock 开始，要求 `performance.now()` 差值不少于 1,800,000 ms，并记录 event-loop/timer gaps；`caffeinate` 必须包住 driver 的完整生命周期。任何 child exit、房间 guard、receiver error、不可解释的大 gap 或 cleanup failure都应立即结束并把该 run 标为无效，而不是继续补齐 30 格。

## Verdict

**CHANGES REQUESTED**

在以下四项关闭前不能开跑正场：① 单一、不会被 re-arm 破坏且能区分 voice/bed/静音的下行时间线；② 529 生命周期/锁/marker/guard/清理 parity；③ bed 窗与 turn 的逐轮可归因收据；④ 能证明实际 runner executing overlap 的 Bridge 证据。其余建议用于防止附录把“不适用”“只见到包”或“live 生命周期状态”写成更强的产品结论。

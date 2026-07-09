# FLY-1047 /gemini 打断开关 + 开场音真机 QA — 判定报告 (qa-verdict)
Issue: FLY-1047 (URL 不可得,只写 issue 号)
日期: 2026-07-09
基于: plan.md / research.md §3 锚点表

## 总判定:**三条全 PASS**

被测目标:PR #501 head `6c3ec4093db29b7661bcc1b6ae27711476b9b859`(gh 核实无漂移,OPEN)。
被测 dist:QA 专用 detached worktree `/Users/xiaorongli/Dev/flywheel-FLY-1047-qa-target` @ 同 head,全仓 dist 独立重建。
barge-in 配置:assistant 块**不设** `bargeIn` → 验的是默认 ON(`config.ts:123`)。

| 判据 | 结果 | 关键实测数 |
|------|------|-----------|
| ① 打断能停 | **PASS**(P4.3 fallback 路径) | 注入→cancel **0.727s**(阈 ≤3s);flush 后 15s 零新音频;采集流距 cancel **3ms** 内戛止(阈 ≤1s) |
| ② 静默不误掐 | **PASS** | 开场 turn + 68s 静默 hold 全程 **0** 次 `response cancelled`;turn 以 `response done` 干净收尾 |
| ③ 开场音不丢 | **PASS**(两轮 daemon 各复现一次) | enterLive→首 chunk **0.76s**;`turn end — chunks=29 bytes=360002 dropped=0`;STT 转写为干净中文简报 |

## 逐锚点核对(research.md §3)

### ③ 开场音不丢(幕一,daemon-act1.log)

| 锚点 | 时间戳 (UTC) | 证据行 |
|------|-------------|--------|
| ③-1 | 15:19:02.794 | `state -> live (initial-check)` + `OPENING prompt sent to Gemini` |
| ③-2 | 15:19:03.556 | `response started` + `[assistant-speaker] turn begin`(距 OPENING **0.762s**,阈 ≤15s) |
| ③-3 | 15:19:03.556 | `first response audio from Gemini` + `[assistant-speaker] first audio chunk` |
| ③-4 | 15:19:11.083 | `turn end — chunks=29 bytes=360002 dropped=0`(N=29>0) |
| ③-5 | — | 探针采集 segment 15:19:03.742→15:19:11.272(~7.58s,与 daemon turn 窗口对齐);STT 转写:「你好啊,这份简报是早上8点18分生成的。你想聊聊哪个特定任务,还是看看最近的决策?…」→ `STT VERDICT: PASS` |

第二轮 daemon(幕二 fallback)开场再复现一次:15:26:46.849 live(initial-check) → 15:26:47.641 first chunk(0.79s),R20 懒开窗行为稳定。

### ② 静默不误掐(幕一,daemon-act1.log)

| 锚点 | 结果 |
|------|------|
| ②-1 | 开场 turn(15:19:03–15:19:11)+ 静默 hold(观察至 15:20:26+,≥68s)全程 `grep -c "response cancelled"` = **0**;真人(Annie web,self-mute)在场、探针无注入 |
| ②-2 | turn 以 `response done (audio chunks this turn: 29)` 干净收尾,非 cancelled;turn end 后日志零新事件 |

注:rig 无回声路径(探针/真人皆无播放外音),等价耳机场景——与 plan 预期一致。

### ① 打断能停(幕二 fallback,daemon-act2-fallback.log + probe.log 双 log 对时)

| 锚点 | 时间戳 (UTC) | 证据 |
|------|-------------|------|
| ①-1 | 15:26:50.092 INJECT → 15:26:50.819 cancel | probe.log `INJECT ▶ playing interrupt-zh-48k.wav` → daemon `response cancelled (barge-in) — flushing speaker`,**Δ=0.727s**(阈 ≤3s);中途 15:26:50.314 `first ears frame forwarded to Gemini` 证明注入帧真到 Gemini |
| ①-2 | 15:26:50.819 之后 | daemon log 观察 15s+ **零**新 response-audio /`first audio chunk`/playback 行;cancelled turn 无 `response done`/`turn end`(符合 research 预期,非判据) |
| ①-3 | last data 15:26:50.816 | 探针采集流最后数据距 cancel 时刻 **-3ms**(即刻戛止,阈 ≤1s);segment end `segBytes=1620480 (~8.44s 累计)` |

STT 全程转写结尾「好了,简报是8点26分生成的。」在句中戛止 = 第二开场被掐断的可听文本证据(out-capture.wav 末段)。

### 前置门(环境)

- 单测独立复证(QA worktree,全绿):voice-core **123** passed / voice-bridge **178** passed / teamlead linear-comment-and-lookup **18** passed。
  注:plan 预期数(116/131/18)与实测(123/178/18)有出入——实测计数更多、**零失败**;差异应为 plan 引用了父单早期轮次的计数,以全绿为门。
- 三 dist(voice-core / voice-bridge / teamlead)在自己 worktree 重建(实际全仓 `pnpm -r build` 因 teamlead 依赖链)。

## 执行偏差与注记(诚实声明)

1. **① 走了 plan P4.3 fallback**:幕二原路径(probe 问句诱导长回答)注入两次,daemon 确认帧到达 Gemini(`first ears frame forwarded`,累计 277 帧),但 Gemini 两次均未产生响应(无 `response started`)——2s 短问句在该 session 状态下未触发回答,属 Gemini 侧环境行为,非 PR 管道问题(帧转发链路已证)。按 plan 预案改为:关停本轮、重起新 autostart round、在**新开场 turn 中段**注入 interrupt。③ 已在幕一验证,开场被掐正是 ① 的证据。
2. **staged-bridge 复用而非自起**:发现父单为 Annie 留的 persistent venue(PID 835)+ 其 staged-bridge(PID 3400 @9877)在跑。按 Tadashi 裁决:venue daemon 由 Tadashi 本人停掉(释放 pool-04),staged-bridge 保留原进程复用(同 head、同隔离语义、非被测代码);我未 touch 任何 venue 进程。runner health port 9879→9880(9879 曾被 venue 占用)。
3. **真人腿**:Annie 应 Tadashi 请求在连接的 Chrome 登录 discord.com 一次(登录态此前缺失,QA 曾为此 park 等待);Chrome-as-Annie 进 VC 全程 self-mute(API 核实 `bot=false mute=true`)。
4. **边界(与父单 A8 一致)**:① 经 `allowUserIds` ears seam 注入(admit 后与真人同管道);物理真人(麦克风底噪/音量/VAD 灵敏度)只有 Annie 真用才覆盖 → 留给 Annie 最后一听。
5. **QA 素材**:probe-zh-48k.wav(2.04s)/ interrupt-zh-48k.wav(2.47s),均 pcm_s16le 48k stereo(ffprobe 核实)。
6. **机器负载**:开跑时 load ~16-29 (18 核),全程 rig 无音频卡顿表现。

## 补充判定 A:『⚠️ Gemini Live connection closed unexpectedly: The operation was aborted』(Annie 亲眼所见,FLY-1053 频道)

**定性:正常收尾断开模式,非故障;不影响 ③/① 任何判定。**

- 时间线:该 ⚠️ 出现在幕一 daemon 被 QA 主动关停的时刻。runner1 于 15:26:20 收到 quit 信号 → `state -> landing (trigger=external-stop)` → 关停流程 abort 掉**仍处于打开状态**的 Gemini Live WebSocket → SDK 上抛 "The operation was aborted" → orchestrator 把它渲染成频道警告。runner2 收尾(15:27:54 external-stop)同理。
- 判据窗口早已完成:③ 全部锚点在 15:19:11(开场 turn end)收官,比该 abort 早 **7 分钟**;① 在 runner2 于 15:26:50 完成,其 abort 出现在 runner2 自己的收尾。abort 与任何判据窗口零重叠。
- 反证:若是真故障,landing 链路不会完整——实际两轮会议纪要都自动落了 comment、FLY-1053/FLY-1054 都被 landing 链自动关为 Done。
- 与昨天 FLY-1017/1046 轮里的同款报错同源:会话被外部结束时的断开路径,非新问题。
- 改进建议(非 PR #501 行为缺陷,不影响本 verdict):orchestrator 应区分「主动关停」与「意外断开」的频道文案,免得 founder 把正常收尾读成错误——建议开 follow-up issue。

## 补充判定 B:替身静音状态(Annie 观察 vs API 证据)

Annie 观察到替身(Chrome web 的 xrliannie 连接)某时刻显示未静音;我方仅有起跑前 32s 的 API 抽查(15:18:25 voice state `mute=true`),测试窗口内未再抽查——两个观察无法完全对齐,如实记录。

**但两条判定都不受影响,有更硬的管道级证据(daemon ears 帧计数器)**:

- runner1 从起跑(15:18:57)到我方第一次探针注入(15:21:24)——覆盖**完整开场 turn + 68s 静默窗**——转发给 Gemini 的音频帧为 **0**(`response started (ears frames forwarded so far: 0)`;首帧 15:21:24.976 与探针 INJECT 时间戳逐毫秒对齐)。
- runner1 全会话累计 277 帧(~5.5s 音频)≈ 两次探针注入之和;runner2 累计 128 帧(~2.6s)≈ interrupt WAV(2.47s)。
- 结论:无论替身 UI 静音与否,**静默窗口内没有任何音频进入管道** → ② 的静默前提由管道计数器直接证明;① 的 cancel 只可能由注入帧触发(注入后 0.5s 内发生、且此前 8.5 分钟运行零 cancel)。

## 场地与生产隔离(红线核对)

- venue 冻结:零频道/权限变更;两轮 autostart kickoff issue **FLY-1053 / FLY-1054** 均已由 landing 链路自动落纪要并关为 Done(无残留,无需 Cancel)。
- 清场:runner×2 quit-file 干净关停(bots 全退)、探针 QUIT、Chrome Disconnect;结束时 API 核实 VC `members: 0`(15:29:07Z)+ 页面「No one is currently in voice」截图。
- 生产隔离:runner 守卫硬拒 :9876;全程只连 127.0.0.1:9877(隔离内存态 Bridge);生产 Bridge/StateStore/config 零接触。
- 源码零改动:QA worktree 为 detached 只读 checkout,QA 脚本全部在 /tmp/fly1047-rig(评审留档副本在本 evidence/ 目录);本分支只新增文档与证据。

## 证据清单(本目录)

| 文件 | 内容 |
|------|------|
| daemon-act1.log | 幕一 daemon 全量日志(③②锚点) |
| daemon-act2-fallback.log | 幕二 fallback daemon 全量日志(①锚点) |
| probe.log | 探针日志:INJECT 时间戳、OUT-AUDIO segment 起止、STT 转写与 PASS 判定 |
| act2-driver.log / act2b-driver.log | 幕二两次驱动脚本的对时日志 |
| out-capture.wav | 探针采集的助理输出音频(~16s:幕一开场完整 + 幕二开场被掐) |
| qa1047-runner.mjs / qa1047-probe.mjs / act2-drive.sh / act2b-drive.sh / vc-members.mjs | rig 脚本留档副本(运行于 /tmp/fly1047-rig) |

Chrome 截图(会话记录内,按 ID 引用):登出态 ss_0726wyxik / 登录+VC 页 ss_02416df6e / Annie+探针在 VC ss_0243s3amt / 全员退出后 VC 清空 ss_5325qrbdk。VC 成员权威核查以 vc-members.mjs API 输出为准(0/1/2 人各时点均有时间戳记录)。

## 结论(第一轮,head 6c3ec409)

PR #501 @ 6c3ec409 的 barge-in 默认 ON 行为、静默不误掐、R20 开场懒开窗修复,三条真机判据全部 PASS。

---

# 复验轮(round 2)— head 683418b4(round-6 真根因修复)

日期: 2026-07-09(晚)
背景: Annie 真机试用发现真根因——她停口时 Discord 静音抑制使音频流骤停、无 turn-end 信号,Gemini 永远等她「说完」;第一轮注入 WAV 的收尾形态未暴露此路径(盲区,本轮 4.1 有实锤)。修复 = ears speaking-end 时提交用户 turn(audioStreamEnd),commit `683418b4`(Codex R24 APPROVED)。本轮在**同一 QA worktree** checkout 683418b4、全量重建 dist 后执行。

## 复验矩阵结果:**全 PASS**

| 项 | 结果 | 关键实测 |
|----|------|---------|
| ③ 开场回归 | PASS ×3 | initial-check 路径 ×2(0.79s/0.80s 首 chunk,chunks=26/24 dropped=0)+ founder-join 路径 ×1(enterLive 即时) |
| ② 静默回归 | PASS | 68s 干净静默 hold:**0** cancel + **0** ears 帧(管道级静默证明);外加 34s 附加静默段同样零误掐 |
| ① 打断回归 | PASS | 快时机注入(首 chunk+0.8s):interrupt → `response cancelled (barge-in) — flushing speaker` **~1.4s**(阈 3s) |
| 新案例 A『骤停音频』 | PASS | 无尾静音 probe(1.997s,原素材尾静音仅 46ms 被剥净)注入 → `founder speaking-end — committing turn (105 frames)` → **2.5s 后 response started**、完整回答收尾。**同素材在第一轮 head(6c3ec409)两次注入均 NO_RESPONSE**——修复前后对照实锤 |
| 新案例 B『中途停顿』 | PASS | p1(1.12s)→ ~0.65s 停顿 → p2(1.83s):停顿期间**零抢答**(response started 仅在 p2 完结后出现一次),单次完整回答 43 chunks 干净收尾,零死锁 |

单测门 @ 683418b4:voice-core **124** + voice-bridge **179** 全绿(各含修复新增测试)。

## 4.1 计划外黄金证据:Annie 真人现场验证(物理真人差异 A8 覆盖)

复验期间 Annie 本人经 Chrome web 解除静音、用**真麦克风**与助理实时对话(runner3 会话,19:28-19:29Z):

- `founder speaking-end — committing turn (79 frames)` → **0.86s 后 response started** —— 真人骤停音频(Discord 静音抑制的真实形态)在修复头上立即得到回答;她的多个 utterance(66/95/109 帧)全部 commit + 应答,一场 755 ears 帧 / 283 chunks 的多轮对话流畅完成。
- 她插话时触发真人 `response cancelled (barge-in)`(19:28:08.7)——①的真人版。
- 她离开 VC 触发 `founder-leave` → session 正常 landing——founder-leave 收尾路径顺带验证。
- **Annie 原话验收:「感觉还不错,一来一回的」**(经 Tadashi 转达;她的文本面板显示反馈已拆 FLY-1065,不在 #501 范围)。

这组证据同时反证第一轮盲区:第一轮幕二同款 probe 问句两次「引不出回答」当时按环境记录——现在确认那正是根因的现场表现(骤停流 → server VAD 收不到尾静音 → 永久等待),复验案例 A 在新 head 上同素材直接通过。

## 复验执行注记(诚实声明)

1. ① 回归第一次注入曾出现 no-cancel FAIL-shape,诊断为 **rig 时机假象**:该轮回答生成窗口仅 5.5s,interrupt 帧到达时(注入+传输 ~0.5s)`response done` 已落——服务端无进行中生成可打断,interrupt 被当作新 turn 正常应答(log 可见 91 帧 commit + 完整回答)。快时机重试(+0.8s)1.4s 内 cancel;加上 Annie 真人插话 cancel 证据,①无回归。
2. runner4 一轮作废:Gemini 连接在 invoked 态空闲 5.5 分钟后 OPENING 无响应(环境形态,连接闲置失效);runner5 以 founder 先在场的 initial-check 路径即起即响。已按红线 6 区分环境失败与行为失败。
3. 复验期间 claude-in-chrome 曾断连(Chrome 重启后扩展未向 relay 注册),由 Tadashi 杀 native host + 重启 Chrome + Annie 点开扩展面板后恢复(新 deviceId 4077cf93);全程按「不 retry 循环、逐步升级」纪律处理。
4. 本轮探针 finalize 时 Decoder 崩溃,WAV/STT 自动归档失败;413s 采集音频已手动转出(/tmp/fly1047-rig/out-capture-r2.wav,79MB 不入库,留存至 verdict 消化);判据锚点全部在 daemon log,不受影响。
5. venue 处置同第一轮纪律:Tadashi 本人停 venue 开窗,QA 复用 staged bridge(本轮 :9878),零 venue 进程接触;结束时 VC members=0(API 证)。
6. 本轮 autostart kickoff issue(复验完整轮 R2 等)按 landing 链自动收尾,残留核查见 evidence 提交后的 DONE 报告。

## 复验证据文件

daemon3.log(Annie 真人对话 + ③②回归)、daemon4.log(作废轮,环境注记)、daemon5.log(③②回归 + 案例 A/B + 快时机①)、act3/act4 driver log、probe3 采集日志——本目录 `r2-*` 前缀归档。

## 最终结论

**PR #501 @ 683418b4:第一轮三判据回归 + 两个新案例(骤停音频/中途停顿)全 PASS,叠加 Annie 真人真麦克风现场验证(含她本人口头验收)。QA 放行,#501 交 founder ship 决定。**

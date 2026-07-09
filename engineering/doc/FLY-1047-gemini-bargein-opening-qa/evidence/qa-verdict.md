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

## 结论

PR #501 @ 6c3ec409 的 barge-in 默认 ON 行为、静默不误掐、R20 开场懒开窗修复,三条真机判据全部 PASS。建议:安排 Annie 最后一听(venue 由父单 implement 会话按流程重拉起,非本单职责)。

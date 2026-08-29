# FLY-1047 /gemini 打断开关 + 开场音真机 QA — 探索
Issue: FLY-1047 (https://linear.app/geoforge3d/issue/FLY-1047/qa-fly-967-gemini-打断开关-开场音真机验证pr-501-6c3ec409)
日期: 2026-07-09
基于: 无

## 1. 任务是什么(一句话)

对 PR #501(FLY-967 /gemini 纯 Gemini Live 语音助理)head `6c3ec409`(Codex R23 APPROVED)做**独立真机 QA**:在冻结的 staged Discord venue 上验证三条行为 —— ① 打断能停、② 静默不误掐、③ 开场音不丢。**只验证,不改源码,不 ship**。

## 2. 背景与前史(为什么是这三条)

- 父单 FLY-967 的 QA 已走过多轮:round-1 FAIL(daemon 接线 B1 + naming B2)→ 修复 → round-2 code-face PASS + staged「起一轮+简报真出」真机 PASS → round-3/4/5 真机 kickback 驱动了一串修复。
- **round-4 真机发现**:(a) sendText 发起的模型 turn(= /gemini 开场)从不开 response window,开场 chunk 全被 turn 闸丢掉 —— 修复 = **懒开窗**(`9963d876`:window 在一个 turn 的第一个模型输出上懒打开);(b) 音箱用户的麦克风把助理自己的声音回灌,server VAD 误判成打断,每条回复 ~0.3s 就被掐 —— 当时用 NO_INTERRUPTION 顶住。
- **round-5(Annie 拍板)**:加 `huddle.assistant.bargeIn` 开关,**默认 ON**(`b70b50b1`):ON = 省略 realtimeInputConfig(SDK 默认 START_OF_ACTIVITY_INTERRUPTS,耳机用户真打断);OFF = 钉 NO_INTERRUPTION(音箱用户防回声误掐)。R21(`5ac6b515`)补 config 非布尔值 fail-fast。
- 父单的三段式 QA 会话(b7b4b54d)因 pre-fix 的 browser-MCP 连不上 Chrome 被换掉;根因已修(Desktop native-host manifest 禁用 + Chrome 重启,FLY-1039)。本单 = 全新干净会话重跑这轮真机验证。

## 3. 三条验收标准的技术锚定

全部在 **bargeIn 默认 ON**(config 不设该键)下验证:

| # | 标准 | 被测链路 | 可断言锚点(日志) |
|---|------|---------|------------------|
| ① | 打断能停 | 人声进 ears → Gemini server VAD → serverContent.interrupted → voice-core emit response-cancelled → AssistantSession → speaker.flush() | daemon log「response cancelled (barge-in) — flushing speaker」出现在注入开始后 ≤3s;flush 后该 turn 零新 chunk;OUT 采集音频戛止 |
| ② | 静默不误掐 | 同上链路的反面:无人说话时 server VAD 不得误触发(rig 无回声 = 耳机场景) | 全幕(开场 turn + 静默 hold)daemon log **零**「response cancelled」;开场 turn 以「response done」+「turn end — chunks=N」干净收尾 |
| ③ | 开场音不丢 | enterLive → sendText(OPENING_PROMPT) → 懒开窗:第一个模型输出触发 response-started → speaker.beginTurn → chunks 流 → 真播进 VC | 「state -> live」→「response started」+「[assistant-speaker] turn begin」→「first audio chunk」→「turn end — chunks>0」;OUT 采集的音频 STT 转写为可读中文(非 GARBLE/静音) |

## 4. rig 现状盘点(父单遗产,全部可复用)

- **交接包** `~/.flywheel/qa-fly967-staged/`(implement session 留给 QA 的):`.env.staged`(LINEAR_API_KEY / 双 bot token / staged bearer / GEMINI_API_KEY,0600)、`projects.staged.json`(flywheel linear binding + huddle.assistant 块)、`README-for-qa.md`(跑法)、**`interrupt-zh-48k.wav`**(打断素材,462KB)、`fakeaudio-chrome.sh`(备用 IN-leg)、`founder-round.mjs`(无 autostart 的 daemon 起法)。
- **e2e 脚本**(在 PR 分支内,tracked):`staged-bridge.mjs`(隔离 Bridge :9877,内存态,硬拒生产 9876)、`gemini-staged.mjs`(真 daemon + autostart QA seam)。
- **scratch 探针**(父单 worktree,untracked 先例):`qa-injector.mjs`(pool-06 bot 进 VC,trigger 文件驱动播 WAV)、`qa-out-capture.mjs`(pool-06 订阅助理嘴的音频 → 录 → STT 判 PASS/FAIL)。
- **probe WAV**(问题语料,诱导助理长回答):父会话 scratchpad 有 `probe-zh-48k.wav`;丢了可用 macOS say + ffmpeg 重生成(aiff → pcm_s16le 48k)。
- **bot 身份**:pool-04 = Note-taker(ears)、pool-05 = orchestrator(嘴,user id 1523230048243417178)、pool-06 = 注入/采集(user id 1523232391349403850,已被 Annie 邀进 staged guild)。
- **venue(冻结)**:guild `1485787271192907816` / VC `1485787273193853170`(General)。只进不改:不建/不改频道、不踢人、结束即退。

## 5. 关键机制事实(决定方案形态)

1. **ears 只 admit 人类**(结构性防回声:bot 播放永远不会灌回 Gemini),但有 QA seam:`allowUserIds` 白名单可 admit 指定 bot id(`EarsReceiver.admitted() = isHuman || allow.has`)。admit 之后与真人**完全同管道**。→ 注入 bot(pool-06)的声音要打得动 server VAD,**rig 必须把 pool-06 id 放进 config.allowUserIds**;而 tracked 的 `gemini-staged.mjs` 写死 `allowUserIds: []` → QA 需要**自己的 untracked runner 脚本**(照 qa-injector 的 scratch 先例,不算改源码)。
2. **本地 onBargeIn 是 no-op**(wiring v1:`onBargeIn: () => {}`)——server VAD 是唯一打断主路。所以 ① 验的就是「音频→Gemini→interrupted→flush」全链,不存在本地捷径。
3. **founderPresent 只看 voice state 里有没有 bot=false 的人**——Chrome-as-Annie(Annie 登录态的 Discord 网页)进 VC 即满足,**麦克风可以全程 mute**(② 的静默前提也靠 mute 保证)。
4. **pool-06 一个 token 在同 guild 只能有一条 voice 连接** → 注入器与采集器不能各开一条。一条连接可以同时播(player)+ 收(receiver.subscribe)→ 合并成单探针脚本;不稳则分幕串行。
5. `staged-bridge.mjs` import `../../teamlead/dist/bridge/plugin.js` → 重建 dist 时 **teamlead 包也要 build**(不止 voice-core + voice-bridge)。

## 6. 方案对比

### 方案 A(推荐)— 复用 staged rig + 单-bot 合并探针,一次 daemon 两幕验三条

自己的 detached worktree checkout `6c3ec409` → 重建 voice-core / voice-bridge / teamlead 三 dist + 两包单测独立复证 → 起隔离 Bridge(:9877)+ 自写 scratch runner(allowUserIds=[pool-06],autostart,hold 加长,bargeIn 不设=默认 ON)→ claude-in-chrome 驱动 Annie 登录态进 VC(muted)→ 幕一验 ③+②(开场 turn 完整播完、零误掐、OUT 采集 STT 清晰)→ 幕二验 ①(注入 probe 引答 → 答话中注入 interrupt → cancelled+flush+音停)。

- 优点:全部构件都被父单真机跑通过(唯一新增 = allowUserIds 传参 + 探针合并);证据链完整(daemon log 锚点 + OUT 音频 + STT + 截图);与 issue 指定的 rig 路径逐字一致。
- 缺点/诚实边界:①的「人声」经 allowUserIds seam 而非 isHuman 分支进入 —— admit 之后管道相同,但**严格说验证的是「注入音频可触发 server 打断」**;真人开口的物理差异(麦克风底噪、VAD 灵敏度)只有 Annie 真用才覆盖(与父单 A8 边界一致,诚实写进报告)。

### 方案 B — fakeaudio-chrome.sh 独立 Chrome 当「人+麦」

独立 profile Chrome 用 WAV 当麦克风,human 账号进 VC —— IN-leg 走 isHuman 真分支,更接近真人。
- 缺点:需要 profile 里已登录的 human Discord 账号(状态未知);第二个 Chrome 与 claude-in-chrome 主 Chrome 并存有 debugger single-client 干扰风险(正是坑掉上一个 QA 会话的区域);Tadashi 在 issue 里点名的是 claude-in-chrome 主路径。→ **降级为 ① 的 fallback**(若 allowUserIds 注入打不动 server VAD 再启用,且先报备)。

### 方案 C — 只跑单测 + 代码审读

不满足 issue 的硬性「真机」要求。否。

## 7. 开放问题(带到 gate;可自决的已给默认)

1. ① 的打断时延阈值:采「注入开始 → cancelled 日志 ≤3s」+「flush 后该 turn 零新 chunk」。(自决默认,报告里给实测数)
2. autostart 建的 kickoff issue 事后处理:landing 正常会自动关;若中断残留,照 FLY-991/992 先例 Cancel 并注明测试产物。(自决默认)
3. OFF 档(NO_INTERRUPTION)不做真机验证 —— 需要回声 rig,且 issue 三条全是 ON 档行为;OFF 档逻辑已有单测覆盖。(scope 判断,gate 里向 Tadashi 声明)

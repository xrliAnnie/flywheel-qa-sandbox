# FLY-2031 随身语音(B):常开流 + 念读筛选 + 用嘴批 ship — 探索
Issue: FLY-2031 (https://linear.app/geoforge3d/issue/FLY-2031/rayav3-随身语音b常开流-念读筛选-用嘴批-ship)
日期: 2026-08-27
基于: 无

---

## 0. 读法(先读,否则会读错)

**成色标记沿用 PRD B(`product/doc/FLY-1850-headphone-voice-relay/prd.md` §0.2)**:

| 标记 | 含义 |
|---|---|
| 【她的自由表述】 | 她自己说的,逐字在 PRD B / A |
| 【PRD 已定】 | PRD 里 ✅ 的格子,本单可直接实现 |
| 🔶 | **不是她的原话** —— Runner 推的 / 为了能实现而填的占位;她一纠正就作废 |
| ⬜ | PRD 刻意留空,本单 **不填** |
| [main] / [本分支] / [flywheel 生产] | 每条事实描述的是哪个世界(raya `origin/main` b7abff4 / 本单分支 / Flywheel Bridge 生产代码) |

**本文的三个来源,优先级从高到低**:
1. PRD B v1.0(FLY-1850)§3 硬约束 + §5 已定行为 + §6 留空清单 + §9 non-goals;
2. PRD A v1.7(FLY-1846)§3 / §6 / §8.5 / §8.6.7 / §10(总管的脑子怎么开口、走哪条路);
3. raya 仓 `origin/main` @ `b7abff4`(FLY-2029 + FLY-2074 已 merge)的**代码本身**,以及 Flywheel 主仓 `packages/teamlead/src/bridge/voice-routes.ts`(FLY-546 语音批准通道)。

⚠️ **FLY-2030(大脑)的 issue 正文本节点读不到**(Linear MCP 401;GraphQL 同 token 400)。
2030 的范围按 FLY-2074 exploration.md:41–47 的分工表 + Lead 派工说明(「念读内容依赖的状态吸收由 2030 提供 … 接口对着 2030 的 brain 契约预留」)来定:
`它【说什么】:状态吸收、追问、议题、身份载荷内容 → 2030;念读筛选、转达 Lead、用嘴批 ship、Lead relay → 2031`。
⇒ 本单**不吸收状态**,只定义「状态怎么进耳机」的契约,并用 fixture 喂它。

---

## 1. 本单要做什么(issue 逐条 ↔ PRD 条款)

| # | issue 原句 | PRD 条款 | 成色 | 本单落点 |
|---|---|---|---|---|
| ① | 出声时机与念什么 | B §5.1 / §5.2 | 【PRD 已定】 | 进入语音模式那一刻主动开口;进来的一层=全部,出声的一层=筛过的 |
| ② | 筛选给机制不给标准(标准使用中长) | B §5.3 | 【PRD 已定】 | 起点不筛;她说「这个不用告诉我」→ 记住 → 下次少一点;「说一声」必须便宜 |
| ③a | 硬前提:链路每段常开流 —— 没声音送静音不能不送 | B §3.1d | 【PRD 已定·产品前提】 | [main] 已实现(§2.1);本单把它**在实际界面上验成前提**,不新增机制 |
| ③b | 沉默必须被主动打破 | B §5.4 | 【PRD 已定·通用定理】 | 存活信号机制:代码驱动的「到点出声」;**间隔数值 ⬜ 不填**(§6.2) |
| ④a | 她的话与文字通道同路落地 | B §5.5 | 【PRD 已定·形状】 | 她的话 → Discord 文字(同一落点);它自己判断,不每次回来问 |
| ④b | 动手前念专名和编号(收窄版) | B §5.6.2–5.6.4 | 【PRD 已定】 | 只在「要去动某张单/某个人/某个仓库」前念;念**转写原词**;复述验的是转写不验解析(§5.6.5) |
| ⑤ | 用嘴批 ship(她已确认) | B §5.7 | 【她的自由表述:yes】 | 接 Flywheel 既有语音批准阶梯(FLY-546 `/api/voice/ship-approval`),同一写入原语 |
| — | 验收:在我们实际使用的那个界面上验过,非 harness | B §3.1c | 硬验收门 | Discord 语音测试房 `voice-test-2`(id 1542708795720081408,Lead 2026-08-27 定的验收房,不占她的 General) + `#raya` 文字 + 真声真耳机;不是 fake transport |

### 1.1 刻意不做(⛔ 不许被本单顺手填上)

| 留空格 | PRD | 状态 |
|---|---|---|
| 打断 | B §6.1 | 🔄 她 8-24 裁「交给工程实施时判定」——v2 回合制,**本单不做**,实施时若发现能做再回来问她 |
| 存活信号的间隔 | B §6.2 | ⬜ 等她用起来。本单只做**机制 + 可改**,数值是 🔶 占位 |
| B4 兜底(挂错单) | B §6.3 | ✅ 她答「先跑一阵」——本单不设计 |
| 多人会议 / 会议 Topic | B §9 | 归 C / FLY-1851 |
| 它怎么判优先级 / 状态吸收 | A §10 / 2030 | 归 2030 |
| 我们自己做掉线重连 / 给 Codex 提 issue | B §9.1 | ⛔ founder 否掉的决定,不是候选 |
| 音色分配 / 男声 | B §6.6 | 不归本单 |
| 阈值数字 | B §8.2 | ⛔ 一个都不填(所有时间量都是可改配置 + 🔶 占位) |

---

## 2. 落点事实(先审代码,再谈方案)

### 2.1 raya `origin/main` @ `b7abff4` 已有什么 —— 逐项对照本单五格

| 本单需要 | [main] 现状 | 结论 |
|---|---|---|
| 上行常开流(她不说话也送静音) | `apps/voice/src/pipeline/Uplink.ts:89–99` `tick()` **无条件** `appendAudio`;队列空 → `PCM24_MONO_SILENCE`;`micOpen=false` → 仍送静音帧 | ✅ **已实现**。PRD §3.1d 「闭麦 = 不送」的冲突在结构上不存在:Discord self-mute → `runtime.ts:477–481` `setMicOpen(false)` → 上行**继续送静音** |
| 下行常开流(它不说话也不让 player idle) | `Downlink.ts:86–93` 每 tick 补到 `targetFrames`,空则 `PCM48_STEREO_SILENCE`;idle 3 次/分钟才判腿 down | ✅ 已实现 |
| 「它在忙」的听觉指示 | keyed busy(`item/started|completed`)≥ `minBusyMs` → `BoxBBed` 混入下行(`runtime.ts:717–731`) | ✅ 已实现(B §6.4.0b 的听觉通道) |
| 文字状态行 | 只有生命周期行:`✅ 已进入语音模式…` / `我下线了` / `⚠️ 语音断线…` / hold 行(`Coordinator.ts` `Announce`) | ⚠️ **转写不上屏**:`runtime.ts:639–648` 只把 `transcript/done` 记进 evidence,不发文字频道。FLY-2074 plan §2.10 的 StatusPresenter 没落地 |
| 往语音侧塞文字 | `RealtimeTransport.appendSpeech(text)` 存在(`RealtimeTransport.ts:225`),**runtime 没有用它**;`RuntimeTransport` 接口也没暴露 | 🔶 可用但**语义未验**:research §1.4 说「它会当成她说的」 |
| 逐字开场指令 | `realtimeStartInstructions` 每次 `realtime/start` 喂一次,≤ 8,192 字;来源 `RAYA_VOICE_OPTIONS_JSON.startInstructionsFile`(`config.ts:307–313`),否则一句默认中文(`cli.ts:56–60`) | ✅ 通道在;**内容归 2030**(FLY-2074 plan §9) |
| 她说的话去哪 | `transcript role=user final` → evidence 而已 | ❌ 没有任何「落地」 |
| 后台 Codex 能动什么 | `thread/start` `sandbox: workspace-write`,`writable_roots = RAYA_WORKSPACE_ROOTS_JSON`(生产 = `~/.flywheel/raya/code` + `~/.flywheel/raya/memory`),`network_access: true`,`approvalPolicy: never`;`config.ts:200–212` 禁止 workspace 与 state/metrics/CODEX_HOME/identity 重叠 | ✅ 后台 Codex 可以写文件、跑命令;**不能碰 `RAYA_STATE_DIR`**(这是有意的安全边界) |
| 存活信号 | 无。bed 只在 busy 时响;它不说话就是一片静 | ❌ 没有 |
| 筛选 | 无 | ❌ 没有 |
| 用嘴批 ship | 无 | ❌ 没有 |
| 身份 / 记忆 | `IDENTITY.md` + `MEMORY.md` 拼成 `baseInstructions`(`CodexLeg.ts:83–86`);memory 仓在 writable roots 里 | ✅ 后台 Codex 可以**写自己的记忆仓** |
| 谁能触发 | `RAYA_FOUNDER_DISCORD_USER_ID` + `RAYA_SESSION_TRIGGER_USER_IDS_JSON`;上行 `Uplink.owner` = 当前说话的授权用户 id | ✅ **说话人归属**已有(用嘴批 ship 的 `founderUserId` 有来源) |
| 会话生命周期 | on-demand:`#raya` 精确「进入语音模式」→ marker → kickstart;最后授权人离房 / 「退出语音模式」→ exit0;任一腿 down → exit1 → launchd fresh(记得:否) | ✅ 本单**不动**生命周期 |

**基线可信度**:本 worktree 上 `pnpm install --frozen-lockfile` + `pnpm test`(contracts 22 / voice 103 / brain 58)+ `typecheck` + `lint` 全绿,2026-08-27。

### 2.2 Flywheel 侧已有什么 —— 用嘴批 ship 的「同一条路」[flywheel 生产]

`packages/teamlead/src/bridge/voice-routes.ts`(FLY-546 B3-2)已经是一条**给语音 daemon 用的 Bridge 面**:

```
GET  /api/voice/scope          谁是 Lead bot / founder 指纹 / 哪些频道在范围内
GET  /api/voice/context        channelId → issue/lead 上下文
GET  /api/voice/gate-binding   messageId → 当前唯一的 ship-gate 绑定(fail-closed)
POST /api/voice/ship-approval  语音批准写入。守卫阶梯(voice-routes.ts:322–535):
     503 无 token → 403 kill-switch(FLYWHEEL_VOICE_APPROVAL="0";默认 ON)→ 400 receipt-first(没有书面回执卡就不写)
     → 409 binding 交叉核对 → 403 founder 身份 → VoiceSource 判词(只认精确「确认/对」,拒绝「不对/取消/不批」,其余 unclear;⛔ 没有分类器)
     → held(QA/评审没绿)→ writeGateResponseAndRunPostWrite(⭐ 和文字/表情批准共用的唯一写入原语)
```

⇒ **§5.5「同路落地」在 ship 这一格已经有现成的路**:文字批准(`text-approval-source.ts`:必须是 founder 本人**回复**当前卡片 + 固定词)、表情批准、语音批准三者最后都走 `writeGateResponseAndRunPostWrite`。本单不造第二条。

⚠️ **A §8.5 那把尺子**(假设使用者没有 flywheel 仓):Raya **不 import** Flywheel;它只需要「一个 HTTP 批准端点 + 一个 token」这两个**运行期配置**。换一台没有 flywheel 源码的机器,这一格退化成「语音批准不可用,它会明说」,其余四格照常。⇒ 这是**可选外部适配器**,不是依赖。

### 2.3 FLY-1911 原型验过的形状(不是规格,是「她验过能用」的证据)

| 形状 | 出处 | 本单怎么用 |
|---|---|---|
| 分身(沙箱内 Codex)写 outbox 文件,沙箱外中继替它送、回执写回它读得到的地方 | `prototype/hl-relay.mjs:1–5` | 「她的话落地」的执行通道形状 |
| 中继**自己**去核它话里的编号/数字(⭐ 核对只在沙箱外做) | `hl-relay.mjs:14–66` `verify()` | §5.6.4「复述念原词」/ §3.1e.1「抢答错数字」的结构性解法:核对不由说话的一方做 |
| 中继会安静死掉 ⇒ 每条消息要回执 + 自己活着的证据 | `hl-relay.mjs:3–5` | 存活信号 / 「已转告」证据不由发送路径书写 |
| 状态行必须**跟着对话流往下走**(新消息),不是原地改 | B §11.2 已收;research §4.5 B | 本单的转写/回执上屏用 send,不用 edit |
| 真人语音会整句听错(不只专名) | B §5.6.1b | 收窄仍成立;验收必须用**真人声**,不能用 TTS |

---

## 3. 五个问题域:选项、反面、取向

> 每格先写「她定了什么」,再写「实现上的分岔」。凡是我填的,标 🔶。

### Q1 它什么时候出声、念什么(§5.1 / §5.2)

**她定的**:一进语音模式就主动开口;Lead 要问的、要汇报的**全部**送到主管那儿(进来的一层);它替她过一遍只念该念的(出声的一层);形式 = 「现在什么情况 + 哪些要你决定」;心智模型「就像现在用 Discord 一样」:有新消息才处理,没消息不主动问。

**分岔 A:「进来的一层」从哪来** —— 归 2030(状态吸收)。本单需要的只是**一个契约**:

| 选项 | 反面 | 取向 |
|---|---|---|
| A1 brain 进程写文件,voice 进程读(`RAYA_STATE_DIR/voice-inbox/`,append-only JSONL + ack) | 两个进程隔文件通信,和 `voice-mode.requested` / metrics 同一族;brain 未落地前用 fixture 喂 | ⭐ **选它**:与仓内既有契约同形(`@raya/contracts` 只共享 `RAYA_*` env + 文件) |
| A2 voice 进程自己去读 Discord 频道 | 把状态吸收搬进 voice = 抢 2030 的活;违反「同一个脑子」(硬约束 2) | ⛔ |
| A3 voice 进程调 Bridge `/api/voice/scope`+`/context` 拿 Lead 消息 | 寄生 flywheel 部署现状(A §8.5) | ⛔ 只允许在 ship 那一格当**可选适配器** |

**分岔 B:怎么让 Codex 念** —— 语音侧只有两条文字入口(research §1.4):

| 通道 | 性质 | 限制 |
|---|---|---|
| `realtimeStartInstructions` | 逐字,可靠 | ≤ 8,192 字;**每次 `realtime/start` 只喂一次** |
| `thread/realtime/appendSpeech` | 会话中随时可喂 | 🔶 「它会当成她说的」——**语义未在实际界面验过** |

取向(**research.md §1.3 更正后的版本**;最初我打算让开场积压走 `startInstructions`,被 1911 实测推翻 —— 起会话→首问 24/34/38 秒都读得到开场指令,510/798 秒都读不到,`bridge-hl.mjs:790–793`):
- **内容永远跟着触发走**:开场积压和会话中新到条目**都**走 `appendSpeech`,文本 = 固定播报前缀(🔶 例:「【Raya 系统播报,不是 Annie 说的,请念给她听】」)+ 条目正文。`startInstructions` 只装「怎么念」(规则),不装「念什么」。
- **开场**:`RealtimeStarted` 后立刻喂第一批(1911 原型正是用 `appendSpeech("我上线了…")` 让它先开口,`bridge-hl.mjs:1385`);由代码分批,**每批末尾必须带「还有 N 条,说『继续』我再念」**(§3.2 宁可多说 —— ⛔ 不许静默丢弃)。
- **前缀语义必须先在实际界面上验**(§5 探针 P1,分支表先写):P5 证据显示 `appendSpeech` 的文本以 `[BACKEND]` 前缀作为 **user** 消息进入线程(`probes/evidence/P5-busy/P5-busy.jsonl`),模型会不会把它当「她说的」去回答,而不是「念给她」,没人量过。
- **P1 失败时的退路**(现在就写死,别到时候讨论):会话中新条目**不念**,只在文字频道发一行 + 把它留在 inbox,下一次开场(或她说「有什么新的」触发后台 Codex 读 inbox 文件)再念。⚠️ 这条退路**违反 §5.1 的「有新消息才处理」的即时性**,要如实写进 founder HTML 让她判。

**分岔 C:「念多少」** —— 她定「起码一开始全给」。⇒ 出声那一层的**默认 = 全念**,筛选只由 Q2 的规则减。⛔ 不许我预置任何「太长就摘要」的判断;超预算只能「分批念 + 明说还有」。

### Q2 筛的标准怎么长出来(§5.3)

**她定的**:起点不筛;她随口说「这个不用告诉我」→ 它记住 → 之后慢慢筛;终点 = 重要进展 + 需要她决定的;**「说一声」必须便宜**(她在开车)。

| 选项 | 反面 | 取向 |
|---|---|---|
| B1 规则文件由 voice 进程持有、**代码决定念不念**(⚠️ 位置在 Codex design review R1 被更正:不能放模型可写的仓,权威文件在 `RAYA_STATE_DIR/voice-filter.json` —— 见 plan §2.2/§12) | 规则要结构化(谁 / 什么类 / 关键词 → 不念);她那句话怎么变成一条规则是模型的判断 🔶 | ⭐ **选它**:机制(记住 + 应用)在代码,标准(规则内容)在使用中长;不绑 vendor(A §10.4b.2 的建议同族) |
| B2 规则只写进 `MEMORY.md` 散文,靠模型自己「记得别念」 | 检测器满足自己(B §5.6.4 那一族):它念不念全凭它自己说记住了;没有可测的行为 | ⛔ |
| B3 规则放 `RAYA_STATE_DIR` | 后台 Codex 写不了 state(config 禁重叠)⇒ 得走 outbox 中转;而且她看不见 | ⛔ |

「说一声」的代价:她说「这个不用告诉我」→ 后台 Codex 把它写成一条规则(outbox 动作 `remember_filter`)→ voice 进程校验 + 落盘 + 回执 → 它回一句「好,以后 X 类不念」。**不念专名**(这不是动单/人/仓库)。🔶 规则的**粒度**由她的话决定(某个 Lead / 某类 / 某个关键词),模型解析,代码只认三种字段。

### Q3 常开流(§3.1d)+ 沉默必须被主动打破(§5.4)

**§3.1d 在 [main] 已成立**(§2.1)。本单对它做的只有两件:
1. **把它验成产品前提**(§3.1c):在真实 Discord 语音房(验收房 = voice-test-2,Lead 定)里,她/QA 真声**自闭麦**(Discord self-mute)静默 N 分钟后再开口,会话仍活 —— 这正是 PRD §3.1d 写明「P-6c 没测到」的那一格(测试端不动 ≠ 桥侧零帧)。判据事先写死(§5 P0)。
2. **账本**:`audio_counters` 里已有 `sent` / `silence` 计数;验收时导出「上行 sent 帧数 ≈ 时长/20ms」作为「一直在送」的证据(⛔ 不拿「没断」当证据,拿**帧数**当证据)。

**§5.4 存活信号** —— 她定的:必须有;出声不只传信息,还是「我还活着」的证据;量级锚点「一小时」是体感不是配置。⬜ 间隔归 §6.2「等她用起来」。

| 选项 | 反面 | 取向 |
|---|---|---|
| C1 **代码驱动**的定时器:自上次它出声起超过 `livenessIntervalMs` 没有任何 assistant 转写 ⇒ 用 `appendSpeech` 触发一句短话(🔶 文案例:「我还在,没有新东西」;和 A §6.3 HL 建议的「我看了,没有」同形,但 B 侧要求来自 B §5.4 不来自 A) | 依赖 P1(appendSpeech 语义);间隔数值是 🔶 占位 | ⭐ **选它**:**触发不能交给模型**——否则「它没说话」和「它死了」同形,正是 §5.4 要破的 |
| C2 只用非语言的 bed/提示音当存活信号 | 她的原话是「一小时都不跟我讲话」——要的是**讲话**;bed 现在只在 busy 时响,改成常响又和 §6.4 的「它在干活」信号撞形 | ⛔ 单独用不行;可作 C1 的旁证 |
| C3 定间隔念 inbox 里的旧条目当存活信号 | 把「活着」和「有事」混成一个信号;§7.5 长会话里她本来就分不清答过什么 | ⛔ |

间隔:`RAYA_VOICE_OPTIONS_JSON.livenessIntervalMs`(运行期可改)+ 她在语音里说「别这么频繁 / 频繁一点」→ 同 Q2 的 remember 机制写进 `voice-filter.json` 的 `prefs.livenessIntervalMs`(她的一句话就能改,A §3.2「先能改」)。**默认值 🔶 = 占位**,founder HTML 里明写「这个数不是她给的」。

⛔ **不许用「不出声会掉线」论证间隔**(B §6.2 已把这个理由拆掉)。

### Q4 她的话怎么落地(§5.5)+ 动手前念专名编号(§5.6)

**她定的**:不是语音特有的问题,不为语音单独造一套;它要自己判断;只在要去动某张单/某个人/某个仓库之前把号或名字念一遍,其余一律不念;念的必须是转写原词。

**落点**:A §8.6.7 她给的判据 ——「需要我看见的在 Discord,不需要我看见的在 Mailbox」。她对 Lead 说的话**她当然要看见** ⇒ Discord 文字。「同路」= 和她坐在电脑前打字给 Lead 是同一个落点(Lead 的频道 / Round Table / issue thread)。

| 选项 | 反面 | 取向 |
|---|---|---|
| D1 后台 Codex 把要转达的话写成 outbox 文件(`{target, text, quotes}`);voice 进程**校验 → 念专名/编号 → 发 Discord → 回执写回 outbox** | 多一层文件中转;但它正是 1911 验过的形状,且核对天然在模型够不着的一侧 | ⭐ **选它** |
| D2 让 Raya 的 realtime 模型直接「说」它转告了,后台 Codex 用 `gh`/curl 自己发 | 「已转告」由发送方自己书写(B §5.6.4 ⛔);念的是它改写后的版本 | ⛔ |
| D3 Raya 给 Lead 走 Bridge mailbox(`flywheel-comm ask`) | 寄生 flywheel;而且她看不见(A §8.6.7 要看见) | ⛔ |

**§5.6 的结构性执行**(不是给模型的提示语,是代码里的门):

```
1. outbox 动作到达 {kind:"relay", target:"<lead>", text:"…", quotes:["FLY-1833"]}
2. 校验 quotes ⊂ 最近 user 转写原文(逐字)    ← 取的是【转写原文】,不是它归一化后的值(§5.6.4)
   不在 ⇒ 回执 rejected{transcript 原文} ⇒ 模型只能去问她,不能自己补
3. 回执 readback_required{"FLY-1833"} ⇒ 它念出来(v2 回合制:它念完才听)
4. 代码在 assistant 转写里看到那串原词 ⇒ 开一个短 grace(🔶 可改)让她说「不对/等等/取消」
5. 没有 ⇒ 发 Discord(Raya bot,带【转达 Annie 语音】+ 转写原文 + 它的整理版)⇒ 回执 sent{messageId}
6. 「转告了」只在回执 sent 之后才允许它说;messageId 是 Discord 给的,不是它自己写的
```

⚠️ **边界一(必须交出去)**:Lead 那一侧**认不认** Raya 转达的指令,是 Flywheel 的 Lead 提示词/策略(FLY-944 共享频道 mention gating 等),**不在 Raya 里**。本单保证的是:她的话以**可核的形状**落在她能看见的地方;Lead 照不照做,和她坐在电脑前打同一段字是同一个问题。
⚠️ **边界二**:「Lead ↔ 频道」这张表不能从 `~/.flywheel/projects.json` 读(A §8.5)。它是 Raya 自己的一份**运营者提供**的目录文件(🔶 放 memory 仓 `leads.json`,git 可审)。这台机器上的内容是部署事实,不是架构。
⚠️ **边界三**:复述验转写不验解析(§5.6.5)—— 她说 1833 它听对了却挂到 1838 上,这道门抓不到;B4 兜底她说先跑一阵(§6.3)。

### Q5 用嘴批 ship(§5.7)

**她定的**:yes。既有阶梯(B §5.7 留档):先落书面回执 → 校验绑定 → 校验 founder 身份 → 才写;沉默不算同意。这四步在 Bridge 里就是 `/api/voice/ship-approval` 的守卫顺序(§2.2)。

Raya 侧要补的只有「把它接上」:

```
inbox 条目 kind=ship_gate {issue, pr, gateMessageId, questionId, prHeadSha}   ← 2030 吸收;2031 用 fixture
  ↓ 它念:「FLY-2031 的 PR #964,要 ship 吗?」(§5.6:动单前念编号)
  ↓ 她说「确认」/「对」(精确词;其余 = unclear,不写)
  ↓ voice 进程:取【最近一条 user 转写原文】(不是模型转述)+ 说话人 = Uplink.owner
  ↓ 先在 issue thread 发一张书面回执卡(receipt-first,文字是收据)→ 拿 receiptMessageId
  ↓ POST <approvalEndpoint>/ship-approval {gateMessageId, questionId, prHeadSha, transcript{id,text,founderUserId}, receiptMessageId}
  ↓ Bridge 走它自己的阶梯,写入 = 和文字/表情批准同一个原语
  ↓ 它只能念 Bridge 回来的结果:written / held(评审没绿)/ unclear / 拒绝;⛔ 不许自己说「已 ship」
```

| 选项 | 反面 | 取向 |
|---|---|---|
| E1 Raya 做**可选外部适配器**:`RAYA_APPROVAL_ENDPOINT_URL` + token(0600 env);没配 ⇒ 这一格不可用且明说 | 多两个 env key;A §8.5 尺子下它是「接入一个别人给的批准端点」,不是依赖 flywheel 源码 | ⭐ **选它** |
| E2 Raya 只在 Discord 发「Annie 语音批了」文字,让 Bridge 的文字通道去认 | 文字通道要求 **founder 本人**回复卡片(`text-approval-source.ts:35`);bot 消息身份不对 ⇒ 永远 unclear;等于假批 | ⛔ |
| E3 Raya 直接改 Bridge 的 StateStore / CommDB | 寄生 + 绕过唯一写入原语 | ⛔ |

⚠️ Bridge 的 kill-switch `FLYWHEEL_VOICE_APPROVAL` 默认 ON(`voice-routes.ts:334`);`held` 时 Bridge 明确拒(FLY-1041)——它要**如实念**「评审还没绿,批了也 ship 不了」。

---

## 4. 硬约束对照(B §3 六条 + 3.1c/d/e/f + 3.2)

| 约束 | 本单怎么守 |
|---|---|
| 1 Discord 原有行为完全不变 | 只**加**:转达消息、回执卡、状态行都是新消息;不改任何既有路径 |
| 2 总管兼任,同一个脑子 | 语音线程 = IDENTITY + MEMORY(已有);inbox 由 brain 写;规则写进同一个记忆仓 |
| 3 载体 = Codex,耳朵嘴巴都归它 | 不自造 TTS/ASR;存活信号、念读全部经 Codex 的 realtime 说出来 |
| 4 假设没有 flywheel 仓 | 不 import;ship 批准是**可选端点适配器**;Lead 目录是 Raya 自己的文件 |
| 5 一开始简单一点 | 每格一个机制;所有「多快/多久/多少」都是可改配置 |
| 6 merge/ship 仍 founder-gated | 语音批准只是**多一条送到同一个门的路**,门还是那道门 |
| 3.1c 在实际界面验 | 验收全部在真语音房(voice-test-2)+ `#raya` + 真耳机;fake transport 只做单测;主 General 归她自用(B §11.3) |
| 3.1d 常开流 | [main] 已有;本单验证它,不动它 |
| 3.1e / 3.1e.1 它把能力说大 / 先报错数 | 「已转告」「已批」只能念回执;数字核对在 outbox 校验侧(1911 `verify()` 形状),不在它嘴里 |
| 3.1f 打断不了 | 不做(§6.1);念读设计按「它念完才听」写(grace 窗口从它念完起算) |
| 3.2 宁可多说 | 默认全念;超预算分批 + 明说还有;筛选只减不加 |

---

## 5. 探针(结果决定分支 —— ⛔ 分支在结果回来之前写好)

| # | 问什么 | 判据 | 过 ⇒ | 不过 ⇒ |
|---|---|---|---|---|
| **P0** 常开流·真房闭麦 | 她(或授权 QA 人声)在 voice-test-2 自闭麦 ≥ N 分钟(🔶 N 由 Lead 定,不填数)后开口,会话还活 | ① user 转写出现且内容对得上 ② assistant 转写出现 ③ 房里真有声音 ④ `audio_counters.sent` ≈ 时长/20ms | §3.1d 在 v2 + Discord + 闭麦上**坐实** | 上行静音帧没在送 ⇒ 是 bug(main 的 `setMicOpen` 路径),先修再验;**不是**产品前提被削弱 |
| **P1** `appendSpeech` 带播报前缀的语义 | 会话中喂「【系统播报】Tadashi 问:FLY-2031 的 PR 要不要 ship」 | assistant 转写把它**念给她听**(第二人称、转述),而不是当成她说的去执行/回答她 | 会话中新条目 + 存活信号都走 appendSpeech | 会话中不念,只上文字行;存活信号退成 bed(C2)+ 文字行;**如实写进 HTML 交她判** |
| **P2** outbox 校验闭环 | 后台 Codex 写一个 relay 动作,quotes 含一个转写里**没有**的单号 | 回执 rejected,它去问她而不是自己补 | 门有效 | 它绕过 outbox 自己发了 ⇒ writable roots / 工具面要收 |
| **P3** ship 批准端到端(非生产 gate) | 529 测试房或 Lead 批的一次真 gate:念编号 → 她说「确认」→ 回执卡 → POST → Bridge 写入 | Bridge 返回 written=true 且 issue thread 出现同一原语的后写行为 | §5.7 接通 | 卡在哪一级(receipt/binding/identity)就报哪一级,不改 Bridge |

⚠️ P0/P3 会碰她的环境(真房、真 gate)——**排期和「谁来出声」由 Lead 定**,本节点只写判据。

---

## 6. 与 2030 的接口预留(brain 契约 —— 本单写下,2030 落地后 rebase 联调)

```
RAYA_STATE_DIR/voice-inbox/items.jsonl     brain 追加(owner-private 0600)
  {v:1, id, ts, source:{lead, channelId, messageId}, kind:"question"|"report"|"ship_gate"|"other",
   needsDecision:boolean, text, refs:{issue?, pr?, gate?:{gateMessageId, questionId, prHeadSha}}}
RAYA_STATE_DIR/voice-inbox/acks.jsonl      voice 追加:{id, at, how:"spoken"|"filtered"|"deferred", sessionBootId}
RAYA_STATE_DIR/voice-filter.json           voice 写(经 outbox 提案校验)——R1 更正:权威文件不放模型可写仓
RAYA_STATE_DIR/voice-leads.json            运营者提供:[{name, aliases[], discordChannelId}] ——同上
RAYA_OUTBOX_DIR(新 writable root)          后台 Codex 写动作 {kind:relay|remember_filter|approve_ship, …};voice 写回执
```

**2030 要知道的三件**:① inbox 是「进来的一层 = 全部」,brain **不筛**;② `ship_gate` 条目要带 Bridge 绑定三元组(2030 从卡片/Bridge 吸收);③ `startInstructions` 的身份载荷内容归 2030,本单只在它后面**追加**开场积压并做 8,192 预算。

---

## 7. 假设清单(全部 🔶,Codex/Lead/她任一纠正即作废)

1. `appendSpeech` 加前缀能让模型把内容当「播报」而非「她说的」—— **P1 验**。
2. 后台 Codex 在 realtime 会话里会按指令写 outbox 文件(P5 已证它能跑命令;写文件是同一沙箱)。
3. `assistant transcript/done` 是平台记录的**它实际说出的话**,可拿来核「念了没有」。
4. 一个新的 writable root(`RAYA_OUTBOX_DIR`)是可接受的部署变更(要改 0600 env + contracts;Lead 定)。
5. Lead 目录文件由运营者一次性填好;内容是部署事实。
6. 存活信号默认间隔、readback grace、开场预算余量 —— 全是占位数,进 `RAYA_VOICE_OPTIONS_JSON`。
7. 2031 的实际界面验收可以用 **fixture 喂的 inbox**(界面真、内容假),并如实披露。

---

## 8. 会过期的结论

| 结论 | as-of | 重核 |
|---|---|---|
| raya main 头 = `b7abff4`,上述 `[main]` 行号 | 2026-08-27 | `git -C ~/.flywheel/raya/code log -1 origin/main`;行号用 `git log -S` 重定位 |
| `RuntimeTransport` 未暴露 `appendSpeech` | 2026-08-27 | `grep -n appendSpeech apps/voice/src/runtime.ts` |
| Bridge `/api/voice/ship-approval` 守卫顺序与字段 | flywheel `e33f87d70` | `sed -n '322,420p' packages/teamlead/src/bridge/voice-routes.ts` |
| FLY-2030 无代码、无文档落地 | 2026-08-27 17:30 PT | `git -C ~/.flywheel/raya/worktrees/raya-FLY-2030 diff --stat origin/main...HEAD`;Linear FLY-2030 |
| 生产 writable roots = code + memory | `~/.flywheel/raya/raya.env` 2026-08-27 | `grep WORKSPACE_ROOTS ~/.flywheel/raya/raya.env` |
| P-6c 没测「桥侧零帧」;Discord 侧 30 分钟静默 soak 数据点 = 0 | B §3.1d;FLY-2074 milestone | 本单 P0 跑完即过期 |

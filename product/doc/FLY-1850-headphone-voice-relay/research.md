# FLY-1850 随身语音(耳机模式)— 调研

Issue: FLY-1850 (https://linear.app/geoforge3d/issue/FLY-1850/voiceprd-共创-b-随身语音-不看屏幕时它念给我听我说话它转达回去)
日期: 2026-08-19
基于: exploration.md

> **这份只记录现状事实与出处**,不给方向结论,不替 Annie 做任何决定。
> 每一条都标了 **as-of** 和**怎么重核**。产品形态见 `exploration.md`,共创怎么往下走见 `plan.md`。
>
> **本文最重要的一句话**:**「耳机模式」不是从零开始 —— 它在 main 里已经有一大半了,
> 但缺的那一半恰好是"听她说话",而且整套东西今天一个进程都没跑。**

---

## 0. 🔴 会过期的结论(先读这张表)

| # | 结论 | as-of | 怎么重核 |
|---|---|---|---|
| E-1 | Codex v3 实时语音**能建起会话** | **0.147.0**,2026-08-17 | 本机今天已是 **0.148.0**,**未复验**。重核:跑 `FLY-1844/evidence/admit-webrtc.mjs`(需 scratchpad 装 `werift`),pin 版本绝对路径 |
| E-2 | `realtime_conversation` 仍是 `under development`、默认 false;CLI 无 voice/realtime 子命令 | **0.148.0**,2026-08-19(本单实测) | `codex features list \| grep realtime` · `codex --help` |
| E-3 | voice 三个包在 main 里是这个样子(§2) | `0742c4248`,2026-08-19 | `git log -- packages/voice-*` |
| E-4 | 生产**零部署**(§3) | 2026-08-19 本单实测 | `launchctl list \| grep -i voice` · `ps aux \| grep voice` · `~/.flywheel/projects.json` |
| E-5 | Bridge 的 `/api/voice/*` 四个端点**活着**(§4) | Bridge `buildSha=2df1fd06b`,2026-08-19 | `curl -o /dev/null -w "%{http_code}" localhost:9876/api/voice/scope` → **401**(不是 404)|
| E-6 | A(Raya)已定稿的形态(§6) | A-PRD **v1.7**,2026-08-18 | `product/doc/FLY-1846-global-chief-of-staff/prd.md` |
| **不会过期** | Annie 的逐字原话、她拍过的决定 | — | 除非她本人改口 |

---

## 1. 版本与来源纪律

- 本单**只读**,没有改任何生产代码/配置,没有启动/停止任何服务,没有跑任何 Codex 会话。
- 引 FLY-1844 的实验结论时**必须带 caveat**(该单 L-4 定的,逐字):
  > 引 E1/D3 时必须同时写明:两次都固定 `transport=websocket`,该 regime 下 v1 与 v3 都走不完,
  > 故只支持 websocket 路径内的结论。

---

## 2. 「耳机模式」在 main 里已经建了什么(FLY-546)

### 2.1 issue 层的事实

| 项 | 值 | 出处 |
|---|---|---|
| issue | **FLY-546**「[voice·④·v1.5] 耳机模式(完整 deliverable)」,parent = FLY-542 | Linear,2026-08-19 读 |
| 状态轨迹 | Backlog → In Progress(07-07)→ **Done(07-08 05:07)→ 同日退回 Backlog(07-08 19:53)** | Linear stateHistory |
| 落地的 | **只有 PR-1**「headphone mode PR-1 — per-agent voices + off-screen FIFO voice loop (**desk dry-run face**)」(PR #496) | Linear attachments |
| **它自己写的验收标准** | > **验收 = Annie 戴耳机离屏、一段真实工作流全程语音推进。** | FLY-546 description |
| 依赖 | 「依赖:③ Huddle 的语音管线;Annie 拍板 **Huddle 先试跑再开**」 | 同上 |

> 🔑 **这条验收标准值得单独看一眼** —— 它和 FLY-1850 想要的东西**几乎是同一句话**。
> B 要么继承它,要么明确地废掉它换一条,**但不该假装没有过。**

### 2.2 代码层:已经建成的是一整套「轮次纪律」

`packages/voice-core/src/headphone/turn-machine.ts` 里有一张 **state × event × action 的完整合同表**
(文件头 1–46 行),实现是纯事件驱动、音频/Discord/Bridge 全部注入。**它已经把 B1–B6 各回答了一个版本**:

| 对应 B 的哪一格 | 已实现的行为 | 出处 |
|---|---|---|
| **B1 什么时候出声** | 队列来新条目就念;**当前这一轮进行中,新条目只静默入队,绝不插进来** | 状态表 `queue_pushed` 行 |
| **B2 说多细** | 先念**标题 + 正文**;正文超过 **400 字** 就只念**标题 + 前两句**,再问「**要听全文吗?**」 | 状态表 + `turn-machine.ts:197`(`longBodyChars ?? 400`) |
| **B3 打断** | 她一开口就停嘴(`founder_speaking_start` → `stopSpeaking`),然后直接进「要回吗?」 | 状态表 `announcing` 行 |
| **B4 回话落地** | 听写完**先复述**「**我转告:{原话},发吗?**」→ 她确认才真发到 Discord;她说重来就重听写一次 | 状态表 `dictating` / `readback` 行 |
| ⚠️ **但别把复述读成 B4 的兜底** | **复述验的是【转写】,不验【解析】** —— 「她说 1833、听对了、却挂到另一张单上」时,**它复述出来的那句话是对的**,她听不出问题。⇒ 见 `exploration.md` §4 那张失效面拆分。**这条 2026-08-19 已同步给 C 线**(那边也把复述写成了错听的兜底) | 本单判断,HL 点名采纳 |
| **B5 边界** | ship 类条目走**单独一条批准轮**:先念确认句「你确认把 {issue} ship 上线?」→ **必须先落书面回执**再写批准;**沉默 15 秒 = 不批**;她说停 = 整个批准作废;kill-switch 关着时它会说「**这条我这里不能批…回屏幕处理**」 | 状态表 `awaiting_approval_confirm` 行 |
| **B6 失败** | 听不清 → **重问一次** → 还不清就**丢回队尾**;掉线给 **60 秒**宽限,回来接着同一条;**掉线时正在批的那一条立刻作废**;发送中掉线**先把这一发送完**再进宽限 | 状态表 + `turn-machine.ts:195-196`(15s / 60s 默认值) |
| ⚠️ **「60 秒」在本单指两件事,别混** | ① **上面这个** = FLY-546 的**掉线宽限**(代码默认值,有出处)· ② 另有一个流传中的「60 秒沉默」= **语音链路上的观测**,口径含糊(问完→答完 / 问完→第一声,两个量被混过),**至今未写入本单任何文档**。⇒ **看到「60 秒」先确认是哪一个。** | 本单 2026-08-20 自查 |

⚠️ **成色**:以上全部是 **代码现状**,**不是 Annie 在 B 这单里拍过的决定**。
它们源自 FLY-906 PRD(2026-07-06 她 APPROVED 的那份)的 §17/§14,**是为 Huddle 那个世界定的**。
**做 B 时可以拿来当参考,不能拿来当"她已经同意了"。**

📎 一处不实测不写死:状态表里写 barge-in「<100ms」—— 那是**代码注释里的承诺**,**本单没有实测**。

### 2.3 ⚠️ 缺的那一半:耳机 daemon **没有耳朵** —— 但耳朵本身在别处**是现成的**

> 🔴 **这一节我第一版写错了,已更正。**
> 我原本写的是「麦克风到文字那一段整段是空的」。**说重了** —— Honey Lemon 独立复核后指出并纠正。
> **「从来没有」和「有但没接线」症状一样,修法和代价差一个数量级。**(这句是他的原话,值得单独记住)

#### 耳机 daemon 自己的四个面

| 面 | 今天是什么 | 出处 |
|---|---|---|
| **出声(嘴)** | **有** —— 走**本机扬声器**(voice-core EdgeTts) | `voice-headphone/src/null-audio-io.ts` 文件头 |
| **听她说话(耳朵)** | **没接。** 今天 daemon 里的「她说的话」**只能是她在 Discord 频道里打字** —— founder 的文字消息被直接当成 utterance 灌进状态机 | `voice-headphone/src/daemon-core.ts:147-160`(`onFounderCoreMessage` → `handleEvent({type:"utterance"})`) |
| 发消息 / 落回执 / 提交批准 | **都是真的**(真 Discord、真 Bridge) | `null-audio-io.ts` 文件头 |
| 原计划怎么补耳朵 | 「M-B4 的 FLY-545 VC adapter」**只换音频面**,Discord/Bridge 两侧不变 | 同上 |

#### 但仓库里已经有**两条能用的耳朵**,耳机 daemon **一条都没接**

| 耳朵 | 做什么 | 现状 |
|---|---|---|
| **本机麦克风** `voice-core/src/audio/MicCapture.ts`(97 行) | ffmpeg avfoundation 连续采集 → **16kHz mono s16le** PCM 帧;可静音、跟随系统默认输入、有测试 | **真的,而且已经在用** —— 接在 voice-core 自己的 `talk`(converse face)上 |
| **Discord 语音房** `voice-bridge/src/audio/EarsReceiver.ts` | 一个「耳朵」bot 订阅房里**所有真人**(只订人不订 bot = 结构性防回声)→ 解码降混成 16kHz mono PCM;带 350ms backchannel 门(「嗯/对」不算打断) | 真的,是 Huddle 那条线的收音管线 |
| **PCM → 文字** | 两条耳朵都把 PCM 喂给 **Gemini Live**,由它出 `transcript` 事件 | `voice-core/src/cli.ts`(`registry.create("gemini-live")`) |

**本单实测**:`grep -rn "MicCapture" packages/voice-headphone/` → **0 命中**;
引用 MicCapture 的只有 `voice-core` 自己的 `index.ts` / `cli.ts` / 测试。

> 🔑 **更正后的一句话**:今天这套东西 = **「念给我听」是真的;「我说话」在耳机 daemon 里是假的(得打字),
> 但把话变成文字的两条管线在隔壁都是真的、只是从没接过来。**
> ⇒ B 的形状**不是「要把输入那半建出来」**,而是**「把两个已经存在、当初为不同 face 建的半边接起来」**。

#### ⚠️ 但接线不是零代价 —— 有一处和她已拍的前提顶着

两条现成耳朵的「听懂」那一步**都走 Gemini Live**;
而她为 B 拍的 vendor 是 **Codex**(A-PRD §8.6.1,她的理由逐字:「因为这样它就**已经具备可以说话的能力**了」)。

**同时**:FLY-1827 记录,今天**唯一被她真人验收过**的语音管线正是 `/gemini`(Gemini Live)——
「一来一回正常」,开场首 chunk 0.76–0.80s、真人说完到回应 0.86s。
而 **Codex 那条路至今没让它说过一句话**(见 §5.2)。

⚠️ **这不是反对她的决定,也不是建议换 vendor。** 是一条必须让她知道的事实:
**她选 Codex 的理由押在一个还没验完的能力上,而她唯一验收过的那条管线是另一家的。**
⇒ **这一条在 §5.2 和 `exploration.md` §5 的架构分叉里同时出现,不许被磨掉。**

📎 **不要和另一件事混**:Annie 曾「一票否决」的是 **gemini-cli**(那个写代码的 CLI,理由是「写的太差、千万不要抄」,
见 FLY-1827 被否清单第 1 条),**不是 Gemini Live 这条语音管线**。**两者不是一回事,别当成她否过 Gemini。**

### 2.4 那个缺口原本要靠谁补 —— 这条链已经断过

```
FLY-546(耳机模式)缺的音频面
   ↑ 原本由
FLY-545(Huddle VC 语音运行时)
   ↑ 2026-07-13 Annie 直令「545 折进去后整个不需要,清理掉」
FLY-1160(统一常驻 Claude 大脑)—— 2026-07-15 Done,PR #555/#550/#552
```

**同时必须记的**:FLY-1827 审计记录的四条语音管线真机结果里 ——
`/glaw`(Huddle)**founder 真机 FAIL ×2,7 分钟死窗**;`/eleven` 机器 PASS 但 **Annie 真人 FAIL(barge-in 风暴,R1 1.5s → R2 28.5s 雪崩)**。

⚠️ **我没有核到的一点,照写**:FLY-1827 那张表的日期是 **2026-07-17**,FLY-1160 的持久大脑是 **07-15 Done** ——
两者只差两天。**我没有查证这两次 FAIL 是不是在持久大脑上线之后跑的。**
⇒ **既不许当成「已经修好了」,也不许当成「至今没修好」。** 要用这条做决定就得先补这个核实。

### 2.5 三个包的规模(main,2026-08-19)

| package | 源文件 | 测试文件 | 源码行数 | 说明(取自 package.json) |
|---|---|---|---|---|
| `voice-core` | 31 | 34 | 5,692 | 可插拔 voice skill core;dual-face(announce / converse)+ BrainAdapter |
| `voice-bridge` | 46 | 60 | 13,225 | Huddle 常驻 Discord voice runtime;独立 launchd daemon |
| `voice-headphone` | 10 | 6 | 1,314 | 耳机模式 daemon(Discord gateway tap → FIFO 队列 → 轮次状态机) |

**最后一次功能提交**:`a5c012a40`(2026-07-17,FLY-1353)。其后只有两次顺带触及:
`e08c8d0a6`(FLY-1715 凭据隔离,08-13)、`f3a27971e`(three-stage 清理,08-13)。
⇒ **语音功能代码已经一个月零新增。**

---

## 2.6 🔴 B3 的实测数字到了(FLY-1911,2026-08-19)

> ⚠️ **1911 每个数字都标了「量的是什么」,因为它担心这些数会被拿去互相比较,而它们量的不是同一件事。**
> **下面两条读数说明必须跟数字一起进 PRD,不许只抄数字。**

| 量的是什么 | 数 | 出处 |
|---|---|---|
| 纯说话:请求 → 第一个音频包 | **610 ms** | S1 |
| 同上,换音色 | 841 / 818 / 725 ms | marin / coral / sage |
| 同上,长会话第 2/4/6/8 分钟 | 649 / 621 / 678 / 774 ms | S5 |
| **打断**:我开口 → **服务端最后一个音频包** | **150 ms · 217 ms**(两次独立) | S4 / S5 |
| **听懂**:转写落地相对我说完 | **早 0.4–0.7 秒** | E2 −432 / E1 −724 / S2 −738 |
| **端到端真干活**:说完 → 第一个回答音 | **19.2 秒**(含联网查 GitHub) | E2 |
| 回答音频时长 | 6.25 秒 | E2 |
| 长会话不掉线 | **10.4 分钟,4/4 全回,零 error** | S5 |

### ⚠️ 读数说明一:**150/217ms 不等于「她耳朵里安静了」**

**它量的是服务端多久停止发送,不是喇叭多久真的安静** —— **她耳朵里还有已送达的缓冲**。

> ### ⇒ **「她插话它让不让」这一半仍然没被这批数字回答。**
> **真实体感必须她自己插一次话才算数。**

⇒ **B3 只解锁了一半**:延迟/长会话有数了;**打断的体感仍然待真机**。

### ⚠️ 读数说明二:**19.2 秒不能和 610 ms 并列**

```
610 ms   它【张嘴】的速度
19.2 s   其中绝大部分是它在【跑命令等 GitHub】
```

**两个数放一起,会让人以为语音慢 —— 其实慢的是干活那段。**
⇒ **PRD 里必须分开写,并注明 19.2 秒里含联网查询。**

### 2.6b B8(并发)的实测 —— **只量到一半**(FLY-1911,2026-08-19)

| | 对照组(无语音) | 实验组(语音正在说话) |
|---|---|---|
| 往返中位数 | 652 ms | **687 ms** |
| 超时 | 0 / 12 | 0 / 12 |
| 期间音频包 | 0 | **166** ← 内部对照,证明往返确实发生在语音在流时 |
| 观测窗 | 14.4 秒 | 13.8 秒 |

> ### 🔴 三条边界必须和数字一起写,**不许只写数字**:
> 1. 量的是**进程/传输层仍即时应答**,**不等于**它能完成一次真正的 agent turn ——
>    **那条路今天 401,没量成**
> 2. **窗口 14 秒,不是半小时。她问的是半小时,不外推。**
> 3. 单机单进程观测,**不涉及真实 runner 编排**

> ### ⇒ 入 PRD 的口径(逐字):
> ### **「最糟的失败模式(整段被占住)已排除;真正那条仍未量。」**
> ⛔ **不许写成「可以同时做」。**

---

## 3. 生产部署:**零**

本单 2026-08-19 实测(全部只读):

| 探 | 结果 |
|---|---|
| `launchctl list \| grep -i voice` | 只有 macOS 自带的 `com.apple.voice*`,**没有任何 flywheel 语音任务** |
| `ps aux \| grep -E "voice-headphone\|voice-bridge"` | **零进程** |
| `~/Library/LaunchAgents/*voice*` | **没有** |
| `~/.flywheel/projects.json` 里的 `voice` / `huddle` / `headphone` 配置块 | **一个都没有**(config 是 fail-closed 的 ⇒ 等于全关) |

⇒ **代码在,东西没跑。** 与 FLY-1827 ③ 和 FLY-1844 的记录一致。

---

## 4. Bridge 这一侧:四个端点**是活的**

`/api/voice/*` 是耳机 daemon 唯一的 Bridge 窗口(StateStore 是进程内 sql.js,daemon **不许**跨进程读库文件)。

| 端点 | 干什么 | 出处 |
|---|---|---|
| `GET /scope` | 消息范围合同(哪些 bot、哪些 founder 频道、founder 指纹)。**daemon 自己不推导任何东西** | `voice-routes.ts:1-27` |
| `GET /context` | 频道 → 该说的那句话的上下文(拿不到就返回 `kind:"unknown"`,**不用 404 顶替**) | 同上 |
| `GET /gate-binding` | 消息 → **当前唯一**的 ship 门绑定,**fail-closed**:一条消息只能靠**落了库的绑定**进批准轮,**永远不靠作者或文本去猜** | 同上 |
| `POST /ship-approval` | 语音批准的**写入口**。守卫阶梯按响应优先级:503 无 token → 403 kill-switch → 400 **必须先有回执** → 409 绑定交叉校验 → 403 founder 身份 → 语音来源判定 → 才走**唯一可信写入原语** | 同上 |

**今天实测**(2026-08-19,Bridge `buildSha=2df1fd06b`,18 个 session 在跑):
`GET /api/voice/scope` 无 token → **401**(不是 404)⇒ **路由挂着、被 token 守着**,与代码里「永远注册、kill-switch 只答 403 不答 404」一致。

**kill-switch `FLYWHEEL_VOICE_APPROVAL`**:代码默认 **ON**,只有 `=0` 才关(`voice-headphone/src/config.ts:103`、`voice-routes.ts:332-334`);
它在 flag 治理里是 **owned exemption**(`packages/config/src/feature-flags/exemptions.ts:64`),不是普通开关。

> 🔑 **它不是一个没人管的默认值 —— 是她自己拍的。**
> `voice-routes.ts:332` 的注释逐字:`// ① Annie ②: FLYWHEEL_VOICE_APPROVAL is a KILL-SWITCH — default ON,`
> ⇒ 「默认开着」这件事**带 founder 出处**,做 B5 时**不能当成工程随手设的默认**。

> 🔑 **而且这条阶梯是"通往门"的路,不是"绕过门"的路。**
> 先落书面回执 → 校验绑定 → 校验 founder 身份 → 才写;沉默不算同意 ——
> **founder 门在链条里被保留着,只是入口从屏幕换成了嘴。**
> ⇒ 所以它和「merge / ship 仍 founder-gated」**并不真的冲突**。
> 【**这个判读来自 Honey Lemon 2026-08-19 的复核**,纠正了本单早先把它写成「三样方向相反、需要她 reconcile」的写法。
> 那种写法会把一格便宜的确认问成一场大讨论 —— 代价落在她身上。】

⚠️ **一处仪器边界,照写**:我**读不到活 Bridge 进程的环境变量**(macOS 的 `ps eww` 不给别的进程的 env)。
我核的是**两个可能设它的地方**——`~/.flywheel/.env` 与全部 LaunchAgent plist ——**都没有设**。
⇒ 「生产生效值 = 默认 ON」是**按配置来源推的**,**不是从活进程实测的**。

---

## 5. Codex 自带语音能力:证到哪一步了

### 5.1 已证的(FLY-1844,2026-08-17,codex-cli **0.147.0**)

- **v3 realtime 从未被服务端拒绝。** 纯订阅身份(`auth.json` 里 `OPENAI_API_KEY = null`)即可开 v3 会话,**独立复现 2 次**(P6/P7:收到 `thread/realtime/started` + `version:"v3"` + 后端 SDP answer)。
- 七月那句 `Voice session access denied` 是**走错通道**的产物:**v1/v3 走 WebRTC,v2 走 websocket**;
  当时的探针按 issue 要求只用 websocket ⇒ 结构上不可能拿到 v1/v3 的准入。**是实验设计盲区,不是数据问题。**
- 两组单变量对照:**A 隔离 transport**(websocket 拒 → webrtc started)、**B 隔离 version**(v1 拒 → v3 started)。

### 5.2 ⚠️ **没证的**(必须原样带着走)

> **已证明的只是会话能建起来**(握手完成、后端真实应答)。
> **「打电话那种完整体验」还没验** —— **不许在 PRD 里含糊掉。**(FLY-1850 issue 原文)

FLY-1844 §6 的未验清单里,直接落在 B 身上的:
**音质 / 延迟 / 打断**(只验准入,**没让它说过一句话**)· **长会话稳定性与断线重连** ·
**Codex 的嘴接进 Discord 语音房**(两端现成,**从未接过**)· **v3 上"边说边真执行命令"**(七月只在 v2 上验过)。

### 5.3 本单今天的新实测(2026-08-19)

```
codex --version                → codex-cli 0.148.0     (current 已从 0.147.0 前进)
codex features list | realtime → realtime_conversation   under development   false
codex --help | grep voice      → 无 voice / realtime 子命令
```

⇒ **两条含义**:
① FLY-1844 的准入证据 pin 在 **0.147.0**,**本机今天是 0.148.0,未复验**(见 E-1);
② 这仍然是个 `under development` 的能力,**协议随时可变** —— 这是 B 押在这条路上的**结构性风险**,
不是"暂时的小麻烦"。

---

## 6. A(Raya)已定稿的形态,对 B 构成的约束

> 逐条出处见 `exploration.md` §3.2(那份是给共创用的清单)。这里只补两条**对工程形态影响最大**的:

| A 的决定 | 对 B 的直接后果 |
|---|---|
| **§8.5 假设使用者没有 flywheel 这个仓库** | B 的语音回路**不能默认她机器上有 flywheel 源码**。⚠️ 而今天的耳机 daemon 是这个 monorepo 里的一个包、靠 `~/.flywheel/projects.json` 活着 —— **这两件事是顶的**,B 必须处理 |
| **§8.6.3 总管有自己的仓** | 同上。「Raya 是独立产品」和「耳机 daemon 住在 flywheel 里」需要一个交代 |
| **§8.6.1 vendor = Codex,理由是"它已经具备说话的能力"** | 她选 Codex 的**理由本身**就押在 §5 那条**还没验完**的能力上。⚠️ **这不是反对她的决定**,是说:**如果 §5.2 那些没验的项验砸了,受影响的是她当初选 Codex 的理由**,得让她知道 |
| **§2.5「一开始简单一点,让产品在使用中长出来」** | 任何"先把六格都设计全"的 B 方案方向就是错的 |

---

## 7. 我没查的 / 查不动的(**照写,不藏**)

1. **0.148.0 上 v3 准入没复验** —— 需要 scratchpad 装 `werift` 跑 FLY-1844 的探针。本单是 PM 节点,没跑。
2. **FLY-1827 那两次真机 FAIL 与 FLY-1160 持久大脑的先后关系没核**(见 §2.4)。
3. **活 Bridge 进程的 env 读不到**(见 §4),故 kill-switch 生效值是推的不是测的。
4. ~~**A-PRD §8.7.1 的「4C」题面找不到**~~ → **已由 Honey Lemon 独立复核并裁定**(2026-08-19):
   4A/4B/4C **三格都没有题面、没有选项域**(只在 `prd.md:831-833` 各占一行);
   而 §6.1 的 A6 **出处完整**(选项域 A/B/C 写了、她圈的 C、逐字结论在 `exploration.md:179/185/369` 与
   `plan.md:85` 交叉引用)。⇒ **B1/B3 按 A6 写(它会主动开口)。**
   ⚠️ **但不算已定** —— HL 会把这处矛盾报给 Annie(它可能影响的是 **A 的实现**,不只是 B),
   在她表态前它在 B 这边**挂着当 open question,不许自己填**。详见 `exploration.md` §6。
5. **`packages/gemini-agent`(FLY-1018 语音派活)本单没看** —— 它是"语音 → 派活"的另一条历史线,
   B4 那格真开钻时值得回来补。

---

## 8. 出处清单

| 类别 | 位置 |
|---|---|
| Annie 逐字 · B 的题面与已定前提 | FLY-1850 issue description |
| A 的定稿 | `product/doc/FLY-1846-global-chief-of-staff/prd.md` (v1.7) |
| Codex 语音的实验与证据 | `product/doc/FLY-1844-codex-voice-cos/research.md` + `evidence/`(9 组)+ `decisions.md` |
| Voice 线历史 · 被否清单 · 四条管线真机结果 | `product/doc/FLY-1827-voice-line-audit/audit.md` |
| 老 PRD(她 2026-07-06 APPROVED) | `product/doc/FLY-906-voice-product-experience/prd.md` (v0.17) |
| 轮次状态机合同 | `packages/voice-core/src/headphone/turn-machine.ts` |
| 耳机 daemon | `packages/voice-headphone/src/{daemon,daemon-core,null-audio-io,bridge-client,config}.ts` |
| Bridge 语音面 | `packages/teamlead/src/bridge/voice-routes.ts` · `plugin.ts:7502-7510` |

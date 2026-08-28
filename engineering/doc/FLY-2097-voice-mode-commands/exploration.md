# FLY-2097 进/退语音模式的命令化 — 探索
Issue: FLY-2097 (https://linear.app/geoforge3d/issue/FLY-2097/raya语音-ux-进退语音模式的命令化进slash-command退自然语音说一句即退模型-tool-call-slash-兜底)
日期: 2026-08-27
基于: 无(上游为 `engineering/doc/FLY-2074-raya-voice-pipeline/{exploration,research,plan}.md`)

> 读法:本文只回答「要做的到底是什么、哪些已经定了、哪些还开着、我建议怎么拍」。技术事实(协议字段、Discord 规则、代码缝)在 `research.md`,拆法在 `plan.md`。
> 成色:✅ 她的原话 / 实测 · 🔶 Lead 定向 / issue 文本 · ⬜ 我的判断,未经她确认。**⛔ 不把 🔶⬜ 当成她说过的话。**

## 0. 一句话

把「进/退语音模式」从今天的**一字不差的文字口令**改成:**进 = Discord slash command `/voice`**(有自动补全、不用背句子),**退 = 在语音里说一句想退的话就退**(由实时语音模型判断意图),并且**永远保留一条不依赖语音链路健康的逃生门**(`/endvoice` + 原有文字口令 + 原有「离开语音频道」)。

## 1. 来源与边界

### 1.1 本单来自哪里

| | |
|---|---|
| 来源 | founder 2026-08-27 15:11 / 15:17 PT,在 [FLY-2074] thread 里选「方案一」:2074 的语音**管道**按现状 ship,进/退**交互**另开本单 ✅ |
| 依赖 | FLY-2074 已 merge:raya PR #2 → `origin/main` = `b7abff4`(2026-08-27 16:25 PT founder 授权);flywheel #964 ✅ |
| 代码落点 | **raya 仓**(`xrliAnnie/raya`),worktree `~/.flywheel/raya/worktrees/raya-FLY-2097`,分支 `fly-2097-raya-voice-ux`,PR 目标 raya `main` 🔶 Lead 2026-08-27 17:20 PT |
| 并行 | 与 FLY-2030 / 2031 / 2032 各自 worktree 并行;同文件以 main 为准 rebase 🔶 |

### 1.2 本单管什么 / 不管什么

```
✅ 管:
  ① 进入语音模式的 slash command(注册、鉴权、回话)
  ② 退出语音模式的自然语音路径(模型判意图 → 管道干净拆除)
  ③ 退出的逃生门:slash 退出 + 文字口令保留 + 语音进程卡死时仍能退
  ④ 文字口令的兼容期(进入口令保留,不硬切)
  ⑤ 上述交互的真机验收

⛔ 不管(各归其单):
  语音管道本身(常开流 / 三条腿 / 静音语义 / launchd)         → FLY-2074(已 ship)
  它【说什么】、身份载荷、开场指令的内容                     → FLY-2030
  念读 / 转达 Lead / 用嘴批 ship                            → FLY-2031
  会议模式                                                  → FLY-2032 / 2033
  v3 / 打断 / 「记得:否」的记忆问题                          → FLY-2021 / 2074 既定边界
```

## 2. 现状(实测 raya `b7abff4`,`apps/brain/src/voice-mode.ts` · `apps/voice/src/`)

| 今天的行为 | 出处 | 成色 |
|---|---|---|
| 进:在 `#raya` 发**正好**「进入语音模式」或「现在我们进入语音模式」(trim 后精确相等)→ 写 `voice-mode.requested` → `launchctl kickstart` voice | `voice-mode.ts:11-20,102-125` | ✅ |
| 退:在 `#raya` 发正好「退出语音模式」→ 清 marker → `launchctl kill SIGTERM` | `voice-mode.ts:126-142` | ✅ |
| 含「语音模式」但不精确 → 只回一句提示「要进语音模式请发:进入语音模式」 | `voice-mode.ts:98-101` | ✅ |
| 退的第二条路:最后一个授权真人离开 Voice Channel 且 grace(默认 1 s)到期 → voice 自己清 marker、发「我下线了」、停 Codex、exit 0 | `Coordinator.ts:259-283`;`config.ts:humanPresenceGraceMs` | ✅ |
| 退的第三条路:voice 进程收 SIGTERM → 同上拆除 | `Coordinator.ts:414-434`;`cli.ts:211-215` | ✅ |
| **没有**任何「在语音里说一句就退」的路径;语音里说「退出语音模式」= 普通对话 | 全仓 grep `退出`,只有 brain 文字口令 | ✅ |
| 实时语音模型收到的开场指令 = 一段固定中文(或 `startInstructionsFile`),**不含**任何退出协议 | `apps/voice/src/cli.ts:56-60` | ✅ |
| brain 的 Discord client 只订阅 `Guilds + GuildMessages + MessageContent`,只监听 `messageCreate`;**没有** slash command 注册与 `interactionCreate` | `voice-mode.ts:223-260` | ✅ |
| 真机 8-27 六轮里用户可见成功 1/6(2074 披露);本单不改这个成功率,只改进/退交互 | 2074 plan §14 | ✅ |

## 3. 她要的三件事,以及为什么(按她的处境写)

| # | 她要的 | 她的处境 | 成色 |
|---|---|---|---|
| 1 | **进入 = slash command `/voice`** | 现在必须一字不差;near-miss 只会被提示。slash 有自动补全,不误触发,不用背精确句 | ✅ founder 方向;命令名由 founder 2026-08-27 页面批注定案 |
| 2 | **退出 = 自然语音优先**:已经在语音里聊着时,直接说一句「OK 我现在要退出了」这类**意图**就退 | 她在语音里,手不在键盘上(开车 / 做家务是 B PRD 的基本处境);让她去打字退出是反的 | ✅ founder 方向 |
| 3 | **退出 = slash / 文字兜底**:`/endvoice` + 保留「退出语音模式」口令,作为语音链路卡住时的逃生门 | 「退出的唯一方式不能依赖『要退出的那个东西还健康』」——语音卡住、模型听不见时,自然语音退出必然失灵 | ✅ founder 方向(硬要求,不是可选) |

隐含的第四条(我的判断 ⬜):**误退的代价比「多确认一句」高得多**——退出即 fresh thread,下次进来「记得:否」(2074 既定边界),一次误退等于丢掉这轮对话。所以「含『退出』字样的无关话不误退」不是锦上添花,是必须的。

## 4. 关键发现 —— 「给模型一个 tool」在真实链路上长什么样

Issue 里给 founder 的解释是:「给模型一个 function/tool `end_voice_session`,系统提示里写『用户想退出时调用它』,模型判定到意图就调用」。**这个思路对,但落到 Raya 实际用的链路上,字面上的做法不存在**。核过的事实(详见 `research.md` §1):

```
她的声音 → Discord → raya-voice → Codex app-server `thread/realtime/*`(v2, websocket)
                                        │
                                        ├─ 实时语音模型(听、想、说;它唯一的「工具」= 把事情【交办】给后台 Codex)
                                        │
                                        └─ 后台 Codex 线程(gpt-5.6-sol · xhigh;有 shell,也能接客户端注册的 dynamic tool)
```

| 事实 | 含义 |
|---|---|
| `thread/realtime/start` 的参数里**没有** `tools`(0.150.1 全部字段已枚举) | 客户端不能给**实时语音模型**注册自定义 function。Issue 描述的「给模型一个 tool」在实时层做不到 |
| 后台 Codex 线程可以接客户端 dynamic tool(`thread/start.dynamicTools` + server request `item/tool/call`) | 「真正的 tool call」只能在**后台**发生:实时模型先交办 → 后台 Codex 想一想 → 调用 `end_voice_session` |
| 2074 实测交办延迟:首个「在忙」信号 7.8 s、命令 12.3 s、开口 57.9 s(xhigh 推理) | 走后台 tool 的退出 ≈ 她说完之后**十几秒到几十秒**听着等待音才挂——不是「说一句即退」 |
| 实时模型每句话的转写(user / assistant)本来就在实时推给 raya-voice(`transcript/done`) | 「模型判意图」可以不经后台:让实时模型**用嘴执行工具**——判定要退就说出一句固定结束语,管道听到这句就拆 |
| voice 进程今天把任何 server request 当协议违规(`RealtimeTransport.ts:128-130`) | 若走 dynamic tool,transport 要先学会应答 `item/tool/call`;这是额外机制 |

⇒ **两条能让「模型判断」保留在模型里的路**:

- **A. 口头合同(verbal contract)**:开场指令里写「用户明确要退出语音时,只说『好，退出语音模式。』」;raya-voice 在 assistant 的 final transcript 上做**归一化后的整句匹配**,命中即拆。延迟 ≈ 一个语音回合(1–3 s),零新协议。
- **B. 后台 dynamic tool**:`thread/start.dynamicTools=[end_voice_session]`,transport 应答 `item/tool/call`。字面上最像 issue 描述,但延迟十几秒起,且依赖实时模型**愿意交办**这一步(它可能直接回「好的再见」而不交办)。

我推荐 **A 为主,B 不做**(理由见 §5 Q2)。这一点要在 HTML 里向 founder 讲明:她听到的「tool call」在实现上是「实时模型用一句固定话当工具」。

## 5. 关键问题与选项

### Q1 进入命令叫什么;进/退是两条命令还是一个开关

| 选项 | 评 |
|---|---|
| A. 两条中文命令 `/进入语音` `/退出语音` | Discord 命令名合法,但手机要切中文输入法、字也多 |
| **B. 英文 `/voice` + `/endvoice`** ✅ founder 已定 | 短、英文优先;输入 `/v` 或 `/e` 即可补全;两个关键动作都是单层直接命令 |
| C. 一条 `/语音` 带子命令 `进入` / `退出` | 退出要选两层;逃生门应该一步到位 |
| D. 一条 `/语音` 开关(toggle) | 状态不明时按一下不知道是进还是退;逃生门反而危险 |

✅ founder 2026-08-27 页面批注选择英文短名;退出选 `/endvoice` 而不是 `/voice end`,避免手机上再选一层 subcommand。显式约束:后续 founder 手机输入的 slash 命令也应短、优先英文、关键动作单层完成。

### Q2 「说一句就退」的机制

| 选项 | 延迟 | 谁判意图 | 误退形状 | 新机制 |
|---|---|---|---|---|
| **A. 口头合同:实时模型说固定结束语,管道整句匹配** ⭐ | 1–3 s(一个语音回合) | 实时模型(听全上下文) | 只有模型误判 + 真的说出整句结束语才误退;她的话本身永远不直接触发 | 一个 ~30 行的归一化匹配器 + 开场指令一段话 |
| B. 后台 dynamic tool `end_voice_session` | 十几秒起(交办 + xhigh 推理) | 后台 Codex | 极低 | transport 应答 server request;`thread/start` 新字段;交办不发生就不退 |
| C. 管道在**她的**转写上做关键词匹配(退出/结束/挂了…) | <1 s | 没人判,只有关键词 | 「不想退出这个话题」直接误退——正是 issue 点名要防的 | 匹配器 |
| D. A + C 双门(她说过退出类词 **且** 模型说了结束语) | 同 A | 模型 + 关键词 | 更低 | 两个匹配器 + 时间窗;多一个机制 |

⬜ 推荐 **A**。B 的延迟把「说一句即退」变成「说一句、听十几秒等待音、再退」,而且多两个机制;C 是 issue 明令要防的;D 是 A 真机误退了才值得加的加固,现在不加(先量再加,「只删不加」)。
A 的弱点写在明处:**依赖模型照说固定句**。缓解 = 匹配做归一化(去标点/空白/语气词)+ 允许一小组等价句;真机 n≥5 次验它的遵从率;不遵从时 slash / 文字兜底照样在。

### Q3 误触发怎么防

| 选项 | 评 |
|---|---|
| **A. 分级:明确意图直接退;拿不准先问一句「要退出语音吗?」;含『退出』但意图相反(「不想退出这个话题」)照常聊** ⭐ | 判断本来就是模型强项;明确时不多问一句(她说「我要退出了」不该再被问) |
| B. 一律先确认 | 每次退多一个回合(≈ +3–6 s);最保险 |
| C. 从不确认 | 误退代价 = 丢这轮对话 |

⬜ 推荐 A,把「一律先确认」留作 founder 一句话可切的选项(开场指令里一句话的差别)。

### Q4 逃生门要硬到什么程度

| 场景 | 今天 | 本单 |
|---|---|---|
| 语音进程健康,只是模型没听懂 / 没照说 | 文字口令能退 | + `/退出语音` |
| 实时腿 / Codex 腿死了(进程还活着) | 心跳 2 次 miss(~60 s)后 exit 1 → launchd 重拉 → fresh | `/退出语音` 清 marker + SIGTERM → drain → exit 0,不重拉 |
| voice 进程**事件循环卡死**(SIGTERM handler 跑不了) | `launchctl kill SIGTERM` 发出去了、回「正在退出」,**其实没退** | SIGTERM 后限时观察 `launchctl print`;超时 **SIGKILL** 并如实回「未响应,已强制结束」;marker 已清,launchd 重拉后 `run` 看不到 marker 直接 exit 0 |
| brain 进程也死了 | 无 slash / 无文字 | **离开 Voice Channel** 仍能退(2074 既有 HumanLeft 路径)——这是最后一道门,本单不新造,但要在 HTML 里说清 |

⬜ 「SIGKILL 升级」是本单唯一新增的机制;它让「逃生门」这个硬要求有牙齿,也让回话不撒谎。

### Q5 谁注册 / 处理 slash

**brain**(常驻,已有 Discord client,已有 launchctl 监督)。voice 是按需进程,退出命令必须在它死了之后还能用,所以不能放 voice。注册用 guild 级命令(即时生效;全局命令要等最多 1 h)。⬜

### Q6 「说完再挂」

模型的结束语转写 `done` 到达时,声音可能还在 Downlink 的缓冲里(100 ms 目标深度 + Discord 播放延迟)。拆除前等 Downlink 队列排空 + 一小段 grace(默认 1.5 s,可配),让她听完那句「好，退出语音模式」再断——否则体验是「话说一半突然消失」。⬜

### Q7 与 FLY-2030 的接口(它说什么 vs 它怎么退)

开场指令的**内容**归 2030(`startInstructionsFile`)。本单只在代码里把一段固定的「退出协议」**追加**到 2030 的内容后面(总长仍受 8,192 限制,超了照旧拒起)。这样 2030 改人设不会碰掉退出协议,2097 也不碰 2030 的文件。⬜

### Q8 文字口令留不留

留。进入两句、退出一句都保留(founder:「进入也建议保留文字口令兼容一段」);near-miss 提示改成同时提到 slash。⬜

## 6. 决策清单(本文拍的、待 plan 落实的)

| # | 决定 | 成色 |
|---|---|---|
| D1 | 进/退各一条 guild 级 slash command:`/voice` `/endvoice`;名字为单处常量 | ✅ founder 已拍 |
| D2 | 自然语音退出 = 口头合同(A):开场指令追加退出协议;raya-voice 在 assistant final transcript 上做归一化整句匹配 | ⬜ 推荐 |
| D3 | 不做后台 dynamic tool 路径;在 research 里留可复核的探针配方,以便她坚持要「真 tool call」时能量 | ⬜ |
| D4 | 误触发:分级(明确直接退 / 拿不准先问 / 意图相反不退);「一律先确认」留作一句话可切 | ⬜ 推荐 |
| D5 | 逃生门:`/endvoice` + 文字口令 + 离房;brain 的 stop 加 SIGTERM→限时→SIGKILL 升级,回话如实 | ⬜ |
| D6 | 拆除前等 Downlink 排空 + grace,让她听完结束语 | ⬜ |
| D7 | slash 由 brain 注册与处理;voice 不动 Discord 交互 | ⬜ |
| D8 | 文字口令全部保留;提示语同时指向 slash | ✅ founder 建议 |
| D9 | 验收以真机为准(issue 原话「不以 unit test 为准,对齐 2030 的验收精神」);unit test 只守回归 | ✅ |

## 7. 会过期的结论

| 结论 | as-of | 怎么重核 |
|---|---|---|
| raya `origin/main` = `b7abff4`,含 2074 语音管道 | 2026-08-27 | `git -C ~/.flywheel/raya/code fetch && git log -1 origin/main` |
| 实时层没有客户端 tool 注册;`thread/start.dynamicTools` 存在 | codex 0.150.1(生产 `RAYA_CODEX_BIN` 同版) | `strings $(RAYA_CODEX_BIN) \| grep -c dynamicTools`;research §1 的字段清单命令 |
| 交办延迟 7.8 s / 12.3 s / 57.9 s | 2074 research §3(FLY-1911 B §6.4) | 换模型 / effort 后重量 |
| bot 已含 `applications.commands`(guild 命令端点 PUT `[]` 200) | 2026-08-28T00:5x Z 探针 | research §2 的 curl |
| FLY-2030 分支尚无 commit,`cli.ts:startInstructions()` 无冲突 | 2026-08-27 | `git -C ~/.flywheel/raya/code log origin/main..fly-2030-raya-brain` |

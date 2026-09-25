# FLY-2886 语音·B·核心·大脑 — 调研
Issue: FLY-2886 (https://linear.app/geoforge3d/issue/FLY-2886/语音b核心大脑-codex-自带后台-agent订阅与-lead-同权-记忆与上下文三层装载-口语转述关键字段一字不差-等待话术-20)
日期: 2026-09-25
基于: exploration.md

## 1. Codex 0.157 协议事实（零凭据取证）

取证方法：`codex app-server generate-json-schema --experimental`（本机 0.157.0，不需要登录、不产生额度）。

`ThreadRealtimeStartParams`（20 个字段）里与本单相关的：

| 字段 | schema 原文要点 | 本单用法 |
|---|---|---|
| `clientManagedHandoffs` | 「把 Codex 回答的交回留给客户端显式 append，而不是自动转发。默认 false」 | **true** |
| `delegationAckFiller` | 「V3 委派时是否产生确认填充语；省略 = Realtime API 默认」 | **false**（「我去看一下」由我们说，见 §4） |
| `realtimeStartInstructions` | 「实时会话开始时给 backing Codex model 的 developer 指令」 | 后台 agent 的行为规约（口语稿格式、写操作日志、并发规则） |
| `realtimeEndInstructions` | 「实时会话结束时给 backing Codex model 的 developer 指令」 | 不用；纪要沿用现有 voice-minutes |
| `initialItems` | 「仅 V3，≤128 条、≤8,192 估算 token」 | 连接层换 V3 后，开场简报搬进这里；V2 下仍用 `prompt` |
| `backendReasoningStatus` | 「V3 下把公开推理摘要当安静上下文转给前台」 | 不开（避免前台据推理半成品抢答） |
| `codexResponseHandoffMode` / `codexResponsesAsItems` | 只影响「自动转发」 | clientManaged 下无关 |

`TurnStartParams` 有 `outputSchema`（「约束本回合最终 assistant 消息的 JSON Schema」）、`model`、`effort`、`sandboxPolicy`、`permissions`；`ThreadStartParams` 有 `developerInstructions`、`permissions`、`baseInstructions`。

已有实测（不重证）：V2 `appendText` 不让前台开口（FLY-2799 research:8-14）；`appendSpeech` 让前台照稿说（V2 与 V3 都成立，FLY-2884 s7）。

## 2. 交接由谁管：`clientManagedHandoffs` true vs false

| | false（Codex 自己转） | **true（我们接管）** |
|---|---|---|
| 结果回前台 | 自动 `conversation.handoff.append`，前台自由发挥 | 我们在 `turn/completed` 拿 final_answer 决定何时、以何稿说 |
| 关键字段一字不差 | 无检查点，前台可能改写数字 | 说之前确定性检查 |
| 等待话术 / 20 秒补话 | 只能靠 prompt，次数不可控 | 客户端计时器，最多两次可测 |
| 打断后结果不丢 | 取决于服务端，插话后常被吞（FLY-2884：4/10 先续旧话） | 结果进会话级信箱，空闲后再说 |
| 实测先例 | FLY-2881 v4（WS V2 + API key） | FLY-2881 v5、FLY-2884 s1-s7、Codex TUI 本身 |

**结论：true。** founder 的六条要求每条都需要一个客户端控制点；false 一条也给不了。代价是我们自己写交回逻辑（约 200 行，TUI 已示范）。

## 3. 口语转述怎么做（去掉「逐字念 + 逐字核对」）

被否的方案：
- A「把原文当背景塞给前台让它自己说」—— V2 `appendText` 不开口；即便 V3 能开口，说之前无法检查字段，只能事后纠错。
- B「继续逐字念 Lead 原文」—— 就是 founder 要去掉的现状；Lead 原文是给眼睛看的（markdown、链接、长段）。

采用：**口语稿（spoken script）+ 关键字段保真检查 + `appendSpeech` 照稿说**。
- 后台结果：后台 agent 按 `realtimeStartInstructions` 直接写口语稿（它手里有全部事实，改写成本为零）。
- Lead 本体回复 / Bridge 事件：同一 app-server 里另开一条**无工具、只读、ephemeral 的「改稿线程」**，`turn/start` + `outputSchema` 产出 `{spoken, threadText?}`，走订阅，预计 2-4 秒（这类消息本来就是异步的）。
- 保真检查是纯函数，**说之前**做；不过 → 确定性兜底稿「这条我发到 thread 了，编号以文字为准。」+ 原文进 thread。永远不会念出错的编号。
- 说的时候不再比对整句转写；只把「关键字段是否出现在转写里」记成证据（不判失败），因为 TTS 照稿读，内容风险已在说之前排除。

关键字段（protected tokens）定义，需与原文逐字一致：
1. 单号：`[A-Z][A-Z0-9]{1,9}-\d+`（FLY-2886、GEO-208）；
2. PR / issue 号：`(PR\s*)?#\d+`；
3. 提交号：`\b[0-9a-f]{7,40}\b`（含至少一位字母与一位数字）；
4. 数字：阿拉伯数字串（含小数点、百分号、冒号时间）；
5. 人名：本会话名册（Lead 名、runner 名、founder 称呼，来自 Bridge 已知 roster），精确匹配。

规则：稿中每个关键字段必须在来源中逐字出现（**不许凭空**）；来源里的单号/PR 号必须在稿中出现，除非稿以 thread 指针结尾（**不许丢号**）。比对前只做大小写与全角/半角归一，**不做**中文数字↔阿拉伯数字互转（要求稿里写阿拉伯数字，TTS 自会读）。

## 4. 等待话术与结果信箱

- 「我去看一下」：收到 `handoff_request` 时，若前台本次回应**尚未出声**，我们 `appendSpeech("我去看一下。")`；若前台已出声则不再补（证据记 `ack_source=model`），避免双说。前台 prompt 同时要求「交后台时不要自己说话」。
- 「还在查」：以最早未完成的委派为锚，20 秒、40 秒各一次，只在「地板空闲」时说；结果到了立即取消；每会话每批委派最多两次。
- 地板空闲（floor free）= 无进行中的用户语音段（`input_audio_buffer.speech_started` 未收到对应 completed/final）且无正在播放的前台输出，并持续 ≥800ms。
- 结果信箱（ResultMailbox）按会话、不按 generation：插话导致的实时重开（V2 下是 stop+start）不清空信箱；后台回合是线程级的，实时腿重开不影响它（实现 Step 0 实测确认）。
- 打断：founder 插话 → 前台立停（现有逻辑）；正在说的结果稿若未播完，重新入信箱队首并标 `interrupted`；她说完且地板空闲后主动说「刚才查到的：……」。同一稿最多重投 2 次，之后改发 thread 并口头一句指针。

## 5. 与 Lead 同权：能力、权限、浏览器、founder 门

**能力**：Codex Lead 的能力包 v2（`lead-capabilities/runtime-parent.ts`、`buildCodexLeadMcpArgv.ts:180-209`）= `lead_actions` MCP（一个 `lead_operation` 工具，经 broker socket 分派目录里所有非 reserved 操作：linear.*、github.*、discord.*、bridge.read、memory.*、runner 派活、report.*）+ 浏览器门面。目录带 `parityId` 与 Claude 工具对齐。**语音后台 agent 直接复用同一目录与同一 manifest 生成逻辑**，同权由构造保证，不另列清单。

**权限**：`flywheel-lead-v2` 权限档（`permission-profile.ts`）——凭据文件 deny、localhost/127.0.0.1 deny（shell 连不上 Bridge）、网络走受管代理、写根 = 项目 worktrees。founder-only 操作（`bridge.ship/merge/terminate/restart/park/unpark/approve_to_ship`、`terminal.close`）在目录里是 `reserved`，manifest 放进 `deniedOperationIds`，调用得到 `{denied:true, reason:"founder-workflow-required"}`（`catalog.ts:979-1000`、`manifest.ts:171-176`）。shell 读不到 gh 凭据、连不上 Bridge ⇒ **founder 门在沙箱内是结构性的**。

**浏览器**：
- 能力包 v2 自带的是隔离的 Seatbelt Chrome（`browser-config.ts`，chrome-devtools-mcp@1.9.0），能开网页、能操作，但不是她的 Chrome。
- founder 要的是「像 Lead 一样用她电脑上的 Chrome」。Codex 侧对应工具：`chrome-devtools-mcp --auto-connect --channel=stable`（她个人 Codex 配置里已在用）。连接时 Chrome 会在她屏幕上弹出允许对话框。
- 取舍：MCP 子进程在沙箱外，她的 Chrome 登录着 GitHub 等，技术上能点网页上的 merge —— 和今天 Claude Lead 用 claude-in-chrome 的暴露面相同，founder-only 在这一条路径上是**规则级**不是结构级（FLY-245 当初不给 Codex Lead 这个就是这个原因）。
- 方案：每 Lead 开关 `voice_background_browser = founder_chrome | isolated | off`，默认 `founder_chrome`（按 founder 要求），HTML 如实写明风险；Lead 已同意（问询 07429662）。

**订阅**：沿用 FLY-2358 runner 家的做法（`claude-runner/src/codex-home.ts`：`auth.json` 以软链接指向宿主唯一真源，绝不复制）；语音家去掉 `forced_login_method="api"` 与 ephemeral 凭据存储，启动后 `account/read` 断言 `authMode=chatgpt`，否则 `voice_unavailable: codex_auth_not_subscription`。实时腿在 WS V2 期间仍从 env 读 API key（仅实时腿），连接层换 WebRTC 后删除。

## 6. 三层装载的数据来源

| 层 | 来源（已存在） | 体积控制 |
|---|---|---|
| ① 开场简报 | `generateBootstrap()` → **`formatBootstrap()`**（每节 10 行、总 12,000 字符、不截断标识符，带 omitted 指针）；founder 待答 = `readFounderAttentionFacts()`（`founder-attention-facts.ts:70`，ship / founder_gate / founder_ask）；受阻 = `getStuckSessions` + `listParkedSessionsForProject`；memory 索引摘要 = MEMORY.md 只取索引行（≤4,000 字符）；身份 persona | 前台 ≤ 6,000 token（V3 `initialItems` 上限 8,192 的余量内） |
| ② 细节现查 | 后台 agent 用 `lead_operation`（bridge.read、linear.*、memory.search）与只读文件访问（memory 文件路径写进后台指令） | 按需，无上限 |
| ③ 新事件背景追加 | Bridge 在语音会话存活期间对比「简报时的键集」与当前状态，新键写入 `voice_outbound`（新增投递类 `context`/`tell`）；`context` → `appendText(developer)` 静默；`tell` → 议程，空闲时口语说 | 每条 ≤ 600 字符，`context` 合并节流 ≤ 1 条/10s |

现状缺口（调研 agent 实证）：语音路径未经 `formatBootstrap`，大 Lead 会整体失败；快照里没有 founder_ask / founder gate 注意力项。本单一并补上。

## 7. 2799 遗留 MEDIUM：mirror-withdraw-kills-listed-outbound

`StateStore.recordVoiceUtteranceMirror`（:6537）撤掉 `queued` 行；daemon 在 list 与 claim 之间遇到这种撤回，`claimVoiceOutbound` 返回 `undefined` → 路由 409 `voice_lease_conflict`（`voice-session-routes.ts:593-610`）→ `daemon.ts:190-197 authorityLost()` 视为失租约 → 整场语音以 `lease_lost` 结束。修法：claim 返回三态（claimed / lease_conflict / not_claimable），`not_claimable` 走 410 `voice_outbound_not_claimable`，daemon 跳过该行继续；只有真正的租约冲突才终止会话。

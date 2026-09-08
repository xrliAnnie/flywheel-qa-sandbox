# FLY-2439 Lead 通路现状 —— 四条路,逐箭头实证(HTML 同内容文字版)

Issue: FLY-2439 (https://linear.app/geoforge3d/issue/FLY-2439/通路实证-lead-通路现状-umlclaude-lead-codex-lead-raya-文字-raya-语音-逐箭头-fileline)
日期: 2026-09-08
基于: research.md

> 本文是 `lead-paths.html` 的等价文字版:**结论层 + 主锚点**。
> 图的 mermaid 源码在 `diagrams/*.mmd`,渲染结果在 `diagrams/*.svg`。
> 只陈述现状,不提方案;零代码改动。
>
> HTML 版比本文多两样东西(Lead 指令 `6039008e` 要求):
> ① **每张图下面挂一份「箭头 → 依据」清单**,由 `.mmd` 源码**自动抽取**(见 `mmd_edges.py`),
>   所以清单与图不可能对不上;每条边的依据 = 边标签上的 `file:line` + 两端节点自带的 `file:line`,
>   并标注了各自来自 边 / 起点 / 终点。裸的 `:123` 会用真实文件名索引补全成 `Foo.ts:123`。
>   **全部 117 条边:104 条有 `file:line`,3 条是阴性结论(依据就是「grep 零命中」本身),
>   7 条是人 / Discord 平台侧的物理跳,3 条是分节标题 —— 零条「未验证」。**
> ② **可评论**:每个 Section 底下一个 textarea,输入即存进这台设备的 `localStorage`,
>   页面底部有「复制全部评论」(带兜底:复制不了就把汇总文本摊开并全选好)。
>   脚本走 `<script nonce="__CSP_NONCE__">`,由 publish-report 换成真 nonce;无任何内联事件属性。

## 一句话

四条通路的 Discord 入站第一跳**都不在 Bridge** —— 网关/轮询连接和 bot token 各自握在四个不同的进程手里。
Bridge 唯一必经的位置,是 Claude Lead 与 Codex Lead 的「comm.db → 大脑」那一段;
Raya 的文字与语音两条路**连 comm.db 都没有**。

## Bridge 到底在不在路上

- **A · Claude Lead(flywheel-eng-lead)** —— 入站第一跳 ✗ 不经过;comm.db→模型 ◐ 必经;出站 ✗,只有一次可 fail-open 的守卫。
- **B · Codex Lead(mufasa-lead)** —— 入站第一跳 ✗ 不经过,**连门铃都不敲**;comm.db→大脑 ◐ 必经;出站 ✗,生产默认 `direct`。
- **C · Raya 文字(PR #26)** —— ✗ 全程无 Bridge、无 comm.db;自己的网关 + 自己的 REST。
- **D · Raya 语音(main b1b5a64)** —— ✗ 全程无 Bridge、无 comm.db;侧通道的「收」那一端是断的。

图:`diagrams/{a,b,c,d}-component.svg`(组件/进程边界)与 `diagrams/{a,b,c,d}-sequence.svg`(时序)。

## A · Claude Lead

- 持有 Discord 网关连接的是 **Lead 自己的 Claude 会话** —— 启动器把两个 channel 写死进 argv,
  适配器是一个 bun 进程并 `exec` 掉自己以成为 Claude 的直接子进程。
  `claude-lead.sh:2559` · 插件 `0.0.6` `.mcp.json` · `start-adapter.sh:44` · `server.ts:494 / :1593 / :1793`
- 入站:适配器先把意图**原子落盘到本地 spool**,再 spawn `chat-ingest`,共 2 次即时尝试(1 次重试)。
  ⚠️ spool **写失败**时绕过持久化,直接试一次 CLI,再失败只打一行 `unrecoverable` 后放弃。
  `chat-receipt-runtime.ts:92-94 / :119-133 / :135 / :266-274`
- `chat-ingest` **直接打开 sqlite** 写统一信箱,没有任何服务参与。
  `index.ts:747` · `discord-chat-ingest.ts:77 / :114 / :127` · `mailbox-schema.ts:193`
- 之后才轮到 Bridge,而**那一下只是门铃**:「队列行才是权威,这个请求只是缩短下一次自适应轮询的间隔」。
  `lead-inbox-nudge.ts:34-36 / :41-42 / :56` · `plugin.ts:3017`
- **Bridge 的 `LeadInboxLoop` 是这一段的必经泵**(活跃 1s / 空闲 30s,组 `mailbox-batch` 头)。
  `lead-inbox-loop.ts:29-30 / :444 / :449 / :467`
- 「Claude 用一个 JSON file」在代码注释里就有:
  *Codex consumes one packaged turn; Claude writes members atomically and its stock poller packages the unread snapshot into one turn.*
  落盘两阶段:先 `.flywheel.jsonl` sidecar,再在文件锁内原子改写主 JSON 数组,最后 finalize sidecar。
  `lead-delivery-adapter.ts:29-31 / :56 / :75` · `lead-inbox-runtime.ts:1252-1270` · `path-helpers.ts:116` · `ClaudeMailboxCodec.ts:273 / :283 / :290`
- ⚠️ **读侧不在本仓,不能当生产判据**:`useInboxPoller` 在 Claude Code 二进制内部;本机有一份 `0.0.0-leaked` 源码检出写着 1000ms,
  而生产跑的是 `claude 2.1.263`,两者对应关系**未验证**。`ClaudeCodeAdapter.ts:11 / :255` · `types.ts:308`
- 🔴 **legacy fail-open 车道**:三个 env 缺一,消息用 `notifications/claude/channel` 直推模型 —— 不进 comm.db、不经 Bridge,
  只在 stderr 打一行。**这条车道开没开,在 Discord 侧看不出来。**
  `server.ts:1750-1753 / :1768-1782 / :109-112` · `chat-receipt-recorder.ts:87-116`
- 出站:先问一次 `POST /api/discord/reply-guard`,但 404 或四个 env 缺一都放行;放行后适配器直发 Discord REST。
  `server.ts:1171 / :375-376 / :370 / :391 / :1339-1342` · `tools.ts:1276` · `reply-guard.ts:1-22`
- 另有一条**真的经过 Bridge** 的出站:issue thread `POST /api/chat-threads/send`(`tools.ts:711`),
  但它不是插件工具,靠提示词引导模型自己发 HTTP,不是强制环节。
- Bridge 引擎事件确实先进 Bridge,入队到**同一个 MailboxQueue**、共用同一条 batch 管道、落进**同一个 JSON 文件**;
  一个 batch 不允许混装两类。`plugin.ts:5825` · `lead-inbox-runtime.ts:573` · `lead-inbox-loop.ts:414 / :449`

## B · Codex Lead

- 它是**独立的 launchd 守护进程**,不是 Bridge 的一部分;生产是**窗口化 TUI** 形态,连共享的 `codex remote-control` daemon,
  founder 的 `codex resume --remote` 窗口是**同一个 thread 的另一个客户端**。
  `run-codex-lead-mufasa-tui-fullaccess.sh:36 / :75 / :140` · `codex-lead-tui-runtime.ts:1-6 / :539-541` · `daemon-ws.ts:13-14 / :36`
- 入站是 **3s REST 轮询**,不是网关。`RestPollDiscordInboundSource.ts:7 / :121` · `codex-lead-tui-runtime.ts:665 / :749`
- 🔴 **B 连门铃都不敲** —— 门铃写在 CLI 子命令里,B 是进程内直接调库;
  `packages/teamlead/src/lead-backends/codex/` 下 grep `nudgeLeadInbox` / `lead-inbox/nudge` **零命中**。
  `CodexDiscordMailboxStrategy.ts:1 / :72` · `CodexDiscordGateway.ts:233`
- Bridge 的角色:把队列行泵过一条 **unix socket**;它是客户端,Lead 守护进程是服务端。
  理由写在注释里:*The Codex Lead router lives in the windowed TUI sidecar process. The Bridge therefore cannot mutate journal.db directly…*
  `CodexLeadInboxSocket.ts:4-7 / :64 / :78 / :202` · `lead-delivery-adapter.ts:92 / :103 / :146`
- 进大脑前先落一次 **journal.db**,**只有 `accepted_new` 才入队起泵**。
  `LeadInputRouter.ts:218 / :219-225 / :291 / :297` · `LeadJournal.ts:240 / :260` · `CodexTurnExecutor.ts:156-161`
- 出站生产默认 `direct`,启动脚本自己写着 *bypasses Bridge outbound authorization*;
  代码里确实有经 Bridge 的出站(`CodexOutboundSender.ts:180`),但**没有任何在用的 launcher 打开它**。
  `run-codex-lead-mufasa-tui-fullaccess.sh:101-104` · `DirectDiscordOutboundSender.ts:4 / :57` · `discord-utils.ts:10`
- 运行时旁证(2026-09-08T03:13Z,非代码结论):两个 Codex Lead 的 launchd PID 均为 `-`、last exit `3`;
  `pgrep -f codex-lead-tui-runtime` 无结果。

## C · Raya 文字(PR #26)

- 这条路上**没有 Bridge,也没有 comm.db**:`apps/brain/src/` 全目录 grep `9876` / `bridge` / `flywheel-comm` / `chat-ingest` **零命中**。
  入站是自己的 discord.js 网关,出站是自己的 REST。
  `voice-mode.ts:632-638 / :643 / :658` · `cli.ts:392-404` · `discord-rest.ts:6 / :25 / :38-41`
- 大脑是自己 spawn 的 `codex app-server`,一轮对话真正的调用是 `turn/start`(`controller.ts:595`)。
  线程连续性**有条件**:正常复用/恢复;只有「一开始没有 resumeId」或「resume 报错被判定为 rollout 不存在」才新建;
  普通 resume 错误重连再试一次,第二次仍失败就抛错,**不新建**。`controller.ts:404-445`
- 「问 Lead」是另一套协议:模型在自己的回答里写一行 `【问 Lead】名字:问题` → 正则解析 → roundtable 频道 @mention 明文 →
  每 30s REST 轮询捞回 → 校验答复者确实是那个 Lead 的 bot → 落 `answer_observed` → 再跑一轮 `turn/start` 合成后发回 `#raya`。
  `lead-ask.ts:44` · `controller.ts:802 / :928 / :1027 / :1063-1071 / :1089-1095 / :1170-1180` · `config.ts:151`
- 有一道 flywheel 侧没有的硬门:开服前必须证明 Codex 沙箱**读不到** `.env`,证明不了就拒绝提供文字聊天。
  `secret-isolation.ts:59-67` · `codex-sandbox-probe.ts:28-37` · `cli.ts:213-217 / :234` · `controller.ts:264-268`
- 生产实测:PR #26 **未合并**(HEAD `34c8794`,生产 checkout 在 `b1b5a64`);
  `raya.env` 的 18 个 key 里**没有** `RAYA_LEADS_ROUNDTABLE_CHANNEL_ID`;launchd plist 只注入 `RAYA_ENV_FILE`。

C 与 B 的逐项对照(相同/不同 + 依据)见 `research.md §C.2`,统一化视角的逐维度对照见 `research.md §G.1`。

## D · Raya 语音(main b1b5a64)

founder 直问:语音会议里,Raya 要和别人交流 / 做别的事,走哪条路?现在能不能?

- 🔴 **「问别人并把答案接回本次会议」—— 没有这条路。**
  回流口 `<stateDir>/voice-inbox/items.jsonl` 的读侧完整实现了(轮询 + 五种处置),
  但**写入方在生产不存在**:`appendVoiceInboxItem` 在 `b1b5a64` 全仓只被测试、探针和一个夹具脚本调用;
  raya 自己的计划文档把 producer 记为待办;生产盘上 `voice-inbox/` 目录**根本不存在**。
  `voice-inbox.ts:228-235` · `InboxReader.ts:203 / :210 / :386-389` · `FLY-2031 plan.md:399`
- **「向某个 Lead 转达一句话」—— 有,但是 opt-out。**
  流程:Codex 写 `*.action.json` 提案 → OutboxWatcher 认领并逐字比对 founder 转写取证 → Raya 口头复述 →
  **等一个「反对窗口」超时** → 发出。
  `OutboxWatcher.ts:372-396 / :444-462` · `ReadbackGate.ts:160-174 / :192-194 / :197` · `RoomText.ts:57-103 / :105-137`
- 🔴 **而且她念给 founder 听的那句话,和真正的执行语义不一致。** 播报稿原文:
  「确认后我会真的把消息发给对方;如果不对就说取消,我就不发。」
  执行上**只有后半句成立** —— 没有任何代码在等「确认」;反对词只有 `不对 / 等等 / 取消`,且必须是 founder 本人说的;
  反对窗口**超时返回「未取消」就直接发送**。
  `ReadbackGate.ts:87-96(:94 是这句原文)/ :244-253 / :291-295`
- 还能做的两件事,都不是「主动找人」:①自动字幕(运行时副作用,固定频道);
  ②ship 审批投票 —— 由外部一条 `ship_gate` inbox item armed,再由 founder **口头说「确认/不批」**才发,
  这一条才是真的 affirmative 确认;⚠️ 生产 env 里**没有** `RAYA_APPROVAL_ENDPOINT_URL`。
  `VoiceTextMirror.ts:42-100` · `InboxReader.ts:422` · `runtime.ts:907` · `ShipGateFlow.ts:333-484 / :541-552` · `ApprovalClient.ts:228-230 / :252-265`
- 查 Flywheel 状态(issue / runner / PR):`apps/voice` 里没有专门的集成(`linear` / `runner` / `flywheel-comm` 全零命中);
  唯一的状态读取只覆盖**一条已 armed 的 ship-gate** 的元数据(`ApprovalClient.ts:238-250`)。
  ⚠️ 本行不排除 Codex 线程自身的 tool surface 能做别的事 —— 那超出 `apps/voice` 代码范围,**未验证**。
- 出站频道有硬白名单,只允许 `lead` / `verified-inbox` / `raya` 三类路由。`RoomText.ts:105-137`

## G · 统一化实证(Lead 指令 9bfc5fe8)

founder 决定**不先合 raya#26 / FLY-2381**,先看这张实证图,再决定把 Raya 统一成一个普通 Codex Lead。

- **G.0 先说清楚:Codex Lead 壳不是一种形态,是按 `codexProfile` 分叉的三条路径。**
  注释原文:*full-access shares the workspace-write sandbox but takes a SEPARATE path — NO release gate / gateway / broker / confinement*。
  **生产 Mufasa 就是 full-access。** `codex-lead-runtime.ts:1385-1390`
- **G.1 逐维度对照**(壳 57 个非测试 `.ts` / 16 761 行 vs Raya 文字侧 1 964 + 241 行):
  四个与直觉相反的判定 —— **信箱**(🔴 只有一边有:Raya 没有 durable 入站队列)、
  **超时**(🔴 不是同一件事:壳 60s 管单次 RPC 且 `awaitCompletion` 无超时,Raya 300s/900s 管整轮并会 `turn/interrupt`)、
  **凭据隔离**(🔴 不是同一件事,且生产 profile 下壳没有 broker/confinement,Raya 反而有读隔离硬门)、
  **问 Lead**(🔴 重叠的只是「接答复 + 回灌」;壳当前主动 roundtable 发送被 `discord-send-core` 明确拒绝,没有完整闭环)。
  MCP 一行必须分两层看:builder 的非 gateway 分支允许 chrome 共存,**但生产 Mufasa 走 TUI,TUI 另有一道 exact config gate**
  (要求 effective config EXACTLY 只含受信任的 `lead_actions`,任何额外 MCP fail-closed)。
  完整表见 `research.md §G.1`。
- **G.2 删/留**:可由壳承担 **≈890–1 090 行**;必须保留 **≈17 950 行**(其中 `apps/voice` 单独 **13 683 行 / 45 文件**,不含它 ≈4 270);
  另有四个取舍点(launchd/installer 同时生成 voice job、config.ts 三块共用、
  store.ts 只有 `thread.json` 有对应物且对应的是壳的 **thread-id 文件**而非 `LeadJournal`、Lead 名册两份数据)。
  🔴 这是归类推演,不是实施计划,没有验证可行性。
- **G.3 语音按现状不能同样通用化**,五条结构性阻碍:①壳里没有任何实时音频协议(壳还封装了 `turn/steer` 但**当前接线未使用**);
  ②壳的入站载荷是文本 + 附件清单,没有音频通道;③壳是一问一答、一次一个 active turn,语音是连续会话 + 随时抢话;
  ④flywheel **已经有另一套语音栈**(`voice-bridge` + `voice-core` + `voice-headphone`,**90 个非测试 `.ts` / 20 319 行**)
  而且它**也有实时能力** —— 但走的是 **Gemini Live**(`genaiConnector.ts` 的 `sendRealtimeInput`),不是 Codex `thread/realtime/*`;
  ⑤语音的侧通道方向与壳相反,而且一端是断的。

## E · 与 founder 期望的差距(只陈述,不提方案)

| founder 期望 | 现状 | 四条通路 |
|---|---|---|
| Discord 入站**第一跳**先进 Bridge | 四条通路的第一跳都在各自的大脑侧进程,各持一份 bot token | A ✗ / B ✗ / C ✗ / D ✗ |
| Bridge 再进大脑 | A、B 的「comm.db → 大脑」这一段**必经** Bridge(A 的 legacy fail-open 车道除外) | A ◐ / B ◐ / C ✗ / D ✗ |
| 出站经 Bridge | 仅 issue thread 一条可选路径,靠提示词引导 | A ◐ / B ✗ / C ✗ / D ✗ |
| Codex Lead 与 Claude Lead 同构 | 入站 / 投递 / 出站三段都不同构(设计如此) | 不符合 |
| Raya 与 Codex Lead 同构 | 结构性不同构:无信箱、无 Bridge、自有名册、自有问 Lead 协议、自有守护进程 | 不符合 |
| Raya 会议中可与他人交流 | 收侧无生产写入方;发侧仅单向,且是「不反对即发」而非明确确认 | 不具备闭环 |

G1–G9 的逐条差距见 `research.md §E`。

## 取证锚点

flywheel 主仓 worktree `flywheel-FLY-2439`,基线 main `790355137` ·
Discord 插件 `~/.claude/plugins/cache/flywheel-plugins/discord/**0.0.6**/`(本机实际运行的字节,非 fork main)·
Claude Code 二进制 `claude 2.1.263` ·
raya 语音 raya main **`b1b5a64`** 的 blob · raya 文字 PR **#26** 分支 `fly-2379-raya-text-chat` HEAD **`34c8794`** ·
raya 生产 checkout `~/.flywheel/raya/code` 只读未改动 · 运行时观察时刻 **`2026-09-08T03:13Z`**。

所有行号用 `grep -n` / `sed -n` 在上述锚点上取过。共 **7 轮 Codex xhigh 设计评审**,
逐条复算行号,发现并修正了 9 处引用偏移、1 处语义反向错误(语音复述门)、多处结论口径过宽与漏跳;第 7 轮 APPROVED。
**零代码改动。**

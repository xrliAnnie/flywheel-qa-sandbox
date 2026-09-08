# FLY-2439 Lead 通路现状 UML — 实施计划

Issue: FLY-2439 (https://linear.app/geoforge3d/issue/FLY-2439/通路实证-lead-通路现状-umlclaude-lead-codex-lead-raya-文字-raya-语音-逐箭头-fileline)
日期: 2026-09-08
基于: research.md

> **2026-09-08 追加(Lead 指令 `9bfc5fe8`)**:founder 决定**不先合 raya#26 / FLY-2381**,
> 而是等这张实证图出来后决定把 Raya 统一成一个普通 Codex Lead。本单产出因此是**决策依据**,
> 不是背景资料。新增三节需求写在 §3 的 3b(→ `research.md §G`)。范围其余不变:**不改代码**。

## 0. 本单是纯文档单

**零代码改动。** 不改 flywheel 任何 `packages/**` / `scripts/**`;
raya 生产 checkout 只读;PR #26 只在 scratchpad 的只读克隆里读。
交付物只有 `engineering/doc/FLY-2439-lead-paths-uml/` 下的文档 + 一个发到 founder thread 的 HTML。

## 1. 交付物清单

| 产物 | 路径 | 说明 |
|---|---|---|
| 探索 | `exploration.md` | ✅ 已完成 |
| 调研(逐箭头取证) | `research.md` | ✅ 已完成并经 Codex R1 复算修正 —— 这是**唯一的逐箭头账本**,其余产物只引用它,不复制它 |
| 本计划 | `plan.md` | 本文件 |
| 四组图的 mermaid 源码 | `diagrams/*.mmd` | 8 个文件:`{a,b,c,d}-component.mmd` + `{a,b,c,d}-sequence.mmd` |
| 渲染出的 SVG | `diagrams/*.svg` | `mmdc` 渲染,内联进 HTML |
| founder 页面 | `lead-paths.html` | Apple 浅色,手机可读,**禁用 markdown 表格**,用卡片/列表 |
| 同内容 markdown | `lead-paths.md` | HTML 的等价文字版 |
| 进度账本 | `progress.md` | 持续更新 |

## 2. 八张图的内容契约

每张图的**每条边都必须带 `file:line`**,取自 `research.md` 已复核的行号;
`research.md` 里写「未在代码中找到」的地方,图上用虚线 + `✗ 未在代码中找到` 标注,不画实线。

### 2.1 组件图(4 张)

用 `flowchart TB`,`subgraph` 表示**进程边界**(这是本单的核心信息:哪一段在谁的进程里)。

- **A**:`Discord` → `Lead Claude 会话{bun 适配器}` → `本地 spool(chat-receipt-spool/ingest)` → `spawn chat-ingest CLI` → `comm.db` →(可丢弃门铃)`Bridge{LeadInboxLoop}` → `JSON 文件 + jsonl sidecar` → `Lead 模型(内置 poller)`;出站 `模型 → reply 工具 →(reply-guard 问 Bridge,可 fail-open)→ Discord REST`;另标 legacy fail-open 旁路(整条绕开 comm.db 与 Bridge)。
- **B**:`Discord` → `Lead launchd 守护进程{RestPoll + Gateway + MailboxStrategy}` → `comm.db` → `Bridge{LeadInboxLoop}` → `unix socket` → 同一守护进程内 `LeadJournal.acceptBatch(journal.db)` → `LeadInputRouter → CodexTurnExecutor` → `codex remote-control daemon(ws+unix)`;出站 `DirectDiscordOutboundSender → Discord REST`(标注 direct 是生产默认)。
  **B 不敲 Bridge 门铃** —— 图上不得从 B 的 ingest 画门铃箭头。
- **C**:`Discord 网关 ws` → `raya brain 进程{voice-mode → TextChatController}` → `spawn codex app-server(stdio)` → `thread/start|resume` + `turn/start`;侧路 `【问 Lead】标记 → roundtable @mention → 30s REST 轮询拉取 → 校验 Lead bot 身份 → synthesizeAsk 再跑一轮合成回灌`(thread 复用是**有条件**的,图上不得画成「保证同一 thread」);出站 `brain → Discord REST`。**图上必须显式画出「无 Bridge / 无 comm.db」。**
- **D**:`Discord 语音房` → `raya voice 进程{VoiceRoom → Uplink → VAD/抢话门}` → `AppServerClient(stdio)` → `thread/realtime/*`;回程 `outputAudio → Downlink → player`;侧通道分两个**方向不同**的组:
  ①**发**(存在):`Codex 提案 *.action.json → OutboxWatcher 取证 → ReadbackGate 复述 → 反对窗口超时 → Lead 频道`,边上必须标「**不反对即发**」而不是「确认后发」;
  ②**收**(断):`voice-inbox/items.jsonl → InboxReader → 念/文字fallback/ship_gate`,**写入方画成虚线 + `✗ 无生产写入方`**。

### 2.2 时序图(4 张)

用 `sequenceDiagram`,participant = 进程,消息标签带 `file:line`。
注意:参与者名不能含 `#` 或括号(会被截断);`;` 在 sequenceDiagram 文本里是分隔符,不能出现在标签里。

- A:founder 发消息 → 适配器 → chat-ingest 子进程 → comm.db → (门铃) → LeadInboxLoop → writeMailboxBatch → poller → 模型 → reply → reply-guard → Discord。
- B:同上但入站是 3s 轮询、投递是 socket、出站 direct。
- C:messageCreate → controller → `thread/resume`(或 `thread/start`)→ **`turn/start`** → 回答 → 若含 `【问 Lead】` 则发 roundtable → 30s 轮询捞回(`rest.list`)→ `synthesizeAsk` 经 `ensureThread()`(通常复用旧 thread,rollout 缺失或无 resumeId 时新建)再跑一轮 `turn/start` → 发回 `#raya`。
- D:说话 → VAD 开门 → appendAudio → outputAudio → Downlink;另加两条**方向相反、彼此不相连**的分支:
  ①**出**(存在,opt-out):`Codex 提案 *.action.json → OutboxWatcher 取证 → ReadbackGate 念复述稿
  (稿子说「确认后我会发」)→ 反对窗口超时 → 发到 Lead 频道`,边上标「**不反对即发**」;
  ②**入**(断):`??? → voice-inbox/items.jsonl → InboxReader → 五种处置`,
  **上游写入方画成虚线 `✗ 无生产写入方`**。
  ⚠️ 图上**绝不能**把 ① 和 ② 串成一条「Raya 提问 → 写 items.jsonl → 收到回答」的时序 ——
  `voice-inbox` 是入站回流口,不存在从 Raya 的提问动作写入它的箭头;
  「问别人并等回答」这条时序在代码里根本不存在,只能画成两个断开的半截。

## 3. HTML 页面结构

Apple 浅色(遵循 `~/.claude/rules/html-report-style.md`),`max-width 960px`,手机响应式。
**禁用 markdown 表格** —— 全部改为卡片 / 定义列表。

1. 顶部:一句话结论 + 四条通路的「Bridge 在不在」四个状态卡。
2. §A/§B/§C/§D:每节 = 组件图 SVG + 时序图 SVG + 逐箭头卡片列表(每卡:箭头 + `file:line` + 一行说明)。
3. §C 额外:C vs B 的逐项差异卡片(每项写「相同/不同 + 依据」)。
3b. **§G 统一化实证**(Lead 指令 `9bfc5fe8` 追加,founder 决策依据):
   - **G.0 必须先讲**:Codex Lead 壳不是一种形态,是按 `codexProfile` 分叉的三条路径;
     生产 Mufasa 走 full-access,**没有 gateway / broker / confinement**(`codex-lead-runtime.ts:1385-1390`)。
     页面上任何「壳有 X」的卡片都必须写明它适用于哪条 profile。
   - G.1 Raya 文字 vs 壳的**逐维度卡片**(入站/信箱/路由/大脑连接/出站/超时/MCP 注入/daemon 监督/凭据隔离/问 Lead/名册),
     每张卡标注「同一件事的两份实现 / 不是同一件事 / 只有一边有」+ 文件与行数(口径:`.ts` 只排除 `*.test.ts`)。
     其中四张卡的判定与直觉相反,必须显眼:**信箱**(Raya 没有 durable 入站队列)、**超时**(不是同一件事)、
     **凭据隔离**(生产 profile 下壳反而没有硬门)、**问 Lead**(重叠的只是「接答复+回灌」,壳缺的是主动发起闭环)。
     **MCP 卡片必须按「builder 潜在能力 vs 生产 TUI 的 exact config gate」两层写**,不能把 builder 的
     「chrome 可共存」当成生产 Mufasa 的事实(`lead-actions/mcp-config.ts:204-210` 是 fail-closed 的 exact gate)。
   - G.2 **删/留清单**:可由壳承担 ≈890–1 090 行、必须保留 **≈17 950 行**(其中 `apps/voice` 单独 13 683 行;
     不含它 ≈4 270)、**页面上的每个合计都必须与表内各行相加一致**、
     外加四个取舍点。整节顶部必须写「这是归类推演,不是实施计划」,且**不得出现「要改成 / 换成 / 重映射」这类实施句**。
   - G.3 **语音能否同样通用化**:五条阻碍卡 + 「可分离面」一张卡。
     ④ 必须写清 flywheel 已有的 `voice-bridge`/`voice-core`(90 文件 / 20 319 行)**有实时能力但走 Gemini Live**,
     不能写成「零 realtime」。① 的措辞必须是「当前接线未使用 `turn/steer`」而不是「壳只有四个 RPC 方法」。整节不提方案。
4. §D 额外:「会议中能不能和别人交流」问答卡(能/不能各自列证据)。
5. §E:与 founder 期望的差距(G1–G9),**只陈述,不提方案**。
6. 页脚:取证方法与版本锚点(flywheel main sha、raya b1b5a64、PR #26 head、插件 0.0.6、claude 2.1.263)。

## 4. 已知风险与对策

| 风险 | 对策 |
|---|---|
| 多张 mmdc SVG 内联同一 HTML 时,删 `id="my-svg"` 会让节点渲染成纯黑块 | 改唯一 id 并**同步重写** `#my-svg` 选择器;发布前**真看渲染图**截图核对 |
| `subgraph` 的 `direction` 在有跨边时被忽略 → 图横排到不可读 | 优先纯 `TB`,必要时用 `~~~` 隐形边;渲染后按宽度检查 |
| 行号漂移(Codex R1 实测已发生过 9 处) | **同一份箭头账本只维护在 `research.md` 一处。** 图上的边只带该箭头的**主锚点**一条 `file:line`;HTML 卡片只放结论 + 主锚点,完整账本由 `research.md` 承担,页面给出指向它的说明。`lead-paths.md` 是 HTML 的等价文字版(同样是结论层),不是 `research.md` 的第二份拷贝 |
| publish-report 重试增殖 | 只发一次,失败先查是否已发出再决定 |

## 5. 验收自检

- [ ] 8 张图 mermaid 渲染无错(mmdc 退出码 0),SVG 内联后节点非黑块(截图确认)。
- [ ] 图上每条边有 `file:line`;所有「找不到」的地方写明,无推测;负面结论都带搜索口径限定。
- [ ] HTML 内零 markdown 表格;手机宽度(390px)下不横向滚动。
- [ ] `publish-report --channel 1546283926513782926` 成功,URL 写进 `progress.md`。
- [ ] `git status` 显示只动了 `engineering/doc/FLY-2439-lead-paths-uml/**`。

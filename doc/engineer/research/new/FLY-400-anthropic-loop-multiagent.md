# Research: Anthropic 的 Loop + 多-Agent 工作法 → 对 Flywheel 的启示 — FLY-400

**Issue**: FLY-400（研究：Anthropic 的 Loop + 多-Agent 工作法 → 对 Flywheel 的启示，X 视频深读）
**Date**: 2026-06-22
**Source**: X 视频 [https://x.com/i/status/2067642452991717790](https://x.com/i/status/2067642452991717790)（『Movez — Creator of Claude Code』，实测 75:50 长片）
**Method**: yt-dlp 拉音频 → OpenAI whisper-1 分段转录（5 × 15min，带时间戳）→ 全文人工深读 + 映射分析

---

## 0. 这是什么视频

一段约 76 分钟的播客（Latent Space / Index Ventures 风格的访谈），嘉宾是 **Boris Cherny**（Claude Code 的创造者）和 **Kat**（Claude Code 的 PM），两位主持人提问。核心是：**Anthropic 工程师现在到底怎么用 Claude Code + Loop + 大量并行 agent 来做事**，以及 Claude Code 这个产品是怎么从一个「研究小实验」长出来的。

> ⚠️ 转录注：whisper 把一批专有名词听错了，本文引用均已人工校正：Cloud/Quad/Codd/clod → **Claude**；Cloud Code → **Claude Code**；Ada/Ader → **Aider**；Clyde → 内部前身工具；Cloud.md → **CLAUDE.md**；clod-p → **claude -p**；Inc → **Ink**；Bunn → **Bun**；meter paper → **METR**；Streamlet → **Streamlit**。

X 帖子的标题钩子是：**"At Anthropic, almost 100% of our engineers are running 100+ agents with self-improving loops"**（视频原话更克制——见 §2.B，但「全员每天用、少数人一天跑出上千美元自动化」是实锤）。

---

## 1. 一句话总结

> **Anthropic 的方法论是「Bitter Lesson 一以贯之」：harness 越薄越好，秘密全在模型里；用最简单的东西（一个文件、一句 grep、一个 summarize），靠并行 fan-out + 人类守在「关键决策点」而不是「每一步」来放大产出。**

这跟 Flywheel 的赌注高度一致（用 Claude Code CLI 当 Runner、不自建 agent 框架、文件式 memory、人类只守 merge gate），同时也暴露了 Flywheel 几个**还没吃到的红利**（任务内并行探索、自改进 loop 自动化、周期性「重写求简」）。

---

## 2. 视频关键观点（按主题 + 时间戳）

### A. Loop / 架构哲学 —— "everything is the model"

| # | 观点 | 时间戳 |
|---|------|--------|
| A1 | **最薄的 wrapper**。"all the secret sauce is in the model. This is the thinnest possible wrapper over the model — we literally could not build anything more minimal." harness 的职责是**把会干扰模型的东西拿掉**，让 context 以「最纯的形式」给到模型，不要 intervene 用户意图。 | 1:10:32 / 1:11:46–1:12:11 |
| A2 | **Do the simple thing first**（Anthropic 的产品原则）。"keep things as crappy as you can because the constraints are actually pretty helpful." compaction 试过一堆复杂方案（重写旧 tool call、截断），最后就是「让 Claude summarize 前面的消息」。"when the model is so good, the simple thing usually works." | 0:04:39 / 0:08:55–0:09:24 |
| A3 | **CLAUDE.md = 最简 memory**。本来有一堆「memory architecture」的宏大想法，最后只 ship 了「一个文件，auto-read 进 context」（root / 子目录 / home 三档）。 | 0:09:36–0:10:11 |
| A4 | **Agentic search 完胜 RAG**。早期版本用过 RAG（Voyage embedding 索引代码库），最后落到「就用 glob/grep 这种 agentic search」。三个理由：①体感和内部 benchmark 都**大幅胜出**；②RAG 的索引步骤会 drift out of sync + 安全负担（索引存哪？被黑了怎么办？敏感代码不想传第三方）；③agentic search **把这些全绕开了**——代价只是 latency 和 token，换来「没有安全短板的强搜索」。 | 0:47:46–0:49:09 |
| A5 | **Ship of Theseus：周期性从零重写求简**。Boris 和团队把 Claude Code **从零重写过约 5 次，差不多每 3–4 周一次**，因为 Claude 太会写自己的代码了；而且每次重写都是**让它更简单**，不是更复杂——"most of the changes are to make things more simple." | 1:11:13–1:12:11 |

### B. 多-Agent / 并行 —— Flywheel 最该看的部分

| # | 观点 | 时间戳 |
|---|------|--------|
| B1 | **任务内并行探索 + 选优**。"when I do something hairy, I'll ask it to just investigate three times or five times in parallel. And then Claude will pick the best option and summarize that." 具体用法："I want to refactor X to do Y — research three separate ideas, do it in parallel, use three agents." 这在 UI 里就是 sub-agent（Task）。 | 0:00:15 / 0:52:56–0:54:02 |
| B2 | **大规模 fan-out 自动化**。"如果你有 1000 个 lint violation，就起 1000 个 Claude 实例，每个修一个然后发 PR。" 少数 Anthropic 工程师靠这种自动化**一天烧上千美元**（多数人不会，但能做）。这是「power user 的 power workload」。 | 0:12:40–0:13:25 |
| B3 | **Unix utility / primitive 心智模型**。"想成 grep / cat 那样可组合的工具。Claude Code 是一个 primitive，不对你的 workflow 有意见，应该能塞进任何 workflow。" 财务的人把 CSV `cat` 进 `claude -p` 问问题；非技术的设计师 Megan 用它**给 console 产品发 PR**。 | 0:22:53 / 0:59:18 / 1:07:16 |
| B4 | **三层 build 的位置感**。要做一个能力，三层可选：①做进**模型**；②做进 **scaffolding**（Claude Code 本体）；③把 Claude Code 当**更大 workflow 里的一个工具**去组合（例：很多人用 tmux 管一堆并行 session——"we don't need to build all of that in"）。 | 0:08:15 |
| B5 | **非交互模式（claude -p）= 自动化入口**。`claude -p "prompt"`。最适合 **read-only** 任务（linter、生成 changelog）。要写就**显式传窄 `--allowed-tools`**（如只给 `git status`/`git diff`/`edit`）。 | 0:30:50–0:32:56 |
| B6 | **并行用 worktree、易回滚用「每次 commit」**。power-user workflow：有人让 Claude「每次改动后就 commit」方便 rewind；有人「每次开一个 worktree」让**几个 Claude 在同一个 repo 里并行跑**。Claude Code 不挑 workflow，都支持。 | 0:59:01–0:59:18 |

### C. 工程实践 / Loop 纪律

| # | 观点 | 时间戳 |
|---|------|--------|
| C1 | **Start small → scale（fan-out 的核心纪律）**。"先在 1 个上测，迭代 prompt，再 scale 到 10 个，确认成功或分析失败模式，再逐步放大。**绝对不要一上来就 kick off 一个修 100,000 个测试的 run。**" | 0:32:56–0:33:18 |
| C2 | **尽早发现失败**。"如果模型走错了路，你 10 分钟后才纠正，会很痛苦；尽早识别失败、尽早纠正，体验好得多。" 权限系统正是为此：read 安全、edit/run-test 中等、bash（`rm -rf` 风险）必须 human-in-loop；其余 allowlist/denylist 用 regex。 | 0:26:00–0:28:09 |
| C3 | **自改进反馈 loop（"AGI-pilled"时刻）**。工程师 Jeremy 写了个 bot 扫某个 Slack 反馈频道，挂上 Claude Code **自动给所有问题发修复 PR**——修好了相当高比例的 issue。还有「客服在频道里报 bug，10 分钟后工程师说『Claude Code 已经修好了』」的常态。 | 0:38:21–0:39:58 |
| C4 | **语义 lint（semantic linting）**。内部 GitHub Action 调 `claude -p` 跑 `/project:lint`：检查**静态分析做不到的事**——代码和注释是否一致、有没有用规定的网络库而不是内置库、拼写……"写一条 markdown bullet commit 进去，比写一堆 lint rule 容易得多"。流程：lint → 找问题 → 改代码 → 用 GitHub MCP 把改动 commit 回去。 | 0:21:41–0:23:02 |
| C5 | **Think/Plan 也走 Bitter Lesson**。不做显式 plan/act 模式开关，就一句话："think hard, make a plan, don't write any code yet"。最佳用法：先让它做点 research（把代码拉进 context）→ 再 think → 再 plan → 再 execute；中途任何时候都能再 think。 | 0:49:46–0:51:31 |
| C6 | **用「跑 3 个原型」替代「写设计文档」**。"以前我会写大设计文档、想很久才动手；现在我让 Claude Code **并行 prototype 3 个版本**，试一下哪个更顺手——这比文档**更快也更准**地帮我判断。" 但**不绕过**「这个 feature 是否符合产品愿景」的把关。 | 0:40:44–0:41:49 |
| C7 | **人类守在 merge，不守每一步**。即使 80–90% 的代码是 Claude 写的，**merge 的那个 IC 仍对代码质量负全责**——"Claude Code isn't its own engineer that's committing code by itself."（对应 ASL 安全级别：模型越强，越要在「对的地方」留 human-in-loop）。同时要有判断力知道**哪些任务交给模型、哪些自己手写**（如「精细的数据模型重构我自己来，因为我意见很强，自己做比跟 Claude 解释更快」）。 | 0:18:16–0:19:05 / 0:33:18–0:36:21 |

### D. 度量与价值

| # | 观点 | 时间戳 |
|---|------|--------|
| D1 | **新的成功度量**。团队在攻坚两个：①**cycle time**（first commit → PR merged，feature 出得多快）；②**「本来不会做的 feature 数量」**——那种「本来会进 backlog 烂掉、现在 10 分钟顺手修了」的。**不是 lines of code**。 | 0:38:21–0:39:27 |
| D2 | **ROI 不是 cost**。"想成 ROI 问题而非成本问题：工程师很贵，能让他 50–70% 更高产就很值。" 内部约 **$6/天/活跃用户**；Boris 自己约 2×，有人 10×，也有人只 10%（只拿去生成 commit message）——"差距很大，要再研究"。 | 0:14:56–0:15:37 / 1:05:28 |
| D2b | **多模型分层**。几乎全默认 **Sonnet**（实测最强）；可 override 用 **Haiku** 跑便宜的连续任务（pre-commit lint）。原则：pre-commit 要快（<5s，只跑 types+lint），贵的放 CI。 | 1:00:04–1:01:46 |
| D3 | **模型失败模式**。Sonnet 3.7「极其执着」但**把目标理解得太字面**（经典："让测试过" → 它把答案 hardcode 了）；多次 compact 后**原始意图会变弱、会忘**。所以期待更大的「有效 context window」，让长任务全程不跑偏。 | 0:54:05–0:56:09 |
| D4 | **会 prompt 比技术深度更重要**。shadow 用户发现：**擅长 prompt 的人（哪怕不懂技术）用 Claude Code 非常有效；不擅长 prompt 的人会让它跑偏。** 技术人最高杠杆的位置是**开头**（问对问题）和**结尾**（review），中间可以交出去。 | 1:05:57–1:09:36 |

---

## 3. 对 Flywheel 的启示（三档）

Flywheel 现状速记：**Lead**（部门负责人，Claude Code session）管 **Runner**（每个 Linear issue 一个，Claude Code in tmux，走 brainstorm→research→plan→design-review→implement→code-review→PR→land）；**Bridge** 居中编排 + gate；**Discord** 当总线；**gate**（brainstorm / approve_to_ship）= 人类检查点；**founder-only-authority** 把 merge/ship 锁给 Annie；**Codex** 当 design/code reviewer；**memory** = 文件式（MEMORY.md auto-load + mem0）；**Decision Layer** 用 Haiku 做 triage。

### 档 1 ✅ 已对齐（视频验证了 Flywheel 的核心赌注是对的）

| 视频观点 | Flywheel 现状 | 结论 |
|---------|--------------|------|
| A1 最薄 wrapper / everything is the model | Runner 直接 spawn **Claude Code CLI**，没自建 agent 框架 | ✅ 赌对了。Anthropic 自己都「最薄 wrapper」，Flywheel 不该回头去造厚 harness |
| A3 CLAUDE.md 文件式 memory 最简 | Flywheel 用 **MEMORY.md auto-load + CLAUDE.md**，刻意推迟了重型 memory 架构 | ✅ 验证「文件式 > 复杂 store」。Boris："everything is the model… 模型自己会编码 knowledge graph" |
| A4 agentic search 完胜 RAG（含安全负担） | Flywheel Runner 直接在 repo 上 grep/glob，**从没建过 RAG 索引** | ✅ 无意中躲过了 RAG 的 drift + 安全坑 |
| C7 人类守 merge、Runner 不自合 | **founder-only-authority + approve_to_ship gate**；FLY-248「Runner 绝不自 merge」 | ✅ 几乎逐字对应 "Claude Code isn't its own engineer committing by itself" |
| C4 语义 lint（超越静态分析的 review） | **Codex design/code review**（多轮、语义级） | ✅ 同一思想：把「静态规则查不出的东西」交给模型评审 |
| C3 自改进反馈 loop（Slack→自动 PR） | **CoS triage（Aunt Cass 扫 Linear/Discord → 建 issue → 派 Runner）** | ✅ 这就是 Flywheel 的存在理由，被 Anthropic 实践直接背书 |
| B3 Unix primitive 可组合 | Flywheel 组合 Claude Code(Runner)+Codex(review)+Bridge+Discord | ✅ |
| B6 worktree 并行 | git-workflow 规则强制 worktree；多 Runner = 多 worktree 并行 | ✅ |
| C5 think-hard 自然语言 plan | Flywheel 的 brainstorm/plan 阶段就是自然语言，不搞模式开关 | ✅ |
| D2b 多模型分层（Haiku 便宜活） | Decision Layer 已用 **Haiku** triage；FLY-241/247 已有 per-agent 模型开关 | ✅ |

> **给 Annie 的话**：这一档的价值是「**信心**」——Anthropic 内部的实践，几乎逐条印证了 Flywheel 这两年的架构选择。不用改，继续。

### 档 2 🔧 可借鉴改进（Flywheel 已有雏形，能做得更好）

| 视频观点 | Flywheel 差距 | 建议动作 |
|---------|--------------|---------|
| **C1 Start small → scale** | Flywheel 已有「单 slot QA → 单 Lead cutover → fleet」的影子，但**没把它写成铁律**。FLY-220/218 等事故里有「实现者自己部署没先验」的教训 | 把 "test on 1 → validate → scale to N" 立成 fleet 变更（新 Runner prompt / agent role / 模型切换）的**强制纪律**，写进 lead-rules-base |
| **C2 尽早发现失败** | brainstorm gate 已是「早检查点」，但中段 implement 基本是 Runner 闷头跑到 PR 才被 review | 增加**轻量中段 checkpoint**（plan 落地即 Codex design-review 已有；可补 implement 中途让 Lead 瞄一眼方向，对应「别等 10 分钟后才纠正」） |
| **C3 自改进 loop 收得更紧** | CoS triage 是「人/定时触发」；生产 incident → issue 还不是全自动 | 探索「**生产报错/Discord 反馈 → 自动建 issue → 自动派 Runner**」的闭环（就是 Jeremy 的 Slack bot 模式） |
| **D1 新度量** | Flywheel 没系统跟踪 cycle-time，也没跟踪「本来不会做的活」 | 给 Runner 埋 **cycle time**（issue 起 → PR merge）+ 统计「**backlog 里本来会烂掉、被顺手 ship 的 issue 数**」当北极星 |
| **B5 claude -p + 窄 allowed-tools** | Runner 跑 interactive tmux（为可视化 + Lead steering），危险动作靠 Bridge gate 拦 | 对**纯 read-only 的 Runner 阶段**（research/审计）可借 `-p` + 窄 `--allowed-tools` 的更细权限模型，降风险降成本 |
| **D4 prompt 质量 > 技术深度** | Flywheel 的 agent prompt（generic-executor 等）是「能力说明」 | 持续投资 **Runner/Lead 的 prompt 工程**（这是杠杆最高的地方）；把好 prompt 当一等公民资产管理（对应 task #16 de-AI skill 评估方法论） |

### 档 3 🚀 新机会（Flywheel 还没吃到的红利）

| 视频观点 | 新机会 | 价值 / 风险 |
|---------|--------|-----------|
| **B1 任务内并行探索 + 选优** ⭐ | **最直接、最该做的一条**。Flywheel 现在是**「一 issue 一 Runner 一个方案」**（issue 间并行，issue 内单线）。新模式：对**难的设计决策**，让 Lead 或 Runner **并行 spawn 3 个 sub-investigation / 3 个原型**，再选优/合并（即 Anthropic 的 "investigate 3-5 paths, pick best" + C6 "prototype 3 versions"）。这正是 Flywheel 自带的 Workflow 工具的 judge-panel 模式 | 价值高：直击「多-agent」红利；风险：成本×N、要 Lead 来选优。先在「方向不明的 brainstorm」类 issue 上试点 |
| **A5 周期性「从零重写求简」** | Flywheel 在累积复杂度（CLAUDE.md 里程碑表已极长、env 开关一堆）。借「ship of Theseus，每 3–4 周重写更简」的纪律，定期做**主动简化 pass**（删死开关、合并重复机制） | 价值中高：抗腐化；现在缺的是「主动求简」的节奏，不是能力 |
| **C3 + memory 的「logbook」** | 视频里「Claude 写一份 action logbook，慢慢理解团队/目标/你怎么干活」。Flywheel 有 MEMORY.md + retro + compound，但**还不是「每个 Runner 完工→自动抽取学习→回灌 prompt/skill」的自动 loop** | 把 retro/compound 从「人触发」做成「Runner 完工自动跑」，让 agent「each run 越来越好」（= 视频钩子里的 "self-improving loops"） |
| **「为 3 个月后的模型而建」** | Anthropic 的设计原则：建给「模型 3 个月后会擅长的事」（更自主、更长 context）。Flywheel 的 **founder-only-authority「随信任逐步收窄」roadmap（FLY-175）** 就是这个思路 | 把「随模型变强、human-in-loop 在对的地方逐步收窄」立成**显式的产品演进原则**（含 ASL 式的分级语言）|

---

## 4. 给 Annie 的 Top 建议（按优先级）

1. **⭐ 试点「任务内并行探索」（档 3·B1）** — 选 1–2 个「方向不明」的 brainstorm 类 issue，让 Runner/Lead 用 Workflow 工具并行跑 3 个方案再选优。这是视频里「多-agent」红利对 Flywheel 最直接的一条，且我们**已有现成工具**（Workflow / judge-panel），只是没在 issue pipeline 里用起来。
2. **把 "Start small → scale" 立成 fleet 变更铁律（档 2·C1）** — 直接呼应我们 FLY-218/220 的部署事故教训：任何 fleet 级改动先在 1 个 slot 验证、再放大。低成本、高收益。
3. **埋 cycle-time + 「本来不会做的活」两个度量（档 2·D1）** — 给 Flywheel 一个比「PR 数」更真实的北极星，也方便对 Annie 讲清楚价值。
4. **收紧自改进 loop（档 2·C3 / 档 3 logbook）** — 朝「生产反馈→自动 issue→自动 Runner」+「Runner 完工→自动 retro 回灌」演进。这是「self-improving loops」钩子的真正落地。
5. **定期「求简 pass」（档 3·A5）** — 给 Flywheel 排一个周期性的主动简化窗口，抗复杂度腐化。

> 决策点都在 Annie：以上 1–5 哪些值得开 issue / 排期，由她拍。本研究只负责把「视频 → 对我们的启示」讲清楚。

---

## 5. 附录：精选原话（已校正专有名词，附时间戳）

- **[0:00:15]** "when I do something hairy, I'll ask it to just investigate three times or five times in parallel. And then Claude will pick the best option and summarize that."
- **[0:12:47]** "if you have like a thousand Lint violations and you want to start a thousand instances of Claude and have it fix each one and then make a PR, then Claude Code is a pretty good tool."
- **[0:33:12]** "definitely don't kick off a run to fix 100,000 tests… test it on one, iterate on your prompt, then scale it up to 10… and gradually scale it from there."
- **[0:39:53]** （Jeremy 的 Slack→PR bot）"it fixed a lot of the issues… it was surprisingly high to the point where I became a believer in this kind of workflow. And I wasn't before."
- **[0:48:21]** "eventually we landed on just agentic search… it outperformed everything by a lot… agentic search just sidesteps all of that. So at the cost of latency and tokens, you now have really awesome search without security downsides."
- **[1:10:40]** "all the secret sauce, it's all in the model. And this is the thinnest possible wrapper over the model. We literally could not build anything more minimal."
- **[1:11:24]** "We've rewritten it from scratch… probably every three weeks, four weeks… it's like a ship of Theseus… most of the changes are to make things more simple."
- **[0:35:54]** "it's still up to the individual who merges it to be responsible… Claude Code isn't its own engineer that's committing code by itself."

---

**Status**: Complete — 交付物 = 本 research md + founder-facing HTML insights 报告（Apple-light）。HTML 路径报 Lead（Tadashi）由其 publish 到 [FLY-400] thread。

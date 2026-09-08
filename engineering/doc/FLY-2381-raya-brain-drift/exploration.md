# FLY-2381 Raya 大脑:读各仓 + goal 两阶段 + 偏离探测 — 探索
Issue: FLY-2381 (https://linear.app/geoforge3d/issue/FLY-2381/raya大脑-自己去各仓读状态-goal-两阶段-偏离探测prd-1846-51-7-102030-声明过从未交付的那一半)
日期: 2026-09-06
基于: 无(上游 = FLY-2379 exploration/research/plan(文字通路)· FLY-1846 PRD v1.7 · FLY-2030 scope-final · FLY-2131 plan)

> 成色标记:✅ founder/Lead 已拍(issue 或 PRD 原文)· 【实核】本机读码/实测(2026-09-06,命令见 research.md)· ⬜ 工程判断 · ❓ 已 ask Lead(7bfca58d),默认继续。
> 模式:Technical · 深度:Deep。本节点自治运行,交互式 Q&A 改为非阻塞 ask。Linear MCP 本会话 401,issue 内容以 dispatch 正文为准。

## 1. 问题:PRD 定了三格,brain 里一格都没有

【实核】`~/.flywheel/raya/code/apps/brain/src/` 共 12 个源文件(runtime / cli / config / voice-mode / meeting / meeting-calendar / metrics / preflight / installer / launchd / env):`grep -rn "projects.json\|projectRoot\|goal\|drift\|偏离" apps/brain/src packages/contracts/src` **零命中**。brain 今天做的是:资源采样(60 s)、语音模式网关、会议网关(未配置)、voice down 告警。

对照 PRD 已定的三格:

| PRD | 她定了什么 | brain 现状 |
|---|---|---|
| §5.1 ✅ 她圈 A | **主管自己去各仓读状态**,注册表 `~/.flywheel/projects.json` 已在 | 无任何仓读取 |
| §7.1 ✅ 她的自由表述 | goal **两阶段**:一开始她主动告诉它;校准频率运行后定(§7.2 = §6.2) | 无 goal 存储 |
| §10.1/10.2 ✅ 她圈 C + 自由表述 | **不排序,做偏离探测**:「你说过 A 要紧,但都在 B,是 A 不重要了还是 B 卡住了?」;§10.5 沉默是一等信号 | 无对照逻辑、无主动开口 |

FLY-2030 以 M1(summary 回流)关单,FLY-2131 做了 summary 吸收 / 可见汇报 —— 但那两单的 M2 都按「Raya = flywheel 侧 Codex Lead(TUI)」的形态设计(2131 plan §1:巡视触发在 flywheel `flag_values`、Raya 在 Lead workspace 里跑)。【实核】那条 Lead 线至今未出生(2379 exploration §1:`com.flywheel.lead.raya-raya` launchd 无此 label、projects.json 无 raya 行)。founder 2026-09-06 直令 2379「补上」文字通路 = brain 常驻 Codex thread。**本单顺着 2379 的形态,把三格落进 brain**;不复活 Lead 线。

## 2. 承重积木(全部 raya 仓内;不依赖 flywheel 源码)

| 积木 | 位置 | 本单怎么用 |
|---|---|---|
| 文字对话控制器(2379,plan 已过 design review) | `apps/brain/src/text-chat/` `TextChatController`(串行队列 · `runTurn` · 标记行协议 `【问 Lead】` · 收据 · `state/text-chat/`) | 偏离追问与 goal 收据都走**同一个 thread、同一条队列**;新增两类标记行、一种「系统发起的 turn」 |
| Codex 常驻子进程 | 2379 `TextChatCodexClient`;`packages/contracts/src/codex-session.ts` 钉 gpt-5.6-sol · xhigh · 1M · workspace-write | 巡视 = 一个 turn,不另起子进程 |
| 提示装配 | 2379 `baseInstructions = IDENTITY + MEMORY + 文字聊天段` | 追加「读数 / goal / 偏离」段;IDENTITY.md 本体不动(Judgment 段已含「Detect divergence… concrete enough that she can reject it」) |
| 可写记忆仓 | `RAYA_MEMORY_FILE=~/.flywheel/raya/memory/MEMORY.md`;【实核】仓 `xrliAnnie/raya-memory`,2 commits,`Active commitments: None recorded yet` | goal 落同仓新文件 `goals.md`(§5.2);brain 代写 + commit |
| 60 s 采样循环 | `runtime.ts` `runBrain`:`do { runSamplerTick; wait(60s) } while(!aborted)` | 巡视计时器形状相同,但**不塞进** `runBrain`(那是资源指标),放进 text-chat 侧的 `PortfolioPatrol`(§5.3) |
| 配置风格 | `config.ts`:`RAYA_MEETING_CALENDAR_ENABLED` 布尔、`RAYA_VOICE_OPTIONS_JSON` 有界 JSON、sensitive 路径不得与 workspace 重叠 | 新 env 同风格:`RAYA_PROJECTS_FILE`、`RAYA_PORTFOLIO_OPTIONS_JSON`、`RAYA_LINEAR_API_KEY?` |
| 原子写 / corrupt 处理 | voice `store.ts` tmp+fsync+rename、`.corrupt-<ts>` | `state/portfolio/*` 同款 |
| Discord REST helper | 2379 `discordRest(token)`:`send` 固定 `allowed_mentions:{parse:[]}` | 主动提醒复用;不新增权限 |
| summaries 合同(2030 M1) | `summaries/<project>/<date>--<lead>--<seq>.md`,frontmatter `{project, lead, period, facts, judgment}`;【实核】生产只有 README,零 summary | 采样器把「该项目 summary 数 / 最近日期」当一个读数来源;今天全部为 0,如实写 |
| Lead 目录 | `state/leads/<id>/profile.json`;【实核 2026-09-06】生产已有 3 个(flywheel cos/eng/product) | 偏离追问点名 Lead 时沿用 2379 的解析;本单不改 |

## 3. 实测:PRD §5.4 的数字已经过期,而且过期的方向要紧

【实核 2026-09-06】逐个 `projectRoot` 跑 `git log`(命令见 research.md §2):

| 项目 | 最近一次提交 | 最近一次**非 chore** 提交 | open PR | 备注 |
|---|---|---|---|---|
| geoforge3d | 2026-08-29 `chore(config): retire project flag keys` | **2026-07-11** feat(GEO-446) | 5(最新 08-17) | 有 CLAUDE.md |
| joycon-typeless | 2026-08-29 同上 | **2026-07-04** docs(LEARN-203) | 5(最新 08-31) | 停在 `chore/enable-doc-flow` 分支 |
| personal-assistant | **2026-09-02** fix(meal-prep) | 2026-09-02 | 2(09-02) | **已是 git 仓**(remote `xrliAnnie/belle-workspace`)—— PRD「不是 git 仓」已过期(2030 scope-final 1.4 已核过一次) |
| growth | 2026-08-29 同上 | **2026-07-10** docs(reflection) | 1(06-24) | |
| flywheel | 2026-09-06 | 2026-09-06 | 30 | 唯一活的 |
| tidal-echo | 2026-08-29 同上 | **2026-07-05** feat(FLY-886) | 5(最新 08-02) | 无 CLAUDE.md |

两条设计后果:

1. **「最近一次提交」单独看会骗人**:五个仓在 08-29 同一天被一条 fleet 级配置 sweep(`chore(config): retire project flag keys`)统一推进;只看 `git log -1` 会把四个已静默两个月的仓读成「上周还在动」。⇒ 采样器必须**同时给出**「最近提交」与「最近非 chore 提交」,把「机器整理」与「真实推进」分开,而且**两个都亮给她**(她能核),不由代码替她裁定哪个算数。
2. **§10.5「沉默是一等信号」今天仍然成立,但 4 个静默项目里 3 个各有 1–5 个 open PR 挂着**(最旧 04-19)—— 「静了多久」之外,「挂着多少没收尾」也是能直接读到的第二个信号。

Linear:【实核】`projects.json` 六项目只有 flywheel 有 `linear` 绑定;Raya 环境无 Linear 凭据(`raya.env` 键名清单不含 LINEAR);本会话 Linear MCP 也 401。⇒ Linear 是「能读多少读多少」里今天**读不到**的那一路,设计上留口子、明写读不到。

## 4. 三个必须先看清的分叉

### 4.1 谁去读:brain 确定性采样 vs 模型自己在沙箱里翻 ❓(ask 7bfca58d 附注)

2379 假设模型在 `workspace-write` 沙箱里能 `git log`(研究 §2.4 已核「不挡读」)。那为什么还要 brain 写采样器?

| | 模型自己翻 | brain 采样器(**默认**) |
|---|---|---|
| 可核性 | 她看到的数字来自模型转述,无法回放 | 每个数字来自一次带时间戳的采样文件 `state/portfolio/snapshots/<ts>.json`,QA/她都能对 |
| §3 硬约束 | 「读不到」由模型自己判断,容易硬编 | 每个来源 `{value} | {unavailable, reason}` 二选一,**没有第三态** |
| 成本 | 每次问都要跑 6 仓 × 若干命令,xhigh 下几十秒 | 采样离线跑(巡视/启动/按需),turn 只吃一份 Markdown |
| 可测 | 只能真机 | 纯函数 + fake `run()` |

决定:**采样器是主干**;模型仍可在沙箱里补读细节(§5.1 的「自己去读」不因此被剥夺),但提示段写明「读数以采样为准,引用时带采样时间」。

### 4.2 goal 存哪、怎么进 ❓(ask 7bfca58d 之 3)

| 候选 | 判 |
|---|---|
| A. `raya-memory/goals.md`,append-only,每条 `{id, date, 她的原话逐字, 来源消息链接, status}`;由模型标记行 `【记目标】` 触发,brain 代写 + commit + 📌 收据 | **默认**:与 §10.4b「留她交代要执行的东西」同形;不填表;可撤;版本可溯 |
| B. 写进 `MEMORY.md` 「Active commitments」段 | 机器解析要靠段落约定;混入其它记忆;否 |
| C. 她打 `目标:…` 命令,brain 直接存 | 填表形态,PRD §10.4 明否;否(留作 2 阶段若她要求) |
| D. 模型直接写文件(memory 仓是 writable root) | 无收据、效果声明不可核(FLY-2031 教训);否 |

### 4.3 巡视在哪跑 ⬜

- 「不做新 daemon」(issue 第 4 条)⇒ 计时器在 brain 进程内。
- 不塞进 `runBrain`(那是资源指标循环,和 Codex 无关)。⇒ `PortfolioPatrol` 挂在 text-chat 控制器旁,到点把「巡视 turn」投进**同一条串行队列**(与 founder 消息、Lead 回帖同队列,天然不打架)。
- 间隔:默认 6 h(§8.7.2 她圈 a),**运行期可改** = `state/portfolio/patrol.json` `{intervalMs, enabled}`,每 tick 重读;env 只给默认值。

## 5. 方案

### 方案 A:采样器 + goals.md + 巡视 turn(推荐)

三块各自独立可验,合在一个 thread 上:

1. **读**(`apps/brain/src/portfolio/sampler.ts`):按 `RAYA_PROJECTS_FILE` 逐项目采样 git / GitHub PR / Linear / summaries;每源超时 15 s;结果 `ProjectReading` 里每个字段都是 `{ok:true, value} | {ok:false, reason}`;落 `state/portfolio/snapshots/<ISO>.json` + `latest.json`;`renderSnapshot()` 出 Markdown(读不到的行原样写「读不到:<原因>」)。
2. **goal**(`apps/brain/src/portfolio/goals.ts`):标记行 `【记目标】<原话>` / `【撤目标】<id>` → `goals.md` append(原子写)→ `git commit` in memory checkout(push best-effort,失败可见)→ 📌 / ↩️ 收据。校准入口 = 同机制,不定时。
3. **偏离探测**(`apps/brain/src/portfolio/patrol.ts`):触发 = 6 h 计时(可改)∪ 新 goal 落地 ∪ brain 启动后首次;每次 = 采样 → 组巡视 turn(读数 Markdown + goals.md + 「只在分岔时说一句可否掉的话,否则回 `【无话】`」)→ 回复 `【无话】` ⇒ 静默只记事件;否则以 `🔔 **Raya**:` 发 #raya,尾行 `依据:读数 <snapshotId> · 目标 <goalId…>`;记 `patrols.jsonl`。她的否定就是下一条对话(同 thread)。

- 优点:三格各自 ≤ 300 行;没有新进程、新库、新权限;读数可回放;与 2379 一个 thread 一条队列。
- 缺点:依赖 2379 先落地(接口在 plan 里钉死);采样器是启发式(chore 判定)—— 处理方式是两个数都给她,不替她裁。
- 不含:排序表、硬规则、跨项目依赖机制、Lead summary 义务(M1 已有)、语音控制电脑。

### 方案 B:全交给模型(提示段 + 沙箱自读 + 自写 goals)

- 零采样代码、零 goal 代码。
- 否:数字不可核(验收要「可核」)、goal 无收据、巡视仍需计时器 ⇒ 省不掉的只剩最难测的部分。

### 方案 C:复活 2131 的 Lead 形态(flywheel `flag_values` 巡视 + Raya TUI Lead)

- 否:Lead 线未出生、五个前提未齐;违反 §8.5(巡视触发寄生在 flywheel DB);与 2379 的 brain 形态双脑。

## 6. 假设(implement 前必须成立或被证伪)

1. 【实核】`gh` 账号级 token(keyring)对六个 origin 都在 `xrliAnnie` 名下 ⇒ `gh pr list -R` 可用;brain 进程以用户身份跑 ⇒ 继承 keyring。采样器仍按「gh 缺席/超时/非零」三类落「读不到」。
2. ⬜ 2379 的 `TextChatController` 会按其 plan §2.5 暴露:串行 `enqueue`、`runTurn(input, clientUserMessageId)`、标记行解析的扩展点(本单加两种标记)。若 2379 实现时形状有偏,本单 plan §2.1 列出的接口契约是**唯一**要对齐的面。
3. ⬜ `git commit` 在 memory checkout 里由 brain 以用户身份跑,`user.name/email` 已配置(【实核】仓已有 2 个 xrliAnnie commit);push 失败只记事件 + stderr。
4. ✅ 验收以 founder 真机为准;单测只护住采样二态、标记解析、巡视静默/开口、goals 落盘与撤销、失败路径。

## 7. 不做(决定,不是遗漏)

- 不做优先级排序表、硬规则引擎(§10.3)。
- 不做跨项目依赖 / 重复劳动检测(§10c 她砍掉);「A 能帮 B」留给模型在对话里说。
- 不改 summaries 合同、不改 IDENTITY.md 本体、不改 2379 的任何 ask/thread 语义。
- 不做自动校准节奏(§7.2 运行后定);不做每日 Report(§8.7.3 另单)。
- 不做「语音控制电脑」(等 FLY-1453 OS 级隔离;HL 2026-09-06 边界)。
- 不读 `~/.flywheel/*` 之外 Raya 未被显式配置的任何 flywheel 事实(§8.5):注册表路径由 `RAYA_PROJECTS_FILE` 给,schema 由 Raya 自己定。

## 8. 下一步

- research.md:每个采样命令的精确形状与输出解析;2379 接口面逐项列;goals.md 文件合同;巡视 turn 的提示原文与「【无话】」判定。
- plan.md:三块的 TDD 分解、状态文件、失败路径、部署 runbook(含部署确认,9-6 教训)。

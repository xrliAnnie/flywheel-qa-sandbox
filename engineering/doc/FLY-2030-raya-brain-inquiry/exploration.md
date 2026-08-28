# FLY-2030 Raya 大脑:状态吸收 + 追问 — 探索
Issue: FLY-2030 (https://linear.app/geoforge3d/issue/FLY-2030/rayav2-大脑状态吸收-追问总管先行权限第一批全给)
日期: 2026-08-27
基于: 无

> 读法:本文只回答「要做的到底是什么、哪些已经定了、哪些是我拍的工程判断」。协议/代码事实在 `research.md`,拆法与验收在 `plan.md`。
> 成色标注沿用 PRD 的规矩:✅ 她的原话/她圈选/她采纳(以 PRD §0.1a 的三档为准) · 🔶 Lead/HL 定向 · ⬜ 本文作者(runner)的工程判断,Tadashi 可否。
> ⛔ 不把 🔶/⬜ 当成她说过的话。Mode = Technical(产品格子 PRD 已全部答完,§12.1「需要她决定的:0 件」);Depth = Deep。
> Linear MCP 本会话 401 不可用;issue 正文以派工 prompt 与 `linear-issue-context` skill 注入的文本为准。

## 0. 一句话

在 FLY-2029 已常驻的 `apps/brain` 里加一条**对话回路**:founder 在 `#raya` 说话 → 一条持久的 Codex thread(gpt-5.6-sol · xhigh · 1M)真回复;同一条 thread 每隔一段(默认 6h,运行期可改)自己拿一份**六仓状态快照**去比对「她说过什么要紧」,分岔时开口问一句**她当场可否掉的话**,问不清就去 `#leads-roundtable` **追问对应 Lead**;没东西说就跳过。所有主动开口都进一本可溯源的账。

## 1. 首要验收(founder 2026-08-27 拍板)

> ✅ 「Raya 能真正和 founder 对话——founder 在 #raya 说话,Raya 真实回复、能追问、能吸收状态。验收以 founder 真实使用为准,不以 unit test 为准。」

⇒ 本单第一优先级是**对话回路真的通**;偏离探测、追问 Lead、节奏 tick 都挂在这条回路上,而不是各自独立的机制(§2.5:部件少)。
issue 附加验收:✅「真实数据下至少产出一次『她当场可否掉的追问』且理由可溯;三指标记录在跑」。

## 2. 已定前提(每条带出处,⛔ 不重新论证)

| # | 前提 | 出处 | 成色 |
|---|---|---|---|
| P1 | 它自己去各仓读状态;协作成本零;注册表已存在 | PRD §5.1 | ✅ 她圈 A + 「力气放追问」 |
| P2 | **重点在追问,不在状态**;问 Lead 不需要她在场;问不到就如实说「没问清楚」,不许猜着填 | PRD §5.2 §5.3 | ✅ |
| P3 | 信息不足 → 默认**不说话**;信息够但和她意见不同 → **必须说** | PRD §3 · §8.1 ③ | ✅ |
| P4 | 开口时机 = 事件触发 + 兜底节奏;到点没东西**可以跳过**;形式 = **一起想**,不是汇报 | PRD §6.1 §6.3 §6.4 | ✅ 她圈选 |
| P5 | 频率**不在设计期定**;当前兜底周期 = **6h,运行期可改** | PRD §6.2 · §8.7.2 | ✅ |
| P6 | 它**不排序、不用硬规则、不填表**;它做偏离探测:「你说过 A 要紧,但这三周都在 B。是 A 不重要了,还是 B 卡住了?」 | PRD §10.1 §10.2 | ✅ 她圈 C + 自由表述 |
| P7 | 必须在**对话历史**上推理,不是存一个「当前 goal」字段;但**不用全量留存**:留「她交代要执行的」+「阶段性提炼的记忆」 | PRD §10.4 · §10.4b | ✅ |
| P8 | **沉默本身是一等信号**:各仓最后活动时间直接可读;它能说「X 静了很久」,不能说「X 里面怎么样」 | PRD §10.5 | 🔶 HL 裁定(实测支撑) |
| P9 | goal 两阶段:阶段一从对话推断 + 固定校准兜底;阶段二外部数据(**本单不做**,留接口) | PRD §7.1 | ✅ |
| P10 | 权限**第一批全给**;任何「先不给 X」先读 §8.4;sub-agent 要给 | PRD §8.1 §8.4 §12.4 | ✅ |
| P11 | ③ 是**披露**不是请示:它可以先动,动完把动作和理由亮出来 | PRD §8.1 ③ | ✅ 她采纳 |
| P12 | 假设使用者**没有 flywheel 这个仓库**;Raya 是独立产品、自己的仓、自己的 channel、常驻 | PRD §8.5 §8.6.3 | ✅ |
| P13 | 她↔Raya 走 `#raya`;Raya↔Lead **需要她看见的走 Lead Round Table**,不需要她看见的走 Mailbox | PRD §8.6.7 | ✅ |
| P14 | vendor = Codex,gpt-5.6-sol · xhigh · 1M 单会话参数 | PRD §8.6.1 §8.6.6 | ✅ |
| P15 | 试用期只记三样:进程内存 · swap 变化 · 实际 window 峰值;验收 = 有可查数据 | PRD §9.1b §13.0a | ✅ 她采纳 |
| P16 | 反指标:打断她的次数 + 其中她事后认为「值」的比例——**只记录,不设目标** | PRD §9.2 ③ | 🔶 HL 起草,她未过目 |
| P17 | 跳过时留一句「我看了,没有」 | PRD §6.3 附带项 · §12.1a | 🔶 HL 建议,她未表态 → **保留** |
| P18 | 大方向,不到 issue 级;失败信号 = 它开始告诉 Lead「怎么做」 | PRD §4.1 · §9.2 ② | ✅ / 🔶 |
| P19 | 记忆放在它自己的仓(`raya-memory`),不绑 vendor | PRD §12.10 · FLY-2029 已落地 | 🔶 HL 建议 → 已实现 |
| P20 | 本单代码落 raya 仓 `fly-2030-raya-brain`(自 `origin/main` b7abff4),⛔ 不碰 `~/.flywheel/raya/code` | Lead 2026-08-27 17:20 PT | 🔶 Lead |

## 3. 现状(FLY-2029 + FLY-2074 merge 后的 raya `main` b7abff4,2026-08-27 核过)

```
apps/brain   常驻(launchd RunAtLoad):60s 资源采样 → resource-usage.jsonl;
             Discord Gateway 只订阅 #raya,只认「进入/退出语音模式」两个短语 → launchctl 拉/停 voice
apps/voice   按需(voice-mode.requested):Discord 语音房 ↔ Codex realtime v2;有完整 AppServerClient(JSON-RPC over stdio)
packages/contracts   thread/start|resume 参数 builder(钉死 model/xhigh/1M/sandbox)、env 合同、metrics 行、voice-mode marker
raya-memory  MEMORY.md(只有身份锚,承诺/事实两节为空)
```

**brain 今天不会说话**:除两个语音短语与两条 voice down/recovered 告警外,founder 在 `#raya` 说什么它都 `ignored`。三指标里 ③(context peak)只在 voice 的 backend turn 有数据(`contextSamples` 极少)。

## 4. 真实意图(按她的处境写,不是按我们要做的写)

1. **她在 `#raya` 打字,对面要有一个真的在想的人**——不是 alert bot;慢可以,但她要知道它在想。
2. **它知道六个项目各自「静了多久」**,并记得**她说过哪个要紧**;两者对不上时它先开口,而且开口的那句**她一句话就能否掉**。
3. **它拿不准就去问 Lead,不用她当中间人**;问到了带结论来,问不到就说「没问清楚」。
4. **它不该在没东西说的时候硬说**;也不该在有看法的时候闷着。
5. **她不想填表**:优先级是聊出来的,不是她给字段赋值。
6. **她想事后能看到账**:它打断了她几次、哪几次值。

## 5. 关键问题与选项(设计要拍的板)

### Q1 对话回路长什么样 —— Codex thread 怎么活、怎么记

| 选项 | 内容 | 判 |
|---|---|---|
| A. 每条消息起一次 `codex exec` | 最简单 | ❌ 没有对话历史(P7);每次重读 identity+memory;RSS 无常驻可量 |
| **B. 一条长寿 `codex app-server` 子进程 + 一条持久 thread;重启后 `thread/resume`** | 对话历史就在 thread 里(Codex 自己的 rollout);三指标 ③ 从 `thread/tokenUsage/updated` 直接来;RSS 含子进程 | ✅ **选它**。前提:文本 thread 能跨进程 resume(⬜ 待 C0 探针;realtime thread 在 FLY-2074 P2 证明**不能**,但 codex-home 里已有 3 份文本 rollout,机制不同) |
| C. B + 每轮把对话摘要写进 MEMORY.md | 「全量留存」的变体 | ❌ P7:阶段性提炼,不是每轮 |

⇒ 记忆两层:**thread 历史**(Codex 原生,会自动 compaction)= 日志;**MEMORY.md**(raya-memory 仓,Raya 可写)= 阶段性提炼,在 tick 里由她自己更新并 commit。⛔ 不用 Codex 的 `thread/goal/set`(那就是 P7 否掉的「goal 字段」)。

### Q2 它怎么「开口」——主动消息、追问 Lead 怎么从模型输出里拿到

| 选项 | 失败方向 | 判 |
|---|---|---|
| A. 纯文本 + 约定标记行(`@ask flywheel-eng-lead: …`) | **静默**:标记打歪 → 她被告知「我去问」但没人被问 | ❌ |
| B. Raya 自己 curl Discord | 要把 bot token 给 Codex 子进程 | ❌ V1 的边界(token 永不进子进程) |
| C. brain 开本机 HTTP 工具端点给她调 | 新攻击面 + 又一个部件 | ❌ 本批不做;将来工具多了再议 |
| **D. 每轮 `turn/start` 带 `outputSchema`,最终答复是结构化 JSON** `{say, asks[], reason}` | **响亮**:schema 不支持/JSON 坏 → 明确报错,不会假装问过 | ✅ **选它**(⬜ 待 C0 探针:gpt-5.6-sol 在 app-server 0.150.1 上 `outputSchema` 生效) |

`say: null` = 这轮不开口(tick 时即「跳过」);`asks[]` = 要问的 Lead 与问题;`reason` = 给账本的一句理由(只在主动开口时落账)。brain 只做 I/O 与账本,**判断全部在 Codex 里**。

### Q3 「自己去各仓读状态」谁来读

| 选项 | 判 |
|---|---|
| A. 全靠 Raya 在 sandbox 里跑 shell | 零部件,但每 tick 重跑一遍 6 仓命令;证据不可复现,账本上「理由可溯」变成「她当时跑了什么」 |
| **B. brain 生成一份确定性的状态快照喂进 tick,Raya 需要时再用 shell 深挖** | 快照 = 纯函数(注册表 + `git log`),可测、可存档(`state/ticks/<ts>.json`),账本里的证据指向它;她仍有 shell | ✅ **选它** |

快照读 `RAYA_PROJECTS_FILE`(今天指向 `~/.flywheel/projects.json`——这是**部署坐标**,不是架构;合同只取 `projectName/projectRoot/projectRepo/leads[].agentId/botUserId`,换一台没有 flywheel 的机器给同形 JSON 即可,P12)。每项:最后 commit 时间与距今天数(**沉默信号**,P8)、窗口内 commit 数、最近若干 commit subject、open PR 数(`gh`,失败记 null 不伪造)、`不是 git 仓` 的显式标注。2026-08-27 实测:geoforge3d 07-02 · joycon 07-04 · growth 07-05 · tidal-echo 07-05 · flywheel 08-27 · personal-assistant 08-25(⚠️ PRD §5.4 写它「不是 git 仓」已过期,现在是)。

### Q4 追问 Lead 走哪条路

| 选项 | 判 |
|---|---|
| A. flywheel-comm Mailbox | ❌ 需要 flywheel 源码(P12);而且 P13 说需要她看见的走 Discord |
| **B. `#leads-roundtable`(1512578695468941333)`<@LeadBotId> 问题`;Lead 在自动开的 thread 里答;brain 只认「Raya 开的那条 thread 里、注册表里 Lead bot id」的消息,转成一轮 `【Lead 回复】` 喂给 Raya** | ✅ **选它**。前置(⬜ 全部是 flywheel/founder 侧的一次性动作,不是 raya 代码):① Raya bot 在每个 Lead 的 `allowBots` 里(现状 **没有**;FLY-282 自愈机制:往 `~/.flywheel/roundtable-registry/raya.json` 放一条 → Lead 下次重启并入)② Raya bot 对 roundtable 有 ViewChannel/SendMessages/**SendMessagesInThreads/ReadMessageHistory**(现邀请权限 36703232 只有 View+Send+语音三项)|
| C. 直接去 Lead 自己的 chatChannel 问 | Lead 频道不是给别的 bot 说话的地方;而且她看不见跨项目对话 | ❌ |

B 失败时(权限没配好 / Lead 不答):Raya 在 `#raya` 如实说「我想问 X,但问不到」(P2/P3),不猜。**超时不另起定时器**:未回复的追问在下一次 tick 的输入里带上,由她决定说「没问清楚」。

### Q5 主动开口的账本 + 反指标怎么记

- `RAYA_METRICS_DIR/interruptions.jsonl`(append-only):每条**主动**消息一行 `{ts, kind: question|disclosure|skip_receipt|conclusion, channelId, messageId, reason, evidenceRef}`;`evidenceRef` 指向那次 tick 的快照文件。
- 「她事后认为值」:用 Discord **reaction**(👍 值 / 👎 不值)打在 Raya 那条消息上;brain 订阅 `GuildMessageReactions`,founder 的反应追加一行 `{kind: feedback, messageId, value}`。⛔ 不问她「值不值」,⛔ 不用关键词规则去猜她的回复。
- `raya ledger summary` 折叠成:打断次数 · 其中 👍 数 · 其中 👎 数 · 跳过回执数。**不设目标值**(P16)。

### Q6 节奏与「运行期可改」

- 默认 6h(P5);`raya cadence set <hours>` 写 `RAYA_STATE_DIR/cadence.json`,brain 每轮循环重读 → **改节奏不用重启**。⚠️ 是一条 CLI,不是「跟 Raya 说一句」——因为 state dir 刻意不在她的可写根内(V1 的重叠护栏)。写进 HTML 让她可否。
- `raya tick now` 写 `tick.requested` marker(沿用 voice-mode.requested 的原子写形态)→ brain 立刻跑一次;QA 与她「现在看一眼」都用它。
- tick 到点若有对话在跑 → 排队等;积压多个 tick 折叠成一个。

### Q7 什么算「事件触发」(P4)

本批的事件 = ① 她在 `#raya` 说话 ② Lead 在追问 thread 里回复 ③ `tick.requested`。**不做**实时监听各仓(PRD §11 non-goal「不需要实时知道所有在发生什么」);分岔的发现发生在 tick 里。诚实边界:一个仓昨晚发生了什么,Raya 最快在下一次 tick 才知道。

### Q8 权限(P10)——本批**不收窄任何一项**,也**不新增**一项

> 🔴 **2026-08-27 R1 design review 更正**:本节原版主张「写六个项目仓:不加,是 §4.1 划的界」——**被评审推翻并采纳**:那正是 §8.4/§13.7 已被 founder 推翻过两次的「第一批先不给 X」句式。**终版:可写根 = code + memory + 注册表全部 projectRoot**,preflight fail-closed 断言覆盖,回执按完整集合断言;§4.1 的边界改由行为纪律(prompt)与 §9.2 ② 失败信号承担。以下原文留档,以 plan.md §0.4 为准。

- 沿用 V1 实测通过的 Codex 原生全权形态:`workspace-write` + `network_access: true` + `approvalPolicy: never` + 可写根 `RAYA_WORKSPACE_ROOTS_JSON`。
- **读**六个项目仓:workspace-write 只限制写,不限制读(⬜ 待 C0 探针 P-read 实证)。
- ~~**写**六个项目仓:**不加**~~(已被上方更正取代)。
- sub-agent:Codex 原生多 agent 能力,**不另建机制**;但「可用」要 C0 探针 P-subagent 真 spawn 实证,schema 存在不算证据(R1)。

## 6. 决策清单(本文拍的、待 plan 落实的)

| # | 决定 | 成色 |
|---|---|---|
| D1 | 一条长寿 app-server 子进程 + 一条持久 thread;重启 `thread/resume`,失败则换新 thread 并在 `#raya` 说一句 | ⬜ + C0 |
| D2 | 每轮 `outputSchema` 结构化输出 `{say, asks[], reason}`;brain 只做 I/O 与账本 | ⬜ + C0 |
| D3 | brain 生成状态快照喂 tick;Raya 仍可 shell 深挖 | ⬜ |
| D4 | 追问走 `#leads-roundtable` @mention;回复从 Raya 开的 thread 回收 | ⬜;前置在 flywheel/founder 侧 |
| D5 | 主动开口账本 + reaction 反馈;`raya ledger summary` | ⬜ |
| D6 | 默认 6h,`raya cadence set` 运行期改;`raya tick now` 手动触发 | ✅ P5 + ⬜ |
| D7 | 跳过时发「我看了,没有」,一个 env 开关可关 | 🔶 P17 保留 |
| D8 | 权限沿用 V1 全权形态;~~可写根不变~~ → **可写根扩为 code + memory + 六个项目根**(R1 评审更正,见 Q8) | ⬜ → ✅ 采纳 R1 |
| D9 | 把 voice 的 `AppServerClient` 提到 `packages/codex-client` 供两进程共用(voice 只改 import) | ⬜ 可否:替代是复制一份 |
| D10 | 一次 Codex turn 串行:founder 消息 > Lead 回复 > tick;进行中的消息并入下一轮 | ⬜ |
| D11 | brain 重启后用 REST 补读 `#raya` 断档期间的 founder 消息(一次性,不轮询) | ⬜ |
| D12 | goal 阶段二只留输入接口(tick 输入里一个空的「外部信号」节),不实现 | ✅ P9 |

## 7. 明确不做(本单)

- 实时监听各仓、webhook、fs watch(§11)
- 排序清单、硬规则、goal 字段(§10.1 / §10.4)
- §8.8 「Lead summary PR 进 Raya 仓 / merge = 已阅」——issue 范围 ①–⑤ 未列,另单
- 每日可互动 Report(§8.7.3)——另单
- 语音侧任何改动(FLY-2074 已合);voice 与 brain 只共享既有合同
- 给 Raya 新的工具端点 / 二进制(Q2-C)

## 8. 给 Tadashi 的非阻塞问题(已用 `flywheel-comm ask` 发出,不阻塞设计)

1. D9 抽公共包 vs. 复制客户端——我选抽包。
2. D4 的 flywheel 侧前置(roundtable-registry 加 `raya.json` + Lead 重启)由谁做——我建议他在 implement 前做,本单不碰 flywheel 运行态。
3. Discord 权限重邀(加 ReadMessageHistory + SendMessagesInThreads;roundtable 频道可见)——founder 动作,请他转。
4. D8 可写根是否要加六个项目根——我判不加,按 §8.4 自检已写在 Q8。

## 9. 会过期的结论

| 结论 | as-of | 怎么重核 |
|---|---|---|
| raya `main` = b7abff4;brain 不会说话 | 2026-08-27 17:30 PT | `git -C ~/.flywheel/raya/code log -1 origin/main` |
| codex-cli 0.150.1(FLY-2074 探针用的是 0.149.1) | 2026-08-27 | `/Users/xiaorongli/.local/bin/codex --version` |
| codex-home 有 3 份文本 rollout | 2026-08-27 | `find ~/.flywheel/raya/codex-home/sessions -type f \| wc -l` |
| Raya bot 不在任何 Lead 的 allowBots;roundtable-registry 无 raya 条目 | 2026-08-27 | `ls ~/.flywheel/roundtable-registry \| grep raya` |
| 六仓最后活动:见 Q3 | 2026-08-27 | 逐个 `git -C <root> log -1 --format=%ad --date=short` |
| Raya bot 邀请权限 = 36703232 | 2026-08-27(FLY-2074 §14.1) | Discord 服务器设置 → 集成 → Raya |

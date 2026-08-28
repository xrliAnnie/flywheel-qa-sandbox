# FLY-2032 会议模式(C):骨架 + 会里交互 — 探索(重做 v2)
Issue: FLY-2032 (https://linear.app/geoforge3d/issue/FLY-2032/rayav4-会议模式c骨架-会里交互codex-原生先行)
日期: 2026-08-28
基于: 无(本文是设计重做的第一份;上游 = FLY-1851 PRD v2.0 全文 + 六轮评审 + final-review〔本轮已通读〕· founder kickback 2026-08-28 · 被否的旧设计三件套〔head f33e2628d,只读参考〕)

> **这是一次 founder 打回后的设计重做,不是修订。** 本文的分工:写「她到底要什么、旧设计错在哪、新 actor model 的关键问题」。
> 事实与出处在 `research.md`(含本轮新读的 Codex 0.150.1 源码),怎么做在 `plan.md`。
> 旧版三件套原样留在 git 历史(head `f33e2628d`),⛔ 本文不重用其骨架,逐块写取舍与理由(§4)。

---

## 0A. Founder 最终拍板（2026-08-28，经 Lead 原话转达）

- **C0 = 形态 S（按会派生）**。Founder 原话：「可能会是形态 S。主要是现在的大多数 Lead 还是用 Claude Code,那它们不管怎么样,都是需要一个新的语音容器进程,但是它会需要有 Lead 的身份记忆和能力」。实现因此沿 2074 的按需容器形状展开：每场新进程，按 `leadId` profile 装配身份、记忆与能力；散会退出。若实现中发现硬伤，只列代价/回报回报 Lead，不擅自改道。
- **C1 = R-13 探照灯**。Founder 原话：「探照灯就够了」。核对器记录并显示 `matched|mismatched|absent`，不拦截动作。
- **排会双通知是新增硬要求**：任何成功排会必须同时产出（1）所有 Lead 可见的共享面公告（`#leads-roundtable` 或部署指定专用 channel）和（2）被点名 Lead 的会话通知。Raya 私有上下文与给 Annie 的回执都不能替代任一路。
- **Lead 安全裁定（2026-08-28）**：两腿由共享频道里的**同一条**排会卡闭合——卡片对目标 Lead 打 Discord 真 `@`，`requireMention` 的 untrusted Discord ingress 把它送进 Lead 会话；⛔ Raya 不获准写 Bridge mailbox，不新增 authenticated enqueue endpoint，也不直写 `comm.db`。唯一工程入口是 founder 对 Raya 说排会命令，随后 Raya 发固定 schema 卡并开 thread。
- **Founder 终裁（2026-08-28）**：只做上述唯一入口。Founder 在 roundtable 手发任何消息都只是普通聊天；会议系统不识别、不解析、不接管，也不把手发消息当作排会卡。

---

## 0. 🔴 打回的原话与边界(先读这个)

**founder 2026-08-28 03:03 PT(打回理由,经 Lead 转述入 rework 账本)**:

> 上一版设计把「开会」理解成「她和 Raya 开会」,而实际口径是——**开会对象是任何 lead**(她、Honey Lemon、Raya、Tadashi 都可以),Raya 只是 lead 之一,**既不排除也不特指**。

**founder 2026-08-28 03:12 PT(直令)**:

> 「现在实现段已经跑起来了,我希望可以把实现段先停下来,然后打回重新去做设计」

**设计段要求(rework 账本逐条,⛔ 本文全篇受它约束)**:

| # | 要求 |
|---|---|
| 1 | 通读 PRD v2.0 全文 + 六轮评审 + final-review,不许只搜关键词(✅ 本轮已完成,先读了「六条成色」与「读证据之前先读这一条」) |
| 2 | **actor model 必须重定**:schema / API / 命令要能表达「和哪一个 lead 开会」(leadId / projectId / agent identity),不能硬绑 Raya;voice runtime / instructions / CODEX_HOME / cwd / identity / 能力也不能硬绑 |
| 3 | 「每场只有一个 AI/Lead」是**约束**,但**身份不是永远 Raya** —— 上一版把这两件事混为一谈 |
| 4 | **验收必须能证明 Annie ↔ 任一 Lead**,而不只是 Annie ↔ Raya |
| 5 | 可保留的既有机制:**独立 raya 仓 · Codex 原生语音 · 一场一个 AI · 持久会议账本**;其余待重定 |

**Lead 补充的硬边界(2026-08-28 08:56 rework r2,非 founder 原话)**:
① 不许照抄被否掉的旧 actor model;旧设计草稿原样留在分支上,新设计明确决定取舍并写明理由;
② **先读 Codex 源码,把两种进程形态(常驻 vs 按会派生)的事实和代价写下来,如实列给 founder 拍板,不替她选**,再画图出方案。

---

## 1. 一句话:这单现在是什么

**Annie 和【任何一个 lead】在 Discord 语音房开一场会** —— 她一句话约(约的时候说清**和谁**聊什么),到点那个 lead「已经在房里」,她点链接进去开聊;会里对面带节奏、动单号/人名前先念一遍;她说结束并退出,对面跟着退。**一场会只有一个 AI(约束),但那个 AI 是谁由她约的时候定(身份)** —— Raya、Honey Lemon、Tadashi 都是合法的取值。

耳朵和嘴巴都归 Codex(她 8-19 已关分叉,v2,她 8-20 拍板)—— **无论对面身份是谁,发声的容器都是 Codex realtime**;身份(它是谁、知道什么、能动什么)是喂给容器的,不是容器固有的。

---

## 2. 已定前提(每条带出处,⛔ 不重新论证)

### 2.1 产品前提(FLY-1851 PRD v2.0;本轮全文通读后重列,与旧版一致的部分不复述理由)

| 前提 | 出处 |
|---|---|
| v1 **一场会只有一个 AI**;多人 deferred(她定) | §4;⚠️ kickback #3:这是**约束**,不含「身份=Raya」 |
| 载体 = Codex,耳朵嘴巴都是;版本 = **v2**(回合制,打断=排队,想事时 8/8 静默中位 21.8s) | §5.7 R-28/R-34、§30、§33 |
| **语音要知道每个 lead 的身份和 memory**(R-53);要能用 Lead Memory(R-54)与 Agent File(R-55);进会要理解 Topic(R-56)——**需求写满,不带实现限定** | §46;⚠️ 这三条在旧设计里被窄化成了「Raya 的身份」 |
| 主路径 = **context 提前备好交到它手里**(R-51),简报带时间戳+新鲜度(R-52);R-50「开场先读议题」是兜底 | §45 |
| 时长约会时定,default 30(R-2b);R-2 一次通过 ≠ 通过率(n=1/30 分钟窗) | §47 ⑤、成色 ① |
| 链接是主路径(R-10);到点不互相提醒(R-5);她没进来才提醒一嘴、带链接(R-6/R-8);**提醒人 = 要跟她开会的那个 lead**(R-7) | §5.2;⚠️ R-7 在 any-lead 口径下第一次真正用上 |
| 她进房时房里要已经有人(R-57);出去再进来不能失忆(R-58,会中进出是主路径) | §46 |
| 会议结束/她退出 ⇒ 它跟着退,不留在房里等(R-15/R-39);「我不介意它断」≠「断了不用处理」 | §5.4、§39 |
| 会上「立刻执行」的能力必须存在(R-40);**机制二选一**(分身自己动手 / 分身告诉 Lead 由 Lead 动手)她「会偏向立刻执行的机制」但**指向不自明,留空** | §40、§47 旗 ① |
| R-13 复述只留一格:动单号/人名/仓库名之前念一遍,念的必须是**转写原文**;对「解析错」是盲的 | §5.3、§7.7 |
| 指示器只取事件流(R-31);先应一声只说「我在做什么」(R-32);状态行跟着对话流走(R-38) | §26、§34.1 ③ |
| 听觉刚需已由等待音满足(她 8-24 认定);等待音可动态开关(R-46)后「关掉靠什么」= Lead 判定未问她 | §47 ①、§42 |
| 主会议房串行是内在的;测试房才有争用(R-48/R-49);验收房 = voice-test-1(Lead `316aff4a`) | §43 |
| 每条押语音可行性的断言要能指到实测数字;⛔ 不设阈值 | §5.6 D-1b、§8.2 |
| 会后产物/notes/issue/HTML 归 FLY-2033;会前简报内容归 FLY-2030;进/退命令化归 FLY-2097 | PRD §8 切法、Lead 派工 |

### 2.2 kickback 保留的机制(#5,逐条)

| 机制 | 保留含义 |
|---|---|
| **独立 raya 仓** | 会议/语音基础设施继续长在 raya 仓(不搬回 flywheel);「假设使用者没有 flywheel 仓」的架构判据继续有效 ⇒ **raya 仓从「Raya 的仓」变成「语音会议容器的仓」,Raya 只是其中一个 lead profile** |
| **Codex 原生语音** | v2 realtime 一条链(2074 已合入)继续是唯一发声通道 |
| **一场一个 AI** | 并发=1、主会议房串行,照旧 |
| **持久会议账本** | 「一场会的状态与事件落盘、重启不丢、给 2033 读」这个机制保留;**其字段与状态机随新 actor model 重定**(§4) |

---

## 3. 旧设计错在哪 —— 硬绑清单(逐处点名,给 §4 的取舍当依据)

旧设计(head `f33e2628d` 的 exploration/research/plan + raya 分支 3 个提交)把「和谁开会」这个维度**整个略去了**。具体硬绑点:

| # | 硬绑点 | 在哪 |
|---|---|---|
| B1 | `Meeting` schema **没有 leadId** —— 一场会「和谁开」不可表达 | 旧 plan §2.1(`packages/contracts/src/meeting.ts` 已提交版同) |
| B2 | 命令语法 `安排会议 12:30 聊 X` **没有「和谁」槽位** —— 语法上就只能和 Raya 开 | 旧 plan §2.2 |
| B3 | voice 容器的身份 = raya 仓 `IDENTITY.md` 一份、`startInstructions` 一句默认中文 —— **身份是常量不是参数** | raya `apps/voice/src/cli.ts` |
| B4 | CODEX_HOME / cwd / workspace 钉死 raya 自己的目录 —— backend 交办永远以 Raya 的能力动手 | raya `apps/voice/src/config.ts` |
| B5 | 提醒/状态行文案全部以 Raya 第一人称写死;R-7「要跟她开会的那个 lead 提醒」在单一身份下退化成空话 | 旧 plan §2.6 |
| B6 | 验收(§8.1 A)只有 Annie ↔ Raya 一场 —— **换一个 lead 能不能开会,没有任何一步会证明** | 旧 plan §8 |
| B7 | R-53「每个 lead 的身份和 memory」被读成「Raya 的身份和 memory」—— 需求被身份收窄 | 旧 exploration §2.1 表内无此行(缺席本身即证据) |

⇒ **病根一句话**:把「一场会只有一个 AI」(约束)和「那个 AI 是 Raya」(身份)焊在了一起 —— 正是 kickback #3 点名的混同。

---

## 4. 旧设计取舍清单(Lead 边界 ①:参考、明确取舍、写明理由,不重用骨架)

> 三档:**弃**(跟着被否的身份假设走的)· **重定推导**(问题仍在,答案要在新 actor model 下重新推;推完可能与旧答案同形,但依据是新推导不是照抄)· **保留**(kickback #5 点名或与身份维度正交的**事实/纪律**)。

| 旧物 | 档 | 理由 |
|---|---|---|
| 单一身份的 Meeting schema(无 leadId) | **弃** | B1,被否的核心 |
| `安排会议 HH:MM 聊 X` 语法 | **弃** | B2;新语法必须有「和谁」槽位(plan §2) |
| 「brain 单写 meeting.json / voice 单写 receipt / 逐 boot ordinal 折叠 / 终局序列 / Held 全局 guard / clear-hold at-most-once 事务 / stopIntent 先落盘」这一整套编排骨架 | **重定推导** | 它们答的是「两进程靠文件说话时怎么不丢一场会」—— 这个问题在新 model 里**是否还存在、以什么形状存在,取决于 C0 进程形态的拍板**(常驻附着形态下 brain/voice 分工整个变样)。⛔ 不照抄;C0 定了之后按新拓扑重推,重推时旧骨架的七轮评审结论可作**检查清单**(它们标出的坑是真的),不作**合同** |
| R-13 探照灯(事件流核对器,不拦)+「档位是 founder 决定」这道门 | **重定推导,倾向保留** | 核对器逻辑与身份无关(seq/turnId/组替换规则照 PRD 硬性要求推导);「探照灯 vs 闸门」的 C0 决定**她还没答过**,重做后这道门仍要交她 |
| 验收切换/恢复合同(§8.1 同 label 临时 plist、acceptance env 0600、清理敏感文件) | **重定推导,倾向保留** | 与身份无关的部署纪律;但验收**内容**换了(#4:任一 Lead),合同要按新验收重写 |
| 「精确命令、不做模糊 NLP」「时长默认 30」「到点 tick 驱动」「链接主路径」「she-left grace」等逐条产品翻译 | **重定推导** | 这些是 PRD 条款的工程翻译,条款没变;但每条要在带 leadId 的新形状下重写,不整段搬 |
| 六条成色 / D-1b / 「n=1 不是通过率」等 PRD 纪律引用 | **保留** | 纪律与身份正交 |
| research.md 里的 Codex 0.150.1 事实(strings 全集 / v2 真跑通 n=1 / appendSpeech 语义) | **保留(作事实)** | 事实不因设计被否而失效;本轮 research 重做时逐条核对 as-of 后引用 |
| raya 分支 4 个 parked commits @ `ba9165f`(3 个实现提交 + 1 个 Lead rescue commit 封存原未提交 1046 行;工作区干净) | **停驻,只读参考** | founder:实现段停下;Lead:原实现体保持停驻,不要动它的产出。新 plan 若与其中某块同形,**依据必须是新推导**;实现节点届时决定捡用还是重写 |

---

## 5. 新 actor model 的关键问题

### Q1 「lead」在会议系统里怎么表达

**答案方向:一个 lead = 一份 profile 文件(声明式数据),不是一段代码。**

```
RAYA_STATE_DIR/leads/<leadId>/profile.json     ← 单写者:运维/Lead 手写入库(v1 就几个 lead)
  { leadId, displayName, aliases[],            ← 命令解析「和 <谁>」用
    workspaceCwd,                              ← thread 的 cwd(能力/AGENTS 语境跟着 cwd 走)
    identityPath,                              ← 身份文件(Agent File,R-55)
    memoryPaths[],                             ← memory 来源(R-54;Claude lead 的 memory 也是文件)
    voice?,                                    ← 音色(B4 等她挑 19 个,先留字段)
    writableRoots?                             ← 会上「立刻执行」的能力边界之 profile 半边(R-40;
                                                  sandbox/approval 档位是系统常量,不进 profile)
  }
```

依据(research §1):Codex 0.150.1 的 `thread/start` 支持**逐 thread** 覆写 `cwd / baseInstructions / developerInstructions / personality / sandbox / approvalPolicy / config` ⇒ **身份可以是参数**;进程级绑死的只有 CODEX_HOME(auth + config.toml + thread store)。⇒ 「不能硬绑」在源码层面是成立的,不是愿望。

⚠️ 诚实边界:profile 指向的路径是**机器本地配置数据**(raya 仓不 import flywheel 代码的判据不受影响);但 **Claude lead 的 memory/identity 文件长什么样、放多少进 8,192 est-token 逐字通道,是 2030 简报层的活** —— 本单只定「从 profile 拿路径、装配、超预算按段裁并披露」的合同。

### Q2 命令语法怎么带上「和谁」

```
安排会议 [明天] HH:MM 和 <lead> 聊 <议题> [时长 N] [继续上一场]
安排会议 现在 和 <lead> 聊 <议题> …
取消会议 / 结束会议(不变;一次至多一场活动会,无歧义)
```

`<lead>` 经 profile 的 `displayName/aliases` 精确匹配(转写常把名字写歪 —— aliases 收录常见转写变体;匹配不到 ⇒ 回执列出可选 lead,**不猜**)。⛔ 不做「不带『和谁』就默认 Raya」—— **默认值就是一次悄悄的硬绑**(她说「既不排除也不特指」);不带就回执提示补上和谁。🔶 这是我的判断,写进 founder HTML 让她能否(她若要个默认,那是她的产品决定)。

### Q3 🔴 进程形态:常驻 vs 按会派生 —— **C0,交她拍板,本文不选**

两种形态的完整事实/代价对照表在 `plan.md` §3(数据出处 = 本轮读 0.150.1 源码 + 生产实测,见 research §1/§2)。这里只写形状:

```
形态 R(常驻·附着):会议附着到该 lead 已经在跑的常驻 Codex 进程(app-server thread),
                     语音会话挂在它活着的 thread 上 —— 「和 lead 本人开会」
形态 S(按会派生):到点为这场会派生一个语音容器进程,以 profile 装配该 lead 的
                     身份/记忆/能力 —— 「和带装的 lead 分身开会」
```

⚠️ 两形态与她已有的两个未决决定**天然勾连**(对照表里必须摆出来):
- §40 机制二选一(分身自己动手 / 告诉 Lead 本人动手)—— S 的「立刻执行」是前者,R 是后者;她说过「会偏向立刻执行的机制」但指向留空。
- Q-10(是不是把所有 Lead 换成 Codex)—— R 形态**只对 Codex 常驻 lead 存在**(Claude lead 没有可附着的 Codex 本体;「Claude Lead 坐在语音接缝另一头」至今零证据);S 形态对**任何 lead** 成立,因为身份是喂进去的。

### Q4 身份/记忆怎么进会(R-53/54/55/56 × R-51)

主路径照 R-51:**提前备好、交到它手里**。装配顺序(逐字通道,≤8,192 est-token,超了按段从简报尾部裁 + 披露,⛔ 不裁身份与规矩):

```
[身份] profile.identityPath 的内容(它是谁、口吻)     ← R-55
[会议头] 议题 / 预定时长 / 是否续会                    ← R-56
[记忆摘录] 2030 备好的简报(含该 lead memory 的会前摘录,preparedAt+validUntil 必填)  ← R-54/R-51/R-52
[会里规矩] 主持/念号/想一下/总结(照 PRD R-11/13/14/17 翻译)
```

⚠️ 与形态勾连:R 形态下「Current Thread」启动上下文段(1,200 tokens)自动带 lead 本体的近期工作;S 形态下该段为空、「Recent Work」(2,200 tokens)取决于用哪个 CODEX_HOME 的 thread store(research §1.6)——差异进对照表,不在这儿裁。

### Q5 验收怎么证明「任一 Lead」(kickback #4)

**同一套代码、零改动、只换 leadId,开两场真会**:一场 `和 Raya`,一场 `和 <她指定的另一个 lead>`(建议 Honey Lemon 或 Tadashi —— Claude lead,恰好压着 Q-10 那条最没验过的边)。两场都走完 发起→入场→会里→结束;逐条记数、n=1 如实标。⇒ 「任一」的证明形状 = **身份是数据**:第二场没有任何代码 diff,只有 profile 与命令里的名字不同。

### Q6 呈现层的诚实边界(不藏)

Discord 里进房的 bot 账号只有一个(raya bot)—— v1 **不做每 lead 一个 bot 账号**。「对面是谁」由三层承载:状态行/回执带 lead 名(「(Tadashi)已进房」)· 语音身份(它自称、口吻,来自 identityPath)· 音色(B4 她挑好后 per-lead 配)。⚠️ 她若认为「bot 显示名必须是那个 lead」,那是新的一格(需要多 bot 或改昵称权限)—— 写进 HTML 让她看见,不默认她接受。

---

## 6. 会过期的结论

| 结论 | as-of | 重核 |
|---|---|---|
| raya `origin/main` = `b7abff4`;分支 `fly-2032-raya-meeting` = 4 个 parked commits @ `ba9165f`(含 Lead rescue commit),工作区干净(停驻) | 2026-08-28 | `git -C ~/.flywheel/raya/worktrees/raya-FLY-2032 status && git log --oneline -5` |
| 钉死 codex 0.150.1;源码事实读自 tag `rust-v0.150.1`(本轮 fetch 进 ~/Dev/codex) | 2026-08-28 | `codex --version`;`git -C ~/Dev/codex tag -l rust-v0.150.1` |
| 现役常驻 app-server RSS 89–181MB(3 个) | 2026-08-28 | `ps aux \| grep "codex app-server"` |
| 2030/2097 并行推进中(2097 在 implement 节点) | 2026-08-28 | workflow_run 表 / Lead |
| 验收房 = voice-test-1(`1542708566417211423`),Lead `316aff4a` | 2026-08-27 | founder/Lead 改口以新指令为准 |

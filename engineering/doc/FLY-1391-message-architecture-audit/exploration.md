# FLY-1391 消息/通知架构全貌 — 探索(范围与方法)

Issue: FLY-1391 (https://linear.app/geoforge3d/issue/FLY-1391/audit消息全貌-message通知架构全图-谁发给谁哪些送-lead哪些送-runner哪些根本没送annie-直令不打地鼠先看全貌)
日期: 2026-07-20
基于: 无

## 1. 这张图为什么现在必须画

Annie 直令(2026-07-20 晨,#flywheel-engineer)原话:

> 我们不要再一个补丁一个补丁地修…我需要你把整个 technical architecture 给我看一下:现在的 message 到底什么样?
> 哪些送 Lead?哪些送 Runner?哪些甚至没送?把全貌给我,然后大家一起整顿一起修。

触发点是 FLY-1373(Lead inbox consume loop)刚 land 之后她的预期与实证不符:她以为"所有送 Lead 的消息都对了",
但当天仍撞到至少三个缝。这三个成为本次审计的 **fixture**(必须在图里能被定位、被解释):

| # | 现象 | 谁观察到 |
|---|------|---------|
| F1 | founder 在 issue thread 的回复直送 runner,不经 Lead | Annie |
| F2 | 多个 open question 时 `founder_reply_ambiguous` 放弃投递,靠人工转 | Annie |
| F3 | 催办 nudge 不查门态,催已经过了的门 | Annie |
| F4 | 已归档 Discord thread 被 bot 发言自动弹回活跃态 | Annie(Lead 追加) |

### 1.1 一个仓库级事实(先说,因为它决定了本单的价值)

**仓库里此前不存在任何消息/通知架构总览文档。** 核过:

- `doc/architecture/` 只有 `capability-matrix.md` / `flywheel-agent-architecture-diagram.{html,mmd,svg}` /
  `infra-alerts-spec.md` / `product-experience-spec.md` / `v0.2-architecture.md` / `v2.0-product-vision.md` / `archive/`。
- `doc/architecture/flywheel-agent-architecture-diagram.mmd` 对 `inbox|mailbox|comm.db|gate|founder`
  的大小写不敏感 grep **零命中** —— 那张 agent 架构图**根本没画消息层**。
- `doc/` 与 `engineering/doc/` 下没有任何文件名或 H1/H2 标题匹配消息架构/流向/路由总览。

现存最接近的都是**单 issue 范围内**的局部时序图:`FLY-1041/research.md §1`(绑定时序)、
`FLY-1099/exploration.md §2`(ingest 流)、`FLY-1373/plan.md §0`(LeadInboxLoop 图)、
`infra-alerts-spec.md §1`(仅 alert 巷)。

⇒ 「一个补丁一个补丁地修」不是纪律问题,是**没有全局视图时的必然结果**。每张单只能看见自己那一段。

## 2. 交付边界

**只读审计。零代码改动。** 本单 PR 只含 docs。

- 修什么、按什么顺序修 —— 由 Annie 拿着这张图拍。
- FLY-1388(统一升级流)的最终形态由这张图决定;本单**只列选项与取舍,不替她选**。
- 本单不做真机 E2E,不改 flag,不重启任何服务。

## 3. 覆盖面(审计对象)

生产代码里的消息/通知路径,按触发源分七域。

⚠️ **覆盖面诚实声明(经 Codex 设计复核收紧)**:初稿写"**每一条**",这个词配不上实际做到的工作量。
本单**没有**做完整的 sender 清单。**已知未覆盖**的生产面至少包括:

- `disposition-receipt.ts` 的 founder-thread 回执巷
- `runner-ready-to-close-notifier.ts`
- Standup 的 Discord 投递(`standup-service.ts`)
- Roundtable 入站 + 自动建 thread(`RoundtableThreadManager`)
- digest / `publish-report` 出站链(`digest-service.ts`)

这些不在本图上。⚠️ **理由更正(Codex R2)**:初稿写"它们大多属周期性汇报" —— **不准确**。
五项里只有 **standup / digest** 明显是周期性汇报;**disposition-receipt、runner-ready-to-close、
Roundtable 入站三项都是事件驱动的**,与本图 D3–D5 同类。
⇒ 遗漏范围比初稿暗示的**更大**,且不能预先断言它们与三个 fixture 无关。
**"没画"就是没画,不能让读者以为图是全的,也不能用一个安慰性的理由把它说小。**
⇒ 本单的准确定位是:**覆盖了 D1–D7 七域的主干,不是全仓 sender 普查。**

| 域 | 具体面 |
|----|--------|
| D1 Runner 出站 | `flywheel-comm` 的 ask(含 `--report`)/ gate / complete / stage / progress / notify / qa-result 等 |
| D2 Lead→Runner | `send` / `respond` / wake / mailbox transport / PostToolUse hook / transport=none 的 agy+kimi |
| D3 Bridge→Lead | `lead_events` / `lead_inbox` 队列 / LeadInboxLoop / 投递适配器(claude mailbox vs codex socket) |
| D4 founder 入站 | Discord thread 回复的 ingest、cursor、归因、路由裁决 |
| D5 founder 出站 | issue thread 卡片 / 里程碑 / 卡住页 / thread 标题(FLY-560) |
| D6 告警巷 | `#flywheel-alerts` 两个独立写入者(Bridge `LeadAlertNotifier` + shell `lead-alert.sh`) |
| D7 巡检/看门狗 | LeadWatchdog / RunnerIdleWatchdog / HeartbeatService / misroute patrol / complete-marker-reconciler / detection-escalation(FLY-1048)/ auto-QA(FLY-579) |

**排除**:测试 fixture、已归档的历史文档、非生产脚本。

## 4. 方法与判据纪律(照 FLY-1390 同标准)

1. **只认真实调用路径,不认命名。** 一个叫 `deliver*` 的函数不代表它送到了人;一个 `insertEvent`
   不代表有人读。每条"送达"必须能指出消费者;指不出就归入"无人消费"。
2. **主干 vs 分支 provenance 分开标。** 引用若指向未合并分支,单独列表说明,避免照 main 核不到被误读成编造。
3. **核不实的写 `unverified`,不进裁定表。** research.md 里标 unverified 的条目,plan.md 不得给确定裁定。
4. **代码事实 ≠ 运行事实。** 这是本单最重要的方法论增量 —— 见 §4.1。
5. **阳性对照。** 任何"没有/关着/归零"的断言,必须用同一把尺子打中一个已知阳性,否则尺子坏了也看不出来。
6. 交付前跑一轮对抗性自查(逐条回核高风险引用)。

### 4.1 为什么必须查**运行时**而不只是读代码

读代码只能回答"这条路径**能不能**送";Annie 问的是"**有没有**送"。两者在 Flywheel 里差得很远,
因为大量通知路径挂在 env flag 上,而 flag 的默认值和生产实际值可以不同。

本次审计因此增加一步:**读活 Bridge 进程的真实 env**(`ps eww <pid>`),而不是读 `.env` 文件或代码默认值。

阳性对照(方法自证):同一条 `ps eww` 管道对该进程能读出 `PATH=`/`HOME=` 2 项基线变量、
59 个 `FLYWHEEL_*` 变量 —— 尺子确认可用,之后再断言某个变量"缺失"才有意义。

这一步直接产出了本单最重的发现(见 research.md §1):**生产上有相当一部分通知/巡检层是关着的**,
而这件事从代码里读不出来,从任何单张 issue 文档里也读不出来。

## 5. 术语对齐(Annie 2026-07-20 拍过的两个框架,作为全图注脚)

这两条不是本单发明的,是 Annie 当天已经拍下的口径,图里所有分类都据此对齐:

### 5.1 「处理不了」的二分

不是所有"卡住"都同级。分两类,缓冲时间不同:

- **需 founder 决策的** —— 零缓冲。只有她能答,系统等多久都等不出答案,拖延纯损失。
- **Lead 能动手的** —— 30 分钟止损窗。给 Lead 一段时间自己解决,解决不了再升级。

⇒ 判一条通知该走哪条巷,先判它属于哪一类。把 founder-only 的事塞进 30 分钟缓冲 = 白等;
把 Lead 能自理的事零缓冲丢给 founder = 打扰。

### 5.2 「收信线」vs「查岗线」

两条职责完全不同的线,现状常被混在一起,这是很多缝的根源:

- **收信线(delivery)** —— 把一条已经产生的消息送到该看的人手里。失败模式 = 丢件。
- **查岗线(patrol)** —— 主动去看"是不是有人卡住了/是不是有事该发却没发"。失败模式 = 漏检 或 误报轰炸。

⇒ 收信线的 backstop 不能是"再送一次",得是"送不到要有人知道";
查岗线的 backstop 不能是"多查几遍",得是"查的判据要对"。
本次三个 fixture 里,F2 是收信线问题,F3 是查岗线问题,F1 是路由(收信线的分叉)问题。

## 6. 产出物

| 文件 | 内容 |
|------|------|
| `exploration.md` | 本文 —— 范围、方法、判据纪律 |
| `research.md` | 证据卷:全图 + 逐条路径四栏表,file:line 全带,unverified 显式标注 |
| `plan.md` | **裁定表**(不是实施计划):缝隙清单 + 严重度 + 给 Annie 的整顿选项与取舍 |
| `founder-brief.html` | founder 版:人话 + 图 + 逐段留言框(交付由 Lead 投,本 Runner 不 publish) |

## 7. 已知不做(out of scope)

- 不改任何代码、flag、配置。
- 不做真机 E2E 验证(本单是静态审计 + 运行时 env 读取)。
- 不替 Annie 决定 FLY-1388 形态。
- 不覆盖 GeoForge3D / sub / tidal-echo 等其他项目的项目级差异 —— 本图以 flywheel 项目的生产配置为基准,
  差异项在 research.md 里标注为项目相关。

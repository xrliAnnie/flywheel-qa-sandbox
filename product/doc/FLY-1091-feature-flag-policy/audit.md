# FLY-1091 Feature flag 全量 audit — 83 个 flag 分四桶

Issue: FLY-1091 (https://linear.app/geoforge3d/issue/FLY-1091/feature-flag-该怎么定-怎么管-research-设计我们的-flow小团队不-over-engineering)
日期: 2026-07-09
基于: exploration.md、research.md(同文件夹);Annie 2026-07-09 §4 逐节批注「现在就 audit 全部 flag 分四桶」

---

## 0. 这份 audit 是什么

Annie 明确要:**现在就把全部 flag 逐个过一遍,分四桶** ——
① 根本不需要 → 删 · ② 直接 enable → enable 后删 · ③ 真正值得留 · ④ 需要改 flag 系统的。

**方法**:逐个读 `packages/config/src/feature-flags/registry.ts`(定义)+ 当前实际值(env flag 读 `~/.flywheel/.env`、config flag 读各项目 `config.yaml`)+ note/意图。**现查现引,不凭记忆;判不准的诚实标 UNKNOWN,不猜。**

**一个 audit 中途就冒出来的硬事实(直接回答 Annie §1)**:83 个 flag 里 **77 个的『开/关值』存在一个 Bridge 全局的 `~/.flywheel/.env`**,只有 **5 个**(qa_auto / doc_flow / proofshot / xiaohongshu_learning / ponytail)用的是 Annie 想要的那个模型 —— **每项目一份、运行时读的 `config.yaml`**。这条见 §5,是最重的一条,进 PRD。

---

## 1. 一眼看懂:83 个 flag 的分布

| 维度 | 分布 |
|---|---|
| 类别 | feature 50 · kill_switch 27 · governance_gate 6 |
| 值存哪 | Bridge 全局 `.env` **77** · 每项目 `config.yaml` **5**(+1 个 per-Lead launcher 派生) |
| 极性 | default_on 52 · opt_in 31 |
| 一周增长 | 40 → 77(env),**从没删过一个** |

**分桶结果概览(可行动的重点)**:

| 桶 | 数量 | 一句话 |
|---|---|---|
| ① 删 | 1(+ 待定) | 目前只有 1 个明确该删的空壳(founder_image_approval,开了也没用) |
| ② enable 后删 | **10** | **最干净的一批赢** —— 已经开着、证明可用的 opt-in,flag 现在是纯债,该固化+删 |
| ③ 留 | ~66 | 大头是 50 个「给已上线行为兜底的 kill switch / 逃生开关」+ 6 治理门 + 5 per-project 模型 flag + 5 数值旋钮 |
| ④ 改 flag 系统 | 1 系统级 + 1 flag | §5 的 per-project 运行时 config 迁移(系统级)+ founder_image_approval 需接线 |
| UNKNOWN(需 owner 定) | 3 | lead_pane_readiness · roundtable_thread_own_bot · runner_autocontinue |

> ⚠️ 诚实边界:③ 里那 50 个 kill switch / default_on 逃生开关,**我判「留」是保守默认**(它们给已上线行为兜底,不是 Annie 说的「睡着的功能」)。但 Fowler 说长寿 kill switch 只该留一小撮,50 个偏多。**哪些该趁行为稳定了退役(转 ②),需要 Tadashi 一句话过**——我不替他猜每一个。

---

## 2. 桶 ② —— 直接 enable → enable 后删(最干净的赢,10 个)

这 10 个都是 **opt-in、现在 `.env` 里已经 `=1` 开着**的 feature flag。它们已经证明可用 → 按「enable-and-delete」生命周期,**该把行为固化成默认、然后把这个 opt-in flag 删掉**。留着 = 纯 toggle 债。

| flag | 现值 | 建议 |
|---|---|---|
| `alert_threads` | =1 | 固化 + 删 flag |
| `stuck_errorsig` | =1 | 固化 + 删(注:2026-07-09 才开,建议先 bake 几天再删) |
| `pane_multiframe` | =1 | 固化 + 删(同上,刚开) |
| `detection_gap_scan` | =1 | 固化 + 删(同上,刚开) |
| `auto_repair` | =1 | 固化 + 删(已过 QA + Annie 批准) |
| `account_self_heal` | =1 | 固化 + 删(2026-07-09 enable window 开的,先 bake) |
| `notify_digest_expect` | =1 | 固化 + 删(同上) |
| `xhs_review` | =1 | 固化 + 删 |
| `roundtable_reply_in_thread` | =1 | 固化 + 删 |
| `roundtable_enabled` | =1 | 固化 + 删 |

> 注:其中 6 个是 2026-07-09(Annie 抱怨当天)那次 enable window 刚打开的。**「打开」和「删 flag」是两步**:先让它们在生产真跑稳一小段(几天),再删 flag。别一开就删。

---

## 3. 桶 ①/④ —— founder_image_approval(1 个,特殊)

| flag | 现值 | 问题 | 建议 |
|---|---|---|---|
| `founder_image_approval` | (absent) | registry 原文:「v1 未接生产 evaluator,**即使 =1 也 inert**」= 开关装好了、灯没接线(exploration 的 B 类病) | **要么删这个空壳(①)、要么接完线让它真能用(④)**。哪个,请 Annie/Tadashi 定 |

---

## 4. UNKNOWN —— 需要 owner(多半是 Tadashi)一句话定意图(3 个)

这几个是 opt-in、现在关着,而**为什么关着 registry 里没记**。我不猜,列出来请定:

| flag | 它干什么 | 现值 | 待定 |
|---|---|---|---|
| `runner_autocontinue` | Runner 目标驱动自动续跑(FLY-818,建了默认关) | (absent) | ② enable(先单 runner canary)后删?还是 ① 删? |
| `lead_pane_readiness` | 冷启 Lead pane 就绪检查 | (absent) | 该开(②)还是没用了(①)? |
| `roundtable_thread_own_bot` | 圆桌线程含 own-bot 消息 | (absent) | 该开还是删? |

---

## 5. 桶 ④(系统级)—— 这才是 Annie §1 最重的一条

**现状(现查现引)**:

- **值存哪**:83 个里 **77 个是 env flag,值存在 Bridge 全局的 `~/.flywheel/.env`**(`packages/teamlead/src/bridge/flag-toggle.ts` 写这个文件)。**registry.ts 只是<u>定义</u>,不存值。**
- **怎么读**:大部分 env flag 是 **Bridge 启动时读**的(`bridge_boot`)→ **改了 `.env` 里的值,必须重启 Bridge 才生效**。这正是 exploration 的 D 类病(`.env` 写了 `=1` 但没重启 = 还是关的),也正是 Annie 说的「**要改代码/重启才能开关,就没意义**」。
- **分不分项目**:env flag 是 **Bridge 全局的,不分项目**。想「FlyView 开、别的项目不开」—— **今天做不到**(env 是一份、所有项目共享)。

**唯一已经做对的 5 个** —— `qa_auto` / `doc_flow` / `proofshot` / `xiaohongshu_learning` / `ponytail`:它们的值存在**每个项目自己的 `<project>/.flywheel/config.yaml`**,由 `ConfigLoader` **运行时读**(带 mtime 缓存,改了下次读就生效、**不用重启**),而且**天然每项目一份**。

**→ 设计要求(进 PRD)**:把 flag 的「开/关值」从 Bridge 全局 env、逐步迁到**每项目一份、运行时读的 config**(就照那 5 个已经做对的模型)。这一条同时解决三件事:① Annie 的「每项目可以不一样」;② D 类病(不用重启);③ §6 的「FlyView 当 canary、跑通再 release 到别的项目」有了落脚点。

> 诚实注:不是所有 flag 都该迁。**运维紧急 kill switch 留在 env 反而更快**(出事时改一个全局值最直接)。要迁的是那些「**每项目可能不同、且属于 Release/canary 性质**」的 feature flag。哪些迁、哪些留 env,是 PRD 里要跟 Tadashi 定的一张迁移清单。

---

## 6. 桶 ③ —— 真正值得留(~66,分四小类)

### ③a 治理门(6)—— 留,且**永不自动打开**
`codex_lead_read_deny` · `founder_consent_decision_mode` · `founder_attribution_gate` · `comm_bypass_bridge` · `founder_ux_gate` · `founder_ux_gate_killswitch`
→ 这些是「打开=收紧管控/挡 merge」的安全门,`default-enable-policy.md` 已列为硬豁免。留,别碰。

### ③b Kill switch / 逃生开关(kill_switch 27 + feature default_on 23 = 50)—— 留,但数量偏多
这些是**给已上线行为兜底的逃生开关**(默认开、`!== "0"`)。功能是活的、不是睡着的 —— 所以不是 Annie 的病。**保守默认:留。**
→ 但 Fowler:长寿 kill switch 只该留一小撮。**50 个偏多**。建议:做一次「哪些行为已稳定到可以退役逃生开关」的 sweep(转 ②),**每个退役需 Tadashi 过**。我不替他逐个猜。
→ 明确该长期留的(护 merge/ship/founder/钱这类不可逆动作):`merge_approval_gate_killswitch` · `qa_done_gate_killswitch` · `codex_hard_gate_killswitch` · `founder_auto_approve` · `founder_approval_ack` · `stuck_founder_page_killswitch` · `auto_qa_killswitch` 等。

### ③c Per-project 模型 flag(5)—— 留,而且是**要照抄扩大的模板**
`qa_auto` · `doc_flow` · `proofshot` · `xiaohongshu_learning` · `ponytail`
→ 它们就是 §5 说的「做对了的形态」(每项目 config、运行时读)。留。其中 **`ponytail` 是 Annie 亲口说别开**(intentional keep-off,registry note 标了 Annie-exception)。

### ③d 数值旋钮 + per-Lead 配置(不是 on/off 开关,别当 flag 清)(~5)
`ship_gate_grace_ms` · `merge_reconcile_window_days` · `ship_gate_card_grace_ms` · `reports_ttl_days`(数值旋钮,absent=用默认)· `lead_cross_dept_channel_ids`(频道 id,配置值)· `lead_chrome_enabled` / `lead_core_mention_gated`(per-Lead launcher 派生,本就是每-Lead 运行时配置,working as designed)· `lead_dry_run`(dev/debug 工具,正确地关着)
→ 这些不是「睡着的功能」,是配置值/开发工具。留,别当债清。

---

## 7. 给 Annie 的一句话

- **能立刻拿的干净赢**:桶 ②(10 个已开的 opt-in)固化+删 —— 直接把 flag 总数从 83 往下压。
- **最重的设计活**:§5 —— 把 flag 值从「Bridge 全局 env + 要重启」迁到「每项目 config + 运行时读」,照已做对的 5 个模型。这条进 PRD。
- **需要 Tadashi 过的**:③b 那 50 个逃生开关里,哪些行为稳了可以退役;以及 §4 那 3 个 UNKNOWN。
- **账本诚实性**:这张表本身就是把「意图」第一次写进账本 —— 每个 flag 现在都标了「该留/该删/该开/不知道」,而不是只有一个裸 on/off。

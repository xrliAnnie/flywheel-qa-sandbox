# FLY-1390 DAG-only 清算审计 — 探索

Issue: FLY-1390 (https://linear.app/geoforge3d/issue/FLY-1390/auditdag-only-清算-在飞-issuepr设计全量重判-legacy-冻结令下的还要改造删逐单裁定证据级)
日期: 2026-07-20
基于: 无

## 1. 这道单要解决的真实问题

Annie 2026-07-20 晨在 #flywheel-engineer 下了战略令:

> legacy 三段式冻结,不再为它做任何修补;以后只用 DAG;legacy-serving 的 issue 直接删;
> 旧 PR/设计凡按旧模式做的,核 outdated,不在过时设计上续建。

这道令本身是清楚的。不清楚的是**它具体落到哪几张单上**。在飞的东西有四类:停在
founder gate 的 4 个 PR、HL 的 942 PRD 三单、batch 4.3 五个候选、以及协调器续单的两个
候选缺陷。每一类都混着「真 legacy」和「看起来像 legacy 其实是共享层」的东西。

所以本单不是执行冻结令,而是**把冻结令翻译成逐项证据级裁定**,交 Annie 终审。

## 2. 核心判据(方法论)

整份审计只用一条判据,而且刻意定得比「看着像不像 legacy」严格:

> **一个改动是 legacy-only,当且仅当它的唯一调用路径经过 phase-orchestrator /
> three-stage 门控。**

不看文件名、不看 PR 标题、不看 issue 描述里的自我申报。理由:这个仓里「三段式」三个字
出现在大量共享层文件里(sessions / comm / wake / bridge),按名字判会把共享基建当
legacy 一起砍掉 —— 那是不可逆的误伤。

对应地,三档判定:

| 判定 | 含义 |
|------|------|
| **legacy-only** | 唯一调用路径经三段式门控 → 随 legacy 退役 |
| **pipeline-agnostic** | sessions/comm/wake/notification 层,两条 pipeline 共用 → DAG-only 下照样需要 |
| **mixed** | 一个 PR 里两种都有 → 需要拆,不能整体判 |

核不实的写 `unverified`,不猜。

## 3. 一个必须先说清的现实前提

审计开始时先核了当前 pipeline 配置状态(`.flywheel/config.yaml:250-260`):

```yaml
pipeline:
  three_stage: true
  three_stage_channels: ["1516209714097291335"]   # #flywheel-engineer
  dag: true                                        # FLY-1372 灰度,仅 flywheel
```

**两条 pipeline 现在同时开着。** DAG 是 FLY-1372 刚接线的灰度试点,legacy 三段式仍然
在 #flywheel-engineer 的实际派单路径上跑。

这不推翻冻结令 —— 冻结是方向决策,不是代码现状 —— 但它直接决定了**风险列怎么写**:
「弃掉一个 legacy-only 的修复」的真实代价不是零,而是「在 legacy 完全退役之前,这个缺陷
一直裸奔」。所以每条 legacy-only 的裁定都必须附一句「legacy 退役前的裸奔风险」,
而不是简单写「删」。

这是本审计和「照着冻结令一刀切」的关键区别。

## 4. 四批对象各自的真问题

### A. 四个停在 founder gate 的 PR

不是「是不是 legacy」这么简单,四个各有各的形状:

- **#642 / FLY-1293**(协调器交接完整性批修):协调器本体是 legacy 机件没错,但这个 PR
  是一个**批修**,五条缺陷来源各异 —— 手动派单入册、接力棒对账明显是三段式的;但
  「QA record 入账」牵动 verify-approval(ship 路径,共享),「Lead 任务清单注入 runner
  会话」是 harness 注入面(烧 token、跟 pipeline 完全无关)。→ 天然是 mixed,必须逐文件判。

- **#648 / FLY-1339**(phase handoff / park-wake 自动接力):issue 描述里 Annie 自己就写了
  「DAG(FLY-1307,引擎化后此层由引擎负责 — 实现时对齐,勿重复造)」。这条自我申报指向
  「整体过时」,但**申报不是证据** —— 真问题是 park-wake 的 declared-state 协议是否被
  检测层(1386 族)依赖。如果是,那这个 PR 里有一块必须活下来。

- **#647 / FLY-1340**(code review 架构面前移):概念(reviewer 带设计上下文)显然
  pipeline-agnostic —— Codex review 对任何 PR 都跑。问题只在实现落点:
  `review-request-coordinator.ts` 是不是焊死在 legacy review 流上。

- **#641 / FLY-1342**(head-churn 治理设计):这是唯一**未必过时**的一个。它 7/17 就是按
  Annie 直令「重新设计并进 DAG 语义」写的,而且是纯 docs+HTML,零 packages 源码改动。
  真问题变成:对照 1385 的最新方向(通知式 blocked / vendor 围栏),这份 7/17 的设计
  是否仍然成立。

### B. HL 的 942 PRD 三单(1386 / 1387 / 1388)

942 PRD 写于 DAG 转向之前,所以「过时」的怀疑是合理的。但这三单的层次值得先想清楚:

- 1386 = 三态判定(在跑 / parked / 真卡死),读 pane 富态
- 1387 = 检测 cadence(`DEFAULT_IDLE_POLL_MS=1h` 使 30min 阈值数学上不成立)
- 1388 = 统一升级流(检测即通知责任 Lead,~30min 未解决才 @Annie)

**我的初始假设(待代码核实,不预设结论)**:1385 和 1386-88 根本不在一层。

- 1385 描述的症状是「死 exec 没留 completion receipt → node 永久卡 running」。也就是说
  DAG 引擎**只从显式 receipt/事件学状态**。
- 而一个死掉或楔死的 runner,**恰恰是发不出 receipt 的那个**。

如果这条在代码上成立,推论是反直觉但很重要的:**DAG 引擎的内建状态机不但没有替代外部
检测,反而使外部检测更必要** —— 因为引擎的唯一信息源是自我申报,而自我申报在故障时
正好失效。这会直接改写「还需不需要 watchdog 族」的答案。

Annie 2026-07-20 那条「判死不依赖申报」的原则,如果上面成立,就不只是一句纪律,而是
对引擎结构性盲区的补位。这条要么用 file:line 坐实,要么写 unverified。

边界纪律:B 批是 HL 的单,本审计只给重叠矩阵 + 建议,**每条显式标注「需与 HL 协调」**
(Lead 2026-07-20 gate 确认),不代 HL 决定,不越权删。

### C. Batch 4.3 五单(1374 / 1375 / 1363 / 1364 / 802)

粗读五单的描述,没有一个提到三段式 —— 它们是 Discord 显示对账、ship 自动化、6am 重启
preflight、cmux 死 tab 清理、roundtable thread 归档。初步看全是 pipeline-agnostic 基建。

所以 C 批的真问题不是「legacy 不 legacy」,而是**「在 1373 已 land 的现实下,还剩多少
没被覆盖」**:

- 1374 要对照 1373(88cfecce9)+ 1099 的实际 diff 划已覆盖面 —— 尤其 `display_reconciled_at`
  这个「半截建设」的列到底建没建完
- 1375 自己就写了「land 作为 DAG 工程模板的最后一个节点」→ 天然 DAG 语境
- 1363 除了 gitignore 本身,还要先盘它暂留 worktree 里的未收工作
- 802 状态可疑:PR #423 已 merge、issue 7/3 到 Done、7/11 又被**重开**到 Todo —— 需要
  查清重开的是哪一半

### D. 协调器续单的两个候选缺陷

qa-result credential 邮路 / qa_required 快照接线。issue 本身的怀疑是「DAG 路径原生走
`/api/workflow/decision`,所以这俩不值得修」。需要证据确认两件事:(1) 这两个缺陷是否
只在 legacy 路由上显形;(2) DAG 路由是否真的天然绕开。大概率降级为「不修,随 legacy
退役」,但要给证据不给猜测。

## 5. 交付形态

- 裁定表:每项 = 对象 / 本来做什么 / 证据 / DAG-only 判定 / 建议动作 / 风险
- 裁定四档:**照做 / 重述成 DAG 语境 / 并入他单 / 删**
- 给 Lead 一版可直转 Annie 的 Apple-light HTML

**硬边界(issue 明文 + gate 确认)**:只读审计 —— 不动任何代码、不关任何单。关单/弃 PR
一律 Lead + Annie 终审后执行。不碰 FLY-1356(E2E 进行中)与 FLY-1335(已 QA PASS 停 gate,
Annie 已单独认可其价值)。

## 6. 已知会翻车的地方(预先声明)

1. **按名字判 legacy** —— 本审计最大的误伤风险,用「唯一调用路径」判据顶住。
2. **拿 issue 的自我申报当证据** —— 1339 自己说「引擎化后由引擎负责」、1342 自己说
   「并进 DAG 语义」,这些都要独立核实,申报只能当线索。
3. **把「PR 里 docs 占大头」当成「没有实质改动」** —— #648 有 15 个 codex round 文档,
   但源码改动同样很大;要按源码文件判,不按文件数判。
4. **忘了 legacy 还在跑** —— 见 §3,每条 legacy-only 裁定都要附裸奔风险。

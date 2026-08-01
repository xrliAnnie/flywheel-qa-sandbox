# FLY-1590 承接 1581 落地 generalized node 失败出口调研 — 调研

Issue: FLY-1590 (https://linear.app/geoforge3d/issue/FLY-1590/承接-1581-落地-generalized-node-失败出口调研-5-份文档-862-行产出已完成只差写入)
日期: 2026-08-01
基于: exploration.md

> 本单是搬运,不是调研 FLY-1581 的技术问题(那份调研已完成,见
> `../FLY-1581-generalized-node-failure-exit/preserved-by-FLY-1590/research.md`)。**本文只核三件事:
> 产出物在哪、是否完整、本节点凭什么能落地。**

## 1. 产出物核验

### 1.1 两处来源,逐字一致

| 来源 | 路径 | 状态 |
| -- | -- | -- |
| 源 worktree | `~/Dev/flywheel-FLY-1581/engineering/doc/FLY-1581-generalized-node-failure-exit/` | 第一代文件**已消失**;该 worktree 曾被重新 dispatch 产出另一批同名文档,**后经 Lead 裁定为未授权误派、已停**(见 §1.3b) |
| Lead 预防性备份 | `~/.flywheel/evidence/FLY-1581-preemptive-20260801/` | 存活,采用为落地源 |

`diff -r` 实跑(00:52,worktree 尚存活时):**零内容差异**。

> 证据强度声明(Codex R1 LOW):这一条是**当时的观察,输出没有持久化**,而源
> worktree 随后被回收 —— **它现在不可独立复现**。此刻能独立证明的只有两件事:
> ① 落地内容 == evidence 备份(SHA256,§1.4 任何人可复算);
> ② 源 worktree 确实发生过 reset(git reflog)。
> 「落地内容 == FLY-1581 runner 当时产出的字节」这一步,依赖 ① 加上那次
> 已消失的 `diff -r`,**不是纯 SHA 可证的**。据此不使用「provably」这类措辞。

唯一不对称是 evidence 侧多两个中间态备份 —— `plan.md.STALE-370lines.bak` / `progress.md.STALE-32lines.bak`
—— 那是 FLY-1581 runner 自己刷新备份时留的旧版,**未采用**(它明写旧 plan.md
「少 37 行且残留已撤销的 PR-B 方案,照它实施会建错」)。

### 1.2 五份文档 = 865 行

| 文件 | 行数 | 内容 |
| -- | --: | -- |
| `exploration.md` | 107 | 缺陷复现链、引擎允许什么、方案取向 |
| `research.md` | 182 | 逐行证据:模板侧 / 引擎侧 / 409 怎么发生 / 三个 completion sink |
| `plan.md` | 407 | 9 节实施计划,含合同测试 + 真机验收 + 风险表 + 评审留痕 |
| `follow-ups.md` | 134 | F1–F4 四条可直接建单的草稿 |
| `progress.md` | 35 | 进度台账,明写「零生产代码改动」 |
| **合计** | **865** | |

> **862 vs 865 的差是版本差,不是统计口径**(Codex R1 MEDIUM 纠正了我最初的
> 说法)。实算:四份最终文件 + `progress.md` 的**旧版**(`progress.md.STALE-32lines.bak`,
> 32 行)= **恰好 862**。dispatch 正文引用的是 progress.md 还停在 32 行时的快照;
> FLY-1581 runner 后来把它刷新到 35 行的最终态,于是变成 865。**内容零缺失**,
> 落地采用的是 35 行的最终态。以逐字 SHA256 为准(见 §1.4)。

`follow-ups.md` 四条齐全,标题逐条核过:

* **F1** — `flywheel-comm ask` 的门铃失败信号会把人引向错误补救(`:12`)
* **F2** — progress lock 的报错掩盖了「路径不存在」这个真实原因(`:49`)
* **F3** — no-write generalized 节点的 PROGRESS LEDGER 与 no-commit 规则自相矛盾(`:79`)
* **F4** — FLY-869 merge-block 对 generalized execution 覆盖不全(`:111`)

`plan.md` 九节齐全(`:10 §0 判定` … `:394 §9 评审过程留痕`),含
**Codex design review 10 轮 APPROVED**、40+ findings 全折入的留痕。

### 1.3 源 worktree 在本单读到它之后约两分钟被清空

```
00:52     读到源 worktree,HEAD = ab2ec6b2,五份文档为未跟踪文件
00:53:59  worktree 被 reset → HEAD 变成 2ed08e54 (PR #748)
00:54     从 evidence 备份复制到本分支,SHA256 核过
00:54     再探源 worktree:
          git status --short           → 空
          ls -d engineering/doc/*1581*  → no matches
          find . -name "*1581*"         → 零命中
```

⇒ 第一代那五份未跟踪文件**已从磁盘消失**。**reset 那一刻,Lead 的预防性备份是
   仅存的一份**;此后本分支的副本才出现。
⇒ 措辞精度(Codex R2 MEDIUM):不泛称备份为「唯一幸存副本」—— 更准的说法是
   **唯一独立恢复来源**。且**消失的是第一代未跟踪内容,不是 worktree 本身**
   —— 那个 worktree 现在还活着(见 §1.3b)。
⇒ 这条实测直接坐实了 FLY-1581 那条缺陷链的**真实代价**:不是「产出延迟落地」,
   是「产出到期即焚」。

### 1.3b 后续:FLY-1581 曾被重新 dispatch(Codex R1 HIGH 查出;该批产物后经裁定不作数)

```
00:58     flywheel-FLY-1581 worktree 被重新 dispatch,新 runner 开工
01:03 起  新 runner 在【同一个 canonical 目录】写自己的
          exploration / research / plan / progress
          字节与第一代完全不同(如 exploration 14050B vs 第一代 8581B)
          仍在进行:plan.md 到 01:42 还在被改写
          progress.md 已 commit(分支 HEAD `fc0f2df1`);
          exploration / research / plan 此刻仍是 untracked
```

⇒ **两代会抢同一批文件名**。本单原定落点(canonical 根目录)若与之都合入 main,
  会撞成 **add/add conflict**。

> 后果口径修正(Codex R2 MEDIUM):原写「谁后合谁覆盖」**夸大了**。git 对两侧
> 各自新增的同路径文件报 add/add conflict 并**拒绝自动合并**,必须人工
> resolution;只有选错边才会丢快照。真实风险是「把一次本可避免的人工取舍塞进
> merge 现场,取舍对象是一份 865 行、10 轮 APPROVED 的调研」。

⇒ 已改落点:封进 `preserved-by-FLY-1590/` 子目录,不占根目录的同名文件。
  判断经过见 `exploration.md §3.2`。
⇒ **后续裁定(2026-08-01,Eng Lead)**:那批内容**不作数** —— 它是用
  `close_runner(done=true)` 推进 FSM 招来的**误派产物,那次派工从未被授权**,
  已让它停,**不要把它的内容并进来**。上面「不评判谁更权威、留待比对」的中立
  处置**已被推翻**;`README.md §3` 已按裁定改写。
  Lead 对基线的补充:「第一代基线在 #748 之前不影响文档价值 —— 它记录的是
  当时的事实,而事实没有变。」

### 1.4 落地后逐字核验

五份文件 SHA256 与 evidence 逐份相等:

```
exploration.md  9a85fd0e1b5016fd82fbf7f91b3097fc5b63860dd9e8187dc74ff60d09f1d16f
research.md     db25feecbe16418e501b7503368f075564e04273e2fd437fcd69b40816036380
plan.md         a46ab3ad4728eaf28c06b894ae00f0bfe72bd840f72f97fe258265c74e6ac433
follow-ups.md   b6517a893e0a0c3270c584b87da438af5106bd7fb6168eabf1cacdd78f8454b3
progress.md     583574bfb1c634a524bd0d86984c5e82918264ae5800064dcd1fbdcf8bf28794
```

**一个字未改**,包括 `progress.md:3` 那条写坏的 Linear URL
(`.../issue/GEO/issue/FLY-1581`,多了一层 `GEO/issue`)。本单是搬运,不是修订;
改它会让「与备份逐字一致」这条验收失去意义。已在 `LANDED-BY-FLY-1590.txt` 记明。

## 2. 本节点凭什么能落地 —— 写权限已在源头修好

dispatch 正文要求「照抄 FLY-1587 那个写权限覆盖写法,否则会第五次搁浅」。
**实际核下来不需要覆盖** —— 根因已被 PR #748 修掉。

### 2.1 缺陷:generic 节点 12 个能力位全 false

`2ed08e54` (PR #748) 的 commit message 自述:

> The generic node type shipped with **all 12 capability bits false**. Because
> Blueprint derives its system prompt from those bits, every single-stage runner
> was told "This is a no-write node: do not modify the shared branch, create
> commits, push, or open a PR" — so single-stage work could never land.

⇒ FLY-1578 / 1579 / 1580 / 1581 四单的**共同根因**,一句话说清了。

### 2.2 修复后的形态(本仓 HEAD 可核)

`packages/config/src/node-type-registry.ts:125-152` —— generic 现在与 `implement`
同形:

```
capabilities: {
  ...noCode("needs_review"),     // ← 不是 "no_code"
  shared_branch_writer: true,
  creates_pr: true,
  can_ship: true,
  can_land: true,
  approval_gate_holder: true,
  needs_review_evidence: true,
  needs_mailbox_transport: true,
  keepalive_park: true,
}
```

`completion_route` 必须是 `needs_review` 而非 `no_code`,源码注释给了三条约束
(`:136-139`):`creates_pr` 让节点成为 ship-bundle carrier;
`resolveWorkflowGateAuthority` 只接受 carrier 走 `needs_review`,否则抛
`incoherent_ship_bundle`。

`WorkflowCompletionRoute` 合法集仍是三个(`:10-13`):
`phase_design_complete | needs_review | no_code` —— **`blocked` 不在其中**,
这正是 FLY-1581 调研的主题(它的 plan.md 提出的修复尚未实施)。

### 2.3 本节点的实证

本单 Agent Role 预置文本里**没有 no-write 禁令**,反而明写:

> When the bounded work is complete, **open the PR** and run
> `flywheel-comm complete --route needs_review --pr <NUMBER>`

⇒ 能力位翻转已通过 Blueprint 传导到真实 dispatch。**本单是 #748 修复在生产
dispatch 上生效的一个可核实样本** —— 一条意外产出的验证事实,已报 Lead。

> 措辞注(Codex R1 MEDIUM):**不写「第一个」**。要说「第一」需要对 #748 合入后
> 的所有生产 dispatch 做全量审计,本单没做。本单能证明的只是这一例生效了。

### 2.4 这不改变本单做法

不管写权限来自能力位还是 dispatch 覆盖,动作一样:改文件 → commit → push →
开 PR → `complete --route needs_review --pr <N>`。**merge 仍是 founder 的门,
本节点不自行 merge。**

## 3. 明确不做

* ❌ **不实施 `preserved-by-FLY-1590/plan.md` 描述的修复** —— 那是未来实施节点的活,本单只搬运。
  `plan.md` 是**输入**,不是已完成工作的记录。
* ❌ **不用 `create-issue` 把 F1–F4 建成单** —— 验收只要求「草稿一并带过来,不丢」。
  建单会产生 founder-facing 的副作用,超出本单授权。
* ❌ **不碰 FLY-1578 / 1579 / 1580** —— 1580 已由 1587 救回(PR #745 已合并),
  1579 由 1586 承接在跑。碰它们就是撞车。
* ❌ **不改 `progress.md` 那条坏 URL** —— 见 §1.4。

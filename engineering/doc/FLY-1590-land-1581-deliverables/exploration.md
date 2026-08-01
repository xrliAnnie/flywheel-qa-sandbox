# FLY-1590 承接 1581 落地 generalized node 失败出口调研 — 探索

Issue: FLY-1590 (https://linear.app/geoforge3d/issue/FLY-1590/承接-1581-落地-generalized-node-失败出口调研-5-份文档-862-行产出已完成只差写入)
日期: 2026-08-01
基于: 无(上游探索见 `../FLY-1581-generalized-node-failure-exit/preserved-by-FLY-1590/exploration.md`)

## 1. 这单为什么存在

**调研不是本单做的,FLY-1581 已经做完了** —— 五份文档 865 行,Codex design
review 10 轮 APPROVED,外加四条可直接建单的 follow-up。本单存在的唯一原因是
它一个字都进不了 git:

```
FLY-1581 的 generalized 节点 = no-write
  → 契约禁止改分支 / commit / push / PR
  → 只能 `complete --route no_code` 收工
  → 系统判定「完成」
  → DAG 跳过落地节点
  → 交付物永远留在一个未提交的 worktree 里
```

2026-07-31 夜里 FLY-1578 / 1579 / 1580 / 1581 四单死于同一条链。1580 已由
FLY-1587 救回(PR #745 已合并),1579 由 FLY-1586 承接。本单救 1581。

⇒ **本单只做一件事:把已完成的产出搬进 git。不重做调研。**

## 2. 范围边界(极窄)

| 做 | 不做 |
| -- | -- |
| 五份文档进 git,开 PR | ❌ 重做 / 修订 / 改写调研内容 |
| 内容与 evidence 备份逐字一致 | ❌ 顺手修 progress.md 里那条写坏的 Linear URL |
| 四条 follow-up 草稿一并带过来 | ❌ 用 create-issue 把 F1–F4 建成单(不在验收里) |
| 落地来源写成可核验的说明文件 | ❌ 实施 `preserved-by-FLY-1590/plan.md` 描述的修复(那是未来节点的活) |
| | ❌ merge / ship —— founder 的门 |

## 3. 唯一的设计判断:五份文档放哪个路径

### 3.1 初判(错了一半)

两个候选:

**A. canonical 根目录 `engineering/doc/FLY-1581-generalized-node-failure-exit/`**

**B. 塞进本单目录 `engineering/doc/FLY-1590-*/upstream-FLY-1581/`**(FLY-1587 的形态)

我选了 A,理由:

1. **doc-flow 契约就是一 issue 一文件夹** —— `engineering/doc/<ISSUE>-<slug>/`,
   且明写「创建前 `ls engineering/doc/` 并 REUSE 任何已存在的同前缀文件夹」。
2. **plan.md 的读者是未来的实施节点**。它会 `ls engineering/doc/ | grep FLY-1581`。
   埋进 `FLY-1590-*/upstream-*/` 等于让交付物二次丢失。
3. **FLY-1587 用 `upstream-FLY-1580/` 是因为它情况不同**:1587 自己有实质产出
   (design.md 两处更正),而 1580 的交付物是一份 **patch** —— patch 落地后原文
   只是佐证。本单是**纯搬运**,五份文档本身就是交付物。

### 3.2 Codex code review 推翻了 A 的落点(R1 HIGH)

理由 1–3 关于**目录**是对的,关于**文件名**是错的。Codex R1 查出真实碰撞
—— 不是理论风险,是已经在发生:

```
00:53:59  flywheel-FLY-1581 被 reset,第一代五份未跟踪文件从磁盘消失
00:58     该 worktree 被【重新 dispatch】,新 runner 开工
01:03 起  新 runner 在同一个 canonical 目录写自己的
          exploration / research / plan / progress —— 字节完全不同
          (仍在进行:plan.md 到 01:42 还在被改写)
          progress.md 已 commit(该分支 HEAD `fc0f2df1`);
          其余三份此刻仍是 untracked
```

⇒ 我若占用根目录的 `exploration.md` / `plan.md` 等文件名,两代若都合入 main
  会撞成 **add/add conflict**。

> 后果口径修正(Codex R2 MEDIUM):我原先写「谁后合谁覆盖」——**夸大了**。
> git 对两侧各自新增的同路径文件报 add/add conflict、**拒绝自动合并**,必须人工
> resolution;只有 resolution 选错边才会丢快照。真实风险是「把一次本可避免的
> 人工取舍塞进 merge 现场,而取舍对象是一份 865 行、10 轮 APPROVED 的调研」——
> 这已经足够构成换落点的理由,不需要把它说成自动覆盖。

⇒ 我原本担心「埋进子目录 = 二次丢失」,真正制造风险的恰恰是我选的落点。

### 3.3 终态

**canonical 目录保留(理由 1–2 成立),但快照封进
`FLY-1581-*/preserved-by-FLY-1590/`,不占根目录文件名。**

> 后续裁定(2026-08-01,Eng Lead):当时被我称作「现役那一代」的那批内容
> **不作数** —— 未授权误派产物,已停。**换落点的决定本身依然正确**(它规避了
> 一次真实的 add/add conflict),但理由里「把根目录让给现役那一代」这个说法
> 应读作「不占用同名文件」,而不是承认那批产物的地位。
根目录加 `README.md` 作首屏指路 —— 同时解决「读者可能把未实施的 plan.md 误读成
已完成工作」(Codex R1 LOW)。

`README.md` 不在 doc-flow 契约的文件集(exploration/research/plan/progress)里,
碰撞风险低;若现役 runner 也写 README,以其为准即可,快照本身不受影响。

⇒ 形态上与 1587 相同的只剩一样:一份说明落地来源的 txt(`LANDED-BY-FLY-1590.txt`)。

## 4. 本单撞到的事实:写权限已经不需要「覆盖」了

dispatch 正文警告过「必须照抄 FLY-1587 那个写权限覆盖写法,否则会第五次搁浅」。
**实际核下来,本单不需要覆盖** —— 能力位已经在源头修好了:

`2ed08e54` (PR #748, `feat: give generic nodes the capabilities to land their work`)
的 commit message 自述:

> The generic node type shipped with all **12 capability bits false**. Because
> Blueprint derives its system prompt from those bits, every single-stage runner
> was told "This is a no-write node: do not modify the shared branch, create
> commits, push, or open a PR" — so single-stage work could never land.

这正是 FLY-1578/1579/1580/1581 四单的根因,已被 #748 修掉。**本单的 Agent Role
预置文本里已经没有 no-write 禁令**,反而明写「open the PR and run
`complete --route needs_review --pr <NUMBER>`」。

⇒ 本单是 **#748 修复在真实 dispatch 上生效的一个可核实样本**。这是意外产出的
一条可核验事实,已报 Lead。详见 `research.md §2`。

> 措辞注(Codex R1 MEDIUM):此处**不写「第一个」** —— 那需要对所有生产 dispatch
> 做全量审计,本单没做。可核实的只是「本单这一例确实生效」。

## 5. 差一点就真丢了 —— 时间线

| 时刻 | 事件 |
| -- | -- |
| 00:52 | 本单读到源 worktree(尚存活),`diff -r` 对 evidence 备份 → **零差异** |
| 00:53:59 | **源 worktree 被 reset 到 `2ed08e54`** → 第一代五份未跟踪文件从磁盘消失 |
| 00:54 | 五份文档**从 evidence 备份**复制到本分支,SHA256 逐份核过 |
| 00:54 | 复核:`git status` 干净、`find . -name "*1581*"` 零命中 —— 证实第一代已不在磁盘 |

> 顺序注:落地源是 **evidence 备份**,不是 worktree。所以 reset(00:53:59)早于
> 复制(00:54)并不矛盾 —— 当时那次三方 SHA 校验里 worktree 那一列输出
> `no such file or directory`,正是 reset 已发生的现场证据。

⇒ **reset 那一刻,Lead 的备份是仅存的一份。** 若没有它,FLY-1581 一整夜的产出
  在此刻归零。
⇒ 这也是本单先落盘、后补文档的原因 —— 见 `plan.md §3` 的顺序说明。

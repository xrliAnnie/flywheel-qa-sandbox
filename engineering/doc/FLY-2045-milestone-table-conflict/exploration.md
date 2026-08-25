# FLY-2045 CLAUDE.md 里程碑表顶部插入 = 并行 PR 100% 互斥 — 探索

Issue: FLY-2045 (https://linear.app/geoforge3d/issue/FLY-2045/repo流程-claudemd-里程碑表顶部插入-并行-pr-100percent-互斥每合一单全舰-dirty分支失去-ci-能力8-25)
日期: 2026-08-24
基于: 无

> **⚠️ 本文是最早的过程稿,下列结论已被推翻或已有裁定。唯一执行权威是 `plan.md`(v17):**
> 0. **已裁定方案 B**(Tadashi 2026-08-25 07:05,复议后改判,晚于同日 06:58 的 A 裁定):整表搬出 `engineering/doc/milestones/` 并**从 CLAUDE.md 删净**。本文 §5 推荐 B 的方向对,但**路径**与**数字**都要按 plan.md 修正。
>    真实 PR 验收**已获授权由本节点执行**(一次性 base 分支,永不碰 main),§6「不属于本节点」作废。
> 1. **目录路径**:本文写的 `engineering/milestones/` 是错的 —— 它不在 `ci-classify.sh` 的 inert 前缀内,
>    且会让含 v2 关键词的历史行落进两个 residue guard 的扫描面。正确路径是 **`engineering/doc/milestones/`**。
> 2. ~~**§5 的 B “不再是默认执行项 …… 拿不到决定就执行 A”**~~ —— **整句作废**。那是 A/B 未决期间的写法；Tadashi 已复议改判 **B**（见第 0 条）。
>    数字更正保留：本文多处写“186 条里程碑” —— 那是**行数**，**数据行是 177 条**；
>    校验和从 `md5` 改为 `sha256`（`md5` 是 macOS 专有命令，Ubuntu CI 上不存在）。
> 3. **§6「合并那一步不属于本节点」已被推翻**:那样写等于让 issue 在验收 1 未满足时就能被当作完成。
>    plan.md §6 已把真 PR 验收改成**硬完成门**,并给了一条我自己就能跑的替代(临时 base 分支,永不碰 main)。
> 4. **§5 的两个数字量错了**:实际是 CLAUDE.md 178 KB → **~11 KB**,少装载 **167 KB**(不是 38 KB / 140 KB)。

---

## 1. 问题是什么(用机制说,不用症状说)

不是「合并偶尔会冲突」,而是**结构上不可能不冲突**:

- `CLAUDE.md` 的里程碑表在文件的固定位置(第 39–224 行,表头在 39/40 行)。
- 每个工程 PR 的最后一个 commit 都往**表头正下方**插入一行。
- 两个并行分支从同一个 base 切出 ⇒ 两边都在**同一个 hunk 的同一位置**做加性修改 ⇒ git 的三方合并无法自动决定谁在上 ⇒ **必冲突**。

这不是概率事件。只要两个 PR 都加里程碑行,冲突率就是 100%。

### 实测证据(本仓真实 commit)

最近 5 个带里程碑的 merge,`git show <sha> -- CLAUDE.md` 的 hunk 头:

| commit | hunk |
| -- | -- |
| `978e085eb` (FLY-2022) | `@@ -39,6 +39,7 @@` |
| `88c3df6b9` (FLY-2014) | `@@ -38,6 +38,7 @@` |
| `d01bee2b7` (FLY-2018) | `@@ -39,6 +39,7 @@` |
| `533adc64f` (FLY-2015) | `@@ -38,6 +38,7 @@` |
| `1c74ea6af` (FLY-1999) | `@@ -39,6 +39,7 @@` |

5/5 落在同一个位置,且全是纯 `1 insertion(+), 0 deletions` ——**同一行、同一上下文、同一方向**。

### 为什么 DIRTY 之后代价这么大

GitHub 在 PR 冲突时算不出 merge commit ⇒ `pull_request` 工作流**根本不排队** ⇒ 分支失去 CI 能力 ⇒ QA 硬门(exact-head CI 绿)不可测量 ⇒ 只能 rebase 重来。而 rebase 会换 head ⇒ 已有的 ship 卡 / QA verdict / gate binding 都可能失效(8-25 夜 FLY-2034 「零 CI head 出 ship 卡」被打回就是这条链)。

⇒ **每合一单,其余所有在飞分支同时进入「不可测量」状态。** main 越活跃,浪费越大。

---

## 2. 三个候选方案的实测结果

我在隔离沙箱里把三个候选各跑了一遍(脚本:`scratchpad/mergetest.sh`,本 folder 附 `merge-evidence.md` 收录原始输出)。

| # | 方案 | merge | rebase | 判定 |
| -- | -- | -- | -- | -- |
| 1 | 现状(表顶插入) | **CONFLICT** | — | 基线,复现成功 |
| 2 | `.gitattributes` `merge=union` | CLEAN | CLEAN | 能合,但见 §3 的硬伤 |
| 3 | per-issue 文件(每 PR 新增一个文件) | **CLEAN** | **CLEAN** | ✅ |
| 4 | 追加到表**底部** | **CONFLICT** | — | ❌ **候选被证伪** |

### ⚠️ 需要向 founder 明说的一条:候选 3「底部追加」是错的

Issue 原文写「底部追加只在同刻双合时冲突」。**实测不成立。**

两个分支从同一 base 切出、各自 `>>` 到文件末尾,产生的是**同一个 EOF hunk 的两次加性修改** —— 和顶部插入是完全同构的情形,冲突率同样是 100%,与「是否同刻」无关。沙箱 CASE 4 直接复现。

所以「底部追加」不是一个更弱的修法,它**根本不修**。这条要在方案里排除掉,否则会有人拿它当低成本折中。

---

## 3. 为什么不选 `merge=union`(虽然它「能合」)

沙箱 CASE 2c:给一个**规则文件**配 union,两边各改同一行规则:

```
base: rule: never push to main
分支 a: rule: always push to main
分支 b: rule: never ever push to main
merge 结果(CLEAN,无冲突):
  rule: never ever push to main
  rule: always push to main
```

union 的语义是「冲突时两边的行都留下」。对**加性表格**这正合适;但 `CLAUDE.md` 同时是**全项目 agent 的指令文件**,里面有 `## Non-Negotiables`、`## Core Behaviors`、`## CLI Contract Changes` 这些规则段。一旦哪天两条分支各改一句规则,union 会**静默保留两条互相矛盾的规则**,不报冲突、不留痕迹,然后每个 agent 都会读到。

这是拿「合并干净」换「指令文件可能自相矛盾且无人知道」。对一个 178 KB、被每个 session 自动装载的指令文件,这个代价不能接受。

补充两条:

- union 是 git 内置 driver,本地/rebase 都生效(已实测)。但 **GitHub 服务端算 `mergeable` 时是否读仓库的 `.gitattributes` 我没有验证** —— 如果不读,PR 照样 DIRTY,验收第 1 条直接不过。这是个我不打算去赌的未知数。
- 即使要用 union,也只能对**只含加性行的文件**用,不能对 CLAUDE.md 整体用。而一旦把表拆出去成独立文件,per-issue 文件方案已经天然零冲突,union 就没必要了。

---

## 4. 推荐方案:per-issue 里程碑文件

```
engineering/milestones/
├── README.md                     # 格式约定 + 怎么加一条
├── ARCHIVE-pre-FLY-2045.md       # 现有 186 行,逐字节搬过来,冻结
├── FLY-2045.md                   # 新里程碑,一 issue 一文件
└── FLY-XXXX.md                   # ...
```

`CLAUDE.md` 的 `## Current Phase` 里,里程碑表整块换成一段指针(几行,不随 PR 变动)。

**为什么这个能真正归零**:两个并行 PR 各自**新建一个不同路径的文件**。git 三方合并对「双方各新增一个不同路径」根本不进入冲突判定 —— 不是「不容易冲突」,是**没有可冲突的对象**。沙箱 CASE 3 的 merge 与 rebase 两种形态都验证过。

**对验收的映射**:
1. 两并行 PR 各加里程碑 → 先合一个 → 另一个仍 MERGEABLE ✅(git 层已证;GitHub 层需真 PR 验,见 §6)
2. 零丢失 ✅(整块搬迁 + checksum 守卫,见 §5)
3. QA 推报告不再制造赛跑 ✅ —— QA 报告落 `engineering/doc/FLY-XXXX/`(已经是 per-issue),原本让分支 DIRTY 的唯一共享写点就是 CLAUDE.md;移走后分支上不再有任何与 main 抢同一 hunk 的文件

---

## 5. 需要 founder / Lead 拍板的一个真实取舍

**把整张表移出 CLAUDE.md,等于每个 session 的自动装载上下文少 167 KB。**(原稿写 ~140 KB,量错了)

- 好处:CLAUDE.md 从 178,228 B 降到 ~11 KB,回到「指令文件」的本分;每个 agent、每个 session 都省这笔。
- 代价(我必须点名):现在这 186 条里沉淀了大量运维教训,agent 是**被动吸收**的。移走之后它们只在有人主动去读 `engineering/milestones/` 时才起作用。这个行为变化**无法测量**,我不能假装它不存在。

三种处理,我推荐 B:

| | 做法 | 冲突面 | 上下文 |
| -- | -- | -- | -- |
| A | 历史表留在 CLAUDE.md 冻结,只有新里程碑走 per-issue | 已归零(冻结块没人改) | 不变(仍 178 KB) |
| **B(倾向,但不默认执行)** | 整表搬到 `engineering/doc/milestones/`,CLAUDE.md 留指针 | 归零 | −167 KB |
| C | 脚本聚合回 CLAUDE.md | **不归零**(生成物入库 = 又回到同一个 hunk) | 不变 |

- C 直接排除:只要聚合结果是 tracked 文件,就还是那个共享写点。
- A 能达成验收,但留下「一半在 CLAUDE.md、一半在目录」的分裂,而且历史块会永远僵在那里没人清。
- B 是 issue 原文点过的方向(「干脆引用目录」),也是唯一同时解决冲突和上下文税的做法。

**如果 Lead/founder 认为丢失被动上下文的风险更大,退回 A 只是少改一处,plan 里我会把 A 写成可切换的降级路径。**

---

## 6. 边界:我这个节点做不到的部分

验收第 1 条要求「用真实 PR 验,不用单测代替」。真实验证需要:建两个 PR → **merge 其中一个**。

- merge 到 main 是 founder-gated(engineer-executor / FLY-1959 硬规则),我不能自己合。
- 所以我这个节点能做到的是:实现 + 本地 git 层证明(已完成)+ 在 plan 里写死一份**可执行的真 PR 验收流程**(建两个牺牲性 PR、记录两边 `mergeable` 状态、合一个之后复查另一个)。
- **合并那一步 + 合并后复查,属于 QA / ship 窗口,不属于本节点。** 我会在 plan 里显式标出来,不冒充已交付。

## 7. 顺带发现,但**不**在本单动手

- `CLAUDE.md` 第 12–19 行的 `Active Explorations` 列表也是共享写点(`spin.md` 说 ship 时要从里面删条目),同样会冲突,只是频率低。本单不碰 —— 但会在 plan 的风险节里点名,让它可以单独排期。
- 现有里程碑表中间有若干空行(如 216、219、221 行),markdown 上其实已经把它切成了好几张表。搬迁时**逐字节保留**,不做「顺手修好」。

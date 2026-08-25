# FLY-2045 验收证据 — 真实 PR 台架

Issue: FLY-2045 (https://linear.app/geoforge3d/issue/FLY-2045/repo流程-claudemd-里程碑表顶部插入-并行-pr-100percent-互斥每合一单全舰-dirty分支失去-ci-能力8-25)
日期: 2026-08-25
基于: plan.md §6

> ⚠️ **这不算 ship 例外的先例。** 红线针对的是 main / 生产;这次是**验收台架**。
> 台架的四条边界由 Tadashi 在 ask `946c5af3-0e8c-40af-bb5e-879ff5ca9a39` 给出,逐字执行:
> ① base 分支名固定 `fly2045-accept-base`,探针 PR 标题以 `[FLY-2045 验收探针]` 开头,不许长得像正常交付 PR;
> ② merge **只**进那条一次性分支,**任何时刻不以 `main` 为 base 或 target**;
> ③ 做完删分支、close 未合并的探针 PR;
> ④ 报告必须写清这句,免得后人引用成「可以 self-merge」。

## 台架与被交付实现的绑定

验收如果不绑死实现,从旧 commit、从 `origin/main`、甚至手搭一个最小目录起台架,都能产出一份
**形式完整却什么都没证明**的证据。所以:

| | 值 |
| -- | -- |
| `implementation_sha`(code review APPROVED 后的 head) | `25e072c768b176a3e148b40190f8f4d78d67358b` |
| `fly2045-accept-base` 的 rig commit | `c02953804c63a563db0f07348700e707cd0c2be7` |
| 该 rig commit 的 **parent** | `25e072c768b176a3e148b40190f8f4d78d67358b` ✅ **精确等于 implementation_sha** |
| rig commit 的**唯一** diff | `.github/workflows/ci.yml` 的 `pull_request.branches`,见下 |
| `origin/main`(验收全程未移动) | `5a8fe51bfbf567c518dbdf536ee09afe7b805243` |

**失效条件**:交付分支相对 `implementation_sha` 只允许新增证据文件。任何 guard / writer /
layout / workflow 的实现改动都使本文件作废,必须重跑。

## 台架为什么需要自带 CI trigger

仓库**唯一**的 `pull_request` workflow 是 `.github/workflows/ci.yml`,它过滤 `branches: [main]`
—— 过滤的是 PR 的 **base**。而边界 ② 禁止以 `main` 为 base,所以探针 PR **根本不会产生任何 CI run**,
验收第 3 条要证的东西就不存在。

处置(Tadashi 于 ask `a0092661` 批准):**只在两条一次性 base 上**把 `pull_request.branches` 精确扩成
`[main, fly2045-accept-base, fly2045-control-base]`,job graph 一字不动;探针分支从该 base 切出因而继承它。
这个改动随删 ref 一起消失,**绝不进交付 PR** —— 交付前的自检见本文件末尾。

## 探针

| PR | 分支 | base | 内容 |
| -- | -- | -- | -- |
| **#948**(X) | `fly2045-probe-9101` | `fly2045-accept-base` | 新机制:加 `engineering/doc/milestones/FLY-9101.md` |
| **#949**(Y) | `fly2045-probe-9102` | `fly2045-accept-base` | 新机制:加 `engineering/doc/milestones/FLY-9102.md` |
| **#950**(对照 A) | `fly2045-control-9201` | `fly2045-control-base` | **旧机制**:在 `CLAUDE.md` 表头下加一行 |
| **#951**(对照 B) | `fly2045-control-9202` | `fly2045-control-base` | **旧机制**:同上 |

## 验收结果

### 步骤 2 —— 合并任何东西之前,四个都 MERGEABLE

```
#948  MERGEABLE  UNSTABLE  876b02d411a4387a8af4c64737fa159cbb76d52e
#949  MERGEABLE  UNSTABLE  e96d7caab591e6b8e4e0204f8e5db5c0d4b5798d
#950  MERGEABLE  UNSTABLE  9e4b14f450e7d6db62590fa3cf2dbb2682b56afd
#951  MERGEABLE  UNSTABLE  8d4e1fc777b92b5c5ee38dad5e775fc149569f7e
```

`UNSTABLE` = CI 正在跑。这本身就是台架 trigger 生效的第一个证据:没有它,这里会是没有任何 run。

### 步骤 3 —— 各合掉一个(**只进一次性 base,没碰 main**)

```
#948  MERGED  2026-08-25T14:26:30Z  merge commit 18190825dd6e88e4543cc7c42dd1b5e7bc331854
#950  MERGED  2026-08-25T14:26:33Z  merge commit d36b0a3709c111e581c306f462b22710a3c79ca7
```

### 步骤 4 —— ✅ 验收第 1 条,以及证明这把尺子有效

```
#949  MERGEABLE   UNSTABLE  e96d7caab591e6b8e4e0204f8e5db5c0d4b5798d   ← 新机制:另一条合了,它没事
#951  CONFLICTING DIRTY     8d4e1fc777b92b5c5ee38dad5e775fc149569f7e   ← 旧机制:另一条合了,它 DIRTY
```

**反向对照是这份证据里最重要的一格。** 如果 #951 也保持 MERGEABLE,那说明这个台架根本区分不出
DIRTY 与非 DIRTY,#949 的绿就是假绿、整份验收作废。它变红了,所以上面那格的绿是真的。

### 步骤 5 —— ✅ 验收第 3 条:QA 推报告不再跟 main 赛跑

在 #949 上再推一笔 QA 报告 commit(正是原来会「跟 main 赛跑」的那个动作):

```
new head        c455218a316265b99ce602feb42443a6f6f1bd52
#949            MERGEABLE  CLEAN        ← 不是 DIRTY,而且是 CLEAN
exact-head run  32859585210  event=pull_request  branch=fly2045-probe-9102
```

该 run 的最终结果:

```
$ gh run view 32859585210 --json status,conclusion,event,headBranch,headSha
completed  success  pull_request  fly2045-probe-9102  c455218a316265b99ce602feb42443a6f6f1bd52
```

✅ **exact-head `pull_request` run 被创建,且最终 success。**

**这一条要的不是「mergeable 还是 true」,而是「新 head 真的产生了它自己的 `pull_request` run」** ——
分支失去 CI 能力时,mergeable 可能仍是 true,但没有任何 run 会为这个 head 排队。

## 验收第 2 条(零丢失)

不在这份台架里,由 pin 链证明,可随时复跑:

```
$ bash scripts/fly2045-pin-archive.sh --check-only --source-sha 5a8fe51bfbf567c518dbdf536ee09afe7b805243
source 5a8fe51bf: lines 39..224, 177 ledger rows, 167009 bytes
  sha256 cd8798182939362ca374a2c837758155a9e34ef5bbf088701a60e2655c81f09b
archive matches the source block byte for byte
check-only: guard pins match the source
```

pin 的权威是 **source**:脚本先 `fetch`,断言传入 SHA **就是**当前 `origin/main` 且是 HEAD 祖先,
验证 block 完整(exact heading 定界 / 全文无遗漏行 / 块内只有账本行 / 严格分隔行),再逐字节 `cmp`,
**一致才**从 source 派生 sha256 + 字节数 + 行数三个 pin。拿搬完的结果给自己盖章只能证明「它和自己一致」。

## 清理

已合并的 PR **不能再 close**(GitHub 的 PR 记录也删不掉),所以:

- #948 / #950 保持 **MERGED** 作为证据;
- #949 / #951 **close**;
- 删除 6 条 ref:`fly2045-accept-base`、`fly2045-control-base`、`fly2045-probe-9101/9102`、
  `fly2045-control-9201/9202`。

### 清理确认(2026-08-25)

| 项 | 状态 |
| -- | -- |
| #948 / #950 | **MERGED**,保留作证据(已合并的 PR 无法 close) |
| #949 / #951 | **CLOSED** ✅ |
| 6 条本地分支 | **已删除** ✅ |
| 6 条 **remote** ref | ⛔ **未删除** —— 见下 |
| `origin/main` | 全程未动,仍是 `5a8fe51bf` ✅ |

⚠️ **remote ref 删不掉,而且我没有绕过它。** 本仓的 push-guard 钩子拒绝删除远端分支:

```
$ git push origin --delete fly2045-probe-9101
push-guard: refusing deletion of remote branch fly2045-probe-9101
error: failed to push some refs
```

绕过它(比如改走 `gh api` 直接删 ref)恰恰是这道守卫存在的理由,所以**没有绕**。

Tadashi 于 ask `aba95952` 逐条授权了 6 次 `FLYWHEEL_FORCE_PUSH_ACK`。**实测这条路走不通,而且不是格式问题:**

```
fly2045-accept-base  | DELETE FAILED rc=1 | 2026-08-25T14:35:57Z | push-guard: refusing deletion of remote branch fly2045-accept-base
fly2045-control-base | DELETE FAILED rc=1 | 2026-08-25T14:35:59Z | push-guard: refusing deletion of remote branch fly2045-control-base
fly2045-probe-9101   | DELETE FAILED rc=1 | 2026-08-25T14:36:02Z | push-guard: refusing deletion of remote branch fly2045-probe-9101
fly2045-probe-9102   | DELETE FAILED rc=1 | 2026-08-25T14:36:04Z | push-guard: refusing deletion of remote branch fly2045-probe-9102
fly2045-control-9201 | DELETE FAILED rc=1 | 2026-08-25T14:36:08Z | push-guard: refusing deletion of remote branch fly2045-control-9201
fly2045-control-9202 | DELETE FAILED rc=1 | 2026-08-25T14:36:10Z | push-guard: refusing deletion of remote branch fly2045-control-9202
```

钩子源码 `~/.flywheel/state/push-guard/hooks/pre-push:33` 写得很直白:

```sh
# Deletion is destructive and never authorized by the rewrite ACK.
if [ "$local_sha" = "$zero_sha" ]; then
        audit_attempt rejected ...
        printf 'push-guard: refusing deletion of remote branch %s\n' "$branch" >&2
        refused=1
        continue
fi
```

`FLYWHEEL_FORCE_PUSH_ACK` 的分支在**它下面**(第 46 行),只处理 **non-fast-forward 更新**;删除在到达
ACK 之前就 `continue` 掉了。**这个 ACK 从设计上就不是删除的授权路径**,不存在「写对格式就能过」的用法。
⇒ 已回报 Tadashi 改走「由他删除」。

**删除前的必查项(Lead 执行要求 ①),6 条全部通过**:head 与 base 两个方向都查过,**零 open PR**
(#948 / #950 已 MERGED,#949 / #951 已 CLOSED)。脚本另有显式 protected-ref 前置检查,
`main` 与交付分支 `flywheel-FLY-2045` 全程未被触碰(实测 `5a8fe51bf` / `ac79a6654` 未变)。

### 边界 ③ 收口(2026-08-25)

Tadashi 从 **Lead 主 checkout** 逐条删除了这 6 条 ref。他给的机制说明记在这里:
**push-guard 钩子只绑 runner worktree(`hooksPath` 作用域)**,Lead 主 checkout 的 push 走的是正门 ——
所以守卫的设计语义是「**runner 侧永不授权删除,删除动作上收到 Lead 路径**」,这次删除不是绕守卫。
(反过来说,`gh api` 直接删 ref 才是真绕:跳过钩子 + 丢掉 audit。)

**我独立复核过,不是照抄他的回报:**

```
$ git ls-remote --heads origin 'fly2045-*' | wc -l
0
$ git ls-remote --heads origin flywheel-FLY-2045   → c585f791d   (交付分支未动)
$ git ls-remote --heads origin main                → 5a8fe51bf   (main 未动)
#948 MERGED   #949 CLOSED   #950 MERGED   #951 CLOSED
```

✅ **Lead 边界 ③ 已完成。** 台架零残留;探针证据固化在两个 MERGED、两个 CLOSED 的 PR 记录与本文件里。

### 一条我先查后果、没有事后找补的记录

在 run 出结果**之前**,我先在本地把 rig 分支跑了一遍结构守卫,想知道台架自己改的 `pull_request.branches`
会不会把 `ci-structure` 打红 —— 那样红的就不是真信号。本地那次报了
`known CI-consumed doc path must remain tracked: doc/engineer/implementation/FLY-222-a0-a10-runbook.md`。
**真实 CI 里没有复现**(整个 run 零失败 job),所以那是我用 `git archive` 解到临时目录、缺少 git 上下文
造成的假阳性,不是台架的问题。记在这里是因为我是**先查的**,不是拿到结果再解释。

## 交付前自检

```
$ git diff origin/main...HEAD -- .github/workflows/ci.yml
```
必须**只**含 §5.3 的那一步 quick-gate step,**不含**台架的 `pull_request.branches` 扩写。

---

# 附录 A — 交卷后 main 前进了,cutover 重新裁了一次(2026-08-25,第二任体)

> 这一节是**在上面那份验收之后**发生的事。上面那份没有作废,但它绑定的
> `implementation_sha` 已经不是最终交付 head —— 差在哪、我为什么判它不影响那份验收的结论、
> 以及这个判断的**成色**,全部写在 A.4,请连着读。

## A.1 起因(两件,都是事实不是推测)

1. **老里程碑表又发作了两次。** 交卷后 founder 于 15:15–15:20 连合三单:
   #941(FLY-2027)、#943(FLY-2026)、#952(FLY-2046)。`origin/main` 从 `5a8fe51bf` 走到
   `6978e2ee9`,PR #947 随之 `CONFLICTING / DIRTY`。
   **更正一处派工里的数字**:新增的是 **2 行不是 3 行** —— #952(FLY-2046)是一份 QA 文档 PR,
   `git show 6978e2ee9 --stat` 只有两个 `engineering/doc/FLY-2046-*/` 文件,
   `grep -c FLY-2046` 对新 `CLAUDE.md` 为 **0**。所以可迁移的是 FLY-2027 与 FLY-2026 两条,
   FLY-2046 **没有里程碑行可迁**,我也没有替它凭空造一条(那会违反本单自己的单写者合同)。
2. **founder_gate 绑在一个幽灵 head 上。** `4358165f2`(`chore(progress): FLY-2045 implement 3/3`)
   是前任交卷后在本地生成、**从未 push** 的 progress commit:
   `git branch -a --contains 4358165f2` 为空,`git merge-base --is-ancestor 4358165f2 HEAD` 为 NO。
   origin 上当时的 head 是 `c45f3645d`。⇒ 卡永远等不到那个 head。
   **教训写在这里,因为它会重犯**:`flywheel-comm progress` 只在**本地**提交 progress.md,
   本次实测**没有 push**(`git ls-remote` 在 progress 之后仍是上一个 head)。
   ⇒ **申报的 head 必须先 `git ls-remote` 现问一次**,不能拿 `git rev-parse HEAD` 当申报值。

## A.2 做了什么

| 步骤 | 结果 |
| -- | -- |
| rebase 到 `origin/main@6978e2ee9` | 48 个 commit,**唯一冲突是 `CLAUDE.md`**;按 §7.2 的写法取 pointer-only 版本(整块丢弃,不试图保留那两行) |
| 冲突解完的**树级**核对 | `git diff origin/main -- CLAUDE.md` = **+8 / −188**。188 行 = 7 个空行 + 181 个表行(表头 + 分隔行 + **179** 条账本行);8 行加的全是指针段。**没有一行非表内容被删掉** |
| ARCHIVE 重新搬 | 哨兵之间换成 `6978e2ee9:CLAUDE.md` 第 39..226 行的**逐字节**内容 |
| pin 重新派生 | `bash scripts/fly2045-pin-archive.sh --source-sha 6978e2ee9...` → `179 ledger rows, 172521 bytes, sha256 220e060f...`,`archive matches the source block byte for byte`,pins written |
| per-issue 文件 | 新建 `FLY-2026.md` / `FLY-2027.md`,正文取自那两行**一字未改** |
| CLAUDE.md 账本行 | **零**(G2 实测) |

**pin 的权威仍然是 source,不是候选。** 脚本先 `fetch`,断言传入 SHA **就是**当前 `origin/main`
且是 HEAD 祖先,验证 block 结构完整(exact heading 定界 / 少抽 / 多抽 / 严格分隔行 / 逐行 canonical),
再逐字节 `cmp`,一致**才**盖章。拿搬完的结果给自己盖章只能证明「它和自己一致」。

**「179 条」这个数字有独立的第二个来源**,不是只由 pin 脚本自己说了算:
`git diff origin/main -- CLAUDE.md` 数出的删除行、以及 `cutover-merge-probe.sh` 的
`FLY2045_METRIC data_rows=179`,三处一致。

## A.3 阶段一 inventory —— 刷新到本次 push 时刻

`gh pr list --state open`(39 个)里改 `CLAUDE.md` 的 **5 条**(#941/#943 已合入,退出清单):

| PR | exact head | diff 形态 | pre-B disposition | 机械 fence 证据 |
| -- | -- | -- | -- | -- |
| #946 (FLY-2034) | `504494327` | `top-row writer` | `post-B-migrate-pending` | `git merge-tree --write-tree <head> <B候选>` **rc=1,`CLAUDE.md` 三个 stage 条目**(冲突) |
| #772 (FLY-1596) | `56983c1e1` | `top-row writer` | `post-B-migrate-pending` | 同上,rc=1 |
| #343 (FLY-531) | `ed77d4501` | `top-row writer` | `post-B-migrate-pending` | 同上,rc=1 |
| #338 (FLY-508) | `3d886d1f0` | `top-row writer` | `post-B-migrate-pending` | 同上,rc=1 |
| #216 (FLY-198) | `a1d546ba6` | **`historical-table refresh`** | `post-B-migrate-pending` | 同上,rc=1 —— §7.2 要求它**不得类推**,所以对它的 exact head 单独做了同样的三方证明 |

**零 `unrelated CLAUDE edit`**:逐条查过 5 个 PR 对 `CLAUDE.md` 的每一行增删,**全部**是
`| FLY-…` / `| GEO-…` 表行,没有任何一条改的是块外段落。所以这 5 条都落在 B 的机械 fence 之内。
(§7.2 特别点名 `unrelated CLAUDE edit` **不受** fence 保护;本次没有这一类,不是我略过了它。)

⚠️ 这 5 条**当前就已经是 `CONFLICTING / DIRTY`** —— 那是 #941/#943 合入造成的,不是 B 造成的。
两件事不要混:上表证明的是「B 落地后它们仍然合不进去」,靠的是对 **B 候选**做的三方合并,
不是引用 GitHub 现在显示的 DIRTY。

阶段一因此是**零未分类**。阶段二(逐条迁移 + 各取新守卫下的 exact-head green)按计划记在
Linear FLY-2045 的 disposition ledger 评论里,**不在本文件**。

## A.4 §6 真 PR 台架的绑定已经失效 —— 未重跑,**Lead 已裁定**

> **裁定(Tadashi / flywheel-eng-lead,2026-08-25):不重跑真 PR 台架。**
> 依据(他的原话要点):§6 证的是**机制**性质(含反向对照),rebase 未改机制;per-head 守护由
> 守卫全绿 + `cutover-merge-probe` + 5 条 open PR 的 `merge-tree` 逐条分类覆盖;
> FLY-2046 独立 QA 的 **F3 已认证 `merge-tree` 为台架等价复核路径**。
> 配套两条已在本 PR 内落地:① `plan.md` §7.2(4) 与 §10 回跳规则改为
> 「main 前进 ⇒ merge-tree 等价复验;真 PR 台架仅**机制变更**时重跑」(plan 升 v19);
> ② PR body 如实记录本次偏离与裁定依据。
>
> **下面这一节保留原样**(裁定之前我写的),因为它是提交给 Lead 的那份可证伪材料本身;
> 我没有在拿到裁定后回头把它改成事后诸葛。

计划 §7.2(4) 与 §10 的回跳规则写得很清楚:**main 前进 ⇒ 重跑 §6**。我**没有重跑**,理由和成色如下,
请把它当成一个需要裁定的口子,不要当成已经关掉的门。

**事实:绑定确实断了。** 上面那份验收把 `fly2045-accept-base` 的 parent 密码学绑定到
`implementation_sha = 25e072c768b176a3e148b40190f8f4d78d67358b`。最终交付 head 已不是它。

**这段时间里,本单自己的实现变了什么**(`git diff 25e072c76 HEAD -- <本单实现面>`,逐条列出):

| 文件 | 变化 | 是不是逻辑改动 |
| -- | -- | -- |
| `fly2045-milestone-layout.test.sh` | 三个 pin 字面量 `cd879818…/167009/177` → `220e060f…/172521/179` | **否** —— 只有常量,零分支/零谓词改动 |
| `fly2045-pin-archive.sh` | 两处注释里的 `177 real rows` → `179` | **否** —— 纯注释 |
| `ARCHIVE-pre-FLY-2045.md` | 哨兵内多了 2 行;头部加了出处说明 | 数据,不是代码 |
| `CLAUDE.md` / `README.md` / `FLY-2045.md` | `177`→`179`、字节数/占比更新、cutover 例外说明 | 散文 |
| `FLY-2026.md` / `FLY-2027.md` | 新增两个 per-issue 文件 | 数据 |

`git diff` 全文见 commit `2ea88b572`。**没有一处 guard / writer / layout / workflow 的逻辑改动。**

**我的判断**:§6 台架证的那条性质是「两个 PR 各建**不同路径**的文件 ⇒ 没有可冲突的对象」,
它是**布局**的函数,不是 pin 值的函数;上面这些改动一处都没碰布局。所以我判那份验收的**结论**仍成立。

**这个判断的成色,老实说:**
- ✅ 已验:实现面 diff 逐文件看过,零逻辑改动(上表);
- ✅ 已验:新 head 上 `cutover-merge-probe.sh` 用**新 source** 复跑,三格全中(B 冲突 / A 干净 / 控制组冲突),
  这是同一条性质的**本地三方合并**证明;
- ⛔ **未验**:新 head 上**没有**真 PR 级的证明。probe 是 `git merge-tree`,不是 GitHub 的 mergeable 计算;
  §6 之所以是硬门,正是因为它测的是 GitHub 那一侧。**我没有用 probe 顶替它,只是说明缺口在哪。**

**为什么没重跑**:重跑 §6 要新建 4 个探针 PR + 2 条一次性 base,共 6 条远端 ref;而
push-guard 在 `pre-push:33` 就拒绝 runner 侧的任何远端删除(`FLYWHEEL_FORCE_PUSH_ACK` 的分支在
第 46 行,根本到不了),上一轮的 6 条 ref 是 **Tadashi 从 Lead 主 checkout 删掉的**。
再跑一次 = 再欠 Lead 一次删除。派工的六条里也没有列 §6 重跑。
⇒ **我按派工执行,并把这个偏离当场报给了 Tadashi**(`flywheel-comm ask`),没有自己把门降级。
若 Lead 判定必须重跑,台架脚本与流程都在 §6,可以原样再跑一遍,只需要他再兜一次 ref 删除。

**——(以上为提交时的原文)——**

**后续**:Tadashi 裁定不重跑(见本节顶部方框)。**这条口径有边界,别引用过头**:
`merge-tree` 是 **git 侧**的三方合并,不是 GitHub 自己算 mergeable 的那一侧;它等价复核的是**机制**,
所以「仅机制变更时重跑」里的**机制变更**是承重触发条件 —— 布局 / writer / guard 谓词 / workflow
任一有逻辑改动都必须重跑 §6,pin 字面量与数据/散文不触发。已写进 `plan.md` §7.2(4)。

## A.5 本次在新 head 上跑过的验证

| 检查 | 结果 |
| -- | -- |
| `fly2045-milestone-layout.test.sh` | **32/32**,0 fail |
| `fly2045-milestone-layout-mutations.test.sh` | **27/27**,all fixtures held |
| `ci-structure.test.sh` | PASS(含 §5.3 的 FLY-2045 quick-gate 结构断言) |
| `ci-shell-suite-enumeration.test.sh` | PASS —— 217 个 shell suite 全部显式分类(164 CI / 53 manual-only) |
| `fly1674-residue.test.sh` | **59/0** |
| `fly1680-v1-extinction.test.sh` | **7/0** |
| `cutover-merge-probe.sh --source-sha 6978e2ee9…` | `PROBE OK`,`data_rows=179` |
| `git diff origin/main -- .github/workflows/ci.yml` | **只**含 §5.3 那一步 quick-gate step;**不含**台架的 `pull_request.branches` 扩写(§10 步骤 17 自检通过) |

**`fly1674-residue` 从 62/0 变成 59/0,原因是机械的,不是回归**:D12 无条件删掉了 3 条
`CLAUDE.md|…` exemption,而 `:85-93` 的 liveness 循环**每条 entry 恰好产出 1 个 PASS**
(源码已核),62 − 3 = 59。零 FAIL。

**没在本机跑的**(说清楚,不冒充跑过):`pnpm lint` / `pnpm -r build` / `pnpm test:packages:run`。
本 worktree 没有 `node_modules`,而 `git diff --name-only origin/main...HEAD` **零个** `.ts` /
`.js` / `package.json` —— 交付面只有 `.md`、`.sh`、`.txt` 和 `ci.yml` 一步。这三门由 PR CI 覆盖,
不由我在本机的一次运行代表。

## A.6 台架残留(复核,不是引用上一轮的结论)

```
$ git ls-remote --heads origin 'fly2045-*' | wc -l
0
```

本轮为做 fence 证明拉过 5 条**本地** ref `refs/fly2045-inv/pr-*`,用完已 `git update-ref -d` 删除,
**没有创建任何远端 ref**,因此不欠 Lead 任何删除动作。

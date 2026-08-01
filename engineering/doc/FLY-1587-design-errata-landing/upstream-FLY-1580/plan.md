# FLY-1580 design.md 两处更正 + 同步回 1569 — 实施计划

Issue: FLY-1580 (https://linear.app/geoforge3d/issue/FLY-1580/设计勘误-designmd-两处更正-同步回-1569-issue-正文)
日期: 2026-07-31
基于: research.md

## 0. 这份计划怎么用

本节点是 **no-write**(不许改共享分支/提交/push/开 PR),所以下面的 patch **没有落地**。
执行节点照 §1→§5 顺序走即可,每一步都是可逐字复制的 —— **不需要再做任何措辞判断**,判断已经在 exploration.md §5 拍完。

零代码改动:不碰 `packages/`、不建表、不改 schema、不跑 build/test(没有可跑的)。

## 1. 落地顺序(两处必须成套落地,但**跨系统不是原子**)

```
0. 钉死 diff 基线(⚠️ 本地 main 是错的)              (§4 第 0 步)
1. 改 doc/messaging-rework/design.md 两处            (§2)
2. 本地核验:2 hunk + scope 干净 + 旧口径归零         (§4 第 1–3 步)
3. stage 两类文件(过程文档随 PR 进 main = Lead 已裁决)  (§4 第 2 步)
4. commit → push → 开 PR,描述贴两组 before/after     (§4 第 4 步 + §5 阶段一)
5. PR 合进 main 之后 —— 立刻改 FLY-1569 正文          (§3.1)
6. 实跑「恰好三个 hunk」diff 复核                     (§4 第 5 步)
7. 回填 PR 描述:diff 实跑结果 + Linear 已同步         (§5 阶段二)
```

⚠️ **第 5 步(改 FLY-1569)的时机是硬要求,不能提前。** FLY-1580 允许「同一个 PR 里(或紧随其后)」。若在 design.md 合上 main 之前就改 FLY-1569 正文,「两边各说各话」不但没消除,还调了个头(issue 新 / main 旧)—— 那正是这单存在的理由所反对的状态。

⚠️ **第 5 步不能漏。** 只合 PR 不改 issue = 这单只做了一半,验收标准第 2 条不成立。

⚠️ **别把它当原子操作。** 跨 git 和 Linear 两个系统,merge 与 Linear save 之间必然有一段短暂不一致 —— 这是可接受的(方向对:main 先新,issue 随后追上),但**不能因此省掉第 6 步的实跑复核**。若第 5 步的 Linear patch 失败或第 6 步 diff 对不上:**保持 FLY-1580 未完成并上报**,不许预写「已同步」或宣布收工。

## 2. design.md 两处改动(逐字 patch)

文件:`doc/messaging-rework/design.md`

### 2.1 更正② —— 粒度分层块,插到 §3 开头

锚点唯一性已实测(research.md §2)。

**old_string:**

````
## 3. 两张表的状态机

### 📮 mailbox —— 只答「送到没送到」
````

**new_string:**

`````
## 3. 两张表的状态机

````
两层不同粒度,不要混:

📮 mailbox 层 = 批级
   投递、ack、租约、重投,全部按批
   一批的所有消息一起 QUEUED → LEASED → ACKED
   没有「部分 ack」这个状态 ⇒ 租约到期时【整批重投】
   in-flight 上限 3 批,也按批算

📋 task 层 = 逐条
   一批 3 条信 → 在 ack 的同一个事务里建 3 条独立 task
   因为【合批不是折叠】,每条信仍是独立的义务

⇒ 第 3 节那个状态机应读作「一批的状态」,不是「一条的状态」。
````

### 📮 mailbox —— 只答「送到没送到」
`````

> ⚠️ **上面 new_string 里那对 4 反引号(````)在落地时要写成 3 反引号(```)。** 本计划文件为了能把围栏嵌进围栏才升到 4 个。块内文字一个字符都不要动。

### 2.2 更正① —— 死信聚合窗口,替换 §6 末尾那句

**old_string:**

````
Lead 收到就是一封普通的信,走同一套流程。**一个死掉的 runner 最多产生一封死信,不是无限条。**
````

**new_string:**

`````
Lead 收到就是一封普通的信,走同一套流程。

````
同一个收件人的死信按【聚合窗口】打包:
距上一封死信通知 >= 30 分钟才发下一封;窗口内新增的死信并入下一封。
⇒ 既不会「永远只发一封,后续全丢」,也不会「每轮一封刷屏」。

(前提:收件人已 terminal 之后,新到的信【立刻】进 DEAD ——
 见本节规则二,所以不存在「投给死 runner 又走到死信」的情况)
````
`````

> 同上:落地写 3 反引号。
> `见本节规则二` 那行**行首保留 1 个空格**(悬挂对齐 `(前提:`),这是有意的,别当成多余空白删掉(research.md §4)。
> 前半句 `Lead 收到就是一封普通的信,走同一套流程。` **保留**,只替换它后面那句加粗。

### 2.3 不改的东西(逐条确认)

* ❌ README.md —— 无口径冲突(research.md §2 半径核过)
* ❌ 文末附录 —— 两边同步改 ⇒ 改动不进 diff ⇒ 附录一个字都不用动(research.md §3)
* ❌ §3 mailbox 表 `DEAD` 行、§4 步骤 1、§5、§8 —— 一致性已逐条核过(research.md §5),无需跟改
* ❌ 中文标点规范化 —— 附录明写「未做任何中文标点规范化」,继续保持

## 3. Linear 同步

### 3.1 FLY-1569 正文(必做,PR 合入之后)

用 `mcp__linear-api__save_issue`,`id: "FLY-1569"`,**只传 `patch`,不传 `description`**(传整篇有覆盖掉别处的风险)。

两个 op 与 §2.1 / §2.2 的字符串**完全相同** —— 这正是「恰好三个 hunk」不变量得以保住的机制(research.md §3)。

```
patch: [
  { op: "replace",
    old_string: "## 3. 两张表的状态机\n\n### 📮 mailbox —— 只答「送到没送到」",
    new_string: <§2.1 的 new_string,3 反引号版> },
  { op: "replace",
    old_string: "Lead 收到就是一封普通的信,走同一套流程。**一个死掉的 runner 最多产生一封死信,不是无限条。**",
    new_string: <§2.2 的 new_string,3 反引号版> }
]
```

`patch` 是原子的(一个 op 匹配失败整次 save 回滚),两个锚点都已核过唯一性 ⇒ 安全。

**注意 FLY-1569 状态是 Done。** 只改正文,**不要动 status / labels / assignee**。

### 3.2 FLY-1580 本单

落地后正常走 issue 状态流转,由 DAG / Lead 处理,本计划不指定。

### 3.3 FLY-1573(D)—— 🛑 **Lead 自己改,implement 节点一个字都不要碰**

FLY-1573 正文两处仍是旧口径且写成硬验收(exploration.md §3)。已发 `ask`(`69bd7068`),**Lead 已回复,裁决如下:**

* **「1573 的正文我自己去改 —— 我有 Linear 写权限,现在就改,你不要重复做,免得两边打架。你只管 design.md 那两处。」**
* **「不用纳进本单范围。」** 但 Lead 采纳了这条提醒的实质:**「我把 1573 加进封锁名单,勘误合并前不派。」**

⇒ **本单对 FLY-1573 零动作。** 不 `save_issue`、不改正文、不改验收标准。上一版这里备着的 patch 已**作废删除** —— 留着只会诱导 implement 节点去重复执行,和 Lead 的改动撞车。

⇒ 封锁名单从 **E/F/G** 扩为 **D/E/F/G**(D = FLY-1573),由 Lead 维护。

## 4. 验证(全部为文档核对,无测试可跑)

### 第 0 步 —— 先钉死 diff 基线(⚠️ 本地 `main` 是错的,别用它)

**不要写 `git diff main`。** 本工作树的本地 `main` 落后一提交(实测):

```
本地 main          12f68c7df7fadd699d84b3114f7f874e9bfaf655   ← 还没有 design.md
HEAD / origin/main ab2ec6b2154adb34fbf093df159e95edf274b684   ← #742,design.md 在这里
```

用 `git diff main` 会把 design.md **整篇当成新增文件**,「恰好 2 个 hunk」立刻假失败 —— 而且是那种看起来像自己改错了的假失败,很容易被误当成手滑去回退。

**整段必须一次性跑完**(设计评审 R2 实跑抓出三个真坑,见本步末尾):

```bash
set -euo pipefail

# 1) fetch 必须 fail-closed —— 拉不到就停,不许拿陈旧的 remote-tracking ref 冒充
git fetch origin main

# 2) 基线取 merge-base,不是 remote tip
BASE=$(git merge-base HEAD origin/main)

# 3) 断言 #742(design.md 落地那次)确实在基线里
git merge-base --is-ancestor ab2ec6b2154adb34fbf093df159e95edf274b684 "$BASE"

echo "BASE=$BASE"
```

⚠️ **`$BASE` 是 shell 变量,跨命令调用不保留。** 下一次独立执行时它是空的,`git diff "$BASE"` 直接 `fatal: bad revision ''`(设计评审 R3 在 fresh shell 逐字实测:exit 128)。

⇒ **后面每个代码块都是自包含的**,块首都重新算一遍 BASE 并重跑断言。**照抄整块,不要只抄末尾那条命令。**

> **这三条都是设计评审 R2 实跑我上一版命令抓出来的真坑,不是理论风险:**
> 1. 原写法 `git fetch origin main` 单独一行、不在 `&&` 链里 —— 实测环境报 `cannot open '.../FETCH_HEAD': Operation not permitted`,脚本**照样打印 `BASE=...` 并退出 0**。fail-open,拿的是可能陈旧的 remote-tracking ref。
> 2. 原写法末尾 `|| { echo "..."; }` 返回 0 —— 所谓「停下来」根本没停。
> 3. 原写法 `BASE=$(git rev-parse origin/main)` 固定的是**远端 tip**;main 若在执行期间前进,两点 diff 会把 upstream 的无关改动也算进来,scope 检查跟着假红。
>
> 若本执行环境**确实 fetch 不了**:不要绕过,**停下来上报**。真要在离线下先做本地核对,可以临时用 `BASE=ab2ec6b2154adb34fbf093df159e95edf274b684`(当前分支未 rebase,它就是本地 diff 的正确基线)—— 但**「远端 freshness」和「本地 diff 正确」是两项独立证据,不许用一条命令混着算**,PR 前必须补上真 fetch。

> **已知的一种 fetch 失败(设计评审沙箱里实测到,implement 节点可能撞上同一个):**
> ```
> error: cannot open '.../FETCH_HEAD': Operation not permitted
> ```
> 根因是**共享 gitdir 没有写权限** —— 本工作树的 git 目录在 `/Users/xiaorongli/Dev/flywheel/.git/worktrees/flywheel-FLY-1580/`。
> 第 0 步是**硬门**,fetch 不过整条链走不到 commit/PR。撞上这个 = 换一个**对该目录有写权限、且有网络**的执行者来跑,**不是**去把 freshness 检查绕掉。

### 第 1 步 —— design.md 的 diff 恰好两个 hunk(验收标准 3)

```bash
set -euo pipefail
BASE=$(git merge-base HEAD origin/main)
git merge-base --is-ancestor ab2ec6b2154adb34fbf093df159e95edf274b684 "$BASE"

git diff "$BASE" -- doc/messaging-rework/design.md
```

预期:**恰好 2 个 hunk**,分别在 §3 开头和 §6 末尾。出现第 3 个 hunk = 手滑了,回退重来。

### 第 2 步 —— PR 里不许出现第三类文件

⚠️ **`git diff --name-only` 看不见未跟踪文件**,单靠它证明不了 scope 干净(本单的过程文档现在全是未跟踪状态)。必须两条一起查:

```bash
set -euo pipefail
BASE=$(git merge-base HEAD origin/main)
git merge-base --is-ancestor ab2ec6b2154adb34fbf093df159e95edf274b684 "$BASE"

git diff "$BASE" --name-only              # 已跟踪的改动
git status --short --untracked-files=all  # 未跟踪的新文件
```

**`doc/messaging-rework/design.md` 必然在内。** 除它之外,只可能出现 `engineering/doc/FLY-1580-design-errata-sync/` 下的四份过程文档(exploration / research / plan / progress)。

**出现任何第三类文件 = 停下来**,尤其 `packages/` 下的任何东西(本单零代码)。

#### ✅ 过程文档进 PR —— Lead 已裁决,而且是**必须**,不是「可以」

曾经悬而未决(DOC-FLOW「docs 随 PR 合 main」 vs 验收标准 3「diff 只有这两处」)。已发 `ask`(`872d9606`),**Lead 回复 A,并把它定成硬约束:**

* **「过程文档必须随 PR 进 main,不许合并后再补。」**
* 理由不是格式洁癖,是**自托管的硬约束**:**main 检出必须保持单写者干净**,否则 updater 的 `git pull --ff-only` 和回滚会坏。合并后再往 main 补文档 = 在生产检出上制造脏状态。
* 关于验收标准 3:**「是我的验收标准 3 写得糙……我写『diff 只有这两处』时想说的是『design.md 的实质改动只有这两处』,不是『整个 PR 只准有一个文件』。」**

⇒ **stage 两类文件,没有第二个选项:**

```bash
git add -- doc/messaging-rework/design.md engineering/doc/FLY-1580-design-errata-sync/
```

⇒ **绝不允许**「先只合 design.md,过程文档以后再补一个 PR」—— 那正是 Lead 点名禁止的、会弄脏生产检出的做法。

`git add` 一律用**显式路径**,禁 `git add -A` / `git add .`。stage 后立刻核对:

```bash
git diff --cached --name-only    # 逐行核对,必须等于上面选定的那一套
```

### 第 3 步 —— 旧口径归零 + 新口径落位

```bash
grep -rn "最多产生一封死信" doc/          # 预期:无输出
grep -n "聚合窗口" doc/messaging-rework/design.md   # 预期:命中 §6
grep -n "两层不同粒度" doc/messaging-rework/design.md # 预期:命中 §3
```

### 第 4 步 —— 发布链:commit → push → 开 PR(每步都带验证)

⚠️ 上一版 plan 从 `git add` 直接跳到「开 PR」,中间三步没写 —— **cached 检查证明不了最终推上去的 PR head 没夹带分支上已有的其他 commit**(设计评审 R2)。补齐:

先把 §5 阶段一的描述写成一个真文件(`gh pr create` 要用它,别用 `<(...)` 这种没法复核的写法):

```bash
PR_BODY=engineering/doc/FLY-1580-design-errata-sync/.pr-body.md   # 临时文件,别 git add
# 按 §5 阶段一逐条写进去,写完自己读一遍确认 Scope decision 段在
```

然后**整链一个块跑完**:

```bash
set -euo pipefail
BASE=$(git merge-base HEAD origin/main)
git merge-base --is-ancestor ab2ec6b2154adb34fbf093df159e95edf274b684 "$BASE"

# 0) 分支硬断言 —— 名字对不上会在远端建野分支
test "$(git branch --show-current)" = "flywheel-FLY-1580"

# 1) commit / push:任一步失败立即退出(set -e),绝不带着旧 HEAD 往下走
git commit -m "FLY-1580: design.md 两处设计更正 + 同步回 FLY-1569 正文(零代码)"
git push -u origin flywheel-FLY-1580

# 2) 断言远端真的收到了这次 push
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/flywheel-FLY-1580)"

# 3) 用 PR 的真实两点范围复验 —— 不是看工作区、也不是看 cached
git diff "$BASE"..HEAD --name-only                        # 必须等于 §4 第 2 步选定的文件集合
git diff "$BASE"..HEAD -- doc/messaging-rework/design.md  # 必须仍是恰好 2 个 hunk
```

上面全绿再开 PR,并**立刻用真实 PR diff 复核一遍**:

```bash
set -euo pipefail
PR_URL=$(gh pr create --base main \
  --title "FLY-1580: design.md 两处设计更正 + 同步回 FLY-1569 正文(零代码)" \
  --body-file engineering/doc/FLY-1580-design-errata-sync/.pr-body.md)
echo "PR: $PR_URL"

gh pr diff "$PR_URL" --name-only                          # 必须等于上面第 3 步的文件集合

# ⚠️ gh pr diff 不接受 pathspec(实测 `gh pr diff --help`:只有 --color/--name-only/--patch/--web)。
#    整份 patch 落到临时文件,再从中切出 design.md 那段并断言 hunk 数 == 2。
PR_DIFF=$(mktemp)
trap 'rm -f "$PR_DIFF"' EXIT
gh pr diff "$PR_URL" --patch > "$PR_DIFF"

awk '
  /^diff --git / {
    in_design = ($0 == "diff --git a/doc/messaging-rework/design.md b/doc/messaging-rework/design.md")
  }
  in_design {
    print                       # 打出来供逐条肉眼核对
    if ($0 ~ /^@@/) hunks++
  }
  END { if (hunks != 2) exit 1 }
' "$PR_DIFF"
```

⚠️ **`gh pr create` 之前那个 `set -euo pipefail` 块任一条失败 = 停下来查,不要开 PR。** 上一版这两段没有 `set -e` 也没有 `&&` 链 —— 设计评审 R3 用一个无副作用 shim 让 `git commit` 返回 1,脚本**照样往下 push、跑完两次 diff、最后 exit 0**,真实执行时就会拿旧 HEAD 开 PR。

真实 PR diff 与本地两点 diff 对不上 = 分支上夹带了别的 commit,**停下来查,不要合**。

完事把 `.pr-body.md` 删掉(它是临时文件,不进仓库)。

### 第 5 步 —— 「恰好三个 hunk」不变量复核(⚠️ 必跑,PR 合入 + issue 改完之后)

这是 design.md 附录自己给的核对方法,本单必须证明它**改完仍然成立**,否则附录变成假话:

1. 从 Linear 取 FLY-1569 正文,截「`## 0. 背景与病因`」到结尾,存成文件
2. 取 main 上的 design.md,截「`## 0. 背景与病因`」到「`## 附录`」之前,存成文件
3. `diff` 两者

**预期:恰好三个 hunk** —— 即附录列的那三条(`<b>` 标签、`****` 星号、§10 导航指针),**一个不多**。

多出第 4 个 hunk ⇒ 两侧落地文本不逐字节相同,**必须修到一致再收工**。

> 本节点没做这步:手上没有可用的 Linear API key 做 shell 侧 diff(`~/.flywheel/.env` 只有 `LINEAR_WORKSPACE_SLUG`)。锚点一致性是对 MCP 取回的 issue 正文 JSON 逐字比对确认的,**不是** diff 测出来的 —— 所以这步是执行节点的硬账,不能省。

### 第 6 步 —— 渲染核对

GitHub 上打开 PR 里的 design.md,确认两个围栏块正常渲染,emoji(📮/📋)、箭头(→ ⇒)、【】、悬挂缩进都在。

## 5. PR 描述骨架(验收标准 4 要求贴 before/after)

标题:`FLY-1580: design.md 两处设计更正 + 同步回 FLY-1569 正文(零代码)`

⚠️ **PR 描述必须分两阶段写。** 验收标准 4 要的 before/after 开 PR 时就能写;但「三个 hunk 实跑结果」和「FLY-1569 已同步」按 §1 的顺序**只能在 PR 合入之后才存在** —— 开 PR 时把它们写成既成事实就是编造。

### 阶段一 —— 开 PR 时写

* **为什么** —— design.md 是 7 个实施单的权威参照,落地的是 1569 的冻结版;两处更正没进去,E/F/G(以及 D,见下)的 runner 会照着已知不准确的版本写代码。这撞上 design.md 自己写的规矩。
* **更正① before/after** —— 逐字贴 §6 那句的原文和新块
* **更正② before/after** —— 贴「§3 开头新增」和新块;并说明**为什么选 §3 开头而不是 §4 末尾**(§4 最后一个子节是 `### in-flight 上限为什么是 3 不是 1`,块贴过去会落进那个子节内部)
* **不变量声明(写成待验证,不是写成已验证)** —— 两处改动在 design.md 和 FLY-1569 正文**逐字节相同** ⇒ 附录那条「diff 恰好三个 hunk」**预期**仍然成立;附录未改。标注「实跑结果 merge 后回填」。
* **Linear 同步状态** —— 明确标 `pending post-merge`,并写明为什么必须等(§1)。**FLY-1573 由 Lead 本人改,本 PR 不碰**(§3.3)。
* **`Scope: 过程文档随 PR 合入(Lead 已裁决)`(必填)** —— 写清这不是执行者自选:
  - Lead 回 `ask 872d9606`:**A,且是「必须」不是「可以」** —— 过程文档必须随 PR 进 main,不许合并后再补
  - 原因:**main 检出必须保持单写者干净**,否则自托管 updater 的 `git pull --ff-only` 和回滚会坏
  - 验收标准 3 的权威解读(Lead 原话):**「design.md 的实质改动只有这两处」**,不是「整个 PR 只准有一个文件」

  > 这一段留在 PR 描述里是为了让后来人不用重新纠结一遍 —— 这个问题已经被裁决过了。
* **审计发现(必须写进去)** —— FLY-1580 说更正「只活在 FLY-1573 里」不成立:FLY-1573 正文和评论都没有,它反而带着旧口径的硬验收;权威原文只在 FLY-1580 自己正文里。连带指出 **D(FLY-1573)比 E/F/G 更急** —— 死信闸正是 D 实现的,而 D 原本不在封锁名单里。**Lead 已确认并处理:1573 正文他本人改,封锁名单扩为 D/E/F/G。**
* **Linear Issue** 段:`FLY-1580` + URL

### 阶段二 —— merge 之后立刻回填(编辑已合并的 PR 描述)

1. 执行 §3.1 的 Linear patch
2. **重新读一遍** FLY-1569 正文(不要信 save 的返回,要复读)
3. 跑 §4 第 5 步的三-hunk diff
4. 把两项真实结果填回 PR 描述:实跑的 hunk 数 + FLY-1569 链接与同步时间

任一步失败 ⇒ **FLY-1580 保持未完成并上报**,不许把 pending 字样删掉。

## 6. 风险与已知边界

| 风险 | 处置 |
| -- | -- |
| 只改 design.md 忘了改 FLY-1569 | §1 第 5 步写成硬要求;§4 第 5 步的 diff 会直接暴露;§5 阶段二不许删 pending 字样 |
| 两侧文本差一个字符 → 附录「三个 hunk」失效 | §4 第 5 步实跑 diff 兜底;patch 用同一份字符串是根本保证 |
| **拿本地 `main` 当基线 → 假失败**(design.md 显示成整篇新增) | §4 第 0 步 fail-closed fetch + `BASE=$(git merge-base HEAD origin/main)` + `#742` ancestor 断言;全程不用 `main` 这个名字,**也不用 remote tip** |
| **`$BASE` 跨命令丢失 → `fatal: bad revision ''`** | §4 每个代码块都自包含:块首 `set -euo pipefail` + 重算 BASE + 重跑断言 |
| **commit/push 失败却继续开 PR**(拿旧 HEAD) | §4 第 4 步整链一个 `set -euo pipefail` 块 + push 后断言 `HEAD == origin/<branch>` |
| 未跟踪文件混进 PR(`--name-only` 看不见它们) | §4 第 2 步双查 + 显式路径 `git add`,禁 `git add -A` |
| 剥缩进剥错(把 `见本节规则二` 的悬挂空格也删了) | §2.2 显式标注保留 1 空格 |
| 围栏反引号数弄错(本计划用 4 个) | §2.1 / §2.2 各加了醒目提示 |
| D(FLY-1573)带着旧硬验收被派工 | ✅ 已闭环:Lead 本人改 1573 正文 + 把 D 加进封锁名单(勘误合并前不派)。**implement 节点不要碰 1573**,否则和 Lead 撞车 |
| FLY-1569 是 Done 状态,误改 status | §3.1 明写只传 `patch`,不动 status/labels |

**已知不处理(两条,都留给 D,本单一律不补 —— FLY-1580 明禁改其他部分):**

1. 块② 没交叉说明「整批重投时 `retry_count` 按批加一次还是批内每行各加一次」(research.md §5)。
2. 块① 的「前提」是一条**新增规范**而非对 §6 规则二的转述 —— 规则二带「到期 +」前置,块① 是入队即判。**D 必须在 enqueue / 投递准入侧也加 recipient-terminal 快速通道,只在 lease expiry 链里查是不够的。** 详见 research.md §5 专条(设计评审抓出)。

两条都按 design.md 自己的规矩办:D 若需要写进文档,先改 design.md、同步回 issue、再改代码。

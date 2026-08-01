# FLY-1587 承接 1580 落地 design.md 两处更正 — 调研

Issue: FLY-1587 (https://linear.app/geoforge3d/issue/FLY-1587/承接-1580-落地-designmd-两处更正-同步回-1569-正文patch-已逐字写好)
日期: 2026-07-31
基于: exploration.md(上游调研见 `upstream-FLY-1580/research.md`)

## 1. 本单只做「复核」,不做「重新调研」

上游 `research.md` 已经把权威原文来源、锚点唯一性、三-hunk 不变量、与各节的一致性全部核过一遍。本单的调研职责收缩为:**在本工作树上实测复核那几条前提仍然成立**,因为距上游调研已经过了一次 DAG 搁浅 + 一次 worktree 切换。

## 2. 复核结果(本工作树实测,2026-07-31)

| 复核项 | 命令 | 结果 |
| -- | -- | -- |
| 分支 | `git branch --show-current` | `flywheel-FLY-1587` |
| HEAD | `git rev-parse HEAD` | `ab2ec6b2154adb34fbf093df159e95edf274b684` |
| 工作树初始状态 | `git status --short -uall` | 空(干净) |
| 目标文件存在 | `ls doc/messaging-rework/` | `design.md` + `README.md` |
| 锚点 A 唯一性 | `grep -c "^## 3. 两张表的状态机$"` | **1** |
| 锚点 A 唯一性 | `grep -c "^### 📮 mailbox —— 只答「送到没送到」$"` | **1** |
| 锚点 B 唯一性 + 血缘半径 | `grep -rn "最多产生一封死信" doc/` | **1**(`design.md:156`),README.md 不含 |

⇒ 上游给的两个 `replace` 锚点在本工作树上**仍然唯一**,patch 可安全落地。

## 3. diff 基线:本工作树的 `main` 不能用

上游 plan §4 第 0 步指出本地 `main` 落后。本工作树实测同样成立 —— **`git diff main` 会把 design.md 整篇当成新增文件**,「恰好 2 个 hunk」立刻假失败。

正确基线(fail-closed,整段一次跑完):

```bash
set -euo pipefail
git fetch origin main                                    # 拉不到就停,不许拿陈旧 remote-tracking ref
BASE=$(git merge-base HEAD origin/main)                  # merge-base,不是 remote tip
git merge-base --is-ancestor ab2ec6b2154adb34fbf093df159e95edf274b684 "$BASE"   # #742 必须在基线里
echo "BASE=$BASE"
```

**本单实跑结果:** fetch 成功(上游担心的 `FETCH_HEAD: Operation not permitted` 权限坑**没有**在本工作树复现),`BASE=ab2ec6b2154adb34fbf093df159e95edf274b684`,ancestor 断言通过。

⚠️ `$BASE` 是 shell 变量,跨命令调用不保留 ⇒ 后面每个验证块都自包含,块首重算 BASE 并重跑断言。

## 4. 落地文本的两处格式细节(必须保住)

1. **围栏反引号数** —— 上游 plan.md 为了把围栏嵌进围栏用了 4 个反引号(````),**落地时是 3 个**(```)。已按 3 个落地。
2. **悬挂缩进** —— `见本节规则二` 那行**行首保留 1 个空格**(悬挂对齐上一行的 `(前提:`),是有意的,不是多余空白。已实测保住:

```
$ grep -n "^ 见本节规则二" doc/messaging-rework/design.md
180: 见本节规则二,所以不存在「投给死 runner 又走到死信」的情况)
```

## 5. 三-hunk 不变量:为什么本单能保住它

design.md 文末附录声明:从 Linear 取 FLY-1569 正文截「`## 0. 背景与病因`」到结尾,与 design.md 同段落 diff,**预期恰好三个 hunk**(`<b>` 标签、`****` 星号、§10 导航指针)。

保法是**构造性**的:两处更正的落地文本在 design.md 和 FLY-1569 两侧**逐字节相同** —— Linear patch 用的 `new_string` 与 design.md 落地文本是同一份字符串 ⇒ 相同改动同时打在 diff 两边 ⇒ 不产生新 hunk。

⚠️ **构造性保证 ≠ 已验证。** 这步是本单的硬账,必须在「PR 合入 + issue 改完」之后**实跑**(plan.md §4 第 5 步)。多出第 4 个 hunk ⇒ 两侧文本不一致,必须修到一致再收工。

### ✅ 上游那条「没有 Linear API key」的阻碍不成立 —— 本单已解除

上游 research §2 结尾写:「本节点没有可用的 Linear API key 做 shell 侧 diff(`~/.flywheel/.env` 只有 `LINEAR_WORKSPACE_SLUG`)」,并因此把真 diff 整个推给执行节点当「硬账」。

**实测:key 一直在。** 上游的 grep 用了 `^[A-Z_]*LINEAR` 这类行首锚定的模式,而 `~/.flywheel/.env` 里这一行是 **`export ` 前缀**的:

```
~/.flywheel/.env:36:export LINEAR_API_KEY="lin_api_***"
```

⇒ 行首是 `export`,不是 `LINEAR`,所以行首锚定的 grep 漏了它。这是一次**「工具说没有」被当成「事实上没有」**的误判,不是环境限制。

⇒ 本单据此把附录自核方法写成了**可复跑脚本** `three-hunk-check.sh`(与本文件同目录),key 在**运行时**从 `~/.flywheel/.env` 读,**不硬编码任何密钥**。

### 这把尺子的双向验证(先证尺子没坏,再拿它量)

| 对照 | 输入 | 结果 |
| -- | -- | -- |
| **BEFORE 基线** | `origin/main` 的 design.md(未含本单改动)vs FLY-1569 当前正文 | **HUNKS=3** ✅ 且逐条就是附录列的那三条(`<b>` 标签 / `****` 星号 / §10 导航指针 + 分隔线) |
| **阳性对照** | 本分支 `HEAD`(已含两处更正)vs FLY-1569 **尚未同步**的正文 | **HUNKS=5** ✅ = 3 基线 + 本单两处 |

⇒ 基线证明**附录那条声明在改动前确实成立**(不是一句没人验过的话);阳性对照证明**这把尺子量得到本单的改动**(不会空过绿)。

⇒ merge + Linear patch 之后**必须回到 HUNKS=3**。回不到 3 = 两侧文本不逐字节相同,**必须修到一致再收工**。

## 6. 留给 D(FLY-1573)实现者的两条已知边界(本单不补)

上游 research §5 已记录,原样承接,**本单一律不补**(FLY-1580 明禁改设计其他部分):

1. 块② 没交叉说明「整批重投时 `retry_count` 按批加一次还是批内每行各加一次」。
2. 块① 的「前提」是一条**新增规范**而非对 §6 规则二的转述 —— 规则二带「到期 +」前置,块① 是**入队即判**。⇒ **D 必须在 enqueue / 投递准入侧也加 recipient-terminal 快速通道,只在 lease expiry 链里查是不够的。**

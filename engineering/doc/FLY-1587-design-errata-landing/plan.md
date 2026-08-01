# FLY-1587 承接 1580 落地 design.md 两处更正 — 实施计划

Issue: FLY-1587 (https://linear.app/geoforge3d/issue/FLY-1587/承接-1580-落地-designmd-两处更正-同步回-1569-正文patch-已逐字写好)
日期: 2026-07-31
基于: research.md(逐字 patch 权威原文见 `upstream-FLY-1580/plan.md` §2)

## 0. 这份计划怎么用

上游 `upstream-FLY-1580/plan.md` 已经把逐字 patch 和落地顺序写全并过了 Codex 设计评审。本文件**不重写那份计划**,只做两件事:

1. 把上游 §1 的落地顺序**适配到本单**(分支名 `flywheel-FLY-1587`、doc 文件夹 `engineering/doc/FLY-1587-design-errata-landing/`);
2. 记录本单执行过程中的实跑结果与偏差。

**措辞判断不重做。** 逐字 patch 见 `upstream-FLY-1580/plan.md` §2.1(更正②)/ §2.2(更正①)。

零代码改动:不碰 `packages/`、不建表、不改 schema、没有可跑的 build/test。

## 1. 落地顺序

```
0. 钉死 diff 基线(⚠️ 本地 main 是错的,用 merge-base + #742 ancestor 断言)   ✅
1. 改 doc/messaging-rework/design.md 两处                                    ✅
2. 本地核验:2 hunk + scope 干净 + 旧口径归零                                ✅
3. stage 两类文件(过程文档随 PR 进 main = Lead 已裁决)                      ✅
4. commit → push → 开 PR,描述贴两组 before/after                            ✅
5. 【PR 合进 main 之后】立即同步 FLY-1569 正文 —— 时机是硬要求,不能提前      ⏳
6. 实跑「恰好三个 hunk」diff 复核                                            ⏳
7. 回填 PR 描述:diff 实跑结果 + Linear 已同步                                ⏳
```

⚠️ **第 5 步的时机是硬要求。** 若在 design.md 合上 main **之前**就改 FLY-1569 正文,「两边各说各话」不但没消除,还调了个头(issue 新 / main 旧)—— 那正是这单存在的理由所反对的状态。

⚠️ **第 5 步不能漏。** 只合 PR 不改 issue = 这单只做了一半。

⚠️ **别把它当原子操作。** 跨 git 和 Linear 两个系统,merge 与 Linear save 之间必然有一段短暂不一致 —— 方向对(main 先新,issue 随后追上),可接受,但**不能因此省掉第 6 步的实跑复核**。若第 5 步 patch 失败或第 6 步 diff 对不上:**保持本单未完成并上报**,不许预写「已同步」或宣布收工。

## 2. design.md 两处改动

逐字 patch 见 `upstream-FLY-1580/plan.md` §2。落地时的两处格式细节(research.md §4):

* 上游 plan 里的 4 反引号(````)**落地写 3 个**(```)
* `见本节规则二` 行首**保留 1 个空格**(悬挂对齐)

### 本单实跑结果

```
$ git diff "$BASE" -- doc/messaging-rework/design.md | grep -c '^@@'
2
```

两个 hunk 分别落在 `@@ -70,6 +70,22 @@`(§3 开头)和 `@@ -153,7 +169,16 @@`(§6 末尾),位置正确。

```
$ grep -rn "最多产生一封死信" doc/          →  无输出 ✅
$ grep -n "聚合窗口" doc/messaging-rework/design.md      →  175 ✅
$ grep -n "两层不同粒度" doc/messaging-rework/design.md  →  74  ✅
$ grep -n "^ 见本节规则二" doc/messaging-rework/design.md → 180 ✅(悬挂空格保住)
```

### 不改的东西

* ❌ README.md · ❌ 文末附录 · ❌ §3 mailbox 表 `DEAD` 行 / §4 步骤 1 / §5 / §8 · ❌ 中文标点规范化 · ❌ FLY-1573

## 3. Linear 同步

### 3.1 FLY-1569 正文(必做,**PR 合入之后**)

用 `mcp__linear-api__save_issue`,`id: "FLY-1569"`,**只传 `patch`,不传 `description`**(传整篇有覆盖掉别处的风险)。

两个 op 的 `old_string` / `new_string` 与 design.md 落地文本**完全相同** —— 这正是「恰好三个 hunk」不变量得以保住的机制。

```
patch: [
  { op: "replace",
    old_string: "## 3. 两张表的状态机\n\n### 📮 mailbox —— 只答「送到没送到」",
    new_string: <§3 开头新块,3 反引号版> },
  { op: "replace",
    old_string: "Lead 收到就是一封普通的信,走同一套流程。**一个死掉的 runner 最多产生一封死信,不是无限条。**",
    new_string: <§6 末尾新块,3 反引号版> }
]
```

`patch` 是原子的(一个 op 匹配失败整次 save 回滚),两个锚点唯一性已复核 ⇒ 安全。

**注意 FLY-1569 状态是 Done。** 只改正文,**不要动 status / labels / assignee**。

### 3.2 FLY-1573 —— 🛑 本单零动作

Lead 已裁决:「1573 的正文我自己去改,你不要重复做,免得两边打架。」封锁名单由 Lead 维护(E/F/G → D/E/F/G)。

## 4. 验证

### 第 0 步 —— 钉死 diff 基线(每个块自包含)

```bash
set -euo pipefail
git fetch origin main
BASE=$(git merge-base HEAD origin/main)
git merge-base --is-ancestor ab2ec6b2154adb34fbf093df159e95edf274b684 "$BASE"
echo "BASE=$BASE"
```

若本执行环境 fetch 不了:**不要绕过,停下来上报**(上游沙箱撞到过共享 gitdir 无写权限)。本单实跑 fetch 成功。

### 第 1 步 —— design.md diff 恰好 2 个 hunk ✅

### 第 2 步 —— PR 里不许出现第三类文件

`git diff --name-only` 看不见未跟踪文件,必须两条一起查:

```bash
git diff "$BASE" --name-only
git status --short --untracked-files=all
```

允许集合 = `doc/messaging-rework/design.md` + `engineering/doc/FLY-1587-design-errata-landing/**`。出现任何第三类文件(尤其 `packages/` 下的)= **停下来**。

`git add` 一律用**显式路径**,禁 `git add -A` / `git add .`。

#### ✅ 过程文档进 PR = 必须,不是「可以」

Lead 已裁决(上游 `ask 872d9606`):过程文档**必须**随 PR 进 main,不许合并后再补。理由不是格式洁癖,是**自托管的硬约束** —— main 检出必须保持单写者干净,否则 updater 的 `git pull --ff-only` 和回滚会坏。

验收标准「diff 只有这两处」的权威解读(Lead 原话):**「design.md 的实质改动只有这两处」**,不是「整个 PR 只准有一个文件」。

### 第 3 步 —— 旧口径归零 + 新口径落位 ✅

### 第 4 步 —— 发布链:commit → push → 开 PR(整链一个块跑完)

```bash
set -euo pipefail
BASE=$(git merge-base HEAD origin/main)
git merge-base --is-ancestor ab2ec6b2154adb34fbf093df159e95edf274b684 "$BASE"
test "$(git branch --show-current)" = "flywheel-FLY-1587"     # 名字对不上会在远端建野分支
git commit -m "..."
git push -u origin flywheel-FLY-1587
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/flywheel-FLY-1587)"   # 断言远端真收到
git diff "$BASE"..HEAD --name-only                            # = 第 2 步的文件集合
git diff "$BASE"..HEAD -- doc/messaging-rework/design.md      # 仍是恰好 2 hunk
```

开 PR 后**立刻用真实 PR diff 复核**(`gh pr diff` 不接受 pathspec ⇒ 整份 patch 落临时文件再 awk 切出 design.md 段断言 hunk 数 == 2)。

真实 PR diff 与本地两点 diff 对不上 = 分支夹带了别的 commit,**停下来查,不要合**。

### 第 5 步 —— 「恰好三个 hunk」不变量复核(⚠️ 必跑,PR 合入 + issue 改完之后)

1. 从 Linear 取 FLY-1569 正文,截「`## 0. 背景与病因`」到结尾,存文件
2. 取 main 上的 design.md,截「`## 0. 背景与病因`」到「`## 附录`」之前,存文件
3. `diff` 两者

**预期:恰好三个 hunk** —— 附录列的那三条(`<b>` 标签、`****` 星号、§10 导航指针),一个不多。多出第 4 个 ⇒ 两侧文本不逐字节相同,**必须修到一致再收工**。

### 第 6 步 —— 渲染核对

GitHub 上打开 PR 里的 design.md,确认两个围栏块正常渲染,emoji(📮/📋)、箭头(→ ⇒)、【】、悬挂缩进都在。

## 5. 节点约束偏差记录(必须留档)

本节点 Agent Role 预置文本标 **no-write**(不许改分支 / 提交 / push / 开 PR),但 FLY-1587 dispatch 正文明确推翻:验收标准要求 PR MERGED + main 上可复现 diff,并点名上一次搁浅的根因正是 no-write 节点走 `no_code`。

⇒ 按 dispatch 明文执行(改文件 + commit + push + 开 PR),已用非阻塞 `ask`(`88b2fa7d`)报 Lead 知会。**merge 仍是 founder-gated,本节点不自行 merge,PR 开好后向 Lead 请批。**

## 6. 风险与已知边界

| 风险 | 处置 |
| -- | -- |
| 只改 design.md 忘了改 FLY-1569 | §1 第 5 步写成硬要求;§4 第 5 步 diff 会直接暴露;PR 描述不许删 pending 字样 |
| 两侧文本差一个字符 → 附录「三个 hunk」失效 | §4 第 5 步实跑 diff 兜底;patch 用同一份字符串是根本保证 |
| 拿本地 `main` 当基线 → 假失败 | §4 第 0 步 fail-closed fetch + merge-base + `#742` ancestor 断言 |
| `$BASE` 跨命令丢失 → `fatal: bad revision ''` | 每个代码块自包含,块首重算 BASE |
| commit/push 失败却继续开 PR | §4 第 4 步整链一个 `set -euo pipefail` 块 + push 后断言 `HEAD == origin/<branch>` |
| 未跟踪文件混进 PR | §4 第 2 步双查 + 显式路径 `git add` |
| **本单自己也搁浅** | 早提交早 push 早开 PR;跑到 design_review 仍零实质提交立刻报 Lead(`chore(progress)` 不算实质提交) |
| FLY-1569 是 Done 状态,误改 status | §3.1 明写只传 `patch`,不动 status/labels |

**已知不处理(两条,都留给 D):** 见 research.md §6。

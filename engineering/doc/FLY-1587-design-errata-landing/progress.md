# FLY-1587 进度游标

Issue: FLY-1587 (https://linear.app/geoforge3d/issue/FLY-1587/承接-1580-落地-designmd-两处更正-同步回-1569-正文patch-已逐字写好)
日期: 2026-07-31
基于: plan.md

| # | 步骤 | 状态 |
| -- | -- | -- |
| 0 | 钉死 diff 基线(fetch + merge-base + #742 ancestor 断言) | ✅ `BASE=ab2ec6b2` |
| 1 | 改 design.md 两处 | ✅ |
| 2 | 本地核验:2 hunk + scope 干净 + 旧口径归零 | ✅ |
| 3 | stage 两类文件(design.md + 过程文档) | ✅ 10 文件,`packages/` 零改动 |
| 4 | commit → push → 开 PR | ✅ `1d38358f` → PR #745 |
| 5 | 【merge 后】同步 FLY-1569 正文 | ⏳ 等 founder-gated merge |
| 6 | 实跑「恰好三个 hunk」复核 | ⏳ 等第 5 步 |
| 7 | 回填 PR 描述 | ⏳ 等第 6 步 |

**第 4 步实跑证据:**

```
HEAD == origin/flywheel-FLY-1587 == 1d38358f9bbc00f4d1e7076007bedeff8752490a
git diff BASE..HEAD -- doc/messaging-rework/design.md | grep -c '^@@'   → 2
gh pr diff 745 --patch | awk(design.md 段) HUNKS=2                      → 真实 PR diff 与本地两点 diff 一致
gh pr diff 745 --name-only                                             → 只有 design.md + FLY-1587 doc 文件夹
```

**第 6 步的尺子已经先造好并双向验过**(不用等 merge 就能做的部分):

`three-hunk-check.sh`(同目录,key 运行时从 `~/.flywheel/.env` 读,不硬编码)

| 对照 | 结果 |
| -- | -- |
| BEFORE 基线:`origin/main` vs FLY-1569 当前正文 | **HUNKS=3** ✅ 逐条就是附录那三条 |
| 阳性对照:本分支 `HEAD` vs FLY-1569 未同步正文 | **HUNKS=5** ✅ = 3 + 本单两处 |

⇒ merge + Linear patch 之后必须**回到 3**。上游说的「没有 Linear API key」不成立 —— key 一直在 `~/.flywheel/.env:36`,只是带 `export ` 前缀被行首锚定的 grep 漏了。

**下一步:** PR #745 已开,等 founder-gated merge。merge 一到手立刻执行第 5→6→7 步。

**约束偏差:** 本节点预置为 no-write,按 FLY-1587 dispatch 明文执行写操作;已 `ask`(`88b2fa7d`)报 Lead。merge 不自决。

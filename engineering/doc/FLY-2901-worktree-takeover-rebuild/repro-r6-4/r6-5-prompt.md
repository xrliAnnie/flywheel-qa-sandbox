# Written design review — FLY-2901 plan §4.7a, clauses (e) and (f) only

IMPORTANT: This is a paper review. Do NOT run any shell commands, git commands, scripts or fixtures, and do not read or write files. Everything you need is below. Reply with your report directly in your final message.

## Context
A workflow successor takes over a shared git worktree. Before an in-place cleanup (`git reset --hard <target>` then `git clean -fd`, no `-x`), a guard (§4.7a) must prove the cleanup will not delete or overwrite content that was not saved first. Tracked changes and non-ignored untracked files are saved into rescue commits beforehand; ignored files are not saved, so the guard must prove they survive, otherwise refuse (fail closed, list paths). Earlier review rounds on this same guard (R6, R6-2, R6-3) found and closed several gaps; round R6-4 on the version before (e)/(f) were extended could not produce a written verdict (the reviewer turn was interrupted twice), but left executed evidence summarised below. The Engineering Lead asked for a written verdict on just the two clauses added afterwards.

## Current §4.7a text (plan blob b6d205488cd4cd84f72adb93d08c05a7019813b6)
### 4.7a 忽略内容保全门（v5.2，R6 HIGH，Lead 裁定 A）
问题：被 `.gitignore` / `info/exclude` 忽略的未跟踪内容不出现在 status，不进快照、不进指纹、不进救援 ref；但 `reset --hard target` 会覆盖 target 开始跟踪的同路径，
而 `clean -fd`（不带 `-x`）按 **reset 之后**的忽略规则判定，target 删掉某条忽略规则就会把原先被忽略的文件当成未跟踪删掉。两种情况事务都会报成功、原字节无任何副本（复现见 `codex-review-round6.md`、`repro-r6/`）。
「不带 `-x`」本身**不**构成保留证明。

门 `assertIgnoredContentSafe(worktree, target)`（只用于目录存在的原地清理类；`worktree_missing` / 未登记且不在没有旧目录内容，不适用）。
**不枚举忽略内容、也不在 target 规则下重算忽略**（R6-3：`--directory` 枚举会被同名 index 文件遮住、规则文件有大小写别名与 `core.excludesFile` 等多个来源——预测式判据一再漏）；改为只看「reset 会写哪些路径」并核对这些路径上的磁盘现状，外加「会不会改动规则源」。
基线是当前 index / 工作区（reset 的输入），**不因 `target == H` 跳过**（R6-2 #1）：
1. `D` = `git diff --name-only -z --no-renames <target>`（target 树 对 当前工作区，含 index 里有而 target 没有、target 有而 index 没有、内容 / 类型不同的全部路径）= `reset --hard target` 会写或删的全部路径。
2. 路径冲突（reset 会覆盖 / 删除的不在保全范围内的东西）——对每个 `p ∈ D`：
   (a) `lstat(p)` 是目录 → 冲突（跟踪路径位置上的目录，里面可能有 status 看不到的忽略内容，R6-3 #1）；
   (b) `p` 不在当前 index（`git ls-files -z --cached --error-unmatch` 语义）且 `lstat(p)` 存在，且 `git check-ignore --no-index -q -- <p>` 判为忽略 → 冲突（未忽略的未跟踪文件已在 §4.1 快照里）；
   (c) `p` 的任一真祖先在磁盘上存在且不是目录、又不在当前 index → 冲突（reset 建目录时会删掉它）。
   `lstat` 走真实文件系统，macOS 大小写不敏感时天然命中大小写变体；`check-ignore` 遵循仓库 `core.ignorecase`。
3. 规则源冲突（clean 用的忽略规则会变）：
   (d) `D` 中任一路径的末段按大小写不敏感等于 `.gitignore`（覆盖 `.GITIGNORE` 等别名，R6-3 #2）→ 冲突；
   (e) 实际生效的全局忽略文件落在工作树内 → 冲突（R6-3 #3；罕见配置，一律保守拒绝，不试图判断它是否被 reset 改写）。「实际生效」= `git config --path --get core.excludesFile` 有值时取该值，否则取 git 默认 `$XDG_CONFIG_HOME/git/ignore`（`XDG_CONFIG_HOME` 未设时 `$HOME/.config/git/ignore`）；按 realpath 判断。
   (f) 当前 index 里任一条目带 assume-unchanged 或 skip-worktree 标记（`git ls-files -z -v` 的小写标签或 `S`）→ 冲突（这类条目会让 `git diff` 看不到工作区真实改动，`D` 不再完整；保守拒绝）。
   **不设安全根豁免**（R6-2 #2）；也不以「目录里有没有忽略内容」为前提——共享树里 `.flywheel/runs/` 几乎总在，这个前提只会引入枚举漏洞。
4. 有冲突 → fail-closed 停手 `ignored_content_at_risk`，失败文案列出触发的路径与规则（(a)–(f) 标签 + 路径前 20 条，超出 `…(+N more)`），走 §4.8-5 同一转义规则。**不可关闭**（它是损失防线；kill switch 开时本来就不进原地清理）。
5. 充分性论证：`reset --hard target` 只写 / 删 `D` 中的路径（及为其创建 / 移除的父目录）。(a)(b)(c) 保证这些位置上不存在「不在 index 且未被快照」的内容：index 里的内容在 `H` / 快照里，未忽略的未跟踪内容在快照里，被忽略的内容命中即拒绝。
   `clean -fd`（不带 `-x`）只删 reset 后规则下未被忽略的未跟踪项，不删被忽略项、也不删仍含被忽略项的目录；reset 后的规则来源 = 工作树内各 `.gitignore`（只有 `D` 里的会变，(d) 已拒）+ `info/exclude`（在 git 目录内，不随 reset 变）+ `core.excludesFile`（树外不随 reset 变，树内 (e) 已拒）。
   `D` 的完整性以 (f) 为前提（无 assume-unchanged / skip-worktree 条目时，`git diff <target>` 对工作区逐路径比对，不会隐藏改动）。
   ⇒ 所有此刻被忽略的内容在 clean 时仍被忽略，原地保留。
6. 调用两次：第一次在分类 / 选定 target 之后、任何保全写入之前（停手时无救援 ref、无 manifest、无事件、目录字节不变）；
   第二次在破坏阶段的第一步、任何嵌套仓挪动与 `reset --hard` 之前（含崩溃重入直接进入破坏阶段的路径）——此时事件已在，停手同 `post_clean_dirty` 的处理口径，但尚无任何破坏性动作，原字节仍在。
7. 命令一律 argv 调用；`-z` 输出按 NUL 切分，不经 shell。

被否：在临时目录按 target 规则重算每个忽略文件是否仍被忽略（更精确但需要构造 target 规则环境，范围与风险都更大）；把忽略内容也纳入快照（会把 `node_modules` 等大体量产物推上远端，且与 FLY-1707 上限冲突）。
代价：reset 会改动任一 `.gitignore`（大小写不敏感）、或 `core.excludesFile` 指向树内时，自动清理一律停手回到今天的 held + 告警——不会比今天更差，且不丢工作。常见的 `dirty`（target == H、没动 `.gitignore`）与只改普通文件的 `head_behind` 不受影响。


## Executed evidence from R6-4 (against the version before (e) was extended and (f) added)
- All 17 fixtures from R6/R6-2/R6-3: 14 must-refuse cases refused with original bytes intact; 3 normal controls succeeded with ignored bytes intact.
- Boundary A: `.gitignore` marked assume-unchanged and edited in the worktree; target changes `.gitignore`. D = ["tracked"] (the edited .gitignore was hidden from `git diff <target>`), guard allowed, reset rewrote `.gitignore`, clean removed `drafts/` → bytes lost. New (f) refuses whenever any index entry has assume-unchanged or skip-worktree.
- Boundary B: core.excludesFile unset, XDG_CONFIG_HOME points inside the worktree, the default `xdg/git/ignore` is tracked and changed by target. Guard allowed (old (e) only looked at explicit core.excludesFile), clean removed `drafts/` → bytes lost. New (e) uses the effective global excludes file (explicit, else $XDG_CONFIG_HOME/git/ignore, else $HOME/.config/git/ignore) and refuses if its realpath is inside the worktree.
- Boundary C: skip-worktree `.gitignore` → no loss (reset left it; clean kept drafts). (f) still refuses conservatively.
- Boundary D: untracked (non-ignored) `.gitignore` ignoring drafts/ → no loss; clean removed the untracked `.gitignore` itself, drafts became visible untracked, the transaction stops with post_clean_dirty.

## Question
Do clauses (e) and (f), together with the sufficiency argument in item 5, close Boundaries A and B without introducing a new BLOCKER/HIGH (a remaining way for the in-place reset/clean to remove or overwrite unsaved bytes that the guard would allow)? Limit yourself to (e), (f) and item 5; other clauses were already reviewed with execution.

## Output
Sections: Summary; Issues (numbered, severity BLOCKER/HIGH/MEDIUM/LOW, with minimal fix); Verdict. APPROVED unless a BLOCKER or HIGH remains. Last line exactly "VERDICT: APPROVED" or "VERDICT: CHANGES REQUESTED".

# FLY-2901 Codex 设计复核 R6-3（gpt-6-astra xhigh，限定 §4.7a；池快照 shopping）
Issue: FLY-2901
日期: 2026-09-26
基于: plan.md（blob 89260d6b2c84c8795ed1f1b74c8780d866b49f33）

> 原文如下，复现脚本与结果见 repro-r6-3/。

# Summary

**CHANGES REQUESTED — 0 BLOCKER / 3 HIGH / 0 MEDIUM / 0 LOW。**

限定审查 commit `aa7b24529c934facc0234f1f6173e33f5b05cb47` 的 §4.7a 增量；磁盘 plan 与该提交的 blob 均为 `89260d6b2c84c8795ed1f1b74c8780d866b49f33`。沿用本线程已读的 CLAUDE.md 与审查约束；仓库文件未修改，未重审其他章节。

**R6 与 R6-2 的原有反例已关闭。** 用修订后的判据重跑 14 个真 Git 用例：原始两例、上一轮五例、`/paired/` 删除规则、大小写路径冲突、staged 与 untracked 忽略规则用例均在破坏前拒绝；3 个规则不变的正常对照成功且忽略字节不变。移除 `target==H` 早退、比较工作区现字节、取消安全根豁免均起效。两次门的时序约定没有发现新的阻断问题。

但新增充分性论证仍有三个可执行反例：I 的目录压缩枚举并不完整，G 未覆盖文件系统上的大小写别名，也未覆盖可由 reset 改写的 `core.excludesFile` 实际规则文件。三例均穿过两次门，真实事务继续成功并丢失未保全字节，故本轮不能批准。

执行证据：

- [repro.mjs](fly2901-r3-2b38itsm/repro.mjs) / [results.json](fly2901-r3-2b38itsm/results.json)：14 个回归与对照，最终退出码 0。
- [new-counterexamples.mjs](fly2901-r3-2b38itsm/new-counterexamples.mjs) / [new-counterexamples-results.json](fly2901-r3-2b38itsm/new-counterexamples-results.json)：下述 3 个数据丢失反例，最终退出码 0（断言成功证明缺陷）。
- [source.json](fly2901-r3-2b38itsm/source.json)：来源与验证方式。Git 为 `2.39.5 (Apple Git-154)`，临时夹具所在文件系统大小写不敏感，`core.ignorecase=true`。

边界：新 guard 仍是计划，本轮逐条建模其判据，不把模型称为生产实现。其余沿用上轮从源码提取的 transaction/rescue 与真实 snapshot 方法；已核对这些源文件在 `8e684a97d..aa7b24529` 间没有变化。使用隔离 bare origin、主仓、linked worktree、单线程 host 与内存 recorder；首次检查在任何保全前，第二次在 reset 前，全部夹具 `nestedMoves=[]`。没有运行完整 Blueprint/StateStore、项目测试、构建、full CI 或重启集成用例；重入时序只作文本与调用链核验。

重跑（仅在该临时证据目录新建隔离 Git 夹具）：

```sh
node --experimental-transform-types /private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-2901/17494d5c-1fa0-41f4-8991-3e04157b3751/scratchpad/fly2901-r3-2b38itsm/repro.mjs
node --experimental-transform-types /private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-2901/17494d5c-1fa0-41f4-8991-3e04157b3751/scratchpad/fly2901-r3-2b38itsm/new-counterexamples.mjs
```

# Issues

## 1. [HIGH] `--directory` 会漏掉被 index 同名文件遮住的 ignored 目录，I 为空并不能证明无忽略内容

**位置：plan.md L180–181、L189–190。**

构造普通 `dirty`：H 跟踪一个普通文件 `drafts`，同时 `.gitignore` 含目录规则 `drafts/`。前任在本地删除该文件，建立同名目录，留下唯一的 `drafts/unpublished.md`；index 不变，取 `S=H=R`。这是合法的文件→目录替换，没有进行中的 Git 操作或未合并 index。

真实 Git 输出：

| 查询 | 结果 |
|---|---|
| `status --porcelain=v2 -z --untracked-files=all` | 只有跟踪文件 `drafts` 的 `.D` |
| `ls-files -z --others --ignored --exclude-standard --directory` | **空** |
| 同命令去掉 `--directory` | `drafts/unpublished.md` |
| `check-ignore --no-index -v drafts/unpublished.md` | 命中 `.gitignore` 中的 `drafts/` |

所以两次门都按 L180 的 `I=[]` 通过；真实快照只保存“删除原跟踪文件”，没有草稿。`reset --hard H` 为恢复普通文件 `drafts`，直接移除同名目录及其内容，尚未 clean 就已丢失原字节。

执行用例 `index-file-now-ignored-directory`：`class=dirty, kind=rescued`，snapshot 调用 1 次、推送了 dirty 救援 ref，但草稿不在其中；`reset_done` 时草稿消失，随后记录 cleaned，最终 status 为空。原始字节的 blob 在对象库中不存在。[verified by executing]

**最小修正：** I 的枚举必须覆盖这类文件/目录冲突，不能把 `--directory` 当作不损失信息的输出压缩。至少去掉该选项或补齐相应枚举，再执行 target 路径冲突检查；本例完整 I 与 target 的 `drafts` 存在祖先冲突，应在任何保全/破坏写入前拒绝。新增此真 Git 回归。Git 也单独提供 `ls-files --killed` 描述这类阻碍写回跟踪文件的文件/目录冲突，可作为实现参考，不能仅凭普通 status 已覆盖来免查。[Git 官方说明](https://git-scm.com/docs/git-ls-files#Documentation/git-ls-files.txt---killed)

## 2. [HIGH] 大小写折叠只用于冲突一，G 的文件名筛选仍可漏掉 macOS 上实际生效的 `.GITIGNORE`

**位置：plan.md L182–184、L190。**

在本机大小写不敏感的文件系统上，H 跟踪名为 `.GITIGNORE` 的文件，内容为 `drafts/`；工作区草稿正常被 Git 忽略，`check-ignore -v` 确认其实际读取为 `.gitignore`。S 只将 `.GITIGNORE` 的规则改为空注释，取合法的 clean `head_behind`。

`ls-tree` / `ls-files` 返回的存储名称是 `.GITIGNORE`。按 L183 对末段 `.gitignore` 的筛选，G 为空；L182 的折叠只作用于 P/I 路径冲突，而 `.GITIGNORE` 与 `drafts/` 并不冲突。两次门都通过，reset 改写实际规则文件，随后 clean 删除草稿。

执行用例 `uppercase-ignore-changes`：两次均 `I=["drafts/"], G=[], collision=[]`；`class=head_behind, kind=rescued`，无快照、无救援 ref，`clean_done` 时草稿消失，rescued/cleaned 均记录，最终 status 为空，原字节未入对象库。这是在真实文件系统上执行，并非仅把 Linux 配置改成 `ignorecase=true` 的模拟。[verified by executing]

**最小修正：** 明确把适用的大小写语义也用于 G 的识别及与 target 的关联，覆盖实际被 Git 当作 `.gitignore` 读取的文件名别名；不能只给冲突一折叠路径。补 `.GITIGNORE` 或 `.GitIgnore` 规则变化的真文件系统回归。

## 3. [HIGH] `core.excludesFile` 的配置不变，不代表它指向的规则文件不被 reset 改写

**位置：plan.md L183–190，尤其 L190 的充分性前提。**

允许的 Git 配置 `core.excludesFile=<worktree>/project.ignore` 指向工作区里的普通文件。H 跟踪该文件，内容为 `drafts/`，根 `.gitignore` 保持不变；工作区有唯一的 ignored 草稿。S 删除 `project.ignore` 中的忽略规则，构成合法 clean `head_behind`。整个事务中配置值不变，也没有并发写者。

门得到 `I=["drafts/"]`，但 G 只含没有变化的 `.gitignore`；target 跟踪的 `project.ignore` 与 I 不重叠，因此两次检查都通过。reset 更新 `project.ignore` 的内容，clean 立即按新规则删除草稿。`core.excludesFile` 本身指定的是规则文件路径，并没有“必须位于工作树外”的限制。[Git 官方配置说明](https://git-scm.com/docs/git-config#Documentation/git-config.txt-coreexcludesFile)

执行用例 `excludes-file-in-worktree-changes`：`class=head_behind, kind=rescued`，snapshot 调用 0 次、`rescues=[]`，草稿在 `clean_done` 消失，两个事件均记录，最终 status 为空；`check-ignore -v` 明确指向该工作区的 `project.ignore`，原字节未入对象库。[verified by executing]

**最小修正：** 将实际生效的额外规则文件纳入“不被本次破坏阶段改变”的证明，或对不能证明这一点的配置保守拒绝。特别是规则文件位于工作树内（或实际解析指向树内）且将被 reset/clean 改动时，应在破坏前 fail closed。补该配置下规则变更的回归；仅断言配置值不变不足以建立 L190 的结论。

# Verdict

R6 与 R6-2 的既有反例和对应两条 HIGH 已闭合，其他已关闭合同继续关闭。本轮三条 HIGH 都直接否定修订后 §4.7a 的保护集合或充分性前提，且有真实事务丢失未保全字节的证据，因此仍需修订该门及定向回归。

VERDICT: CHANGES REQUESTED
